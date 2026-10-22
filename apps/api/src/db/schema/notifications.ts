/* Notification outbox (n8n → Gmail). A row is written in the same transaction as the verified status change it
   reports (events.type outage | recovery), so a change is never lost and never queued twice: one row per event
   (unique). The row id is the event ID sent to n8n, stable across retries, so n8n can drop duplicates too.
   Delivery state lives here, so retries survive restarts and several API instances can share the work. */
import { sql } from "drizzle-orm";
import { bigint, check, index, integer, jsonb, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { deliveryStatus, notificationKind } from "./enums.js";
import { machines } from "./machines.js";
import { events } from "./monitoring.js";

export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    /** Event ID sent to n8n (X-PisoWiFi-Event-Id and payload.eventId). */
    id: uuid("id").primaryKey(),
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    machineId: uuid("machine_id")
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    kind: notificationKind("kind").notNull(),
    /** Exact JSON body sent to the webhook (snapshot at detection time). */
    payload: jsonb("payload").notNull(),
    status: deliveryStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    /** While "sending": after this time another dispatcher may take the row over (crash recovery). */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    /** Short reason of the last failed attempt ("HTTP 404", "timeout"). Never a URL, header or secret. */
    lastError: text("last_error"),
    lastHttpStatus: smallint("last_http_status"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("notification_deliveries_event_key").on(t.eventId),
    index("notification_deliveries_due_idx").on(t.status, t.nextAttemptAt),
    index("notification_deliveries_machine_created_idx").on(t.machineId, t.createdAt.desc()),
    check("notification_deliveries_attempts_nonneg", sql`${t.attempts} >= 0`),
    check("notification_deliveries_last_error_len", sql`${t.lastError} is null or char_length(${t.lastError}) <= 200`),
    check("notification_deliveries_sent_has_time", sql`(${t.status} = 'sent') = (${t.sentAt} is not null)`),
  ],
);
