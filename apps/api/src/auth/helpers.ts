/* Small helpers shared by the auth and account routes. */
import type { FastifyBaseLogger, FastifyRequest } from "fastify";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema/index.js";
import { auditLog } from "../db/schema/index.js";
import type { Db } from "../db/client.js";
import type { MailMessage, Mailer } from "../mail/mailer.js";

type Orm = NodePgDatabase<typeof schema>;

/** The ORM, or a 503 when no database is configured. */
export function requireOrm(db: Db | null): Orm {
  if (!db) throw Object.assign(new Error("Database is not configured"), { statusCode: 503, code: "unavailable" });
  return db.orm;
}

/** Audit entry by `userId` (the actor). The target defaults to that user; pass one for other objects (e.g. a machine). */
export const audit = (
  orm: Orm,
  req: FastifyRequest,
  action: string,
  userId: string | null,
  meta: Record<string, unknown> = {},
  target: { type: string; id: string } | null = userId ? { type: "user", id: userId } : null,
) => orm.insert(auditLog).values({ action, userId, ip: req.ip, targetType: target?.type ?? null, targetId: target?.id ?? null, meta });

/** Sends without delaying the response; failures are logged (without the message body), never thrown. */
export function notify(mailer: Mailer | null, message: MailMessage, log: FastifyBaseLogger): void {
  if (!mailer) return;
  mailer.send(message).catch((err: unknown) => log.error({ err: err instanceof Error ? err.message : String(err), subject: message.subject }, "email not sent"));
}

/** PostgreSQL unique_violation, whether raw (pg, PGlite) or wrapped by Drizzle. */
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | null;
  return e?.code === "23505" || e?.cause?.code === "23505";
}
