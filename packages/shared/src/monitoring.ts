/* Monitoring events, history series and monitoring settings. */
import { z } from "zod";
import { isoDateTimeSchema } from "./api.js";
import { machineStatusSchema } from "./machine.js";

export const EVENT_TYPES = ["outage", "recovery", "stale", "error", "system", "check"] as const;
export const eventTypeSchema = z.enum(EVENT_TYPES);
export type EventType = z.infer<typeof eventTypeSchema>;

export const monitoringEventSchema = z.object({
  id: z.string(),
  /** null for workspace-level (system) events */
  machineId: z.uuid().nullable(),
  type: eventTypeSchema,
  status: z.union([machineStatusSchema, z.literal("system")]),
  message: z.string(),
  occurredAt: isoDateTimeSchema,
  /** outage duration in minutes, when known */
  durationMinutes: z.number().nonnegative().optional(),
});
export type MonitoringEventDto = z.infer<typeof monitoringEventSchema>;

/** Chart ranges: last 24 hours (hourly buckets) or N days (daily buckets). */
export const HISTORY_RANGES = ["24", "7", "14", "30", "custom"] as const;
export const historyRangeSchema = z.enum(HISTORY_RANGES);
export type HistoryRange = z.infer<typeof historyRangeSchema>;

export const seriesQuerySchema = z
  .object({
    range: historyRangeSchema.default("14"),
    metric: z.enum(["uptime", "rt"]).default("uptime"),
    from: z.iso.date().optional(),
    to: z.iso.date().optional(),
  })
  .refine((q) => q.range !== "custom" || (q.from && q.to), { message: "Custom ranges need from and to dates", path: ["from"] });
export type SeriesQuery = z.infer<typeof seriesQuerySchema>;

export const historyPointSchema = z.object({
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  label: z.string(),
  uptimePercent: z.number().min(0).max(100),
  avgResponseMs: z.number().nonnegative().nullable(),
  downMinutes: z.number().nonnegative(),
  outages: z.number().int().nonnegative(),
});
export type HistoryPointDto = z.infer<typeof historyPointSchema>;

/* ---------- monitoring history from recorded checks (GET /history) ----------
   Everything is measured: uptime is the share of valid checks that reached the machine, downtime comes from
   recorded outages, and a time slot without any valid check is "none" (not checked), never assumed Reachable. */

export const HISTORY_MAX_DAYS = 31;
export const HISTORY_MAX_BUCKETS = 48;
/** Slots in the status timeline strip. */
export const TIMELINE_SLOTS = 48;
export const HISTORY_RECENT_CHECKS = 20;
export const HISTORY_MAX_EVENTS = 500;

/** The client sends the exact window (it knows the viewer's local day boundaries); the API buckets it evenly. */
export const historyQuerySchema = z
  .object({
    from: isoDateTimeSchema,
    to: isoDateTimeSchema,
    buckets: z.coerce.number().int().min(1).max(HISTORY_MAX_BUCKETS).default(24),
    machine: z.uuid().optional(),
  })
  .refine((q) => Date.parse(q.to) > Date.parse(q.from), { message: "The end must be after the start", path: ["to"] })
  .refine((q) => Date.parse(q.to) - Date.parse(q.from) <= HISTORY_MAX_DAYS * 86_400_000, {
    message: `Choose a range of at most ${HISTORY_MAX_DAYS} days`,
    path: ["from"],
  });
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

export const historyBucketSchema = z.object({
  start: isoDateTimeSchema,
  end: isoDateTimeSchema,
  checks: z.number().int().nonnegative(),
  okChecks: z.number().int().nonnegative(),
  /** null when the slot has no valid check */
  uptimePercent: z.number().min(0).max(100).nullable(),
  /** average response of checks that reached the machine; null when none did */
  avgResponseMs: z.number().nonnegative().nullable(),
  downMinutes: z.number().nonnegative(),
});
export type HistoryBucketDto = z.infer<typeof historyBucketSchema>;

/** ok: every valid check reached the machine · bad: at least one did not · none: no valid check */
export const timelineStateSchema = z.enum(["ok", "bad", "none"]);
export type TimelineState = z.infer<typeof timelineStateSchema>;

export const historyCheckSchema = z.object({
  startedAt: isoDateTimeSchema,
  ok: z.boolean(),
  httpCode: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
});
export type HistoryCheckDto = z.infer<typeof historyCheckSchema>;

export const historyMachineSchema = z.object({
  machineId: z.uuid(),
  totals: z.object({
    checks: z.number().int().nonnegative(),
    okChecks: z.number().int().nonnegative(),
    uptimePercent: z.number().min(0).max(100).nullable(),
    avgResponseMs: z.number().nonnegative().nullable(),
    downMinutes: z.number().nonnegative(),
    outages: z.number().int().nonnegative(),
    lastSuccessAt: isoDateTimeSchema.nullable(),
  }),
  points: z.array(historyBucketSchema),
  timeline: z.array(timelineStateSchema),
  /** newest first, within the window */
  recentChecks: z.array(historyCheckSchema),
});
export type HistoryMachineDto = z.infer<typeof historyMachineSchema>;

export const historyOutageSchema = z.object({
  machineId: z.uuid(),
  startedAt: isoDateTimeSchema,
  /** null while ongoing */
  endedAt: isoDateTimeSchema.nullable(),
  durationMinutes: z.number().nonnegative(),
});
export type HistoryOutageDto = z.infer<typeof historyOutageSchema>;

export const historyResponseSchema = z.object({
  from: isoDateTimeSchema,
  to: isoDateTimeSchema,
  generatedAt: isoDateTimeSchema,
  machines: z.array(historyMachineSchema),
  /** status changes (outage / recovery) in the window, newest first */
  events: z.array(monitoringEventSchema),
  /** outages overlapping the window, newest first */
  outages: z.array(historyOutageSchema),
});
export type HistoryResponse = z.infer<typeof historyResponseSchema>;

/* ---------- monitoring settings (Settings → Monitoring) ---------- */

export const CHECK_INTERVALS = [30, 60, 300, 900] as const;
export const MONITORING_MESSAGES = {
  timeout: "Enter a whole number from 1 to 30",
  threshold: "Enter a whole number from 1 to 10",
} as const;

const wholeNumber = (min: number, max: number, message: string) =>
  z.coerce.number({ error: message }).int({ error: message }).min(min, { error: message }).max(max, { error: message });

export const monitoringSettingsSchema = z.object({
  intervalSeconds: z.coerce.number().refine((n) => (CHECK_INTERVALS as readonly number[]).includes(n), "Choose 30, 60, 300 or 900 seconds"),
  timeoutSeconds: wholeNumber(1, 30, MONITORING_MESSAGES.timeout),
  /** Missed checks before a machine becomes Stale. */
  staleThreshold: wholeNumber(1, 10, MONITORING_MESSAGES.threshold),
});
export type MonitoringSettings = z.infer<typeof monitoringSettingsSchema>;
