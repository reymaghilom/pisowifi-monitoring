/* ZeroTier gateway (Phases Z1, PC2): target rules (SSRF), checks and their recorded results.
   Remote admin is direct (the user's own ZeroTier); the API serves no proxy.
   No network access: a recording fake transport stands in for the gateway's HTTP client. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { gatewayCheckSchema, gatewayStatusSchema, machineListResponseSchema } from "@pisowifi/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema/index.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import { hashPassword } from "../src/auth/password.js";
import { mapLimit, probeAdmin, type GatewayTransport } from "../src/gateway/probe.js";
import { parseCidr, parseCidrList, resolveTarget, targetUrl } from "../src/gateway/target.js";
import type { ZeroTierClient } from "../src/gateway/zerotier.js";

const ORIGIN = "http://localhost:3000";
const PW = "correct horse battery";
const ALLOWED = parseCidrList("192.168.194.0/24");
const T82 = resolveTarget({ ztIp: "192.168.194.82", adminPath: "/admin" }, { allowed: ALLOWED, port: 80 });
if (!T82.ok) throw new Error("fixture");
const target = T82.target;

/* ---------------- unit: target rules ---------------- */

describe("targets (SSRF boundary)", () => {
  it("accepts the registered WiFi5Soft machines inside the allowed range, with a fixed scheme and port", () => {
    expect(target).toEqual({ ip: "192.168.194.82", port: 80, origin: "http://192.168.194.82", adminPath: "/admin" });
    const t127 = resolveTarget({ ztIp: "192.168.194.127", adminPath: "/admin" }, { allowed: ALLOWED, port: 8080 });
    expect(t127).toMatchObject({ ok: true, target: { origin: "http://192.168.194.127:8080" } });
  });

  it("refuses addresses outside the range and special ranges even when a CIDR includes them", () => {
    expect(resolveTarget({ ztIp: "10.0.0.5", adminPath: "/admin" }, { allowed: ALLOWED, port: 80 })).toEqual({ ok: false, reason: "outside_allowed" });
    const wide = parseCidrList("0.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16, 224.0.0.0/8");
    for (const ip of ["127.0.0.1", "169.254.169.254", "0.0.0.1", "224.0.0.1"]) {
      expect(resolveTarget({ ztIp: ip, adminPath: "/" }, { allowed: wide, port: 80 })).toEqual({ ok: false, reason: "blocked_range" });
    }
    expect(resolveTarget({ ztIp: "pisowifi.local", adminPath: "/" }, { allowed: ALLOWED, port: 80 })).toEqual({ ok: false, reason: "invalid_ip" });
    expect(() => parseCidr("192.168.194.0/0")).toThrow();
    expect(() => parseCidr("300.1.1.1/24")).toThrow();
  });

  it("keeps every checked path on the target (no traversal, no other hosts, no control characters)", () => {
    expect(targetUrl(target, "/admin/status?x=1")?.href).toBe("http://192.168.194.82/admin/status?x=1");
    for (const bad of ["//evil.com/x", "/../etc/passwd", "/a/%2e%2e/b", "/a/%2E%2E/b", "/\\evil.com", "/a%00b", "/a\nb", "http://evil.com/", "evil", "/%E0%A4%A"]) {
      expect(targetUrl(target, bad), bad).toBeNull();
    }
  });
});

describe("helpers", () => {
  it("mapLimit never exceeds the concurrency limit and keeps order", async () => {
    let inFlight = 0;
    let max = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      max = Math.max(max, ++inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(max).toBe(3);
  });

  it("probe: any answer is reachable (login still required), even 5xx; no answer is unreachable; strict timeout", async () => {
    const answer = (status: number): GatewayTransport => async () => new Response("<html>login</html>", { status });
    expect(await probeAdmin(target, answer(200), 1000)).toMatchObject({ adminHttp: "reachable", httpStatus: 200, error: null });
    expect(await probeAdmin(target, answer(302), 1000)).toMatchObject({ adminHttp: "reachable", httpStatus: 302 });
    expect(await probeAdmin(target, answer(401), 1000)).toMatchObject({ adminHttp: "reachable", httpStatus: 401 });
    expect(await probeAdmin(target, answer(503), 1000)).toMatchObject({ adminHttp: "reachable", httpStatus: 503, error: null });
    const refused: GatewayTransport = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    expect(await probeAdmin(target, refused, 1000)).toEqual({ adminHttp: "unreachable", httpStatus: null, latencyMs: null, error: "refused" });
    const unexpected: GatewayTransport = async () => { throw new Error("broken checker"); };
    expect(await probeAdmin(target, unexpected, 1000)).toMatchObject({ adminHttp: "unknown", error: "monitor" });
    const noRoute: GatewayTransport = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENETUNREACH" } }); };
    expect(await probeAdmin(target, noRoute, 1000)).toMatchObject({ adminHttp: "unknown", error: "monitor" });
    expect(await probeAdmin(target, async () => ({ status: 0 } as Response), 1000)).toMatchObject({ adminHttp: "unknown", error: "monitor" });
    const hang: GatewayTransport = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    const started = Date.now();
    expect(await probeAdmin(target, hang, 600)).toMatchObject({ adminHttp: "unreachable", error: "timeout" });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("config: enabling the gateway needs the allowed ranges", () => {
    expect(() => loadConfig({ GATEWAY_ENABLED: "true" })).toThrow(/ZT_ALLOWED_CIDRS: is required/);
    expect(() => loadConfig({ GATEWAY_ENABLED: "true", ZT_ALLOWED_CIDRS: "192.168.194.0" })).toThrow(/ZT_ALLOWED_CIDRS/);
    expect(loadConfig({}).GATEWAY_ENABLED).toBe(false);
  });
});

/* ---------------- integration: routes ---------------- */

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

let pglite: PGlite;
let db: Db;
let app: FastifyInstance | undefined;
let calls: Call[];
let device: (c: Call) => Response | Promise<Response>;
let admin: string;
let viewer: string;
let m82: string;
let m127: string;
let mOutside: string;

const transport: GatewayTransport = async (url, init) => {
  const c = { url, method: init.method, headers: init.headers, body: init.body?.toString() };
  calls.push(c);
  return device(c);
};

beforeAll(async () => {
  pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  await migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
  db = { orm: orm as never, pool: null as never, check: async () => true, close: async () => {} };
  const hash = await hashPassword(PW);
  await pglite.query("insert into users (email, display_name, password_hash, role) values ('admin@example.com', 'Admin', $1, 'admin'), ('viewer@example.com', 'Viewer', $1, 'viewer')", [hash]);
});
afterAll(() => pglite.close());

async function start(env: Record<string, string> = {}, deps: { zerotier?: ZeroTierClient } = {}) {
  app = await buildApp(loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN, GATEWAY_ENABLED: "true", ZT_ALLOWED_CIDRS: "192.168.194.0/24", GATEWAY_TIMEOUT_MS: "1000", ...env }), {
    db,
    gatewayTransport: transport,
    zerotier: deps.zerotier,
  });
  const signIn = async (email: string) => {
    const res = await app!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW }, headers: { origin: ORIGIN } });
    const c = res.cookies.find((x) => x.name.endsWith("pisowifi_session"))!;
    return `${c.name}=${c.value}`;
  };
  admin = await signIn("admin@example.com");
  viewer = await signIn("viewer@example.com");
}

beforeEach(async () => {
  calls = [];
  device = () => new Response("<html><form action=/admin/login method=post></form></html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
  await pglite.exec("delete from checks; delete from machines; delete from audit_log; delete from sessions; update users set role = 'admin' where email = 'admin@example.com'");
  const ins = async (name: string, ip: string) =>
    (await pglite.query<{ id: string }>("insert into machines (name, zt_ip, admin_path) values ($1, $2, '/admin') returning id", [name, ip])).rows[0]!.id;
  m82 = await ins("WiFi5Soft 01", "192.168.194.82");
  m127 = await ins("WiFi5Soft 02", "192.168.194.127");
  mOutside = await ins("Elsewhere", "10.20.30.40");
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const api = (method: "GET" | "POST" | "DELETE", url: string, cookie?: string) =>
  app!.inject({ method, url: "/api/v1" + url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });

describe("gateway disabled (default)", () => {
  it("reports disabled and never touches the network", async () => {
    await start({ GATEWAY_ENABLED: "false" });
    expect(gatewayStatusSchema.parse((await api("GET", "/gateway/status", admin)).json())).toMatchObject({ enabled: false, gateway: "disabled" });
    const check = gatewayCheckSchema.parse((await api("POST", `/gateway/machines/${m82}/check`, admin)).json());
    expect(check).toMatchObject({ gateway: "disabled", adminHttp: "unknown", internet: "unverified", httpStatus: null });
    expect(calls).toEqual([]);
  });
});

describe("access", () => {
  it("every gateway admin route needs a session and the Admin role", async () => {
    await start();
    for (const [method, url] of [
      ["GET", "/gateway/status"],
      ["POST", `/gateway/machines/${m82}/check`],
      ["POST", "/gateway/check"],
    ] as const) {
      expect((await api(method, url)).statusCode, url).toBe(401);
      expect((await api(method, url, viewer)).statusCode, url).toBe(403);
    }
    expect(calls).toEqual([]);
  });
});

describe("checks", () => {
  it("checks exactly the registered machine's admin URL; three separate signals", async () => {
    await start();
    const res = await api("POST", `/gateway/machines/${m82}/check`, admin);
    const check = gatewayCheckSchema.parse(res.json());
    expect(check).toMatchObject({ machineId: m82, gateway: "unknown", adminHttp: "reachable", httpStatus: 200, internet: "unverified", error: null });
    expect(calls.map((c) => [c.method, c.url])).toEqual([["GET", "http://192.168.194.82/admin"]]);
  });

  it("records the admin HTTP result for signed-in users; unchecked machines stay unknown; internet stays unverified", async () => {
    await start();
    expect((await api("GET", "/machines")).statusCode).toBe(401);
    await api("POST", `/gateway/machines/${m82}/check`, admin);
    const list = machineListResponseSchema.parse((await api("GET", "/machines", viewer)).json()).items;
    const by = (id: string) => list.find((m) => m.id === id)!.state;
    expect(by(m82)).toMatchObject({ http: "reachable", internet: "unverified", zeroTier: "unknown", monitor: "unknown" });
    expect(by(m82).lastCheckAt).toBe(by(m82).lastSuccessAt);
    expect(by(m127)).toMatchObject({ http: "unknown", lastCheckAt: null, internet: "unverified" });
    const rows = (await pglite.query("select machine_id, ok, http_code, error_kind, trigger from checks")).rows;
    expect(rows).toEqual([{ machine_id: m82, ok: true, http_code: 200, error_kind: null, trigger: "manual" }]);
  });

  it("failures count up and keep the last success; a paused machine stays paused", async () => {
    await start({}, { zerotier: { nodeState: async () => "online" } });
    await api("POST", `/gateway/machines/${m82}/check`, admin);
    await pglite.query("update machine_state set monitor_health = 'paused' where machine_id = $1", [m82]);
    device = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    await api("POST", `/gateway/machines/${m82}/check`, admin);
    await api("POST", `/gateway/machines/${m82}/check`, admin);
    const s = (await pglite.query<Record<string, unknown>>("select http_status, consecutive_failures, monitor_health, internet_state, last_success_at < last_check_at as older from machine_state where machine_id = $1", [m82])).rows[0];
    expect(s).toEqual({ http_status: "unreachable", consecutive_failures: 2, monitor_health: "paused", internet_state: "unverified", older: true });
    const kinds = (await pglite.query("select ok, error_kind from checks order by id")).rows;
    expect(kinds).toEqual([{ ok: true, error_kind: null }, { ok: false, error_kind: "refused" }, { ok: false, error_kind: "refused" }]);
  });

  it("only two results: a 5xx answer is reachable; no answer is unreachable only when the gateway node is confirmed online", async () => {
    device = () => new Response("oops", { status: 500 });
    await start();
    expect((await api("POST", `/gateway/machines/${m82}/check`, admin)).json()).toMatchObject({ adminHttp: "reachable", httpStatus: 500 });
    device = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
    };
    // Gateway node state unknown (no local ZeroTier API): the failure may be ours, so the last valid result stays.
    const unverified = gatewayCheckSchema.parse((await api("POST", `/gateway/machines/${m82}/check`, admin)).json());
    expect(unverified).toMatchObject({ gateway: "unknown", adminHttp: "unknown", error: "monitor" });
    const state = async () => (await pglite.query<{ http_status: string }>("select http_status from machine_state where machine_id = $1", [m82])).rows[0]!.http_status;
    expect(await state()).toBe("reachable");
    expect((await pglite.query("select count(*)::int as n from checks")).rows).toEqual([{ n: 1 }]);
    await app!.close();
    await start({}, { zerotier: { nodeState: async () => "online" } });
    await api("POST", `/gateway/machines/${m82}/check`, admin);
    expect(await state()).toBe("unreachable");
  });

  it("checks that never ran record nothing (gateway disabled or offline, target refused)", async () => {
    await start({ GATEWAY_ENABLED: "false" });
    await api("POST", "/gateway/check", admin);
    await app!.close();
    await start({}, { zerotier: { nodeState: async () => "offline" } });
    await api("POST", "/gateway/check", admin);
    await app!.close();
    await start();
    await api("POST", `/gateway/machines/${mOutside}/check`, admin);
    expect((await pglite.query("select count(*)::int as n from checks")).rows).toEqual([{ n: 0 }]);
    expect((await pglite.query("select count(*)::int as n from machine_state where http_status <> 'unknown'")).rows).toEqual([{ n: 0 }]);
    expect(calls).toEqual([]);
  });

  it("never follows a redirect, even to another host", async () => {
    device = () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    await start();
    const check = gatewayCheckSchema.parse((await api("POST", `/gateway/machines/${m82}/check`, admin)).json());
    expect(check).toMatchObject({ adminHttp: "reachable", httpStatus: 302 });
    expect(calls.map((c) => c.url)).toEqual(["http://192.168.194.82/admin"]);
  });

  it("checks registered WiFi5Soft machines only, and only their own admin path", async () => {
    const other = (await pglite.query<{ id: string }>("insert into machines (name, zt_ip, software) values ('Legacy', '192.168.194.90', 'Other') returning id")).rows[0]!.id;
    const sneaky = (await pglite.query<{ id: string }>("insert into machines (name, zt_ip, admin_path) values ('Sneaky', '192.168.194.91', '//evil.example/admin') returning id")).rows[0]!.id;
    await start();
    expect((await api("POST", `/gateway/machines/${other}/check`, admin)).statusCode).toBe(404);
    expect((await api("POST", `/gateway/machines/${crypto.randomUUID()}/check`, admin)).statusCode).toBe(404);
    expect((await api("POST", `/gateway/machines/${sneaky}/check`, admin)).json()).toMatchObject({ adminHttp: "unknown", error: "monitor" });
    const items = (await api("POST", "/gateway/check", admin)).json().items as { machineId: string }[];
    expect(items.map((c) => c.machineId)).not.toContain(other);
    expect(calls.map((c) => c.url).sort()).toEqual(["http://192.168.194.127/admin", "http://192.168.194.82/admin"]);
  });

  it("refuses machines outside the allowed range without any request", async () => {
    await start();
    const check = gatewayCheckSchema.parse((await api("POST", `/gateway/machines/${mOutside}/check`, admin)).json());
    expect(check).toMatchObject({ adminHttp: "unknown", error: "monitor" });
    expect(calls).toEqual([]);
  });

  it("checks all machines with bounded concurrency", async () => {
    let inFlight = 0;
    let max = 0;
    device = async () => {
      max = Math.max(max, ++inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return new Response("ok", { status: 200 });
    };
    await pglite.query("insert into machines (name, zt_ip) values ('WiFi5Soft 03', '192.168.194.90')");
    await start({ GATEWAY_MAX_CONCURRENCY: "2" });
    const res = await api("POST", "/gateway/check", admin);
    expect(res.json().items.map((c: { adminHttp: string }) => c.adminHttp).sort()).toEqual(["reachable", "reachable", "reachable", "unknown"]);
    expect(max).toBe(2);
  });

  it("an offline gateway node skips the check before contacting machines", async () => {
    await start({}, { zerotier: { nodeState: async () => "offline" } });
    expect((await api("GET", "/gateway/status", admin)).json().gateway).toBe("offline");
    const check = gatewayCheckSchema.parse((await api("POST", `/gateway/machines/${m82}/check`, admin)).json());
    expect(check).toMatchObject({ gateway: "offline", adminHttp: "unknown", error: "monitor" });
    expect(calls).toEqual([]);
  });

  it("an unreachable admin interface is reported as unreachable, with the gateway online", async () => {
    device = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    await start({}, { zerotier: { nodeState: async () => "online" } });
    const check = gatewayCheckSchema.parse((await api("POST", `/gateway/machines/${m127}/check`, admin)).json());
    expect(check).toMatchObject({ gateway: "online", adminHttp: "unreachable", error: "refused" });
  });
});
