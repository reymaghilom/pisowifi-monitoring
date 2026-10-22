/* Monitoring history. Time-series tables are append-only and indexed (machine, time DESC) for
   "latest N for a machine" and range scans; BRIN on time keeps retention deletes cheap.
   Volume estimate: 1 check/min/machine ≈ 525k rows/machine/year; checks are pruned after 90 days (B8),
   hourly rollups and events are kept for reports. */
import { sql } from "drizzle-orm";
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { checkErrorKind, checkTrigger, eventType, httpStatus } from "./enums.js";
import { machines } from "./machines.js";

/** Raw admin HTTP checks. */
export const checks = pgTable(
  "checks",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    durationMs: integer("duration_ms"),
    ok: boolean("ok").notNull(),
    httpCode: smallint("http_code"),
    errorKind: checkErrorKind("error_kind"),
    trigger: checkTrigger("trigger").notNull().default("schedule"),
  },
  (t) => [
    index("checks_machine_started_idx").on(t.machineId, t.startedAt.desc()),
    index("checks_started_brin").using("brin", t.startedAt),
    check("checks_duration_nonneg", sql`${t.durationMs} is null or ${t.durationMs} >= 0`),
    check("checks_http_code_range", sql`${t.httpCode} is null or ${t.httpCode} between 100 and 599`),
    // A successful check has no error; a failed one says why.
    check("checks_ok_xor_error", sql`(${t.ok} and ${t.errorKind} is null) or (not ${t.ok} and ${t.errorKind} is not null)`),
  ],
);

/** Event log (outage, recovery, stale, error, system, check). machine_id is null for workspace-level events. */
export const events = pgTable(
  "events",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    machineId: uuid("machine_id").references(() => machines.id, { onDelete: "cascade" }),
    type: eventType("type").notNull(),
    /** Machine status the event refers to; null for system events. */
    status: httpStatus("status"),
    message: text("message").notNull(),
    meta: jsonb("meta").notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("events_occurred_idx").on(t.occurredAt.desc()),
    index("events_machine_occurred_idx").on(t.machineId, t.occurredAt.desc()),
    index("events_type_occurred_idx").on(t.type, t.occurredAt.desc()),
    check("events_message_len", sql`char_length(${t.message}) between 1 and 500`),
    check("events_machine_unless_system", sql`${t.type} = 'system' or ${t.machineId} is not null`),
  ],
);

/** Outage intervals (from the first failed check past the threshold to the recovery). */
export const outages = pgTable(
  "outages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** null while the outage is ongoing */
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    index("outages_machine_started_idx").on(t.machineId, t.startedAt.desc()),
    // At most one open outage per machine.
    uniqueIndex("outages_one_open_per_machine").on(t.machineId).where(sql`${t.endedAt} is null`),
    check("outages_end_after_start", sql`${t.endedAt} is null or ${t.endedAt} > ${t.startedAt}`),
  ],
);

/** Hourly aggregates for charts and reports (24 h … 30 d ranges read these, not raw checks). */
export const checkRollupsHourly = pgTable(
  "check_rollups_hourly",
  {
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    /** Start of the UTC hour. */
    bucketStart: timestamp("bucket_start", { withTimezone: true }).notNull(),
    checks: integer("checks").notNull().default(0),
    okCount: integer("ok_count").notNull().default(0),
    avgResponseMs: integer("avg_response_ms"),
    downSeconds: integer("down_seconds").notNull().default(0),
  },
  (t) => [
    primaryKey({ name: "check_rollups_hourly_pkey", columns: [t.machineId, t.bucketStart] }),
    index("check_rollups_hourly_bucket_idx").on(t.bucketStart),
    check("rollups_counts_valid", sql`${t.checks} >= 0 and ${t.okCount} between 0 and ${t.checks}`),
    check("rollups_down_seconds_range", sql`${t.downSeconds} between 0 and 3600`),
    check("rollups_avg_nonneg", sql`${t.avgResponseMs} is null or ${t.avgResponseMs} >= 0`),
    // Buckets are whole UTC hours.
    check("rollups_bucket_on_hour", sql`extract(epoch from ${t.bucketStart})::bigint % 3600 = 0`),
  ],
);
