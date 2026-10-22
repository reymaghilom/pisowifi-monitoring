/* Workspace monitoring settings (single row) and per-user notification preferences. */
import { sql } from "drizzle-orm";
import { boolean, check, integer, pgTable, smallint, timestamp, uuid } from "drizzle-orm/pg-core";
import { CHECK_INTERVALS } from "@pisowifi/shared";
import { users } from "./auth.js";

export const monitoringSettings = pgTable(
  "monitoring_settings",
  {
    /** Always 1: one settings row for the single workspace. */
    id: smallint("id").primaryKey().default(1),
    intervalSeconds: integer("interval_seconds").notNull().default(60),
    timeoutSeconds: integer("timeout_seconds").notNull().default(5),
    /** Missed checks before a machine becomes Stale. */
    staleThreshold: integer("stale_threshold").notNull().default(3),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check("monitoring_settings_singleton", sql`${t.id} = 1`),
    check("monitoring_settings_interval", sql`${t.intervalSeconds} in (${sql.raw(CHECK_INTERVALS.join(", "))})`),
    check("monitoring_settings_timeout", sql`${t.timeoutSeconds} between 1 and 30`),
    check("monitoring_settings_threshold", sql`${t.staleThreshold} between 1 and 10`),
  ],
);

export const notificationPrefs = pgTable("notification_prefs", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  offline: boolean("offline").notNull().default(true),
  recovery: boolean("recovery").notNull().default(true),
  email: boolean("email").notNull().default(false),
  telegram: boolean("telegram").notNull().default(false),
  quietHours: boolean("quiet_hours").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
