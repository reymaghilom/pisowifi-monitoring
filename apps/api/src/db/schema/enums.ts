/* Postgres enums, generated from the shared contracts so the database and API can't drift apart. */
import { customType, pgEnum } from "drizzle-orm/pg-core";
import {
  CHECK_ERROR_KINDS,
  EVENT_TYPES,
  INTERNET_STATES,
  MACHINE_STATUSES,
  MONITOR_HEALTH_STATES,
  ROLES,
  SOFTWARE_TYPES,
  ZEROTIER_STATES,
} from "@pisowifi/shared";

export const userRole = pgEnum("user_role", ROLES);
export const softwareType = pgEnum("software_type", SOFTWARE_TYPES);
/** Admin HTTP check result. */
export const httpStatus = pgEnum("http_status", MACHINE_STATUSES);
/** ZeroTier sighting (separate from admin reachability). */
export const zerotierState = pgEnum("zerotier_state", ZEROTIER_STATES);
/** Internet verification (separate; only "unverified" until an internet check exists). */
export const internetState = pgEnum("internet_state", INTERNET_STATES);
/** Health of the monitor itself (separate from the machine's state). */
export const monitorHealth = pgEnum("monitor_health", MONITOR_HEALTH_STATES);
export const eventType = pgEnum("event_type", EVENT_TYPES);
export const checkTrigger = pgEnum("check_trigger", ["schedule", "manual"]);
export const checkErrorKind = pgEnum("check_error_kind", CHECK_ERROR_KINDS);
/** Status-change notification (n8n → Gmail): the status the machine changed to. */
export const notificationKind = pgEnum("notification_kind", ["unreachable", "reachable"]);
/** Webhook delivery state of a notification. */
export const deliveryStatus = pgEnum("delivery_status", ["pending", "sending", "sent", "failed"]);

/** Raw bytes (SHA-256 digests, encrypted secrets). Drizzle has no built-in bytea column. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});
