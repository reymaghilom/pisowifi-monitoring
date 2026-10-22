/* Dynamic machine management: registration policy (SSRF), the scheduler picking machines up and dropping them,
   the kernel egress allowlist (worker gate + root egress-sync) and optional ZeroTier Central membership.
   Real migrations on PGlite; fake transport, fake ZeroTier, fake systemctl. No network access. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { machineSchema } from "@pisowifi/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema/index.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import { hashPassword } from "../src/auth/password.js";
import { createGatewayChecker } from "../src/gateway/checker.js";
import { probeAdmin, type GatewayTransport } from "../src/gateway/probe.js";
import { resolveTarget } from "../src/gateway/target.js";
import { parseCidrList } from "../src/gateway/policy.js";
import { fileEgressGate, parseEgressFile, parseKernelAllow, writeEgressFile, type EgressGate } from "../src/gateway/egress.js";
import { planEgress } from "../src/gateway/egress-plan.js";
import { runEgressSync, type Run } from "../src/gateway/egress-sync.js";
import { authorizedMemberIps } from "../src/gateway/zt-central.js";
import type { ZeroTierClient } from "../src/gateway/zerotier.js";

const ORIGIN = "http://localhost:3000";
const PW = "correct horse battery";
const NET = "8286ac0e4705c5aa";
const POLICY = { ZT_ALLOWED_CIDRS: "192.168.194.0/24", ZT_DENY_IPS: "192.168.194.22,192.168.194.1", ZT_NETWORK_ID: NET };
const RULES = { allowed: parseCidrList("192.168.194.0/24"), denied: new Set(["192.168.194.22", "192.168.194.1"]) };

let pglite: PGlite;
let db: Db;
let app: FastifyInstance;
let admin: string;
let viewer: string;

const body = (o: Record<string, unknown> = {}) => ({ name: "PISOWIFI 3", location: "", description: "", software: "WiFi5Soft", softwareVersion: "", ztNetworkId: "", ztIp: "192.168.194.150", adminPath: "/admin", tags: [], ...o });
const post = (b: unknown, cookie = admin) => app.inject({ method: "POST", url: "/api/v1/machines", payload: b as object, headers: { cookie, origin: ORIGIN } });

async function appWith(env: Record<string, string>) {
  await app?.close();
  app = await buildApp(loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN, ...env }), { db });
  const signIn = async (email: string) => {
    const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW }, headers: { origin: ORIGIN } });
    const c = res.cookies.find((x) => x.name.endsWith("pisowifi_session"))!;
    return `${c.name}=${c.value}`;
  };
  admin = await signIn("admin@example.com");
  viewer = await signIn("viewer@example.com");
}

beforeAll(async () => {
  pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  await migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
  db = { orm: orm as never, pool: null as never, check: async () => true, close: async () => {} };
  const hash = await hashPassword(PW);
  await pglite.query("insert into users (email, display_name, password_hash, role) values ('admin@example.com', 'Admin', $1, 'admin'), ('viewer@example.com', 'Viewer', $1, 'viewer')", [hash]);
});
afterAll(async () => {
  await app?.close();
  await pglite.close();
});
beforeEach(async () => {
  await pglite.exec("delete from machines; delete from sessions");
});

/* ---------------- registration: authorization and destination policy ---------------- */

describe("registering machines (admin only, destination policy)", () => {
  beforeEach(() => appWith({ ...POLICY, MONITOR_MAX_MACHINES: "3" }));

  it("an admin registers a machine in the ZeroTier range; it starts as not checked", async () => {
    const res = await post(body({ ztNetworkId: NET }));
    expect(res.statusCode, res.body).toBe(201);
    const m = machineSchema.parse(res.json());
    expect(m.state).toMatchObject({ http: "unknown", lastCheckAt: null, monitoringEnabled: true });
  });

  it("viewers can't register, edit, pause or delete", async () => {
    expect((await post(body(), viewer)).statusCode).toBe(403);
    const id = machineSchema.parse((await post(body())).json()).id;
    const h = { cookie: viewer, origin: ORIGIN };
    expect((await app.inject({ method: "PUT", url: `/api/v1/machines/${id}`, payload: body(), headers: h })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/api/v1/machines/${id}/monitoring`, payload: { enabled: false }, headers: h })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/api/v1/machines/${id}`, headers: h })).statusCode).toBe(403);
  });

  it.each([
    ["10.0.0.5", /PisoWiFi ZeroTier network \(192\.168\.194\.0\/24\)/],
    ["8.8.8.8", /PisoWiFi ZeroTier network/],
    ["169.254.169.254", /reserved/],
    ["127.0.0.1", /reserved/],
    ["192.168.194.0", /network or broadcast/],
    ["192.168.194.255", /network or broadcast/],
    ["192.168.194.22", /monitoring or admin equipment/],
    ["192.168.194.1", /monitoring or admin equipment/],
  ])("refuses %s (SSRF / not a PisoWiFi)", async (ip, message) => {
    const res = await post(body({ ztIp: ip }));
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.fields.ztIp).toMatch(message);
  });

  it("refuses another ZeroTier network and unsafe admin paths", async () => {
    expect((await post(body({ ztNetworkId: "0123456789abcdef" }))).json().error.fields.ztNetworkId).toMatch(NET);
    for (const p of ["//evil.example/x", "/a/../b", "/a\\b"]) {
      const res = await post(body({ adminPath: p }));
      expect(res.statusCode, p).toBe(400);
      expect(res.json().error.fields.adminPath).toBeDefined();
    }
  });

  it("applies the same policy to edits", async () => {
    const id = machineSchema.parse((await post(body())).json()).id;
    const res = await app.inject({ method: "PUT", url: `/api/v1/machines/${id}`, payload: body({ ztIp: "169.254.169.254" }), headers: { cookie: admin, origin: ORIGIN } });
    expect(res.statusCode).toBe(400);
  });

  it("caps the number of machines", async () => {
    for (const [i, ip] of ["192.168.194.150", "192.168.194.151", "192.168.194.152"].entries()) expect((await post(body({ name: `M${i}`, ztIp: ip }))).statusCode).toBe(201);
    const res = await post(body({ name: "M4", ztIp: "192.168.194.153" }));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/limit \(3\)/);
  });

  it("an address change resets the status to not checked and closes an open outage without a recovery event", async () => {
    const id = machineSchema.parse((await post(body())).json()).id;
    await pglite.query("update machine_state set http_status = 'unreachable', last_check_at = now(), consecutive_failures = 3 where machine_id = $1", [id]);
    await pglite.query("insert into outages (machine_id, started_at) values ($1, now() - interval '1 hour')", [id]);
    const res = await app.inject({ method: "PUT", url: `/api/v1/machines/${id}`, payload: body({ ztIp: "192.168.194.160" }), headers: { cookie: admin, origin: ORIGIN } });
    expect(res.statusCode, res.body).toBe(200);
    expect(machineSchema.parse(res.json()).state).toMatchObject({ http: "unknown", lastCheckAt: null });
    expect((await pglite.query<{ n: number }>("select count(*)::int n from outages where machine_id = $1 and ended_at is null", [id])).rows[0]!.n).toBe(0);
    expect((await pglite.query<{ n: number }>("select count(*)::int n from events where machine_id = $1", [id])).rows[0]!.n).toBe(0);
  });

  it("publishes the policy to signed-in users", async () => {
    await post(body());
    const res = await app.inject({ method: "GET", url: "/api/v1/machines/policy", headers: { cookie: viewer } });
    expect(res.json()).toEqual({ allowedRanges: ["192.168.194.0/24"], networkId: NET, maxMachines: 3, registered: 1 });
    expect((await app.inject({ method: "GET", url: "/api/v1/machines/policy" })).statusCode).toBe(401);
  });

  it("keeps D3 registration, edits and resume inside the approved two-device boundary", async () => {
    await appWith({ ...POLICY, MONITOR_APPROVED_IPS: "192.168.194.127,192.168.194.82" });
    const allowed = await post(body({ name: "PISOWIFI 1", ztIp: "192.168.194.127" }));
    expect(allowed.statusCode, allowed.body).toBe(201);
    const refused = await post(body({ name: "PISOWIFI 3", ztIp: "192.168.194.150" }));
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error.fields.ztIp).toMatch(/not authorized/);
    const id = machineSchema.parse(allowed.json()).id;
    const edit = await app.inject({ method: "PUT", url: `/api/v1/machines/${id}`, payload: body({ name: "PISOWIFI 1", ztIp: "192.168.194.150" }), headers: { cookie: admin, origin: ORIGIN } });
    expect(edit.statusCode).toBe(400);
    expect(edit.json().error.fields.ztIp).toMatch(/not authorized/);
    const [legacy] = (await pglite.query<{ id: string }>("insert into machines (name, zt_ip, monitoring_enabled) values ('Unapproved', '192.168.194.150', false) returning id")).rows;
    const resume = await app.inject({ method: "PATCH", url: `/api/v1/machines/${legacy!.id}/monitoring`, payload: { enabled: true }, headers: { cookie: admin, origin: ORIGIN } });
    expect(resume.statusCode).toBe(400);
    expect(resume.json().error.fields.ztIp).toMatch(/not authorized/);
  });

  it("without a configured range, only private addresses are accepted", async () => {
    await appWith({});
    expect((await post(body({ ztIp: "10.1.2.3" }))).statusCode).toBe(201);
    expect((await post(body({ name: "x", ztIp: "8.8.8.8" }))).json().error.fields.ztIp).toMatch(/private range/);
    expect((await post(body({ name: "y", ztIp: "169.254.169.254" }))).statusCode).toBe(400);
  });
});

/* ---------------- scheduler: dynamic pick-up and drop-out ---------------- */

const online: ZeroTierClient = { nodeState: async () => "online" };
function recordingTransport() {
  const hits: string[] = [];
  const t: GatewayTransport = async (url) => {
    hits.push(new URL(url).hostname);
    return new Response("ok", { status: 200 });
  };
  return { t, hits };
}
const insertMachine = async (name: string, ip: string, enabled = true) =>
  (await pglite.query<{ id: string }>("insert into machines (name, zt_ip, monitoring_enabled) values ($1, $2, $3) returning id", [name, ip, enabled])).rows[0]!.id;
const checksFor = async (id: string) => (await pglite.query<{ n: number }>("select count(*)::int n from checks where machine_id = $1", [id])).rows[0]!.n;
const workerConfig = (env: Record<string, string> = {}) => loadConfig({ NODE_ENV: "test", GATEWAY_ENABLED: "true", MONITOR_SCHEDULE_ENABLED: "true", ...POLICY, ...env });

describe("scheduler (registry in the database)", () => {
  it("checks new machines on the next round and stops checking paused and deleted ones", async () => {
    const { t, hits } = recordingTransport();
    const checker = createGatewayChecker({ config: workerConfig(), db, transport: t, zerotier: online });
    const p1 = await insertMachine("PISOWIFI 1", "192.168.194.127");
    await checker.checkAll({ trigger: "schedule", skipPaused: true });
    expect(hits).toEqual(["192.168.194.127"]);

    const p3 = await insertMachine("PISOWIFI 3", "192.168.194.150"); // registered later, no config change
    hits.length = 0;
    await checker.checkAll({ trigger: "schedule", skipPaused: true });
    expect(hits.sort()).toEqual(["192.168.194.127", "192.168.194.150"]);
    expect(await checksFor(p3)).toBe(1);

    await pglite.query("update machines set monitoring_enabled = false where id = $1", [p3]);
    hits.length = 0;
    await checker.checkAll({ trigger: "schedule", skipPaused: true });
    expect(hits).toEqual(["192.168.194.127"]);
    expect(await checksFor(p3)).toBe(1);

    await pglite.query("delete from machines where id = $1", [p1]);
    hits.length = 0;
    await checker.checkAll({ trigger: "schedule", skipPaused: true });
    expect(hits).toEqual([]);
  });

  it("never contacts or records a machine that fails the destination policy (e.g. written straight into the database)", async () => {
    const { t, hits } = recordingTransport();
    const checker = createGatewayChecker({ config: workerConfig(), db, transport: t, zerotier: online });
    const bad = await insertMachine("Metadata", "169.254.169.254");
    const pc = await insertMachine("Admin PC", "192.168.194.22");
    const out = await checker.checkAll({ trigger: "schedule", skipPaused: true });
    expect(hits).toEqual([]);
    expect(out.map((o) => o.refusal)).toEqual(["target_not_allowed", "target_not_allowed"]);
    expect((await checksFor(bad)) + (await checksFor(pc))).toBe(0);
  });
});

/* ---------------- kernel egress: worker gate ---------------- */

describe("egress gate (worker)", () => {
  function fakeGate(applied: string[]) {
    const requests: string[][] = [];
    const gate: EgressGate = { request: async (ips) => void requests.push([...ips]), applied: async () => new Set(applied), confirm: async (ip) => applied.includes(ip) };
    return { gate, requests };
  }

  it("D2 boundary never requests or probes a newly registered range-valid machine", async () => {
    const { t, hits } = recordingTransport();
    const { gate, requests } = fakeGate(["192.168.194.127", "192.168.194.150"]);
    const checker = createGatewayChecker({ config: workerConfig({ MONITOR_APPROVED_IPS: "192.168.194.127,192.168.194.82" }), db, transport: t, zerotier: online, egress: gate });
    await insertMachine("PISOWIFI 1", "192.168.194.127");
    const newId = await insertMachine("Unapproved", "192.168.194.150");
    const outcomes = await checker.checkAll({ trigger: "schedule", skipPaused: true });
    expect(requests).toEqual([["192.168.194.127"]]);
    expect(hits).toEqual(["192.168.194.127"]);
    expect(outcomes.find((o) => o.machineId === newId)?.refusal).toBe("target_not_allowed");
    expect(await checksFor(newId)).toBe(0);
  });

  it("requests exactly the policy-valid addresses and checks only those the kernel allows; the rest record nothing", async () => {
    const { t, hits } = recordingTransport();
    const { gate, requests } = fakeGate(["192.168.194.127"]);
    const checker = createGatewayChecker({ config: workerConfig(), db, transport: t, zerotier: online, egress: gate });
    const known = await insertMachine("PISOWIFI 1", "192.168.194.127");
    const fresh = await insertMachine("PISOWIFI 3", "192.168.194.150");
    await insertMachine("Paused", "192.168.194.151", false);
    await insertMachine("Metadata", "169.254.169.254");
    const out = await checker.checkAll({ trigger: "schedule", skipPaused: true });
    expect(requests).toEqual([["192.168.194.127", "192.168.194.150"].sort()]);
    expect(hits).toEqual(["192.168.194.127"]);
    expect(out.find((o) => o.machineId === fresh)?.refusal).toBe("egress_pending");
    // Not allowed yet is a monitoring-side refusal: no check, status stays "not checked", no outage.
    expect(await checksFor(fresh)).toBe(0);
    expect(await checksFor(known)).toBe(1);
    expect((await pglite.query<{ s: string }>("select coalesce((select http_status::text from machine_state where machine_id = $1), 'unknown') s", [fresh])).rows[0]!.s).toBe("unknown");
  });

  it("file gate: atomic request file, only rewritten on change; unreadable or invalid applied file allows nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "egress-"));
    const gate = fileEgressGate({ requestFile: join(dir, "w", "request.json"), appliedFile: join(dir, "applied.json"), maxEntries: 10, kernel: async () => parseKernelAllow("127.0.0.0/8 ::1/128 192.168.194.127/32") });
    await gate.request(["192.168.194.150", "192.168.194.127", "192.168.194.127"]);
    const first = readFileSync(join(dir, "w", "request.json"), "utf8");
    expect(JSON.parse(first)).toMatchObject({ version: 1, ips: ["192.168.194.127", "192.168.194.150"] });
    await gate.request(["192.168.194.127", "192.168.194.150"]);
    expect(readFileSync(join(dir, "w", "request.json"), "utf8")).toBe(first);
    expect([...(await gate.applied())]).toEqual([]);
    writeFileSync(join(dir, "applied.json"), '{"version":1,"ips":["192.168.194.127","not-an-ip"]}');
    expect([...(await gate.applied())]).toEqual([]);
    await writeEgressFile(join(dir, "applied.json"), ["192.168.194.127"]);
    expect([...(await gate.applied())]).toEqual(["192.168.194.127"]);
    expect(parseEgressFile('{"version":1,"ips":["1.1.1.1","1.1.1.2"]}', 1)).toBeNull();
  });

  it("an EPERM connect error is inconclusive (a kernel drop usually TIMES OUT instead: see egress-kernel.test.ts)", async () => {
    const target = resolveTarget({ ztIp: "192.168.194.150", adminPath: "/admin" }, { allowed: RULES.allowed, port: 80 });
    if (!target.ok) throw new Error("fixture");
    const blocked: GatewayTransport = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EPERM" } });
    };
    expect(await probeAdmin(target.target, blocked, 1000)).toMatchObject({ adminHttp: "unknown", error: "monitor" });
  });
});

/* ---------------- kernel egress: root egress-sync ---------------- */

describe("egress plan", () => {
  it("D2 root boundary refuses an unapproved address even without Central membership verification", () => {
    const p = planEgress({ requested: ["192.168.194.127", "192.168.194.150"], current: [], rules: RULES, maxEntries: 10, members: null, approved: new Set(["192.168.194.127", "192.168.194.82"]) });
    expect(p.devices).toEqual(["192.168.194.127"]);
    expect(p.rejected).toContainEqual({ ip: "192.168.194.150", reason: "not_approved" });
  });
  it("accepts only policy-valid requested addresses, capped", () => {
    const plan = planEgress({ requested: ["192.168.194.150", "169.254.169.254", "192.168.194.22", "10.0.0.1", "192.168.194.151"], current: [], rules: RULES, maxEntries: 1, members: null });
    expect(plan.devices).toEqual(["192.168.194.150"]);
    expect(Object.fromEntries(plan.rejected.map((r) => [r.ip, r.reason]))).toEqual({
      "169.254.169.254": "blocked_range",
      "192.168.194.22": "denied",
      "10.0.0.1": "outside_allowed",
      "192.168.194.151": "over_limit",
    });
  });
  it("with membership verification: only authorized members; if Central is down, keep verified ones and add none", () => {
    const members = new Set(["192.168.194.127"]);
    expect(planEgress({ requested: ["192.168.194.127", "192.168.194.150"], current: [], rules: RULES, maxEntries: 10, members }).devices).toEqual(["192.168.194.127"]);
    const down = planEgress({ requested: ["192.168.194.127", "192.168.194.150"], current: ["192.168.194.127"], rules: RULES, maxEntries: 10, members: "error" });
    expect(down.devices).toEqual(["192.168.194.127"]);
    expect(down.rejected).toEqual([{ ip: "192.168.194.150", reason: "membership_unverified" }]);
  });
  it("a missing or invalid request allows no device", () => {
    expect(planEgress({ requested: null, current: ["192.168.194.127"], rules: RULES, maxEntries: 10, members: null }).devices).toEqual([]);
  });
});

describe("egress-sync (fake systemctl)", () => {
  const BASE = ["127.0.0.0/8", "::1/128", "13.237.241.81/32"];
  function fakeSystemctl(initial: string) {
    let allow = initial;
    const calls: string[][] = [];
    let broken = false;
    const run: Run = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (args[0] === "show") return { code: 0, stdout: allow + "\n", stderr: "" };
      if (args[0] === "set-property" && !broken) allow = args[args.length - 1]!.replace(/^IPAddressAllow=/, "");
      return { code: broken ? 1 : 0, stdout: "", stderr: broken ? "Access denied" : "" };
    };
    return { run, calls, get allow() { return allow; }, breakIt: () => (broken = true) };
  }
  function files(request: unknown) {
    const dir = mkdtempSync(join(tmpdir(), "esync-"));
    const requestFile = join(dir, "request.json");
    if (request !== undefined) writeFileSync(requestFile, typeof request === "string" ? request : JSON.stringify(request));
    return { requestFile, appliedFile: join(dir, "applied", "applied.json") };
  }
  const opts = (f: ReturnType<typeof files>, run: Run, members: (() => Promise<ReadonlySet<string>>) | null = null) => ({
    ...f, unit: "pisowifi-worker.service", base: BASE, rules: RULES, maxEntries: 10, members, run, log: () => {},
  });
  const applied = (f: ReturnType<typeof files>) => JSON.parse(readFileSync(f.appliedFile, "utf8")).ips;

  it("adds new devices to the kernel allowlist, confirms it, then tells the worker", async () => {
    const sc = fakeSystemctl("127.0.0.0/8 ::1/128 13.237.241.81/32");
    const f = files({ version: 1, ips: ["192.168.194.127", "192.168.194.150", "169.254.169.254"], at: "x" });
    const r = await runEgressSync(opts(f, sc.run));
    expect(r).toMatchObject({ changed: true, verified: true });
    expect(sc.allow.split(" ").sort()).toEqual(["127.0.0.0/8", "13.237.241.81/32", "192.168.194.127/32", "192.168.194.150/32", "::1/128"].sort());
    expect(sc.calls.find((c) => c[1] === "set-property")).toEqual(["systemctl", "set-property", "--runtime", "pisowifi-worker.service", "IPAddressAllow=", expect.stringMatching(/^IPAddressAllow=/)]);
    expect(applied(f)).toEqual(["192.168.194.127", "192.168.194.150"]);
  });

  it("removes devices that are no longer requested (deleted or paused machines)", async () => {
    const sc = fakeSystemctl("127.0.0.0/8 ::1/128 13.237.241.81/32 192.168.194.127/32 192.168.194.150/32");
    const f = files({ version: 1, ips: ["192.168.194.127"], at: "x" });
    await runEgressSync(opts(f, sc.run));
    expect(sc.allow).not.toContain("192.168.194.150");
    expect(applied(f)).toEqual(["192.168.194.127"]);
  });

  it("does nothing when the kernel already matches", async () => {
    const sc = fakeSystemctl("127.0.0.0/8 13.237.241.81/32 192.168.194.127/32 ::1/128");
    const f = files({ version: 1, ips: ["192.168.194.127"], at: "x" });
    expect((await runEgressSync(opts(f, sc.run))).changed).toBe(false);
    expect(sc.calls.filter((c) => c[1] === "set-property")).toEqual([]);
  });

  it("fails closed: an unconfirmed kernel change or an invalid request leaves the worker with no device", async () => {
    const sc = fakeSystemctl("127.0.0.0/8 ::1/128 13.237.241.81/32");
    sc.breakIt();
    const f = files({ version: 1, ips: ["192.168.194.127"], at: "x" });
    expect((await runEgressSync(opts(f, sc.run))).verified).toBe(false);
    expect(applied(f)).toEqual([]);
    const sc2 = fakeSystemctl("127.0.0.0/8 ::1/128 13.237.241.81/32 192.168.194.127/32");
    const f2 = files("{not json");
    await runEgressSync(opts(f2, sc2.run));
    expect(sc2.allow).toBe("127.0.0.0/8 13.237.241.81/32 ::1/128".split(" ").sort().join(" "));
    expect(applied(f2)).toEqual([]);
  });

  it("with ZeroTier membership verification, non-members are never allowed", async () => {
    const sc = fakeSystemctl("127.0.0.0/8 ::1/128 13.237.241.81/32");
    const f = files({ version: 1, ips: ["192.168.194.127", "192.168.194.150"], at: "x" });
    await runEgressSync(opts(f, sc.run, async () => new Set(["192.168.194.127"])));
    expect(applied(f)).toEqual(["192.168.194.127"]);
  });

  it("refuses an unexpected unit name", async () => {
    const sc = fakeSystemctl("");
    await expect(runEgressSync({ ...opts(files({ version: 1, ips: [], at: "x" }), sc.run), unit: "x; rm -rf /" })).rejects.toThrow(/invalid unit/);
  });
});

describe("ZeroTier Central membership (read-only)", () => {
  it("returns addresses of authorized members only and sends the token only to the Central API", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ztc-"));
    writeFileSync(join(dir, "token"), "secret-token\n");
    let seen: { url: string; auth: string | null } | null = null;
    const fetchImpl = (async (url: URL, init: RequestInit) => {
      seen = { url: String(url), auth: new Headers(init.headers).get("authorization") };
      return new Response(JSON.stringify([
        { config: { authorized: true, ipAssignments: ["192.168.194.127"] } },
        { config: { authorized: false, ipAssignments: ["192.168.194.150"] } },
        { config: { authorized: true, ipAssignments: ["fd00::1", "not-ip"] } },
      ]), { status: 200 });
    }) as unknown as typeof fetch;
    const ips = await authorizedMemberIps({ apiUrl: "https://api.zerotier.com", networkId: NET.toUpperCase(), tokenFile: join(dir, "token"), fetchImpl });
    expect([...ips]).toEqual(["192.168.194.127"]);
    expect(seen).toEqual({ url: `https://api.zerotier.com/api/v1/network/${NET}/member`, auth: "token secret-token" });
  });
});

describe("configuration", () => {
  it("retention is off unless set; ranges must be private; egress files go together", () => {
    expect(loadConfig({ NODE_ENV: "test" }).CHECK_RETENTION_DAYS).toBeUndefined();
    expect(() => loadConfig({ NODE_ENV: "test", ZT_ALLOWED_CIDRS: "8.8.0.0/16" })).toThrow(/private ranges/);
    expect(() => loadConfig({ NODE_ENV: "test", GATEWAY_EGRESS_REQUEST_FILE: "/run/x" })).toThrow(/must be set together/);
    expect(loadConfig({ NODE_ENV: "test", ZT_ALLOWED_CIDRS: "192.168.194.0/24" }).MONITOR_MAX_MACHINES).toBe(100);
  });
});
