/* Authentication: email + password sign-in, HttpOnly session cookie, sign-out, role guards.
   There is no public registration: accounts are created with `npm run user:create` (src/auth/cli.ts).

   Defences
   - Passwords: Argon2id (./password.ts); unknown emails cost the same time as wrong passwords.
   - Brute force: per-IP limit on POST /auth/login (LOGIN_RATE_LIMIT per 15 min) and a per-account lock
     (MAX_FAILED_LOGINS wrong passwords → locked for LOCK_MS).
   - Sessions: opaque random token in an HttpOnly, SameSite=Lax cookie (Secure + `__Host-` prefix when
     SESSION_COOKIE_SECURE), SHA-256 digest server-side, rotated on every sign-in (./sessions.ts).
   - CSRF: state-changing requests must come from APP_ORIGIN or APP_EXTRA_ORIGINS (checkOrigin, registered for the whole API).
   - Errors never say whether the email or the password was wrong. */
import type { FastifyInstance, FastifyPluginAsync, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { eq, sql } from "drizzle-orm";
import { AUTH_MESSAGES, PERMISSIONS, apiError, can, fieldErrors, loginRequestSchema, type Permission } from "@pisowifi/shared";
import type { Config } from "../config/env.js";
import type { Db } from "../db/client.js";
import { auditLog, users } from "../db/schema/index.js";
import { burnPasswordCheck, hashPassword, needsRehash, verifyPassword } from "./password.js";
import { createSession, findSession, revokeSession, toUserDto, type SessionUser } from "./sessions.js";

export const MAX_FAILED_LOGINS = 5;
export const LOCK_MS = 15 * 60_000;
const TOO_MANY = "Too many sign-in attempts. Try again in 15 minutes.";

export const sessionCookieName = (secure: boolean) => (secure ? "__Host-pisowifi_session" : "pisowifi_session");

/** Every route declares exactly one (route option `config.access`); routes without one fail at startup.
 *  public: anyone · session: any signed-in, active user · a Permission: a signed-in user whose role grants it. */
export type Access = "public" | "session" | Permission;

export interface AuthGuards {
  /** 401 unless the request carries a live session of an active user; sets `req.user`. */
  requireAuth: preHandlerAsyncHookHandler;
  /** requireAuth, then 403 unless the user's role grants the permission. */
  requirePermission: (permission: Permission) => preHandlerAsyncHookHandler;
  /** Kept for compatibility: requirePermission("users:manage") (only Administrators hold it). */
  requireAdmin: preHandlerAsyncHookHandler;
}

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
  }
  interface FastifyInstance {
    auth: AuthGuards;
    /** Every registered route and its declared access (for the security tests' route × role matrix). */
    routeAccess: { method: string; url: string; access: Access }[];
  }
  interface FastifyContextConfig {
    access?: Access;
  }
}

export const FORBIDDEN_MESSAGE = "You don't have permission to do this.";
const isAccess = (v: unknown): v is Access => v === "public" || v === "session" || (PERMISSIONS as readonly unknown[]).includes(v);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** CSRF defence: unsafe methods need an Origin header equal to APP_ORIGIN or one of APP_EXTRA_ORIGINS (exact match),
 *  or a same-origin fetch marker. */
export function checkOrigin(appOrigins: string | readonly string[]) {
  const allowed = new Set(typeof appOrigins === "string" ? [appOrigins] : appOrigins);
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin !== undefined && allowed.has(origin)) return;
    if (origin === undefined && req.headers["sec-fetch-site"] === "same-origin") return;
    return reply.code(403).send(apiError("forbidden", "Cross-origin request blocked."));
  };
}

/** Decorates the app with `req.user` and the guards, and enforces every route's declared access centrally
 *  (deny-by-default). Call on the root instance before any route is registered. */
export function registerAuthGuards(app: FastifyInstance, config: Config, db: Db | null) {
  const cookie = sessionCookieName(config.SESSION_COOKIE_SECURE);
  app.decorateRequest("user", null);

  /** The session's user, looked up once per request. Deactivated users have no live session (findSession). */
  const authenticate = async (req: FastifyRequest) => {
    if (!req.user && db) req.user = await findSession(db.orm, req.cookies[cookie]);
    return req.user;
  };
  const unauthorized = (reply: FastifyReply) => reply.code(401).send(apiError("unauthorized", "Sign in to continue."));
  const forbidden = (reply: FastifyReply) => reply.code(403).send(apiError("forbidden", FORBIDDEN_MESSAGE));

  const requireAuth: preHandlerAsyncHookHandler = async (req, reply) => {
    if (!(await authenticate(req))) return unauthorized(reply);
  };
  const requirePermission = (permission: Permission): preHandlerAsyncHookHandler =>
    async (req, reply) => {
      const user = await authenticate(req);
      if (!user) return unauthorized(reply);
      if (!can(user.role, permission)) return forbidden(reply);
    };
  app.decorate("auth", { requireAuth, requirePermission, requireAdmin: requirePermission("users:manage") });

  // Deny-by-default, part 1: a route that doesn't say who may call it never starts serving.
  const routeAccess: FastifyInstance["routeAccess"] = [];
  app.decorate("routeAccess", routeAccess);
  app.addHook("onRoute", (route) => {
    const access = (route.config as { access?: unknown } | undefined)?.access;
    if (!isAccess(access)) throw new Error(`Route ${String(route.method)} ${route.url} must declare config.access ("public", "session" or a permission)`);
    for (const method of [route.method].flat()) routeAccess.push({ method: String(method), url: route.url, access });
  });
  // Part 2: enforced here for every route, before any route code runs. Unknown routes (404) have no access to check.
  app.addHook("preHandler", async (req, reply) => {
    if (req.is404) return;
    const access = req.routeOptions.config.access;
    if (access === "public") return;
    if (!isAccess(access)) return forbidden(reply);
    const user = await authenticate(req);
    if (!user) return unauthorized(reply);
    if (access !== "session" && !can(user.role, access)) return forbidden(reply);
  });
}

export interface AuthRoutesOptions {
  config: Config;
  db: Db | null;
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, { config, db }) => {
  const cookie = sessionCookieName(config.SESSION_COOKIE_SECURE);
  const cookieBase = { httpOnly: true, secure: config.SESSION_COOKIE_SECURE, sameSite: "lax", path: "/" } as const;

  // Auth responses are never cached (they carry identity).
  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store");
  });

  const orm = () => {
    if (!db) throw Object.assign(new Error("Database is not configured"), { statusCode: 503, code: "unavailable" });
    return db.orm;
  };

  const audit = (req: FastifyRequest, action: string, userId: string | null, meta: Record<string, unknown> = {}) =>
    orm().insert(auditLog).values({ action, userId, ip: req.ip, targetType: userId ? "user" : null, targetId: userId, meta });

  app.post(
    "/auth/login",
    { config: { access: "public", rateLimit: { max: config.LOGIN_RATE_LIMIT, timeWindow: LOCK_MS } } },
    async (req, reply) => {
      const parsed = loginRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send(apiError("validation_failed", "Check the highlighted fields.", fieldErrors(parsed.error)));
      const { email, password, remember } = parsed.data;
      const db = orm();

      const [user] = await db
        .select()
        .from(users)
        .where(eq(sql`lower(${users.email})`, email.toLowerCase()))
        .limit(1);

      if (!user) {
        await burnPasswordCheck(password);
        await audit(req, "auth.login.failed", null, { reason: "unknown_email", email: email.toLowerCase().slice(0, 254) });
        return reply.code(401).send(apiError("unauthorized", AUTH_MESSAGES.invalidCredentials));
      }

      // Deactivated: same answer and cost as an unknown email, before the password is checked (a guess can't
      // confirm anything) and without touching the failure counter.
      if (user.disabledAt) {
        await burnPasswordCheck(password);
        await audit(req, "auth.login.deactivated", user.id);
        return reply.code(401).send(apiError("unauthorized", AUTH_MESSAGES.invalidCredentials));
      }

      if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
        await burnPasswordCheck(password);
        await audit(req, "auth.login.locked", user.id);
        return reply.code(429).send(apiError("rate_limited", TOO_MANY));
      }

      if (!(await verifyPassword(user.passwordHash, password))) {
        // Atomic: concurrent failures can't skip the lock. Reaching the limit locks and restarts the count.
        const [after] = await db
          .update(users)
          .set({
            failedLoginCount: sql`case when ${users.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS} then 0 else ${users.failedLoginCount} + 1 end`,
            lockedUntil: sql`case when ${users.failedLoginCount} + 1 >= ${MAX_FAILED_LOGINS} then now() + ${`${LOCK_MS} milliseconds`}::interval else ${users.lockedUntil} end`,
          })
          .where(eq(users.id, user.id))
          .returning({ lockedUntil: users.lockedUntil });
        const locked = !!after?.lockedUntil && after.lockedUntil.getTime() > Date.now();
        await audit(req, locked ? "auth.account.locked" : "auth.login.failed", user.id, { reason: "bad_password" });
        return reply.code(401).send(apiError("unauthorized", AUTH_MESSAGES.invalidCredentials));
      }

      await db
        .update(users)
        .set({
          failedLoginCount: 0,
          lockedUntil: null,
          lastLoginAt: sql`now()`,
          ...(needsRehash(user.passwordHash) ? { passwordHash: await hashPassword(password) } : {}),
        })
        .where(eq(users.id, user.id));

      // Rotate: a session cookie present before sign-in is never reused.
      const previous = await findSession(db, req.cookies[cookie]);
      if (previous) await revokeSession(db, previous.sessionId);

      const session = await createSession(db, { userId: user.id, remember, ip: req.ip, userAgent: req.headers["user-agent"] ?? null });
      reply.setCookie(cookie, session.token, remember ? { ...cookieBase, expires: session.expiresAt } : cookieBase);
      await audit(req, "auth.login.succeeded", user.id, { remember });
      return { user: toUserDto(user) };
    },
  );

  // Public: signing out must work with a stale or revoked cookie (it only ends a session it finds).
  app.post("/auth/logout", { config: { access: "public" } }, async (req, reply) => {
    const session = db ? await findSession(db.orm, req.cookies[cookie]) : null;
    if (session) {
      await revokeSession(orm(), session.sessionId);
      await audit(req, "auth.logout", session.id);
    }
    reply.clearCookie(cookie, cookieBase);
    return reply.code(204).send();
  });

  app.get("/auth/me", { config: { access: "session" } }, async (req) => ({ user: toUserDto(req.user!) }));
};
