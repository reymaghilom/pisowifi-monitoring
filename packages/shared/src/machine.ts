/* Machine model, statuses and validation shared by the web app and the API.
   Messages are the approved UI copy; changing one changes what the Add/Edit form shows. */
import { z } from "zod";
import { isoDateTimeSchema } from "./api.js";

/* ---------- statuses (each one is shown as a word + icon + colour in the UI) ---------- */

/** Admin HTTP check state of a machine, as stored. "stale" and "error" are kept for stored-data compatibility only:
 *  checks now record "reachable" or "unreachable", and "unknown" means no valid check yet. */
export const MACHINE_STATUSES = ["reachable", "stale", "unreachable", "unknown", "error"] as const;
export const machineStatusSchema = z.enum(MACHINE_STATUSES);
export type MachineStatus = z.infer<typeof machineStatusSchema>;

/** The only two connectivity statuses users see. */
export const CONNECTIVITY_STATUSES = ["reachable", "unreachable"] as const;
export type Connectivity = (typeof CONNECTIVITY_STATUSES)[number];

/** User-facing connectivity from a stored status: null until a valid check exists (never a guess). */
export function connectivityOf(status: MachineStatus): Connectivity | null {
  return status === "reachable" || status === "unreachable" ? status : null;
}

/** ZeroTier sighting state. Kept separate from admin reachability: a recent sighting proves nothing else. */
export const ZEROTIER_STATES = ["recent", "stale", "unknown"] as const;
export const zeroTierStateSchema = z.enum(ZEROTIER_STATES);
export type ZeroTierState = z.infer<typeof zeroTierStateSchema>;

/** Internet verification. Only "unverified" exists until an internet check is built. */
export const INTERNET_STATES = ["unverified"] as const;
export const internetStateSchema = z.enum(INTERNET_STATES);
export type InternetState = z.infer<typeof internetStateSchema>;

/** Health of the monitor itself (not the machine): ok, paused by an admin, failing to run checks, or never run. */
export const MONITOR_HEALTH_STATES = ["ok", "paused", "error", "unknown"] as const;
export const monitorHealthSchema = z.enum(MONITOR_HEALTH_STATES);
export type MonitorHealth = z.infer<typeof monitorHealthSchema>;

/** Why a check failed. */
export const CHECK_ERROR_KINDS = ["timeout", "refused", "dns", "tls", "http", "monitor"] as const;
export const checkErrorKindSchema = z.enum(CHECK_ERROR_KINDS);
export type CheckErrorKind = z.infer<typeof checkErrorKindSchema>;

/** Database enum values. "Other" is kept for stored data compatibility only: new and edited machines must be WiFi5Soft. */
export const SOFTWARE_TYPES = ["WiFi5Soft", "Other"] as const;
export const softwareTypeSchema = z.enum(SOFTWARE_TYPES);
export type SoftwareType = z.infer<typeof softwareTypeSchema>;
/** Software the app supports (B6 decision): WiFi5Soft only. */
export const SUPPORTED_SOFTWARE = ["WiFi5Soft"] as const;

/* ---------- field rules ---------- */

export const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
export const ZT_NETWORK_ID_PATTERN = /^[0-9a-f]{16}$/i;
/** ZeroTier member (node) address: 10 hex characters. Backend-only, never shown in the Add/Edit UI. */
export const ZT_MEMBER_ID_PATTERN = /^[0-9a-f]{10}$/i;

export const MACHINE_MESSAGES = {
  nameRequired: "Machine name is required",
  nameTaken: "Another machine already uses this name",
  ipRequired: "ZeroTier managed IP is required",
  ipInvalid: "Enter a full IPv4 address, e.g. 192.168.194.82",
  ipTaken: "This IP is already registered",
  pathInvalid: "Admin path must start with /",
  ztNetworkIdInvalid: "Network ID is 16 hex characters",
  ztMemberIdInvalid: "Member ID is 10 hex characters",
  softwareUnsupported: "Only WiFi5Soft machines are supported",
} as const;

/** Per-field limits enforced by the API (generous; the UI never reaches them in normal use). */
export const MACHINE_LIMITS = { name: 64, location: 120, description: 2000, softwareVersion: 40, adminPath: 200, tag: 32, tags: 8 } as const;

const trimmed = z.string().transform((s) => s.trim());

/** Optional text: trimmed, and "" becomes null. */
const optionalTrimmed = (max?: number) =>
  z
    .string()
    .trim()
    .max(max ?? Number.MAX_SAFE_INTEGER)
    .transform((s) => (s === "" ? null : s))
    .nullable()
    .optional();

export const machineNameSchema = trimmed.pipe(z.string().min(1, MACHINE_MESSAGES.nameRequired));
export const ztIpSchema = trimmed.pipe(z.string().min(1, MACHINE_MESSAGES.ipRequired).regex(IPV4_PATTERN, MACHINE_MESSAGES.ipInvalid));
export const adminPathSchema = trimmed.pipe(z.string().startsWith("/", MACHINE_MESSAGES.pathInvalid));
/** Optional; "" means not set. */
export const ztNetworkIdSchema = trimmed.pipe(z.union([z.literal(""), z.string().regex(ZT_NETWORK_ID_PATTERN, MACHINE_MESSAGES.ztNetworkIdInvalid)]));
export const ztMemberIdSchema = trimmed.pipe(z.union([z.literal(""), z.string().regex(ZT_MEMBER_ID_PATTERN, MACHINE_MESSAGES.ztMemberIdInvalid)]));
/** Tags: trimmed, lowercased, de-duplicated, empty ones dropped. */
export const tagsSchema = z
  .array(z.string())
  .transform((tags) => [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))]);

/** Create / update body (API contract). Uniqueness of name and IP is checked against stored machines. */
export const machineInputSchema = z.object({
  name: machineNameSchema.pipe(z.string().max(MACHINE_LIMITS.name)),
  location: optionalTrimmed(MACHINE_LIMITS.location),
  description: optionalTrimmed(MACHINE_LIMITS.description),
  software: z.enum(SUPPORTED_SOFTWARE, MACHINE_MESSAGES.softwareUnsupported).default("WiFi5Soft"),
  softwareVersion: optionalTrimmed(MACHINE_LIMITS.softwareVersion),
  ztNetworkId: ztNetworkIdSchema.transform((v) => (v === "" ? null : v.toLowerCase())).nullable().optional(),
  /** Backend-only (future discovery via the ZeroTier API). Not part of the Add/Edit form. */
  ztMemberId: ztMemberIdSchema.transform((v) => (v === "" ? null : v.toLowerCase())).nullable().optional(),
  ztIp: ztIpSchema,
  adminPath: adminPathSchema.pipe(z.string().max(MACHINE_LIMITS.adminPath)).default("/admin"),
  tags: tagsSchema.pipe(z.array(z.string().max(MACHINE_LIMITS.tag)).max(MACHINE_LIMITS.tags)).default([]),
  monitoringEnabled: z.boolean().default(true),
});
export type MachineInputBody = z.input<typeof machineInputSchema>;
export type MachineInputData = z.output<typeof machineInputSchema>;

/* ---------- API representation ---------- */

/** The four independent signals shown on Machine Details: Admin HTTP, ZeroTier, Internet verification, Monitoring health. */
export const machineStateSchema = z.object({
  http: machineStatusSchema,
  lastCheckAt: isoDateTimeSchema.nullable(),
  lastSuccessAt: isoDateTimeSchema.nullable(),
  zeroTier: zeroTierStateSchema,
  zeroTierLastSeenAt: isoDateTimeSchema.nullable(),
  internet: internetStateSchema,
  monitor: monitorHealthSchema,
  monitoringEnabled: z.boolean(),
});
export type MachineState = z.infer<typeof machineStateSchema>;

export const machineSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  location: z.string().nullable(),
  description: z.string().nullable(),
  software: softwareTypeSchema,
  softwareVersion: z.string().nullable(),
  ztNetworkId: z.string().nullable(),
  ztMemberId: z.string().nullable(),
  ztIp: z.string(),
  adminPath: z.string(),
  tags: z.array(z.string()),
  state: machineStateSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type MachineDto = z.infer<typeof machineSchema>;

/** `GET /machines` query, mirroring the My PisoWiFi toolbar. */
export const MACHINE_SORTS = ["name", "status", "seen", "ip"] as const;
export const machineListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  status: z.union([z.literal("all"), machineStatusSchema]).default("all"),
  sort: z.enum(MACHINE_SORTS).default("name"),
});
export type MachineListQuery = z.infer<typeof machineListQuerySchema>;

/** `GET /machines`. */
export const machineListResponseSchema = z.object({ items: z.array(machineSchema) });
export type MachineListResponse = z.infer<typeof machineListResponseSchema>;

/** `PATCH /machines/:id/monitoring`: pause or resume monitoring (Admin). */
export const machineMonitoringSchema = z.object({ enabled: z.boolean() });
