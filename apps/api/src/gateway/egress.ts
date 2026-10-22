/* Worker side of the dynamic egress allowlist. The worker runs with a kernel allowlist (systemd IPAddressAllow)
   that it cannot change. Each scheduled round it writes the machine addresses it wants to check to the request
   file (GATEWAY_EGRESS_REQUEST_FILE); the root egress-sync validates them and, once the kernel allows them, lists them
   in the applied file (GATEWAY_EGRESS_APPLIED_FILE).

   The kernel drops a blocked connection silently: the connect TIMES OUT (verified on the VM in D1), which is
   indistinguishable from a device that doesn't answer. So the worker never trusts the applied file alone. Each round
   it also reads its own EFFECTIVE allowlist from systemd (`systemctl show <unit> -p IPAddressAllow`) and only checks
   an address that is in the applied file AND covered by the effective list. After a probe that got no answer it
   reads the effective list again; if the address is no longer covered (revoked mid-round) or the list can't be read,
   nothing is recorded. If the list can't be read, parsed or is empty, nothing is checked (fail closed). */
import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { STRICT_IPV4, parseCidr, type Cidr } from "./policy.js";

export interface EgressGate {
  /** Publishes the addresses the next rounds need (sorted, unique). Only rewrites the file when they change. */
  request(ips: readonly string[]): Promise<void>;
  /** Addresses that may be checked now: in the applied file and covered by the effective kernel allowlist. Empty when
   *  either can't be verified. */
  applied(): Promise<ReadonlySet<string>>;
  /** Fresh effective-allowlist read: true only when it can be read and still covers `ip`. */
  confirm(ip: string): Promise<boolean>;
}

export interface EgressFile {
  version: 1;
  ips: string[];
  /** ISO time */
  at: string;
}

export function parseEgressFile(text: string, maxEntries: number): string[] | null {
  try {
    const j = JSON.parse(text) as Partial<EgressFile>;
    if (j.version !== 1 || !Array.isArray(j.ips) || j.ips.length > maxEntries) return null;
    if (!j.ips.every((ip) => typeof ip === "string" && STRICT_IPV4.test(ip))) return null;
    return [...new Set(j.ips)].sort();
  } catch {
    return null;
  }
}

/** Atomic write: readers never see a half-written file. */
export async function writeEgressFile(file: string, ips: readonly string[], mode = 0o644) {
  await mkdir(dirname(file), { recursive: true });
  const body: EgressFile = { version: 1, ips: [...new Set(ips)].sort(), at: new Date().toISOString() };
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(body) + "\n", { mode });
  await rename(tmp, file);
}

/* ---------------- effective kernel allowlist (systemd) ---------------- */

export type Run = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;

/** No shell; bounded time and output. */
export const execRun: Run = (cmd, args) =>
  new Promise((resolve) =>
    execFile(cmd, args, { timeout: 5000, maxBuffer: 64 * 1024 }, (err, stdout) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout) })),
  );

const UNIT = /^[a-zA-Z0-9@._-]+\.service$/;
const V4_ENTRY = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/;
const V6_ENTRY = /^[0-9a-fA-F:]+\/\d{1,3}$/;

/** IPv4 ranges of the unit's effective IPAddressAllow, or null when it can't be read, is empty or has any entry that
 *  doesn't parse (fail closed: then nothing is checked). IPv6 entries (e.g. ::1/128) are accepted and ignored. */
export function parseKernelAllow(stdout: string): Cidr[] | null {
  const entries = stdout.trim().split(/\s+/).filter(Boolean);
  if (!entries.length) return null;
  const v4: Cidr[] = [];
  for (const e of entries) {
    const m = V4_ENTRY.exec(e);
    if (m) {
      if (!STRICT_IPV4.test(m[1]!)) return null;
      try {
        v4.push(parseCidr(e, 0));
      } catch {
        return null;
      }
    } else if (!V6_ENTRY.test(e)) return null;
  }
  return v4;
}

export async function readKernelAllow(unit: string, run: Run = execRun): Promise<Cidr[] | null> {
  if (!UNIT.test(unit)) return null;
  try {
    const r = await run("systemctl", ["show", unit, "-p", "IPAddressAllow", "--value"]);
    return r.code === 0 ? parseKernelAllow(r.stdout) : null;
  } catch {
    return null;
  }
}

const toInt = (ip: string) => ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
/** True when a (strict) IPv4 address is inside one of the ranges. */
export const kernelCovers = (ranges: readonly Cidr[], ip: string) => STRICT_IPV4.test(ip) && ranges.some((c) => (toInt(ip) & c.mask) >>> 0 === c.base);

export function fileEgressGate(opts: {
  requestFile: string;
  appliedFile: string;
  maxEntries: number;
  /** Reads the effective allowlist (default: systemctl show on GATEWAY_EGRESS_UNIT). */
  kernel: () => Promise<Cidr[] | null>;
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}): EgressGate {
  let last: string | null = null;
  const log = opts.log ?? (() => {});
  return {
    async request(ips) {
      const want = [...new Set(ips)].sort().slice(0, opts.maxEntries);
      const key = want.join(",");
      if (key === last) return;
      await writeEgressFile(opts.requestFile, want);
      last = key;
    },
    async applied() {
      const text = await readFile(opts.appliedFile, "utf8").catch(() => null);
      const listed = text === null ? [] : (parseEgressFile(text, opts.maxEntries) ?? []);
      const kernel = await opts.kernel();
      if (!kernel) {
        log("effective egress allowlist could not be verified; checking no machine this round");
        return new Set();
      }
      const stale = listed.filter((ip) => !kernelCovers(kernel, ip));
      if (stale.length) log("applied egress file lists addresses the kernel does not allow; skipping them", { stale });
      return new Set(listed.filter((ip) => kernelCovers(kernel, ip)));
    },
    async confirm(ip) {
      const kernel = await opts.kernel();
      return !!kernel && kernelCovers(kernel, ip);
    },
  };
}
