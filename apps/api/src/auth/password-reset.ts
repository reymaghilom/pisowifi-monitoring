/* Password reset by email (B4, configurable SMTP).

   POST /auth/password-reset          {email} → 202 whether or not the account exists (no enumeration);
                                      503 when email delivery is not enabled (SMTP_ENABLED).
   POST /auth/password-reset/confirm  {token, password} → 204; the link works once, for PASSWORD_RESET_TTL_MINUTES.

   Tokens: 256-bit random, only the SHA-256 is stored; a new request replaces older unused links; at most
   MAX_RESETS_PER_HOUR links per account per hour; the link carries the token in the URL fragment
   (/reset-password#token=…) so it never reaches server or proxy logs. A successful reset unlocks the account,
   signs out every session and notifies the owner. */
import type { FastifyPluginAsync } from "fastify";
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import { AUTH_MESSAGES, PASSWORD_RESET_TTL_MINUTES, apiError, fieldErrors, passwordResetConfirmSchema, passwordResetRequestSchema } from "@pisowifi/shared";
import type { Config } from "../config/env.js";
import type { Db } from "../db/client.js";
import { auditLog, passwordResetTokens, users } from "../db/schema/index.js";
import type { Mailer } from "../mail/mailer.js";
import { passwordChangedEmail, passwordResetEmail } from "../mail/templates.js";
import { audit, notify, requireOrm } from "./helpers.js";
import { hashPassword } from "./password.js";
import { hashToken, newSessionToken, revokeAllSessions } from "./sessions.js";

export const MAX_RESETS_PER_HOUR = 3;
const WINDOW = 15 * 60_000;

export interface PasswordResetOptions {
  config: Config;
  db: Db | null;
  mailer: Mailer | null;
}

export const resetLink = (appOrigin: string, token: string) => `${appOrigin}/reset-password#token=${token}`;

export const passwordResetRoutes: FastifyPluginAsync<PasswordResetOptions> = async (app, { config, db, mailer }) => {
  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store");
  });

  app.post("/auth/password-reset", { config: { access: "public", rateLimit: { max: 5, timeWindow: WINDOW } } }, async (req, reply) => {
    const parsed = passwordResetRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send(apiError("validation_failed", "Check the highlighted fields.", fieldErrors(parsed.error)));
    if (!mailer) return reply.code(503).send(apiError("unavailable", AUTH_MESSAGES.resetUnavailable));
    const orm = requireOrm(db);
    const email = parsed.data.email.toLowerCase();

    const [user] = await orm
      .select({ id: users.id, email: users.email, displayName: users.displayName, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(sql`lower(${users.email})`, email))
      .limit(1);
    // Deactivated accounts get no link; the answer is the same as for an unknown email.
    if (user?.disabledAt) {
      await audit(orm, req, "auth.password_reset.deactivated", user.id);
      return reply.code(202).send();
    }
    if (!user) {
      await audit(orm, req, "auth.password_reset.unknown_email", null, { email: email.slice(0, 254) });
      return reply.code(202).send();
    }

    // Counted from the audit trail: older unused links are deleted when a new one is issued.
    const [recent] = await orm
      .select({ n: count() })
      .from(auditLog)
      .where(and(eq(auditLog.userId, user.id), eq(auditLog.action, "auth.password_reset.requested"), gt(auditLog.createdAt, sql`now() - interval '1 hour'`)));
    if ((recent?.n ?? 0) >= MAX_RESETS_PER_HOUR) {
      await audit(orm, req, "auth.password_reset.throttled", user.id);
      return reply.code(202).send();
    }

    const token = newSessionToken();
    await orm.delete(passwordResetTokens).where(and(eq(passwordResetTokens.userId, user.id), isNull(passwordResetTokens.usedAt)));
    await orm.insert(passwordResetTokens).values({
      userId: user.id,
      tokenHash: hashToken(token),
      requestedIp: req.ip,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000),
    });
    await audit(orm, req, "auth.password_reset.requested", user.id);
    notify(mailer, passwordResetEmail(user.email, user.displayName, resetLink(config.APP_ORIGIN, token)), req.log);
    return reply.code(202).send();
  });

  app.post("/auth/password-reset/confirm", { config: { access: "public", rateLimit: { max: 10, timeWindow: WINDOW } } }, async (req, reply) => {
    const parsed = passwordResetConfirmSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      const fields = fieldErrors(parsed.error);
      if (fields.token) return reply.code(400).send(apiError("invalid_token", AUTH_MESSAGES.resetLinkInvalid));
      return reply.code(400).send(apiError("validation_failed", "Check the highlighted fields.", fields));
    }
    const orm = requireOrm(db);

    // Consume atomically: a link can't be used twice, even by concurrent requests.
    const [used] = await orm
      .update(passwordResetTokens)
      .set({ usedAt: sql`now()` })
      .where(
        and(
          eq(passwordResetTokens.tokenHash, hashToken(parsed.data.token)),
          isNull(passwordResetTokens.usedAt),
          gt(passwordResetTokens.expiresAt, sql`now()`),
          // A link issued before the account was deactivated stops working with it.
          sql`exists (select 1 from ${users} where ${users.id} = ${passwordResetTokens.userId} and ${users.disabledAt} is null)`,
        ),
      )
      .returning({ userId: passwordResetTokens.userId });
    if (!used) return reply.code(400).send(apiError("invalid_token", AUTH_MESSAGES.resetLinkInvalid));

    const passwordHash = await hashPassword(parsed.data.password);
    const [user] = await orm
      .update(users)
      .set({ passwordHash, failedLoginCount: 0, lockedUntil: null })
      .where(eq(users.id, used.userId))
      .returning({ email: users.email, displayName: users.displayName });
    const revoked = await revokeAllSessions(orm, used.userId);
    await orm.delete(passwordResetTokens).where(and(eq(passwordResetTokens.userId, used.userId), isNull(passwordResetTokens.usedAt)));
    await audit(orm, req, "auth.password_reset.completed", used.userId, { sessionsRevoked: revoked });
    if (user) notify(mailer, passwordChangedEmail(user.email, user.displayName), req.log);
    return reply.code(204).send();
  });
};
