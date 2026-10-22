/* Webhook payload for a verified status change (see @pisowifi/shared notifications.ts). Built once, when the change
   is recorded, and stored with the delivery, so every retry sends exactly the same body. No causes are guessed. */
import { NOTIFICATION_TIME_ZONE, type NotificationPayload, type NotificationRecipient } from "@pisowifi/shared";

export type StatusKind = "unreachable" | "reachable";

const dateFmt = new Intl.DateTimeFormat("en-US", { timeZone: NOTIFICATION_TIME_ZONE, year: "numeric", month: "long", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat("en-US", { timeZone: NOTIFICATION_TIME_ZONE, hour: "numeric", minute: "2-digit", hour12: true });

/** "October 12, 2026" and "8:44 PM" in Asia/Manila (UTC+8, no daylight saving). */
export function manilaDateTime(at: Date) {
  return { date: dateFmt.format(at), time: timeFmt.format(at) };
}

/** "less than 1 minute", "15 minutes", "1 hour 5 minutes", "2 days 3 hours". Whole minutes, rounded down. The n8n v4
    workflow formats downtimeSeconds the same way. */
export function formatDowntime(seconds: number) {
  if (seconds < 60) return "less than 1 minute";
  const minutes = Math.floor(seconds / 60);
  const parts: [number, string][] = [[Math.floor(minutes / 1440), "day"], [Math.floor((minutes % 1440) / 60), "hour"], [minutes % 60, "minute"]];
  return parts.filter(([n]) => n > 0).map(([n, unit]) => `${n} ${unit}${n === 1 ? "" : "s"}`).join(" ");
}

export function buildPayload(input: {
  eventId: string;
  kind: StatusKind;
  machine: { id: string; name: string; ip: string };
  detectedAt: Date;
  recipients: NotificationRecipient[];
  /** Back Online only: start of the open outage record this change closes (null when there was none). */
  outageStartedAt?: Date | null;
}): NotificationPayload {
  const { eventId, kind, machine, detectedAt, recipients } = input;
  const { date, time } = manilaDateTime(detectedAt);
  const down = kind === "unreachable";
  // Downtime only from the backend's own outage record, never estimated; a clock step backwards drops it.
  const started = !down && input.outageStartedAt ? input.outageStartedAt : null;
  const downtimeSeconds = started ? Math.floor((detectedAt.getTime() - started.getTime()) / 1000) : null;
  const downtime = started && downtimeSeconds !== null && downtimeSeconds >= 0 ? { outageStartedAt: started.toISOString(), downtimeSeconds } : null;
  // `status` / `previousStatus` keep their webhook-contract values (Reachable / Unreachable) so existing n8n workflows
  // keep working. The email itself (subject, text) says Online / Offline / Back Online.
  const status = down ? "Unreachable" : "Reachable";
  return {
    eventId,
    event: down ? "machine.unreachable" : "machine.reachable",
    machine: { id: machine.id, name: machine.name, ip: machine.ip },
    status,
    previousStatus: down ? "Reachable" : "Unreachable",
    detectedAt: detectedAt.toISOString(),
    detectedDate: date,
    detectedTime: time,
    timeZone: NOTIFICATION_TIME_ZONE,
    utcOffset: "+08:00",
    subject: down ? `[PisoWiFi Alert] ${machine.name} is Offline` : `[PisoWiFi Recovery] ${machine.name} is Back Online`,
    text: [
      down ? `${machine.name} is Offline.` : `${machine.name} is Back Online.`,
      "",
      `Machine: ${machine.name}`,
      `Previous Status: ${down ? "Online" : "Offline"}`,
      `Current Status: ${down ? "Offline" : "Online"}`,
      `${down ? "Detected" : "Recovered"}: ${date}, ${time} (Asia/Manila)`,
      ...(downtime ? [`Downtime: ${formatDowntime(downtime.downtimeSeconds)}`] : []),
      "",
      `Event ID: ${eventId}`,
    ].join("\n"),
    recipients: recipients.map((r) => ({ id: r.id, email: r.email })),
    ...(downtime ?? {}),
  };
}
