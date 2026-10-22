/* Server-side sessions. The cookie holds an opaque 256-bit random token; the database stores only its
   SHA-256 digest, so a leaked sessions table can't be replayed. Revocation is immediate (revoked_at). */
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Role, SessionDto, UserDto } from "@pisowifi/shared";
import type * as schema from "../db/schema/index.js";
import { sessions, users } from "../db/schema/index.js";
import { sessionLabel } from "./user-agent.js";

type Orm = NodePgDatabase<typeof schema>;

/** "Remember me": persistent cookie. Otherwise a browser-session cookie with a short server-side lifetime. */
export const SESSION_TTL_MS = { remember: 30 * 24 * 3600_000, short: 12 * 3600_000 };
/** last_seen_at is written at most this often per session (keeps reads cheap). */
const TOUCH_INTERVAL_MS = 5 * 60_000;

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const newSessionToken = () => randomBytes(32).toString("base64url");
export const hashToken = (token: string) => createHash("sha256").update(token).digest();

export interface SessionUser extends UserDto {
  sessionId: string;
}

export const toUserDto = (u: { id: string; email: string; displayName: string; role: Role }): UserDto => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  role: u.role,
});

export async function createSession(
  orm: Orm,
  input: { userId: string; remember: boolean; ip: string | null; userAgent: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = newSessionToken();
  const expiresAt = new Date(Date.now() + (input.remember ? SESSION_TTL_MS.remember : SESSION_TTL_MS.short));
  await orm.insert(sessions).values({
    userId: input.userId,
    tokenHash: hashToken(token),
    remember: input.remember,
    ip: input.ip,
    userAgent: input.userAgent?.slice(0, 512) ?? null,
    label: sessionLabel(input.userAgent),
    expiresAt,
  });
  // Housekeeping: drop this user's dead sessions (expired, or revoked over a day ago).
  await orm
    .delete(sessions)
    .where(and(eq(sessions.userId, input.userId), or(lt(sessions.expiresAt, sql`now()`), lt(sessions.revokedAt, sql`now() - interval '1 day'`))));
  return { token, expiresAt };
}

/** Resolves a cookie token to its live session and user, or null. */
export async function findSession(orm: Orm, token: string | undefined): Promise<SessionUser | null> {
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const [row] = await orm
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    // A deactivated user's sessions stop working at once, even if one escaped revocation (e.g. created concurrently).
    .where(and(eq(sessions.tokenHash, hashToken(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`), isNull(users.disabledAt)))
    .limit(1);
  if (!row) return null;
  if (Date.now() - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await orm.update(sessions).set({ lastSeenAt: sql`now()` }).where(eq(sessions.id, row.sessionId));
  }
  return { sessionId: row.sessionId, ...toUserDto(row) };
}

export async function revokeSession(orm: Orm, sessionId: string): Promise<void> {
  await orm.update(sessions).set({ revokedAt: sql`now()` }).where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
}

/** Signs a user out everywhere, optionally except one session (the caller's). Returns the number revoked. */
export async function revokeAllSessions(orm: Orm, userId: string, exceptSessionId?: string): Promise<number> {
  const rows = await orm
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined))
    .returning({ id: sessions.id });
  return rows.length;
}

/** Revokes one of the user's own live sessions. False when it doesn't exist, isn't theirs or is already gone. */
export async function revokeUserSession(orm: Orm, userId: string, sessionId: string): Promise<boolean> {
  const rows = await orm
    .update(sessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)))
    .returning({ id: sessions.id });
  return rows.length > 0;
}

/** The user's live sessions, most recently active first. */
export async function listSessions(orm: Orm, userId: string, currentSessionId: string): Promise<SessionDto[]> {
  const rows = await orm
    .select({ id: sessions.id, label: sessions.label, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), gt(sessions.expiresAt, sql`now()`)))
    .orderBy(desc(sessions.lastSeenAt));
  return rows.map((r) => ({
    id: r.id,
    label: r.label ?? "Unknown device",
    current: r.id === currentSessionId,
    createdAt: r.createdAt.toISOString(),
    lastSeenAt: r.lastSeenAt.toISOString(),
  }));
}
