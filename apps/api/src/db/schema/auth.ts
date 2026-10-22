/* Users, sessions and other credential material (email + password sign-in, no second factor; logic in src/auth/).
   Secrets are never stored in plain form:
   - passwords: Argon2id hash (text, PHC string)
   - session / reset tokens: SHA-256 digest of a random value (32-byte bytea) */
import { sql } from "drizzle-orm";
import { boolean, check, index, inet, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, bigint, type AnyPgColumn } from "drizzle-orm/pg-core";
import { bytea, userRole } from "./enums.js";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    passwordHash: text("password_hash").notNull(),
    /** Single workspace: admin (manages machines and settings) or viewer (read-only). */
    role: userRole("role").notNull().default("viewer"),
    failedLoginCount: integer("failed_login_count").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    /** Deactivated by an Administrator (RBAC-1): no sign-in, no sessions, no reset links. Null = active.
     *  Migration 0005 also adds a trigger that always keeps at least one active admin while any account exists. */
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    disabledBy: uuid("disabled_by").references((): AnyPgColumn => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("users_disabled_by_needs_disabled_at", sql`${t.disabledBy} is null or ${t.disabledAt} is not null`),
    // Case-insensitive uniqueness without the citext extension.
    uniqueIndex("users_email_lower_key").on(sql`lower(${t.email})`),
    check("users_email_format", sql`${t.email} ~ '^[^@[:space:]]+@[^@[:space:]]+\\.[^@[:space:]]+$' and char_length(${t.email}) <= 254`),
    check("users_display_name_len", sql`char_length(btrim(${t.displayName})) between 1 and 80`),
    check("users_password_hash_nonempty", sql`char_length(${t.passwordHash}) > 0`),
    check("users_failed_logins_nonneg", sql`${t.failedLoginCount} >= 0`),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the opaque cookie token. The token itself is never stored. */
    tokenHash: bytea("token_hash").notNull(),
    remember: boolean("remember").notNull().default(false),
    ip: inet("ip"),
    userAgent: text("user_agent"),
    label: text("label"),
    createdAt: createdAt(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("sessions_token_hash_key").on(t.tokenHash),
    index("sessions_user_active_idx").on(t.userId).where(sql`${t.revokedAt} is null`),
    index("sessions_expires_at_idx").on(t.expiresAt),
    check("sessions_token_hash_len", sql`octet_length(${t.tokenHash}) = 32`),
    check("sessions_expiry_after_creation", sql`${t.expiresAt} > ${t.createdAt}`),
    check("sessions_user_agent_len", sql`${t.userAgent} is null or char_length(${t.userAgent}) <= 512`),
  ],
);

export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: bytea("token_hash").notNull(),
    requestedIp: inet("requested_ip"),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("password_reset_tokens_token_hash_key").on(t.tokenHash),
    index("password_reset_tokens_user_idx").on(t.userId),
    check("password_reset_tokens_hash_len", sql`octet_length(${t.tokenHash}) = 32`),
    check("password_reset_tokens_expiry", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    /** Kept when the user is deleted (set null) so the trail survives. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: inet("ip"),
    meta: jsonb("meta").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    index("audit_log_created_at_idx").on(t.createdAt.desc()),
    index("audit_log_user_created_idx").on(t.userId, t.createdAt.desc()),
    check("audit_log_action_nonempty", sql`char_length(${t.action}) between 1 and 100`),
  ],
);
