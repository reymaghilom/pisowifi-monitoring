/* Registered machines and their current state. Limits and formats mirror @pisowifi/shared (machineInputSchema). */
import { sql } from "drizzle-orm";
import { boolean, check, index, inet, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { MACHINE_LIMITS } from "@pisowifi/shared";
import { httpStatus, internetState, monitorHealth, softwareType, zerotierState } from "./enums.js";
import { users } from "./auth.js";

const L = MACHINE_LIMITS;

export const machines = pgTable(
  "machines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    location: text("location"),
    description: text("description"),
    software: softwareType("software").notNull().default("WiFi5Soft"),
    softwareVersion: text("software_version"),
    /** Optional ZeroTier network ID (16 lowercase hex). */
    ztNetworkId: text("zt_network_id"),
    /** Optional ZeroTier member address (10 lowercase hex). Backend-only: not shown in the Add/Edit UI;
     *  reserved for future automatic discovery through the ZeroTier API. */
    ztMemberId: text("zt_member_id"),
    /** ZeroTier managed IPv4 address the monitor checks. */
    ztIp: inet("zt_ip").notNull(),
    adminPath: text("admin_path").notNull().default("/admin"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    monitoringEnabled: boolean("monitoring_enabled").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("machines_name_lower_key").on(sql`lower(${t.name})`),
    uniqueIndex("machines_zt_ip_key").on(t.ztIp),
    // A member address is unique within its network.
    uniqueIndex("machines_zt_member_key").on(t.ztNetworkId, t.ztMemberId).where(sql`${t.ztMemberId} is not null`),
    check("machines_name_valid", sql`char_length(${t.name}) between 1 and ${sql.raw(String(L.name))} and ${t.name} = btrim(${t.name})`),
    check("machines_location_len", sql`${t.location} is null or char_length(${t.location}) <= ${sql.raw(String(L.location))}`),
    check("machines_description_len", sql`${t.description} is null or char_length(${t.description}) <= ${sql.raw(String(L.description))}`),
    check("machines_version_len", sql`${t.softwareVersion} is null or char_length(${t.softwareVersion}) <= ${sql.raw(String(L.softwareVersion))}`),
    check("machines_zt_network_id_format", sql`${t.ztNetworkId} is null or ${t.ztNetworkId} ~ '^[0-9a-f]{16}$'`),
    check("machines_zt_member_id_format", sql`${t.ztMemberId} is null or ${t.ztMemberId} ~ '^[0-9a-f]{10}$'`),
    check("machines_zt_member_needs_network", sql`${t.ztMemberId} is null or ${t.ztNetworkId} is not null`),
    // A single IPv4 host address (no IPv6, no CIDR ranges).
    check("machines_zt_ip_ipv4_host", sql`family(${t.ztIp}) = 4 and masklen(${t.ztIp}) = 32`),
    check("machines_admin_path_format", sql`left(${t.adminPath}, 1) = '/' and char_length(${t.adminPath}) <= ${sql.raw(String(L.adminPath))}`),
    check("machines_tags_limit", sql`cardinality(${t.tags}) <= ${sql.raw(String(L.tags))}`),
  ],
);

/** One row per machine: the four independent signals shown on Machine Details. Written by the monitor (B8). */
export const machineState = pgTable(
  "machine_state",
  {
    machineId: uuid("machine_id")
      .primaryKey()
      .references(() => machines.id, { onDelete: "cascade" }),
    /** 1. Admin HTTP reachability */
    httpStatus: httpStatus("http_status").notNull().default("unknown"),
    lastCheckAt: timestamp("last_check_at", { withTimezone: true }),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** 2. ZeroTier sighting (never proof of internet access) */
    ztState: zerotierState("zt_state").notNull().default("unknown"),
    ztLastSeenAt: timestamp("zt_last_seen_at", { withTimezone: true }),
    /** 3. Internet verification */
    internetState: internetState("internet_state").notNull().default("unverified"),
    internetCheckedAt: timestamp("internet_checked_at", { withTimezone: true }),
    /** 4. Monitoring health (the monitor itself, not the machine) */
    monitorHealth: monitorHealth("monitor_health").notNull().default("unknown"),
    monitorError: text("monitor_error"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("machine_state_http_status_idx").on(t.httpStatus),
    check("machine_state_failures_nonneg", sql`${t.consecutiveFailures} >= 0`),
    check("machine_state_success_not_after_check", sql`${t.lastSuccessAt} is null or (${t.lastCheckAt} is not null and ${t.lastSuccessAt} <= ${t.lastCheckAt})`),
    check("machine_state_monitor_error_len", sql`${t.monitorError} is null or char_length(${t.monitorError}) <= 500`),
  ],
);
