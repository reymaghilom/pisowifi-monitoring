import type { Permission } from "@pisowifi/shared";
import type { IconName } from "@/components/ui/icon";
import type { EventType, MachineStatus, Range, StatusKey } from "@/lib/types";

export const APP_NAME = "PisoWiFi Monitoring";

/** Remote Administration path. Only explicit "direct" or "gateway" enables an access flow.
 *  Missing and unrecognized values fail closed. The API still decides who gets a gateway ticket. */
export const REMOTE_MODE: "disabled" | "direct" | "gateway" =
  process.env.NEXT_PUBLIC_REMOTE_MODE === "direct" || process.env.NEXT_PUBLIC_REMOTE_MODE === "gateway"
    ? process.env.NEXT_PUBLIC_REMOTE_MODE
    : "disabled";

export type RouteKey = "dash" | "machines" | "detail" | "remote" | "history" | "auto" | "users" | "settings";

/** Navigation order, icons, labels, header titles and subtitles, from the prototype. `perm`: shown only to roles that
 *  hold it (shared RBAC map); the API enforces the same permission on everything behind the page. */
export const NAV: { key: RouteKey; icon: IconName; label: string; href: string; title: string; subtitle: string; perm?: Permission }[] = [
  { key: "dash", icon: "dashboard", label: "Dashboard", href: "/dashboard", title: "Dashboard", subtitle: "Overview of your registered PisoWiFi machines" },
  { key: "machines", icon: "server", label: "My PisoWiFi", href: "/machines", title: "My PisoWiFi", subtitle: "Register, edit and review machines" },
  { key: "detail", icon: "pulse", label: "Machine Details", href: "/machines", title: "Machine Details", subtitle: "Status, history and actions" },
  {
    key: "remote",
    icon: "shield",
    label: "Remote Administration",
    href: "/remote",
    title: "Remote Administration",
    subtitle: REMOTE_MODE === "gateway" ? "Securely manage your PisoWiFi machines through the Remote Admin Gateway." : REMOTE_MODE === "direct" ? "Direct access through your own ZeroTier connection" : "Remote access is unavailable",
  },
  { key: "history", icon: "history", label: "Monitoring History", href: "/history", title: "Monitoring History", subtitle: "Checks, outages and events" },
  { key: "auto", icon: "zap", label: "Notifications & Automations", href: "/automations", title: "Notifications & Automations", subtitle: "Manage connectivity alerts and monitor notification delivery.", perm: "settings:manage" },
  { key: "users", icon: "users", label: "Manage Users", href: "/users", title: "Manage Users", subtitle: "Accounts, roles and access", perm: "users:manage" },
  { key: "settings", icon: "settings", label: "Settings", href: "/settings", title: "Settings", subtitle: "Account, monitoring and integrations" },
];

export function routeKeyFor(pathname: string): RouteKey {
  if (pathname === "/machines") return "machines";
  if (pathname.startsWith("/machines/")) return "detail";
  if (pathname.startsWith("/remote")) return "remote";
  if (pathname.startsWith("/history")) return "history";
  if (pathname.startsWith("/automations")) return "auto";
  if (pathname.startsWith("/users")) return "users";
  if (pathname.startsWith("/settings")) return "settings";
  return "dash";
}

export type Tone = "ok" | "bad" | "warn" | "info" | "mute";

/** Status vocabulary: tone, icon, default word. Never colour alone. */
export const STATUS: Record<StatusKey, [Tone, IconName, string]> = {
  reachable: ["ok", "check", "Online"],
  unreachable: ["bad", "x", "Offline"],
  soon: ["mute", "clock", "Coming Soon"],
  notconn: ["mute", "link", "Not Connected Yet"],
  demo: ["info", "info", "Demo data"],
  sample: ["info", "info", "Sample data"],
  proto: ["warn", "info", "Prototype only"],
  enabled: ["ok", "check", "Enabled"],
  paused: ["mute", "pause", "Paused"],
  failed: ["bad", "x", "Failed"],
  nodata: ["mute", "info", "Not enough checks"],
};

export const STATUS_LABEL: Record<MachineStatus, string> = {
  reachable: "Online",
  unreachable: "Offline",
};

/** Shown instead of a status until a machine has a valid check: neutral text, not a third status. */
export const NO_RESULT = "Not checked yet";
/** Tooltip for NO_RESULT. */
export const NO_RESULT_LABEL = "No valid check yet, so no status is shown";

export const EVICON: Record<EventType, [Tone, IconName]> = {
  outage: ["bad", "x"],
  recovery: ["ok", "check"],
  check: ["info", "refresh"],
};

export const EVLABEL: Record<EventType, string> = {
  outage: "Offline",
  recovery: "Online",
  check: "Demo check",
};

export const RANGES: [Range, string][] = [
  ["24", "24 h"],
  ["7", "7 d"],
  ["14", "14 d"],
  ["30", "30 d"],
];

/** Demo presets used when a machine's state is set: minutes since the last valid check / last Online result. */
export const STATUS_PRESETS: Record<MachineStatus, { checked: number; ok: number }> = {
  reachable: { checked: 1, ok: 1 },
  unreachable: { checked: 2, ok: 25 },
};

/** The two planned Gmail notifications. Nothing else is planned for n8n. */
export type RuleKey = "outage" | "recovery";

export const RULES: Record<RuleKey, { icon: IconName; title: string; desc: string; flow: string }> = {
  outage: {
    icon: "alert",
    title: "Offline alert",
    desc: "Gmail alert when a machine goes from Online to Offline",
    flow: "Trigger: status changes Online → Offline · Action: send one Gmail message · No repeat while it stays Offline",
  },
  recovery: {
    icon: "check",
    title: "Recovery notification",
    desc: "Gmail notification when a machine goes from Offline to Online",
    flow: "Trigger: status changes Offline → Online · Action: send one Gmail message · No repeat while it stays Online",
  },
};

/** Sample execution rows. No workflow has ever run. */
export const EXEC: { rule: RuleKey; name: string; result: "failed" | "skipped"; reason: string; when: string }[] = [
  { rule: "outage", name: "Offline alert", result: "failed", reason: "Gmail not connected", when: "2 h ago" },
  { rule: "recovery", name: "Recovery notification", result: "failed", reason: "Gmail not connected", when: "2 h ago" },
  { rule: "recovery", name: "Recovery notification", result: "skipped", reason: "Rule disabled", when: "Yesterday" },
  { rule: "outage", name: "Offline alert", result: "failed", reason: "n8n webhook not configured", when: "3 days ago" },
];

/** Sample Gmail messages, laid out like the backend's notification payload (apps/api/src/notifications/payload.ts):
 *  subject, first line, machine, IP, status and the Asia/Manila date and time. No causes are guessed. */
export function msgPreview(rule: RuleKey, machineName = "PisoWiFi 01", ip = "192.168.194.82", now = Date.now()) {
  const date = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", year: "numeric", month: "long", day: "numeric" }).format(now);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Manila", hour: "numeric", minute: "2-digit", hour12: true }).format(now);
  const body = (first: string, status: string) =>
    [first, "", "Machine: " + machineName, "IP: " + ip, "Status: " + status, "Detected: " + date + ", " + time + " (Asia/Manila, UTC+8)"].join("\n");
  return {
    outage: "Subject: PisoWiFi alert: " + machineName + " is Offline\n\n" + body(machineName + " is Offline.", "Offline") + "\n\n(Sample message. Not sent.)",
    recovery: "Subject: PisoWiFi: " + machineName + " is back Online\n\n" + body(machineName + " is back Online.", "Online") + "\n\n(Sample message. Not sent.)",
  }[rule];
}

export const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";

/** "mock" (default): everything simulated in the browser. "api": real data from the PisoWiFi API where it exists. */
export const DATA_SOURCE = process.env.NEXT_PUBLIC_DATA_SOURCE ?? "mock";
export const API_MODE = DATA_SOURCE === "api";

/** The private ZeroTier network users' own devices join for Remote Administration (16 hex characters).
 *  Not a secret: joining still needs an administrator's authorization in ZeroTier Central. Empty: not configured. */
export const ZT_NETWORK_ID = process.env.NEXT_PUBLIC_ZT_NETWORK_ID ?? "";
