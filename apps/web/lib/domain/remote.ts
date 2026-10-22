/* Remote Administration: Direct ZeroTier Client Access.

   The user's own device (Windows PC or Android phone) joins the private ZeroTier network, an administrator
   authorizes it in ZeroTier Central, and the browser then opens the machine's own WiFi5Soft admin page
   (http://<ZeroTier IP><admin path>) in a new tab. This app never proxies, frames or signs in to that page.

   A web page cannot tell whether ZeroTier is installed, running, joined or authorized on the device it runs on,
   so every setup step is confirmed by the user ("I've completed this step"); nothing here pretends to detect it. */
import type { Machine } from "@/lib/types";

export type Platform = "windows" | "android";
export type SetupStepId = "install" | "join" | "authorize" | "vpn" | "test";

export const PLATFORMS: readonly (readonly [Platform, string])[] = [
  ["windows", "Windows PC"],
  ["android", "Android phone"],
];

/** Setup order per platform. Android also has to switch the network on and approve the VPN permission. */
export const SETUP_STEPS: Record<Platform, readonly SetupStepId[]> = {
  windows: ["install", "join", "authorize", "test"],
  android: ["install", "join", "authorize", "vpn", "test"],
};

export const STEP_TITLE: Record<SetupStepId, string> = {
  install: "Install ZeroTier One",
  join: "Join the private network",
  authorize: "Wait for administrator authorization",
  vpn: "Turn on the network and allow the VPN",
  test: "Test the connection",
};

/** Official ZeroTier sources only. */
export const ZT_LINKS = {
  windows: "https://www.zerotier.com/download/",
  android: "https://play.google.com/store/apps/details?id=com.zerotier.one",
  central: "https://my.zerotier.com/",
} as const;

/** Best guess for the first tab shown. A guess about the operating system only: never about ZeroTier. */
export function guessPlatform(userAgent: string): Platform {
  return /android/i.test(userAgent) ? "android" : "windows";
}

/** First step not yet confirmed, or null when setup is complete for this platform. */
export function nextStep(platform: Platform, done: readonly SetupStepId[]): SetupStepId | null {
  return SETUP_STEPS[platform].find((s) => !done.includes(s)) ?? null;
}

export function stepState(platform: Platform, done: readonly SetupStepId[], step: SetupStepId): "ok" | "now" | "" {
  if (done.includes(step)) return "ok";
  return nextStep(platform, done) === step ? "now" : "";
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** The machine's own admin page on its ZeroTier IP, or null when the record can't form a safe URL
 *  (not an IPv4 literal, or a path that would leave the machine). */
export function adminUrl(m: Pick<Machine, "ip" | "path">): string | null {
  if (!IPV4.test(m.ip)) return null;
  const path = m.path || "/";
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\s]/.test(path)) return null;
  try {
    const url = new URL(path, `http://${m.ip}`);
    return url.hostname === m.ip ? url.href : null;
  } catch {
    return null;
  }
}

/** Network ID to join: the machine's own (when registered) or the configured network. Not a secret, but joining
 *  still needs an administrator's authorization in ZeroTier Central. */
export function networkIdFor(m: Pick<Machine, "ztNet"> | undefined, configured: string): string | null {
  const id = (m?.ztNet || configured).trim().toLowerCase();
  return /^[0-9a-f]{16}$/.test(id) ? id : null;
}
