/* Account management for the signed-in user (B4): profile, password, sessions.
   Every route requires a live session; changes are audited and, when email is enabled, the account owner is
   notified of security-relevant changes (password changed, email changed: sent to the old address). */
import type { FastifyPluginAsync } from "fastify";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { AUTH_MESSAGES, USER_MESSAGES, apiError, can, changePasswordSchema, fieldErrors, profileUpdateSchema } from "@pisowifi/shared";
import type { Db } from "../db/client.js";
import { passwordResetTokens, users } from "../db/schema/index.js";
import type { Mailer } from "../mail/mailer.js";
import { emailChangedEmail, passwordChangedEmail } from "../mail/templates.js";
import { audit, isUniqueViolation, notify, requireOrm } from "../auth/helpers.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { listSessions, revokeAllSessions, revokeUserSession, toUserDto } from "../auth/sessions.js";

export interface AccountRoutesOptions {
  db: Db | null;
  mailer: Mailer | null;
}

const idParam = z.object({ id: z.uuid() });
const emailTaken = () => apiError("conflict", AUTH_MESSAGES.emailTaken, { email: AUTH_MESSAGES.emailTaken });

export const accountRoutes: FastifyPluginAsync<AccountRoutesOptions> = async (app, { db, mailer }) => {
  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store");
  });

  app.patch("/account/profile", { config: { access: "account:self" } }, async (req, reply) => {
    const parsed = profileUpdateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(apiError("validation_failed", "Check the highlighted fields.", fieldErrors(parsed.error)));
    const orm = requireOrm(db);
    const me = req.user!;
    const { displayName, email } = parsed.data;
    const emailChanged = email.toLowerCase() !== me.email.toLowerCase();
    // The sign-in email is also the notification address: Members ask an Administrator to change it.
    if (emailChanged && !can(me.role, "account:email")) return reply.code(403).send(apiError("forbidden", USER_MESSAGES.emailByAdmin, { email: USER_MESSAGES.emailByAdmin }));

    if (emailChanged) {
      const [taken] = await orm
        .select({ id: users.id })
        .from(users)
        .where(and(eq(sql`lower(${users.email})`, email.toLowerCase()), ne(users.id, me.id)))
        .limit(1);
      if (taken) return reply.code(409).send(emailTaken());
    }
    let updated;
    try {
      [updated] = await orm.update(users).set({ displayName, email }).where(eq(users.id, me.id)).returning();
    } catch (err) {
      if (isUniqueViolation(err)) return reply.code(409).send(emailTaken());
      throw err;
    }
    await audit(orm, req, "account.profile_updated", me.id, { emailChanged, nameChanged: displayName !== me.displayName });
    if (emailChanged) notify(mailer, emailChangedEmail(me.email, displayName, email), req.log);
    return { user: toUserDto(updated!) };
  });

  app.post("/account/password", { config: { access: "account:self", rateLimit: { max: 10, timeWindow: 15 * 60_000 } } }, async (req, reply) => {
    const parsed = changePasswordSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(apiError("validation_failed", "Check the highlighted fields.", fieldErrors(parsed.error)));
    const orm = requireOrm(db);
    const me = req.user!;
    const [user] = await orm.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, me.id)).limit(1);

    if (!user || !(await verifyPassword(user.passwordHash, parsed.data.currentPassword))) {
      await audit(orm, req, "account.password_change_failed", me.id);
      return reply
        .code(400)
        .send(apiError("validation_failed", AUTH_MESSAGES.currentPasswordIncorrect, { currentPassword: AUTH_MESSAGES.currentPasswordIncorrect }));
    }

    const passwordHash = await hashPassword(parsed.data.newPassword);
    await orm.update(users).set({ passwordHash, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, me.id));
    // Other devices are signed out; this one stays. Pending reset links stop working.
    const revoked = await revokeAllSessions(orm, me.id, me.sessionId);
    await orm.delete(passwordResetTokens).where(and(eq(passwordResetTokens.userId, me.id), isNull(passwordResetTokens.usedAt)));
    await audit(orm, req, "account.password_changed", me.id, { sessionsRevoked: revoked });
    notify(mailer, passwordChangedEmail(me.email, me.displayName), req.log);
    return { revoked };
  });

  app.get("/account/sessions", { config: { access: "account:self" } }, async (req) => {
    const me = req.user!;
    return { items: await listSessions(requireOrm(db), me.id, me.sessionId) };
  });

  app.delete("/account/sessions/:id", { config: { access: "account:self" } }, async (req, reply) => {
    const params = idParam.safeParse(req.params);
    const me = req.user!;
    if (!params.success) return reply.code(404).send(apiError("not_found", "Session not found"));
    if (params.data.id === me.sessionId) return reply.code(400).send(apiError("bad_request", "Use Sign out to end the current session."));
    const orm = requireOrm(db);
    if (!(await revokeUserSession(orm, me.id, params.data.id))) return reply.code(404).send(apiError("not_found", "Session not found"));
    await audit(orm, req, "account.session_revoked", me.id, { sessionId: params.data.id });
    return reply.code(204).send();
  });

  app.post("/account/sessions/revoke-others", { config: { access: "account:self" } }, async (req) => {
    const orm = requireOrm(db);
    const me = req.user!;
    const revoked = await revokeAllSessions(orm, me.id, me.sessionId);
    await audit(orm, req, "account.other_sessions_revoked", me.id, { sessionsRevoked: revoked });
    return { revoked };
  });
};
