/* Manage Users (permission users:manage, i.e. Administrators) and the audit log (permission audit:view).
   There is no public registration: accounts exist only when an Administrator (or the CLI) creates them.

     GET    /users                         list (search q, role, status)
     GET    /users/:id                     one account
     POST   /users                         { displayName, email, role? }          → 201 { user, setPasswordUrl, expiresAt }
     PATCH  /users/:id                     { displayName?, email? }
     PUT    /users/:id/role                { role }      signs the person out everywhere
     PUT    /users/:id/status              { active }    deactivating signs out everywhere and voids reset links
     POST   /users/:id/password-link       one-time set-password link; signs the person out everywhere
     GET    /users/:id/activity            audit entries by or about the account (audit:view)
     GET    /audit                         the whole audit log, newest first (audit:view)

   Rules
   - Requests are strict schemas: no field outside the listed ones is accepted (no mass assignment of role, status,
     password, ids). Ids are UUIDs from the path; every account is addressed explicitly (Administrators only).
   - Passwords never pass through these endpoints. New accounts get an unusable random Argon2id hash and a one-time
     link (the existing reset-confirm flow, token in the URL fragment); the link is returned once and never stored,
     logged or audited (only its expiry is).
   - Nobody changes their own role, deactivates themselves or issues themselves a link here.
   - At least one active Administrator always remains: role and status changes run in a transaction holding the same
     advisory lock as the database trigger (migration 0005), which also refuses any statement leaving none.
   - Every change is audited with the acting Administrator and the target account. */
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes } from "node:crypto";
import { and, desc, eq, gt, ilike, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import {
  SET_PASSWORD_LINK_TTL_MINUTES,
  USER_MESSAGES,
  AUTH_MESSAGES,
  apiError,
  auditQuerySchema,
  can,
  fieldErrors,
  userCreateSchema,
  userRoleUpdateSchema,
  userStatusUpdateSchema,
  userUpdateSchema,
  usersQuerySchema,
  type AdminUserDto,
  type AuditEntryDto,
} from "@pisowifi/shared";
import type { Config } from "../config/env.js";
import type { Db } from "../db/client.js";
import { auditLog, passwordResetTokens, sessions, users } from "../db/schema/index.js";
import { isUniqueViolation, requireOrm } from "../auth/helpers.js";
import { FORBIDDEN_MESSAGE } from "../auth/plugin.js";
import { hashPassword } from "../auth/password.js";
import { resetLink } from "../auth/password-reset.js";
import { hashToken, newSessionToken } from "../auth/sessions.js";

export interface UserRoutesOptions {
  config: Config;
  db: Db | null;
}

/** Same key as the trigger in migration 0005 ("pisowifi users: active admin guard"). */
export const ACTIVE_ADMIN_LOCK = 7240001;

const idParam = z.object({ id: z.uuid() });
const WINDOW = 15 * 60_000;

type Row = typeof users.$inferSelect;
const toAdminUser = (u: Row, now = Date.now()): AdminUserDto => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  role: u.role,
  status: u.disabledAt ? "deactivated" : u.lockedUntil && u.lockedUntil.getTime() > now ? "locked" : "active",
  lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
  lockedUntil: u.lockedUntil && u.lockedUntil.getTime() > now ? u.lockedUntil.toISOString() : null,
  deactivatedAt: u.disabledAt?.toISOString() ?? null,
  createdAt: u.createdAt.toISOString(),
});

/** The database refused a statement that would leave no active admin (trigger in migration 0005). */
export function isActiveAdminViolation(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string; cause?: { code?: string; constraint?: string } } | null;
  const c = e?.cause ?? e;
  return c?.code === "23514" && c?.constraint === "users_active_admin_required";
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => "\\" + m);
const validation = (reply: FastifyReply, err: z.ZodError) => reply.code(400).send(apiError("validation_failed", "Check the highlighted fields.", fieldErrors(err)));
const notFound = (reply: FastifyReply) => reply.code(404).send(apiError("not_found", "User not found"));
const conflict = (reply: FastifyReply, message: string, fields?: Record<string, string>) => reply.code(409).send(apiError("conflict", message, fields));

export const userRoutes: FastifyPluginAsync<UserRoutesOptions> = async (app, { config, db }) => {
  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store");
    reply.header("pragma", "no-cache");
  });

  type Tx = Parameters<Parameters<ReturnType<typeof requireOrm>["transaction"]>[0]>[0];
  const auditIn = (tx: Tx | ReturnType<typeof requireOrm>, req: FastifyRequest, action: string, targetId: string, meta: Record<string, unknown> = {}) =>
    tx.insert(auditLog).values({ action, userId: req.user!.id, ip: req.ip, targetType: "user", targetId, meta });
  const revokeAll = async (tx: Tx, userId: string) =>
    (await tx.update(sessions).set({ revokedAt: sql`now()` }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt))).returning({ id: sessions.id })).length;
  const issueLink = async (tx: Tx, req: FastifyRequest, userId: string) => {
    const token = newSessionToken();
    const expiresAt = new Date(Date.now() + SET_PASSWORD_LINK_TTL_MINUTES * 60_000);
    await tx.delete(passwordResetTokens).where(and(eq(passwordResetTokens.userId, userId), isNull(passwordResetTokens.usedAt)));
    await tx.insert(passwordResetTokens).values({ userId, tokenHash: hashToken(token), requestedIp: req.ip, expiresAt });
    return { setPasswordUrl: resetLink(config.APP_ORIGIN, token), expiresAt: expiresAt.toISOString() };
  };
  const params = (req: FastifyRequest) => idParam.safeParse(req.params);
  /** The acting account, re-read inside the transaction: a request authorized just before its sender was demoted or
   *  deactivated (by another Administrator) must not still change accounts. */
  class ActorRevoked extends Error {}
  const assertActor = async (tx: Tx, req: FastifyRequest) => {
    const [me] = await tx.select({ role: users.role, disabledAt: users.disabledAt }).from(users).where(eq(users.id, req.user!.id)).for("share");
    if (!me || me.disabledAt || !can(me.role, "users:manage")) throw new ActorRevoked();
  };
  const forbiddenNow = (reply: FastifyReply) => reply.code(403).send(apiError("forbidden", FORBIDDEN_MESSAGE));

  app.get("/users", { config: { access: "users:manage" } }, async (req, reply) => {
    const q = usersQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return validation(reply, q.error);
    const where: SQL[] = [];
    if (q.data.q) {
      const like = `%${escapeLike(q.data.q)}%`;
      where.push(or(ilike(users.email, like), ilike(users.displayName, like))!);
    }
    if (q.data.role) where.push(eq(users.role, q.data.role));
    if (q.data.status === "deactivated") where.push(isNotNull(users.disabledAt));
    if (q.data.status === "locked") where.push(isNull(users.disabledAt), gt(users.lockedUntil, sql`now()`));
    if (q.data.status === "active") where.push(isNull(users.disabledAt), or(isNull(users.lockedUntil), lte(users.lockedUntil, sql`now()`))!);
    const rows = await requireOrm(db).select().from(users).where(and(...where)).orderBy(users.createdAt, users.displayName, users.id);
    return { items: rows.map((r) => toAdminUser(r)) };
  });

  app.get("/users/:id", { config: { access: "users:manage" } }, async (req, reply) => {
    const p = params(req);
    if (!p.success) return notFound(reply);
    const [u] = await requireOrm(db).select().from(users).where(eq(users.id, p.data.id)).limit(1);
    return u ? { user: toAdminUser(u) } : notFound(reply);
  });

  app.post("/users", { config: { access: "users:manage", rateLimit: { max: 20, timeWindow: WINDOW } } }, async (req, reply) => {
    const body = userCreateSchema.safeParse(req.body ?? {});
    if (!body.success) return validation(reply, body.error);
    // Nobody knows this password: the person sets their own through the link.
    const unusable = await hashPassword(randomBytes(32).toString("base64url"));
    try {
      const result = await requireOrm(db).transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${ACTIVE_ADMIN_LOCK})`);
        await assertActor(tx, req);
        const [created] = await tx.insert(users).values({ email: body.data.email, displayName: body.data.displayName, role: body.data.role, passwordHash: unusable }).returning();
        const link = await issueLink(tx, req, created!.id);
        await auditIn(tx, req, "user.created", created!.id, { role: created!.role, via: "admin", linkExpiresAt: link.expiresAt });
        return { user: toAdminUser(created!), ...link };
      });
      return reply.code(201).send(result);
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(reply, AUTH_MESSAGES.emailTaken, { email: AUTH_MESSAGES.emailTaken });
      if (err instanceof ActorRevoked) return forbiddenNow(reply);
      throw err;
    }
  });

  app.patch("/users/:id", { config: { access: "users:manage", rateLimit: { max: 60, timeWindow: WINDOW } } }, async (req, reply) => {
    const p = params(req);
    if (!p.success) return notFound(reply);
    const body = userUpdateSchema.safeParse(req.body ?? {});
    if (!body.success) return validation(reply, body.error);
    try {
      return await requireOrm(db).transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${ACTIVE_ADMIN_LOCK})`);
        await assertActor(tx, req);
        const [before] = await tx.select().from(users).where(eq(users.id, p.data.id)).for("update");
        if (!before) return notFound(reply);
        const [after] = await tx.update(users).set(body.data).where(eq(users.id, p.data.id)).returning();
        const fields = Object.keys(body.data).filter((k) => (body.data as Record<string, unknown>)[k] !== (before as Record<string, unknown>)[k]);
        if (fields.length) await auditIn(tx, req, "user.updated", before.id, { fields });
        return { user: toAdminUser(after!) };
      });
    } catch (err) {
      if (isUniqueViolation(err)) return conflict(reply, AUTH_MESSAGES.emailTaken, { email: AUTH_MESSAGES.emailTaken });
      if (err instanceof ActorRevoked) return forbiddenNow(reply);
      throw err;
    }
  });

  /** Role and status changes: one transaction, the active-admin lock first, then the target row. */
  const guarded = async <T>(req: FastifyRequest, reply: FastifyReply, run: (tx: Tx) => Promise<T>) => {
    try {
      return await requireOrm(db).transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${ACTIVE_ADMIN_LOCK})`);
        await assertActor(tx, req);
        return run(tx);
      });
    } catch (err) {
      if (err instanceof ActorRevoked) return forbiddenNow(reply) as never;
      if (isActiveAdminViolation(err)) return conflict(reply, USER_MESSAGES.lastAdmin) as never;
      throw err;
    }
  };
  const otherActiveAdmins = async (tx: Tx, id: string) =>
    (await tx.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), isNull(users.disabledAt), ne(users.id, id)))).length;

  app.put("/users/:id/role", { config: { access: "users:manage", rateLimit: { max: 60, timeWindow: WINDOW } } }, async (req, reply) => {
    const p = params(req);
    if (!p.success) return notFound(reply);
    const body = userRoleUpdateSchema.safeParse(req.body ?? {});
    if (!body.success) return validation(reply, body.error);
    if (p.data.id === req.user!.id) return conflict(reply, USER_MESSAGES.selfRole);
    return guarded(req, reply, async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.id, p.data.id)).for("update");
      if (!u) return notFound(reply);
      if (u.role === body.data.role) return { user: toAdminUser(u), sessionsRevoked: 0 };
      if (u.role === "admin" && !u.disabledAt && (await otherActiveAdmins(tx, u.id)) === 0) return conflict(reply, USER_MESSAGES.lastAdmin);
      const [after] = await tx.update(users).set({ role: body.data.role }).where(eq(users.id, u.id)).returning();
      // Effective on the next request anyway (roles are read per request); signing out also refreshes every open app.
      const sessionsRevoked = await revokeAll(tx, u.id);
      await auditIn(tx, req, "user.role_changed", u.id, { from: u.role, to: body.data.role, sessionsRevoked });
      return { user: toAdminUser(after!), sessionsRevoked };
    });
  });

  app.put("/users/:id/status", { config: { access: "users:manage", rateLimit: { max: 60, timeWindow: WINDOW } } }, async (req, reply) => {
    const p = params(req);
    if (!p.success) return notFound(reply);
    const body = userStatusUpdateSchema.safeParse(req.body ?? {});
    if (!body.success) return validation(reply, body.error);
    if (p.data.id === req.user!.id && !body.data.active) return conflict(reply, USER_MESSAGES.selfDeactivate);
    return guarded(req, reply, async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.id, p.data.id)).for("update");
      if (!u) return notFound(reply);
      if (body.data.active === !u.disabledAt) return { user: toAdminUser(u), sessionsRevoked: 0 };
      if (!body.data.active) {
        if (u.role === "admin" && (await otherActiveAdmins(tx, u.id)) === 0) return conflict(reply, USER_MESSAGES.lastAdmin);
        const [after] = await tx.update(users).set({ disabledAt: sql`now()`, disabledBy: req.user!.id }).where(eq(users.id, u.id)).returning();
        const sessionsRevoked = await revokeAll(tx, u.id);
        await tx.delete(passwordResetTokens).where(and(eq(passwordResetTokens.userId, u.id), isNull(passwordResetTokens.usedAt)));
        await auditIn(tx, req, "user.deactivated", u.id, { sessionsRevoked });
        return { user: toAdminUser(after!), sessionsRevoked };
      }
      const [after] = await tx.update(users).set({ disabledAt: null, disabledBy: null, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, u.id)).returning();
      await auditIn(tx, req, "user.reactivated", u.id);
      return { user: toAdminUser(after!), sessionsRevoked: 0 };
    });
  });

  app.post("/users/:id/password-link", { config: { access: "users:manage", rateLimit: { max: 10, timeWindow: WINDOW } } }, async (req, reply) => {
    const p = params(req);
    if (!p.success) return notFound(reply);
    if (Object.keys((req.body as object | undefined) ?? {}).length) return reply.code(400).send(apiError("validation_failed", "This request takes no body."));
    if (p.data.id === req.user!.id) return conflict(reply, USER_MESSAGES.selfLink);
    return guarded(req, reply, async (tx) => {
      const [u] = await tx.select().from(users).where(eq(users.id, p.data.id)).for("update");
      if (!u) return notFound(reply);
      if (u.disabledAt) return conflict(reply, USER_MESSAGES.deactivatedLink);
      const link = await issueLink(tx, req, u.id);
      const sessionsRevoked = await revokeAll(tx, u.id);
      await auditIn(tx, req, "user.password_link_issued", u.id, { sessionsRevoked, linkExpiresAt: link.expiresAt });
      return link;
    });
  });

  /* ---------------- audit log (audit:view) ---------------- */

  const actor = alias(users, "actor");
  const auditPage = async (where: SQL | undefined, q: z.infer<typeof auditQuerySchema>) => {
    const rows = await requireOrm(db)
      .select({ e: auditLog, actorName: actor.displayName })
      .from(auditLog)
      .leftJoin(actor, eq(actor.id, auditLog.userId))
      .where(and(where, q.before ? lt(auditLog.id, q.before) : undefined, q.action ? sql`${auditLog.action} like ${escapeLike(q.action) + "%"}` : undefined))
      .orderBy(desc(auditLog.id))
      .limit(q.limit + 1);
    const items: AuditEntryDto[] = rows.slice(0, q.limit).map(({ e, actorName }) => ({
      id: e.id,
      action: e.action,
      createdAt: e.createdAt.toISOString(),
      actor: e.userId ? { id: e.userId, displayName: actorName ?? "Deleted account" } : null,
      target: e.targetType && e.targetId ? { type: e.targetType, id: e.targetId } : null,
      ip: e.ip,
      meta: e.meta as Record<string, unknown>,
    }));
    return { items, nextBefore: rows.length > q.limit ? items[items.length - 1]!.id : null };
  };

  app.get("/users/:id/activity", { config: { access: "audit:view" } }, async (req, reply) => {
    const p = params(req);
    if (!p.success) return notFound(reply);
    const q = auditQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return validation(reply, q.error);
    const [u] = await requireOrm(db).select({ id: users.id }).from(users).where(eq(users.id, p.data.id)).limit(1);
    if (!u) return notFound(reply);
    return auditPage(or(eq(auditLog.userId, u.id), and(eq(auditLog.targetType, "user"), eq(auditLog.targetId, u.id))), q.data);
  });

  app.get("/audit", { config: { access: "audit:view" } }, async (req, reply) => {
    const q = auditQuerySchema.safeParse(req.query ?? {});
    if (!q.success) return validation(reply, q.error);
    return auditPage(undefined, q.data);
  });
};
