/* Status-change notifications sent by the API to an n8n webhook (n8n then sends the Gmail message).
   Two events only, both from a verified transition recorded by the backend: a machine went Offline, or is Back
   Online. The email (subject, text) says "Offline" / "Back Online"; event names keep the internal reachable /
   unreachable values, and `status` / `previousStatus` keep their original contract values (Reachable / Unreachable).
   Each event lists its recipients (resolved by the backend). No reports, no causes. Times are given in UTC and in
   Asia/Manila (UTC+8). A Back Online event carries the outage start and downtime when the backend has an outage record. */
import { z } from "zod";
import { isoDateTimeSchema } from "./api.js";

export const NOTIFICATION_EVENTS = ["machine.unreachable", "machine.reachable"] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

export const NOTIFICATION_TIME_ZONE = "Asia/Manila";

/** Upper bound on recipients per event (the backend resolves them; today: every active account). */
export const NOTIFICATION_MAX_RECIPIENTS = 20;

/** One email recipient, resolved by the backend when the change is recorded. `id` is the user's UUID: n8n tracks
    delivery per (eventId, recipient id) and never stores the address. */
export const notificationRecipientSchema = z.object({ id: z.uuid(), email: z.email().max(254) });
export type NotificationRecipient = z.infer<typeof notificationRecipientSchema>;

/** JSON body of the webhook request. `eventId` is stable across retries: use it to drop duplicates in n8n. */
export const notificationPayloadSchema = z.object({
  eventId: z.uuid(),
  event: z.enum(NOTIFICATION_EVENTS),
  /** ZeroTier IP the machine was checked at. */
  machine: z.object({ id: z.uuid(), name: z.string().min(1), ip: z.string().min(1) }),
  /** Current status. Contract values, unchanged for existing n8n workflows; the app shows them as Offline / Online. */
  status: z.enum(["Unreachable", "Reachable"]),
  previousStatus: z.enum(["Reachable", "Unreachable"]),
  /** When the backend recorded the change (UTC). */
  detectedAt: isoDateTimeSchema,
  /** Same moment in Asia/Manila, ready to print: "October 12, 2026" and "8:44 PM". */
  detectedDate: z.string(),
  detectedTime: z.string(),
  timeZone: z.literal(NOTIFICATION_TIME_ZONE),
  utcOffset: z.literal("+08:00"),
  /** Ready-made email subject and plain-text body (n8n may use them as-is). */
  subject: z.string(),
  text: z.string(),
  /** Who receives this alert; fixed at the time of the change so every retry targets the same people. */
  recipients: z
    .array(notificationRecipientSchema)
    .min(1)
    .max(NOTIFICATION_MAX_RECIPIENTS)
    .refine((r) => new Set(r.map((x) => x.id)).size === r.length, "recipient ids must be unique"),
  /** Back Online only: start of the outage that just ended (UTC), read from the backend's outage record in the same
      transaction. Absent when no open outage record existed; never estimated. */
  outageStartedAt: isoDateTimeSchema.optional(),
  /** Back Online only: whole seconds from outageStartedAt to detectedAt. Present exactly when outageStartedAt is. */
  downtimeSeconds: z.number().int().nonnegative().optional(),
}).refine(
  (p) => (p.outageStartedAt === undefined) === (p.downtimeSeconds === undefined) && (p.event === "machine.reachable" || p.outageStartedAt === undefined),
  "outageStartedAt and downtimeSeconds come together, and only with machine.reachable",
);
export type NotificationPayload = z.infer<typeof notificationPayloadSchema>;
