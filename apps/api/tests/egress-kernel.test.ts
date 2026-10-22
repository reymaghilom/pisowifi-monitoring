/* D1 safety correction: a kernel-blocked connect TIMES OUT (observed on the VM, systemd 255), exactly like a silent
   device. The worker therefore checks only addresses covered by its EFFECTIVE allowlist (systemctl show), re-reads it
   after a probe without an answer, and records nothing when the address is blocked or the list can't be verified.
   The fake network below behaves like the real kernel: an address the fake allowlist doesn't cover times out.
   Real migrations on PGlite; nothing touches the network or systemd. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { loadConfig } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema/index.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import { createGatewayChecker } from "../src/gateway/checker.js";
import type { GatewayTransport } from "../src/gateway/probe.js";
import type { ZeroTierClient } from "../src/gateway/zerotier.js";
import { fileEgressGate, kernelCovers, parseKernelAllow, readKernelAllow, writeEgressFile, type Run } from "../src/gateway/egress.js";

const BASE = "127.0.0.0/8 ::1/128 13.237.241.81/32 13.238.183.126/32 3.106.102.114/32";
const P1 = "192.168.194.127";
const P2 = "192.168.194.82";
const N8N = { N8N_ENABLED: "true", N8N_WEBHOOK_URL: "https://n8n.example.test/webhook/pisowifi", N8N_WEBHOOK_SECRET: "x".repeat(40) };
const config = loadConfig({
  NODE_ENV: "test", GATEWAY_ENABLED: "true", MONITOR_SCHEDULE_ENABLED: "true", GATEWAY_TIMEOUT_MS: "1000",
  ZT_ALLOWED_CIDRS: "192.168.194.0/24", ZT_DENY_IPS: "192.168.194.162,192.168.194.22", ZT_NETWORK_ID: "8286ac0e4705c5aa", ...N8N,
});
const online: ZeroTierClient = { nodeState: async () => "online" };

let pglite: PGlite;
let db: Db;
let dir: string;
let ids: Record<string, string>;

/** Simulated systemd + kernel: `allow` is what `systemctl show -p IPAddressAllow --value` prints. */
const sim = { allow: BASE as string, code: 0, throws: false, reads: 0, down: new Set<string>(), afterProbe: null as null | (() => void) };
const run: Run = async () => {
  sim.reads++;
  if (sim.throws) throw new Error("systemctl timed out");
  return { code: sim.code, stdout: sim.allow + "\n" };
};
const contacted: string[] = [];
const network: GatewayTransport = async (url) => {
  const ip = new URL(url).hostname;
  contacted.push(ip);
  const ranges = parseKernelAllow(sim.allow) ?? [];
  const blocked = !kernelCovers(ranges, ip);
  sim.afterProbe?.();
  // Kernel drop: the connect times out (D1 evidence), like a device that doesn't answer.
  if (blocked || sim.down.has(ip)) throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  return new Response("<html>WiFi5Soft</html>", { status: 200 });
};

function worker() {
  const gate = fileEgressGate({ requestFile: join(dir, "worker", "request.json"), appliedFile: join(dir, "applied.json"), maxEntries: 100, kernel: () => readKernelAllow("pisowifi-worker.service", run) });
  return createGatewayChecker({ config, db, transport: network, zerotier: online, egress: gate });
}
const round = () => worker().checkAll({ trigger: "schedule", skipPaused: true });
const applied = (...ips: string[]) => writeEgressFile(join(dir, "applied.json"), ips);
const count = async (table: string, ip?: string) =>
  (await pglite.query<{ n: number }>(`select count(*)::int n from ${table} t ${ip ? "join machines m on m.id = t.machine_id where host(m.zt_ip) = $1" : ""}`, ip ? [ip] : [])).rows[0]!.n;
const status = async (ip: string) => (await pglite.query<{ s: string | null }>("select s.http_status::text s from machines m left join machine_state s on s.machine_id = m.id where host(m.zt_ip) = $1", [ip])).rows[0]?.s ?? null;

beforeAll(async () => {
  pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  await migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
  db = { orm: orm as never, pool: null as never, check: async () => true, close: async () => {} };
});
afterAll(() => pglite.close());
beforeEach(async () => {
  await pglite.exec("delete from machines; delete from users");
  // Alerts go to active accounts; one is enough for these delivery-count assertions.
  await pglite.exec("insert into users (email, display_name, password_hash, role) values ('admin@example.invalid', 'Admin', 'x', 'admin')");
  const r = await pglite.query<{ id: string; ip: string }>(
    "insert into machines (name, zt_ip) values ('PISOWIFI 1', $1), ('PISOWIFI 2', $2) returning id, host(zt_ip) ip",
    [P1, P2],
  );
  ids = Object.fromEntries(r.rows.map((x) => [x.ip, x.id]));
  // Both start Reachable (as in production), so a false Unreachable would also create an outage event.
  for (const id of Object.values(ids)) await pglite.query("insert into machine_state (machine_id, http_status, last_check_at, last_success_at) values ($1, 'reachable', now(), now())", [id]);
  dir = mkdtempSync(join(tmpdir(), "egress-kernel-"));
  Object.assign(sim, { allow: `${BASE} ${P1}/32 ${P2}/32`, code: 0, throws: false, reads: 0, afterProbe: null });
  sim.down.clear();
  contacted.length = 0;
});

describe("effective allowlist parsing (systemctl show -p IPAddressAllow --value)", () => {
  it("reads IPv4 ranges and ignores IPv6 entries", () => {
    const r = parseKernelAllow(`3.106.102.114/32 ::1/128 ${P1}/32 127.0.0.0/8`)!;
    expect(r.map((c) => c.text).sort()).toEqual(["127.0.0.0/8", "192.168.194.127/32", "3.106.102.114/32"]);
    expect(kernelCovers(r, P1)).toBe(true);
    expect(kernelCovers(r, P2)).toBe(false);
  });
  it.each([
    ["empty (unit missing or no allowlist)", ""],
    ["unexpected token", `${P1}/32 garbage`],
    ["address without prefix", `${P1}`],
    ["octet out of range", "192.168.194.300/32"],
    ["leading zero", "192.168.194.082/32"],
    ["prefix out of range", "192.168.194.0/33"],
  ])("malformed or missing -> fail closed (%s)", (_name, out) => {
    expect(parseKernelAllow(out)).toBeNull();
  });
  it("readback failure (non-zero exit, systemctl error, unsafe unit name) -> null", async () => {
    expect(await readKernelAllow("pisowifi-worker.service", async () => ({ code: 1, stdout: `${BASE} ${P1}/32` }))).toBeNull();
    expect(await readKernelAllow("pisowifi-worker.service", async () => { throw new Error("timeout"); })).toBeNull();
    expect(await readKernelAllow("x; rm -rf /", run)).toBeNull();
  });
});

describe("worker rounds against the effective allowlist", () => {
  it("allowed: PISOWIFI 1 and PISOWIFI 2 are checked and recorded Reachable exactly as before", async () => {
    await applied(P1, P2);
    const out = await round();
    expect(contacted.sort()).toEqual([P1, P2].sort());
    expect(out.map((o) => o.adminHttp)).toEqual(["reachable", "reachable"]);
    expect(await count("checks")).toBe(2);
    expect(await count("events")).toBe(0);
    expect(sim.reads).toBe(1); // one effective-allowlist read per round when nothing fails
  });

  it("revoked: an address the kernel no longer allows is not contacted and nothing is recorded", async () => {
    await applied(P1, P2);
    sim.allow = `${BASE} ${P1}/32`; // P2 revoked
    const out = await round();
    expect(contacted).toEqual([P1]);
    expect(out.find((o) => o.machineId === ids[P2])?.refusal).toBe("egress_pending");
    expect(await count("checks", P2)).toBe(0);
    expect(await status(P2)).toBe("reachable"); // last valid result stays
  });

  it("stale applied file: listed but not in the effective allowlist -> never probed (no false timeout outage)", async () => {
    await applied(P1, P2, "192.168.194.150");
    await pglite.query("insert into machines (name, zt_ip) values ('PISOWIFI 3', '192.168.194.150')");
    sim.allow = `${BASE} ${P1}/32 ${P2}/32`; // e.g. runtime drop-in reverted while the file remained
    await round();
    expect(contacted.sort()).toEqual([P1, P2].sort());
    expect(await count("checks", "192.168.194.150")).toBe(0);
    expect(await count("events")).toBe(0);
  });

  it("in the effective allowlist but not confirmed by egress-sync -> not probed either", async () => {
    await applied(P1);
    await round();
    expect(contacted).toEqual([P1]);
  });

  it.each([
    ["malformed allowlist", () => void (sim.allow = `${BASE} ${P1}/32 bogus`)],
    ["missing allowlist (empty output)", () => void (sim.allow = "")],
    ["readback failure (non-zero exit)", () => void (sim.code = 1)],
    ["readback failure (systemctl hangs/throws)", () => void (sim.throws = true)],
  ])("%s -> no machine is contacted, nothing is recorded", async (_name, breakIt) => {
    await applied(P1, P2);
    breakIt();
    const out = await round();
    expect(contacted).toEqual([]);
    expect(out.every((o) => o.refusal === "egress_pending")).toBe(true);
    expect(await count("checks")).toBe(0);
    expect(await count("events")).toBe(0);
    expect(await count("notification_deliveries")).toBe(0);
    expect([await status(P1), await status(P2)]).toEqual(["reachable", "reachable"]);
  });

  it("revoked mid-round: the timeout is re-checked against a fresh readback and not recorded (no outage, no notification)", async () => {
    await applied(P1, P2);
    sim.afterProbe = () => {
      sim.allow = `${BASE} ${P1}/32`; // P2's /32 disappears while its probe is in flight
    };
    await round();
    expect(await count("checks", P2)).toBe(0);
    expect(await status(P2)).toBe("reachable");
    expect(await count("events")).toBe(0);
    expect(await count("outages")).toBe(0);
    expect(await count("notification_deliveries")).toBe(0);
  });

  it("readback fails right after a timeout: not recorded", async () => {
    await applied(P1, P2);
    sim.down.add(P2);
    sim.afterProbe = () => void (sim.code = 1);
    await round();
    expect(await count("checks", P2)).toBe(0);
    expect(await count("events")).toBe(0);
  });

  it("a genuine outage (allowed, no answer, allowlist still confirmed) is recorded once, with one notification; repeats add none", async () => {
    await applied(P1, P2);
    sim.down.add(P2);
    await round();
    expect(await status(P2)).toBe("unreachable");
    expect(await count("events")).toBe(1);
    expect(await count("notification_deliveries")).toBe(1);
    await round();
    await round();
    expect(await count("checks", P2)).toBe(3);
    expect(await count("events")).toBe(1); // no duplicate transition while it stays Unreachable
    expect(await count("notification_deliveries")).toBe(1);
    sim.down.clear();
    await round();
    expect(await status(P2)).toBe("reachable");
    expect(await count("events")).toBe(2); // one recovery
    expect(await count("notification_deliveries")).toBe(2);
  });

  it("a blocked address never produces an outage/recovery pair when it is later allowed", async () => {
    await applied(P1, P2);
    sim.allow = `${BASE} ${P1}/32`;
    await round();
    await round();
    sim.allow = `${BASE} ${P1}/32 ${P2}/32`;
    await round();
    expect(await count("events")).toBe(0);
    expect(await count("checks", P2)).toBe(1);
    expect(await status(P2)).toBe("reachable");
  });

  it("an unreadable applied file allows nothing even when the kernel allows everything", async () => {
    writeFileSync(join(dir, "applied.json"), "{broken");
    await round();
    expect(contacted).toEqual([]);
  });
});
