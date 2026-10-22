/* Egress decision (pure): which requested machine addresses the worker's kernel allowlist may contain. */
import { destinationRefusal, type DestinationRefusal, type DestinationRules } from "./policy.js";

export type EgressRejection = DestinationRefusal | "over_limit" | "not_approved" | "not_a_member" | "membership_unverified";

export interface EgressPlanInput {
  /** From the worker's request file; null when missing or invalid (fail closed: no device egress). */
  requested: readonly string[] | null;
  /** Addresses currently applied (kept only while membership can't be verified). */
  current: readonly string[];
  rules: DestinationRules;
  maxEntries: number;
  /** D2 boundary: only these exact addresses may enter the kernel allowlist. */
  approved?: ReadonlySet<string> | null;
  /** ZeroTier Central membership: addresses assigned to authorized members. null = verification not configured;
   *  "error" = configured but unavailable right now. */
  members: ReadonlySet<string> | null | "error";
}

export interface EgressPlan {
  devices: string[];
  rejected: { ip: string; reason: EgressRejection }[];
}

export function planEgress(input: EgressPlanInput): EgressPlan {
  const rejected: EgressPlan["rejected"] = [];
  const valid: string[] = [];
  for (const ip of [...new Set(input.requested ?? [])].sort()) {
    const reason = destinationRefusal(ip, input.rules);
    if (reason) rejected.push({ ip, reason });
    else if (input.approved && !input.approved.has(ip)) rejected.push({ ip, reason: "not_approved" });
    else valid.push(ip);
  }
  const current = new Set(input.current);
  const devices: string[] = [];
  for (const ip of valid) {
    if (input.members === "error") {
      // Central is down: keep what was already verified, add nothing new.
      if (current.has(ip)) devices.push(ip);
      else rejected.push({ ip, reason: "membership_unverified" });
    } else if (input.members && !input.members.has(ip)) {
      rejected.push({ ip, reason: "not_a_member" });
    } else devices.push(ip);
  }
  for (const ip of devices.splice(input.maxEntries)) rejected.push({ ip, reason: "over_limit" });
  return { devices, rejected };
}

/** systemd IPAddressAllow entries: base (pooler, loopback) plus one /32 per device, normalized for comparison. */
export const normalizeAllowEntry = (e: string) => (e.includes("/") ? e : e.includes(":") ? `${e}/128` : `${e}/32`);
export const allowList = (base: readonly string[], devices: readonly string[]) => [...new Set([...base, ...devices].map(normalizeAllowEntry))].sort();
