/* Root side of the dynamic egress allowlist (see ./egress.ts for the worker side). One run:
   1. read the worker's request file (missing or invalid: no device egress)
   2. re-check every address against the destination policy (and ZeroTier Central membership, when configured)
   3. set the worker unit's kernel allowlist (systemctl set-property --runtime ... IPAddressAllow=) to the base
      entries (loopback, database pooler) plus one /32 per accepted device, only when it differs
   4. read the unit's allowlist back and require an exact match
   5. only then write the applied file the worker reads (it never checks an address the kernel doesn't allow)
   The runtime property lives until reboot; after a reboot the worker starts with the base allowlist only and
   checks nothing until this runs again. Commands run without a shell; arguments are validated IPs and CIDRs. */
import { readFile } from "node:fs/promises";
import { parseEgressFile, writeEgressFile } from "./egress.js";
import { allowList, planEgress, type EgressPlan } from "./egress-plan.js";
import type { DestinationRules } from "./policy.js";

export type Run = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface EgressSyncOptions {
  requestFile: string;
  appliedFile: string;
  unit: string;
  /** Always allowed (normalized CIDRs), e.g. 127.0.0.0/8 ::1/128 and the database pooler's /32s. */
  base: readonly string[];
  rules: DestinationRules;
  maxEntries: number;
  approved?: ReadonlySet<string> | null;
  /** null: membership verification not configured. */
  members: (() => Promise<ReadonlySet<string>>) | null;
  run: Run;
  log: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface EgressSyncResult {
  changed: boolean;
  plan: EgressPlan;
  allow: string[];
  /** false when the kernel allowlist could not be confirmed (applied file then lists no device) */
  verified: boolean;
}

const UNIT = /^[a-zA-Z0-9@._-]+\.service$/;
const parseAllow = (s: string) => s.trim().split(/\s+/).filter(Boolean).sort();
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function runEgressSync(o: EgressSyncOptions): Promise<EgressSyncResult> {
  if (!UNIT.test(o.unit)) throw new Error(`invalid unit name ${o.unit}`);
  const requestText = await readFile(o.requestFile, "utf8").catch(() => null);
  const requested = requestText === null ? null : parseEgressFile(requestText, o.maxEntries * 2);
  if (requestText !== null && requested === null) o.log("egress request file is invalid; allowing no device", { file: o.requestFile });
  const currentText = await readFile(o.appliedFile, "utf8").catch(() => null);
  const current = (currentText && parseEgressFile(currentText, o.maxEntries)) || [];

  let members: ReadonlySet<string> | null | "error" = null;
  if (o.members) {
    try {
      members = await o.members();
    } catch (err) {
      members = "error";
      o.log("ZeroTier membership check failed; keeping verified devices, adding none", { error: err instanceof Error ? err.message : "error" });
    }
  }
  const plan = planEgress({ requested, current, rules: o.rules, maxEntries: o.maxEntries, members, approved: o.approved });
  for (const r of plan.rejected) o.log("egress refused", r);
  const allow = allowList(o.base, plan.devices.map((ip) => `${ip}/32`));

  const show = async () => {
    const r = await o.run("systemctl", ["show", o.unit, "-p", "IPAddressAllow", "--value"]);
    return r.code === 0 ? parseAllow(r.stdout) : null;
  };
  let kernel = await show();
  let changed = false;
  if (!kernel || !same(kernel, allow)) {
    // Reset, then set the complete list, in one call.
    const r = await o.run("systemctl", ["set-property", "--runtime", o.unit, "IPAddressAllow=", `IPAddressAllow=${allow.join(" ")}`]);
    if (r.code !== 0) o.log("systemctl set-property failed", { code: r.code, stderr: r.stderr.slice(0, 300) });
    changed = true;
    kernel = await show();
  }
  const verified = !!kernel && same(kernel, allow);
  // The worker may only check what the kernel provably allows.
  await writeEgressFile(o.appliedFile, verified ? plan.devices : []);
  if (!verified) o.log("kernel egress allowlist could not be confirmed; applied list is empty", { expected: allow.join(" "), got: kernel?.join(" ") ?? null });
  else if (changed) o.log("egress allowlist updated", { devices: plan.devices.length });
  return { changed, plan, allow, verified };
}
