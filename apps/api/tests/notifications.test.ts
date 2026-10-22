/* Status-change notifications (n8n → Gmail): verified transitions only, stored with the check, delivered server to
   server with persistent retries and a stable event ID. No network access: fake device transport and fake webhook. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { notificationPayloadSchema } from "@pisowifi/shared";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema/index.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import { hashPassword } from "../src/auth/password.js";
import { createGatewayChecker } from "../src/gateway/checker.js";
import type { GatewayTransport } from "../src/gateway/probe.js";
import type { ZeroTierClient } from "../src/gateway/zerotier.js";
import { backoffSeconds, createNotificationDispatcher, leaseSeconds, type WebhookFetch } from "../src/notifications/dispatcher.js";
import { buildPayload, formatDowntime, manilaDateTime } from "../src/notifications/payload.js";

const SECRET = "s".repeat(40);
const HOOK = "https://n8n.example.com/webhook/pisowifi-status";
const BASE = { NODE_ENV: "test", GATEWAY_ENABLED: "true", ZT_ALLOWED_CIDRS: "192.168.194.0/24", GATEWAY_TIMEOUT_MS: "1000" };
const N8N = { N8N_ENABLED: "true", N8N_WEBHOOK_URL: HOOK, N8N_WEBHOOK_SECRET: SECRET };
const online: ZeroTierClient = { nodeState: async () => "online" };

let pglite: PGlite;
let db: Db;
let m1: string;
let up = true;
const transport: GatewayTransport = async () => {
  if (up) return new Response("<html>login</html>", { status: 200 });
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
};

beforeAll(async () => {
  pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  await migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
  db = { orm: orm as never, pool: null as never, check: async () => true, close: async () => {} };
});
afterAll(() => pglite.close());

beforeEach(async () => {
  up = true;
  await pglite.exec("delete from notification_deliveries; delete from events; delete from outages; delete from checks; delete from machines; delete from notification_prefs; delete from sessions; delete from users;");
  m1 = (await pglite.query<{ id: string }>("insert into machines (name, zt_ip) values ('PISOWIFI 2', '192.168.194.82') returning id")).rows[0]!.id;
  // The three accounts of the deployment (two Administrators and one Member), with test-only addresses.
  for (const [email, name, role, at] of ACCOUNTS) {
    await pglite.query("insert into users (email, display_name, password_hash, role, created_at) values ($1, $2, 'x', $3, $4)", [email, name, role, at]);
  }
});
const ACCOUNTS = [
  ["rey@example.invalid", "Rey", "admin", "2026-10-01T00:00:00Z"],
  ["cris@example.invalid", "Cris", "admin", "2026-10-02T00:00:00Z"],
  ["member@example.invalid", "Member", "viewer", "2026-10-03T00:00:00Z"],
] as const;
const recipientEmails = (p: { recipients: { email: string }[] }) => p.recipients.map((r) => r.email);

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pglite.query<T>(text, params)).rows;
const checker = (env: Record<string, string> = {}, zerotier: ZeroTierClient | null = online, onStatusChange?: () => void) =>
  createGatewayChecker({ config: loadConfig({ ...BASE, ...N8N, ...env }), db, transport, zerotier, onStatusChange });
const target = () => ({ id: m1, ztIp: "192.168.194.82", adminPath: "/admin" });

describe("payload", () => {
  it("machine name, status, detection date and time in Asia/Manila; no cause; matches the shared contract", () => {
    const at = new Date("2026-10-12T12:44:07Z");
    expect(manilaDateTime(at)).toEqual({ date: "October 12, 2026", time: "8:44 PM" });
    expect(manilaDateTime(new Date("2026-10-12T17:05:00Z"))).toEqual({ date: "October 13, 2026", time: "1:05 AM" });
    const recipients = [{ id: crypto.randomUUID(), email: "rey@example.invalid" }, { id: crypto.randomUUID(), email: "member@example.invalid" }];
    const p = buildPayload({ eventId: crypto.randomUUID(), kind: "unreachable", machine: { id: crypto.randomUUID(), name: "PISOWIFI 2", ip: "192.168.194.82" }, detectedAt: at, recipients });
    expect(notificationPayloadSchema.parse(p)).toMatchObject({
      event: "machine.unreachable",
      status: "Unreachable",
      previousStatus: "Reachable",
      detectedAt: "2026-10-12T12:44:07.000Z",
      detectedDate: "October 12, 2026",
      detectedTime: "8:44 PM",
      timeZone: "Asia/Manila",
      subject: "[PisoWiFi Alert] PISOWIFI 2 is Offline",
      machine: { name: "PISOWIFI 2", ip: "192.168.194.82" },
    });
    expect(p.text).toBe(
      `PISOWIFI 2 is Offline.\n\nMachine: PISOWIFI 2\nPrevious Status: Online\nCurrent Status: Offline\nDetected: October 12, 2026, 8:44 PM (Asia/Manila)\n\nEvent ID: ${p.eventId}`,
    );
    expect(p).not.toHaveProperty("downtimeSeconds");
    expect(p.recipients).toEqual(recipients);
    // The email (subject and text) says Online / Offline / Back Online; only the contract fields keep Reachable / Unreachable.
    expect(p.subject + p.text).not.toMatch(/Reachable|Unreachable/);
    expect(JSON.stringify(p)).not.toMatch(/timed out|refused|power|ISP|cause|report|telegram/i);
    const up = buildPayload({ eventId: p.eventId, kind: "reachable", machine: p.machine, detectedAt: at, recipients });
    expect(notificationPayloadSchema.parse(up)).toMatchObject({ event: "machine.reachable", status: "Reachable", previousStatus: "Unreachable", subject: "[PisoWiFi Recovery] PISOWIFI 2 is Back Online" });
    expect(up.text.split("\n").slice(0, 6)).toEqual(["PISOWIFI 2 is Back Online.", "", "Machine: PISOWIFI 2", "Previous Status: Offline", "Current Status: Online", "Recovered: October 12, 2026, 8:44 PM (Asia/Manila)"]);
    expect(up.text).not.toContain("Downtime");
    expect(up.subject + up.text).not.toMatch(/Reachable|Unreachable/);
  });

  it("Back Online carries downtime only from an outage record; Offline never does; never estimated", () => {
    const at = new Date("2026-10-21T13:45:00Z");
    const base = { eventId: crypto.randomUUID(), machine: { id: crypto.randomUUID(), name: "Cris Pisowifi", ip: "192.168.194.82" }, detectedAt: at, recipients: [{ id: crypto.randomUUID(), email: "a@example.invalid" }] };
    const up = buildPayload({ ...base, kind: "reachable", outageStartedAt: new Date("2026-10-21T13:30:00Z") });
    expect(notificationPayloadSchema.parse(up)).toMatchObject({ outageStartedAt: "2026-10-21T13:30:00.000Z", downtimeSeconds: 900 });
    expect(up.text).toContain("Recovered: October 21, 2026, 9:45 PM (Asia/Manila)\nDowntime: 15 minutes\n\nEvent ID: ");
    expect(buildPayload({ ...base, kind: "reachable", outageStartedAt: null })).not.toHaveProperty("downtimeSeconds");
    expect(buildPayload({ ...base, kind: "reachable", outageStartedAt: new Date("2026-10-21T14:00:00Z") })).not.toHaveProperty("downtimeSeconds"); // clock went back
    expect(buildPayload({ ...base, kind: "unreachable", outageStartedAt: new Date("2026-10-21T13:30:00Z") })).not.toHaveProperty("downtimeSeconds");
    expect([0, 59, 60, 900, 3900, 90000, 86460].map(formatDowntime)).toEqual(["less than 1 minute", "less than 1 minute", "1 minute", "15 minutes", "1 hour 5 minutes", "1 day 1 hour", "1 day 1 minute"]);
    const down = buildPayload({ ...base, kind: "unreachable" });
    for (const bad of [{ ...down, outageStartedAt: up.outageStartedAt, downtimeSeconds: 900 }, { ...up, downtimeSeconds: undefined }, { ...up, downtimeSeconds: -1 }, { ...up, downtimeSeconds: 1.5 }]) {
      expect(notificationPayloadSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("the contract requires 1–20 unique recipients with valid addresses", () => {
    const base = buildPayload({ eventId: crypto.randomUUID(), kind: "unreachable", machine: { id: crypto.randomUUID(), name: "A", ip: "192.168.194.82" }, detectedAt: new Date(), recipients: [{ id: crypto.randomUUID(), email: "a@example.invalid" }] });
    expect(notificationPayloadSchema.safeParse(base).success).toBe(true);
    const id = crypto.randomUUID();
    for (const recipients of [[], [{ id, email: "a@example.invalid" }, { id, email: "b@example.invalid" }], [{ id, email: "not-an-address" }], Array.from({ length: 21 }, (_, i) => ({ id: crypto.randomUUID(), email: `u${i}@example.invalid` }))]) {
      expect(notificationPayloadSchema.safeParse({ ...base, recipients }).success).toBe(false);
    }
  });
});

describe("config", () => {
  it("enabling n8n needs the URL and a long secret; https only (loopback http for local tests); no credentials in the URL", () => {
    expect(loadConfig({}).N8N_ENABLED).toBe(false);
    expect(() => loadConfig({ N8N_ENABLED: "true" })).toThrow(/N8N_WEBHOOK_URL: is required[\s\S]*N8N_WEBHOOK_SECRET: is required/);
    expect(() => loadConfig({ ...N8N, N8N_WEBHOOK_SECRET: "short" })).toThrow(/N8N_WEBHOOK_SECRET: must be at least 32 characters/);
    expect(() => loadConfig({ ...N8N, N8N_WEBHOOK_URL: "http://n8n.example.com/webhook/x" })).toThrow(/must use https/);
    expect(() => loadConfig({ ...N8N, N8N_WEBHOOK_URL: "https://user:pw@n8n.example.com/webhook/x" })).toThrow(/must not contain credentials/);
    expect(loadConfig({ ...N8N, N8N_WEBHOOK_URL: "http://127.0.0.1:5678/webhook/x" }).N8N_ENABLED).toBe(true);
    expect(() => loadConfig({ MONITOR_SCHEDULE_ENABLED: "true" })).toThrow(/MONITOR_SCHEDULE_ENABLED: needs GATEWAY_ENABLED=true/);
    const workerConfig = loadConfig({ ...BASE, MONITOR_SCHEDULE_ENABLED: "true", ZT_NETWORK_ID: "0123456789abcdef", ZT_AUTHTOKEN_FILE: "package.json" });
    expect(workerConfig).toMatchObject({
      MONITOR_SCHEDULE_ENABLED: true,
      REMOTE_GATEWAY_ENABLED: false,
    });
    expect(workerConfig.REMOTE_TICKET_PRIVATE_KEY_FILE).toBeUndefined();
    try {
      loadConfig({ ...N8N, N8N_WEBHOOK_URL: "https://n8n.example.com/x", N8N_WEBHOOK_SECRET: "tiny-secret-value" });
    } catch (err) {
      expect(String(err)).not.toContain("tiny-secret-value");
    }
  });
});

describe("verified status changes", () => {
  it("first result and unchanged status queue nothing; each change is one event and one notification", async () => {
    const c = checker();
    await c.check(target()); // unknown → reachable: first result, not a change
    await c.check(target()); // unchanged
    expect(await q("select count(*)::int n from events")).toEqual([{ n: 0 }]);
    expect(await q("select count(*)::int n from notification_deliveries")).toEqual([{ n: 0 }]);

    up = false;
    await c.check(target()); // reachable → unreachable
    await c.check(target()); // still unreachable: no repeat
    up = true;
    await c.check(target()); // unreachable → reachable
    await c.check(target());

    const ev = await q<{ type: string; status: string; message: string; meta: { from: string; to: string } }>("select type, status, message, meta from events order by id");
    expect(ev.map((e) => [e.type, e.status, e.message, e.meta.from, e.meta.to])).toEqual([
      ["outage", "unreachable", "Became Unreachable", "reachable", "unreachable"],
      ["recovery", "reachable", "Became Reachable", "unreachable", "reachable"],
    ]);
    const out = await q<{ open: boolean }>("select ended_at is null as open from outages");
    expect(out).toEqual([{ open: false }]);
    const d = await q<{ kind: string; status: string; attempts: number; payload: { eventId: string; machine: { name: string }; status: string }; id: string }>(
      "select id, kind, status, attempts, payload from notification_deliveries order by created_at",
    );
    expect(d.map((x) => [x.kind, x.status, x.attempts, x.payload.status, x.payload.machine.name])).toEqual([
      ["unreachable", "pending", 0, "Unreachable", "PISOWIFI 2"],
      ["reachable", "pending", 0, "Reachable", "PISOWIFI 2"],
    ]);
    expect(d.every((x) => x.payload.eventId === x.id)).toBe(true);
  });

  it("all three active accounts (two Administrators and the Member) receive both alerts, in sign-up order", async () => {
    const c = checker();
    await c.check(target());
    up = false;
    await c.check(target());
    up = true;
    await c.check(target());
    const d = await q<{ kind: string; payload: { recipients: { id: string; email: string }[]; subject: string } }>("select kind, payload from notification_deliveries order by created_at");
    const ids = (await q<{ id: string }>("select id from users order by created_at")).map((u) => u.id);
    expect(d.map((x) => [x.kind, recipientEmails(x.payload)])).toEqual([
      ["unreachable", ["rey@example.invalid", "cris@example.invalid", "member@example.invalid"]],
      ["reachable", ["rey@example.invalid", "cris@example.invalid", "member@example.invalid"]],
    ]);
    expect(d.every((x) => x.payload.recipients.map((r) => r.id).join() === ids.join())).toBe(true);
    expect(d.map((x) => x.payload.subject)).toEqual(["[PisoWiFi Alert] PISOWIFI 2 is Offline", "[PisoWiFi Recovery] PISOWIFI 2 is Back Online"]);
  });

  it("Back Online downtime comes from the outage record closed in the same transaction; without one there is none", async () => {
    const c = checker();
    await c.check(target());
    up = false;
    await c.check(target());
    await q("update outages set started_at = now() - interval '15 minutes 20 seconds' where ended_at is null");
    up = true;
    await c.check(target());
    const rows = await q<{ kind: string; payload: { downtimeSeconds?: number; outageStartedAt?: string; text: string } }>("select kind, payload from notification_deliveries order by created_at");
    const [offline, recovery] = rows;
    expect(offline!.payload).not.toHaveProperty("downtimeSeconds");
    const outage = (await q<{ started_at: string; ended_at: string }>("select started_at, ended_at from outages"))[0]!;
    expect(recovery!.payload.outageStartedAt).toBe(new Date(outage.started_at).toISOString());
    expect(recovery!.payload.downtimeSeconds).toBe(Math.floor((new Date(outage.ended_at).getTime() - new Date(outage.started_at).getTime()) / 1000));
    expect(recovery!.payload.text).toContain("Downtime: 15 minutes");
    // A recovery with no open outage record (e.g. removed by hand) gets no downtime rather than a guessed one.
    up = false;
    await c.check(target());
    await q("delete from outages where ended_at is null");
    up = true;
    await c.check(target());
    const last = (await q<{ payload: { downtimeSeconds?: number; text: string } }>("select payload from notification_deliveries order by created_at desc limit 1"))[0]!;
    expect(last.payload).not.toHaveProperty("downtimeSeconds");
    expect(last.payload.text).not.toContain("Downtime");
  });

  it("deactivated accounts and per-kind opt-outs are left out; recipients are fixed when the change is recorded", async () => {
    await pglite.exec("update users set disabled_at = now() where email = 'cris@example.invalid'");
    await pglite.exec("insert into notification_prefs (user_id, offline, recovery) select id, true, false from users where email = 'member@example.invalid'");
    const c = checker();
    await c.check(target());
    up = false;
    await c.check(target());
    await pglite.exec("update users set disabled_at = null where email = 'cris@example.invalid'"); // after the change: no effect on it
    up = true;
    await c.check(target());
    const d = await q<{ kind: string; payload: { recipients: { email: string }[] } }>("select kind, payload from notification_deliveries order by created_at");
    expect(d.map((x) => [x.kind, recipientEmails(x.payload)])).toEqual([
      ["unreachable", ["rey@example.invalid", "member@example.invalid"]],
      ["reachable", ["rey@example.invalid", "cris@example.invalid"]],
    ]);
  });

  it("with nobody to notify the change is still recorded, but no delivery is queued", async () => {
    await pglite.exec("insert into notification_prefs (user_id, offline, recovery) select id, false, true from users");
    const c = checker();
    await c.check(target());
    up = false;
    await c.check(target());
    expect(await q("select type from events")).toEqual([{ type: "outage" }]);
    expect(await q("select count(*)::int n from notification_deliveries")).toEqual([{ n: 0 }]);
  });

  it("monitoring-side failures never create a change or a notification", async () => {
    await checker().check(target()); // reachable
    up = false;
    // Gateway node state unknown (no local ZeroTier API): no answer is not a verified result.
    await checker({}, null).check(target());
    await checker({}, { nodeState: async () => "offline" }).check(target());
    await checker({ GATEWAY_ENABLED: "false", N8N_ENABLED: "false" }, online).check(target());
    expect(await q("select http_status from machine_state")).toEqual([{ http_status: "reachable" }]);
    expect(await q("select count(*)::int n from events")).toEqual([{ n: 0 }]);
    expect(await q("select count(*)::int n from notification_deliveries")).toEqual([{ n: 0 }]);
  });

  it("unexpected probe and network-path errors preserve the last verified result and send no alert", async () => {
    await checker().check(target());
    const before = await q<{ last_check_at: Date }>("select last_check_at from machine_state");
    const broken: GatewayTransport = async () => { throw new Error("unexpected transport failure"); };
    const noRoute: GatewayTransport = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENETUNREACH" } }); };
    for (const probe of [broken, noRoute]) {
      const c = createGatewayChecker({ config: loadConfig({ ...BASE, ...N8N }), db, transport: probe, zerotier: online });
      expect(await c.check(target())).toMatchObject({ adminHttp: "unknown", error: "monitor" });
    }
    expect(await q("select http_status, last_check_at from machine_state")).toEqual([{ http_status: "reachable", last_check_at: before[0]!.last_check_at }]);
    expect(await q("select count(*)::int n from checks")).toEqual([{ n: 1 }]);
    expect(await q("select count(*)::int n from events")).toEqual([{ n: 0 }]);
    expect(await q("select count(*)::int n from notification_deliveries")).toEqual([{ n: 0 }]);
  });

  it("does not mark a device unreachable when ZeroTier fails during its probe", async () => {
    await checker().check(target());
    up = false;
    let reads = 0;
    const unstable: ZeroTierClient = { nodeState: async () => ++reads === 1 ? "online" : "offline" };
    const result = await checker({}, unstable).check(target());
    expect(result).toMatchObject({ adminHttp: "unknown", error: "monitor" });
    expect(reads).toBe(2);
    expect(await q("select http_status from machine_state")).toEqual([{ http_status: "reachable" }]);
    expect(await q("select count(*)::int n from checks")).toEqual([{ n: 1 }]);
    expect(await q("select count(*)::int n from notification_deliveries")).toEqual([{ n: 0 }]);
  });

  it("with n8n disabled the change is still recorded, but nothing is queued", async () => {
    const c = checker({ N8N_ENABLED: "false" });
    await c.check(target());
    up = false;
    await c.check(target());
    expect(await q("select type from events")).toEqual([{ type: "outage" }]);
    expect(await q("select count(*)::int n from notification_deliveries")).toEqual([{ n: 0 }]);
  });

  it("a change calls onStatusChange after commit; scheduled rounds skip paused machines", async () => {
    const kick = vi.fn();
    const c = checker({}, online, kick);
    await c.check(target());
    expect(kick).not.toHaveBeenCalled();
    up = false;
    await c.check(target());
    expect(kick).toHaveBeenCalledTimes(1);
    await pglite.query("update machines set monitoring_enabled = false where id = $1", [m1]);
    expect(await c.checkAll({ trigger: "schedule", skipPaused: true })).toEqual([]);
    expect((await c.checkAll()).length).toBe(1);
    expect(await q("select distinct trigger from checks order by 1")).toEqual([{ trigger: "manual" }]);
  });

  it("one notification per event at most (database unique key)", async () => {
    const c = checker();
    await c.check(target());
    up = false;
    await c.check(target());
    const [row] = await q<{ event_id: number; machine_id: string }>("select event_id, machine_id from notification_deliveries");
    await expect(
      pglite.query("insert into notification_deliveries (id, event_id, machine_id, kind, payload) values (gen_random_uuid(), $1, $2, 'unreachable', '{}')", [row!.event_id, row!.machine_id]),
    ).rejects.toThrow(/notification_deliveries_event_key/);
  });
});

describe("delivery to n8n", () => {
  async function queueOutage(env: Record<string, string> = {}) {
    const c = checker(env);
    await c.check(target());
    up = false;
    await c.check(target());
  }
  const dispatcher = (fetchImpl: WebhookFetch, env: Record<string, string> = {}, log?: Parameters<typeof createNotificationDispatcher>[0]["log"]) =>
    createNotificationDispatcher({ config: loadConfig({ ...BASE, ...N8N, ...env }) as Config, db, fetchImpl, log });
  /** Outage then recovery: two queued notifications, oldest first. */
  async function queueOutageAndRecovery() {
    await queueOutage();
    up = true;
    await checker().check(target());
  }
  /** A fake webhook that answers only when the test releases each request (a slow n8n / Gmail). */
  function gatedFetch() {
    const calls: { id: string; release: (status: number) => void }[] = [];
    const fetchImpl: WebhookFetch = (_u, init) =>
      new Promise((resolve) => calls.push({ id: init.headers["x-pisowifi-event-id"]!, release: (status) => resolve(new Response(null, { status })) }));
    return { calls, fetchImpl };
  }
  type Row = { id: string; status: string; attempts: number; last_error: string | null };
  const rows = () => q<Row>("select id, status, attempts, last_error from notification_deliveries order by created_at");
  const expireLeases = () => pglite.exec("update notification_deliveries set locked_until = now() - interval '1 second' where status = 'sending'");

  it("POSTs the stored payload server to server with bearer auth, stable event ID and an HMAC signature; sent once", async () => {
    await queueOutage();
    const seen: { url: string; headers: Record<string, string>; body: string; redirect: string }[] = [];
    const ok: WebhookFetch = async (url, init) => {
      seen.push({ url, headers: init.headers, body: init.body, redirect: init.redirect });
      return new Response("ok", { status: 200 });
    };
    const d = dispatcher(ok);
    expect(await d.deliverDue()).toEqual({ sent: 1, retrying: 0, failed: 0 });
    expect(await d.deliverDue()).toEqual({ sent: 0, retrying: 0, failed: 0 });
    expect(seen).toHaveLength(1);
    const [req] = seen;
    const [row] = await q<{ id: string; status: string; sent_at: string | null; attempts: number }>("select id, status, sent_at, attempts from notification_deliveries");
    expect(row).toMatchObject({ status: "sent", attempts: 1 });
    expect(req!.url).toBe(HOOK);
    expect(req!.redirect).toBe("manual");
    expect(req!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(req!.headers["x-pisowifi-event-id"]).toBe(row!.id);
    const ts = req!.headers["x-pisowifi-timestamp"]!;
    expect(req!.headers["x-pisowifi-signature"]).toBe("sha256=" + createHmac("sha256", SECRET).update(`${ts}.${req!.body}`).digest("hex"));
    expect(notificationPayloadSchema.parse(JSON.parse(req!.body))).toMatchObject({ eventId: row!.id, status: "Unreachable", machine: { name: "PISOWIFI 2", ip: "192.168.194.82" } });
  });

  it("failures are retried with persistent backoff (same event ID), then marked failed; no secret or URL in the stored error", async () => {
    await queueOutage({ N8N_MAX_ATTEMPTS: "3" });
    const ids: string[] = [];
    let status = 500;
    const failing: WebhookFetch = async (_u, init) => {
      ids.push(init.headers["x-pisowifi-event-id"]!);
      return new Response("no", { status });
    };
    const d = dispatcher(failing, { N8N_MAX_ATTEMPTS: "3" });
    expect(await d.deliverDue()).toEqual({ sent: 0, retrying: 1, failed: 0 });
    const r1 = (await q<{ status: string; attempts: number; last_error: string; last_http_status: number; wait: number }>(
      "select status, attempts, last_error, last_http_status, extract(epoch from next_attempt_at - now())::int as wait from notification_deliveries",
    ))[0]!;
    expect(r1).toMatchObject({ status: "pending", attempts: 1, last_error: "HTTP 500", last_http_status: 500 });
    expect(r1.wait).toBeGreaterThan(20);
    // Not due yet: nothing is sent.
    expect(await d.deliverDue()).toEqual({ sent: 0, retrying: 0, failed: 0 });
    await pglite.exec("update notification_deliveries set next_attempt_at = now() - interval '1 second'");
    status = 302;
    expect(await d.deliverDue()).toEqual({ sent: 0, retrying: 1, failed: 0 });
    await pglite.exec("update notification_deliveries set next_attempt_at = now() - interval '1 second'");
    status = 503;
    expect(await d.deliverDue()).toEqual({ sent: 0, retrying: 0, failed: 1 });
    const [last] = await q<{ status: string; attempts: number; last_error: string }>("select status, attempts, last_error from notification_deliveries");
    expect(last).toEqual({ status: "failed", attempts: 3, last_error: "HTTP 503" });
    expect(new Set(ids).size).toBe(1);
    const stored = JSON.stringify(await q("select last_error, payload from notification_deliveries"));
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain("n8n.example.com");
    expect([1, 2, 3, 8, 20].map(backoffSeconds)).toEqual([30, 60, 120, 3600, 3600]);
  });

  it("timeouts and network errors are retried; a crashed attempt is taken over after its lock expires", async () => {
    await queueOutage();
    const hang: WebhookFetch = (_u, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
    const d = dispatcher(hang, { N8N_TIMEOUT_MS: "1000" });
    expect(await d.deliverDue()).toEqual({ sent: 0, retrying: 1, failed: 0 });
    expect(await q("select last_error from notification_deliveries")).toEqual([{ last_error: "timeout" }]);
    // Simulate a process that died while sending.
    await pglite.exec("update notification_deliveries set status = 'sending', locked_until = now() - interval '1 second'");
    const ok = dispatcher(async () => new Response(null, { status: 204 }));
    expect(await ok.deliverDue()).toEqual({ sent: 1, retrying: 0, failed: 0 });
  });

  it("nothing is sent while n8n is disabled", async () => {
    await queueOutage();
    const spy = vi.fn<WebhookFetch>(async () => new Response("ok"));
    const d = dispatcher(spy, { N8N_ENABLED: "false" });
    expect(d.enabled()).toBe(false);
    expect(await d.deliverDue()).toEqual({ sent: 0, retrying: 0, failed: 0 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("claims one row at a time under a lease longer than the request timeout; a concurrent dispatcher takes the next row, never the same one", async () => {
    await queueOutageAndRecovery();
    for (const t of [1000, 10_000, 30_000]) expect(leaseSeconds(t)).toBeGreaterThanOrEqual(t / 1000 + 30);
    const slow = gatedFetch();
    const a = dispatcher(slow.fetchImpl, { N8N_TIMEOUT_MS: "30000" });
    const roundA = a.deliverDue();
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    // Only the request in flight is claimed; its lease covers the 30 s timeout plus the margin.
    const during = await q<{ status: string; attempts: number; lease: number | null }>(
      "select status, attempts, extract(epoch from locked_until - now())::int as lease from notification_deliveries order by created_at",
    );
    expect(during.map((r) => [r.status, r.attempts])).toEqual([["sending", 1], ["pending", 0]]);
    expect(during[0]!.lease).toBeGreaterThanOrEqual(55);
    expect(during[0]!.lease).toBeLessThanOrEqual(leaseSeconds(30_000));

    const sentByB: string[] = [];
    const b = dispatcher(async (_u, init) => (sentByB.push(init.headers["x-pisowifi-event-id"]!), new Response(null, { status: 200 })));
    expect(await b.deliverDue()).toEqual({ sent: 1, retrying: 0, failed: 0 });
    slow.calls[0]!.release(200);
    expect(await roundA).toEqual({ sent: 1, retrying: 0, failed: 0 });

    const [r1, r2] = await rows();
    expect(slow.calls.map((c) => c.id)).toEqual([r1!.id]);
    expect(sentByB).toEqual([r2!.id]);
    expect([r1!.status, r2!.status]).toEqual(["sent", "sent"]);
  });

  it("an attempt whose lease expired cannot overwrite a newer claim: its late failure is discarded", async () => {
    await queueOutage();
    const logs: string[] = [];
    const first = gatedFetch();
    const second = gatedFetch();
    const a = dispatcher(first.fetchImpl, {}, (msg) => logs.push(msg));
    const b = dispatcher(second.fetchImpl);
    const roundA = a.deliverDue();
    await vi.waitFor(() => expect(first.calls).toHaveLength(1));
    await expireLeases();
    const roundB = b.deliverDue();
    await vi.waitFor(() => expect(second.calls).toHaveLength(1));
    expect(second.calls[0]!.id).toBe(first.calls[0]!.id);

    // The stale attempt (attempts = 1) fails while the newer claim (attempts = 2) is still in flight.
    first.calls[0]!.release(500);
    expect(await roundA).toEqual({ sent: 0, retrying: 0, failed: 0 });
    expect(await rows()).toMatchObject([{ status: "sending", attempts: 2, last_error: null }]);
    expect(logs.some((m) => /taken over by a newer attempt/.test(m))).toBe(true);

    second.calls[0]!.release(200);
    expect(await roundB).toEqual({ sent: 1, retrying: 0, failed: 0 });
    expect(await rows()).toMatchObject([{ status: "sent", attempts: 2, last_error: null }]);
  });

  it("an attempt whose lease expired cannot overwrite a newer claim: its late success is logged, not recorded twice", async () => {
    await queueOutage();
    const logs: string[] = [];
    const first = gatedFetch();
    const a = dispatcher(first.fetchImpl, {}, (msg) => logs.push(msg));
    const roundA = a.deliverDue();
    await vi.waitFor(() => expect(first.calls).toHaveLength(1));
    await expireLeases();
    // A newer claim fails and schedules a retry; the stale attempt then succeeds.
    const b = dispatcher(async () => new Response(null, { status: 503 }));
    expect(await b.deliverDue()).toEqual({ sent: 0, retrying: 1, failed: 0 });
    first.calls[0]!.release(200);
    expect(await roundA).toEqual({ sent: 0, retrying: 0, failed: 0 });
    expect(await rows()).toMatchObject([{ status: "pending", attempts: 2, last_error: "HTTP 503" }]);
    expect(logs.some((m) => /delivered, but its claim had been taken over/.test(m))).toBe(true);
  });

  it("graceful shutdown: no new claims once stop() begins; the request in flight finishes and is recorded", async () => {
    await queueOutageAndRecovery();
    const slow = gatedFetch();
    const d = dispatcher(slow.fetchImpl);
    d.start(60_000);
    await vi.waitFor(() => expect(slow.calls).toHaveLength(1));
    let stopped = false;
    const stopping = d.stop().then(() => (stopped = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(stopped).toBe(false); // waits for the request in flight
    slow.calls[0]!.release(200);
    await stopping;
    expect((await rows()).map((r) => [r.status, r.attempts])).toEqual([["sent", 1], ["pending", 0]]);
    // After shutdown nothing claims or sends.
    d.kick();
    d.start(60_000);
    expect(await d.deliverDue()).toEqual({ sent: 0, retrying: 0, failed: 0 });
    await new Promise((r) => setTimeout(r, 20));
    expect(slow.calls).toHaveLength(1);
    expect((await rows())[1]).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("rejected credentials and exhausted retries are logged as errors with an operator hint; no secret or URL in logs", async () => {
    await queueOutage({ N8N_MAX_ATTEMPTS: "3" });
    const logs: { msg: string; meta?: Record<string, unknown>; level?: string }[] = [];
    let status = 500;
    const d = dispatcher(async () => new Response(null, { status }), { N8N_MAX_ATTEMPTS: "3" }, (msg, meta, level) => logs.push({ msg, meta, level }));
    const due = () => pglite.exec("update notification_deliveries set next_attempt_at = now() - interval '1 second'");
    expect(await d.deliverDue()).toEqual({ sent: 0, retrying: 1, failed: 0 });
    await due();
    status = 401;
    expect(await d.deliverDue()).toEqual({ sent: 0, retrying: 1, failed: 0 });
    await due();
    status = 404;
    expect(await d.deliverDue()).toEqual({ sent: 0, retrying: 0, failed: 1 });

    expect(logs.map((l) => [l.level ?? "warn", l.meta?.httpStatus, l.meta?.attempts])).toEqual([
      ["warn", 500, 1],
      ["error", 401, 2],
      ["error", 404, 3],
    ]);
    expect(logs[0]!.meta).not.toHaveProperty("hint");
    expect(logs[1]!.meta?.hint).toMatch(/Header Auth/);
    expect(logs[2]!.msg).toMatch(/retries exhausted/);
    expect(logs[2]!.meta).toMatchObject({ maxAttempts: 3, error: "HTTP 404", hint: expect.stringMatching(/workflow active/) });
    const [row] = await rows();
    expect(logs[2]!.meta?.deliveryId).toBe(row!.id);
    const text = JSON.stringify(logs);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("n8n.example.com");
  });

  it("a manual check through the API kicks delivery after a recorded change", async () => {
    const hash = await hashPassword("correct horse battery");
    await pglite.exec("delete from sessions; delete from users");
    await pglite.query("insert into users (email, display_name, password_hash, role) values ('admin@example.com', 'Admin', $1, 'admin')", [hash]);
    const kick = vi.fn();
    const ORIGIN = "http://localhost:3000";
    const app = await buildApp(loadConfig({ ...BASE, ...N8N, APP_ORIGIN: ORIGIN }), { db, gatewayTransport: transport, zerotier: online, notifier: { kick } as never });
    try {
      const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "admin@example.com", password: "correct horse battery" }, headers: { origin: ORIGIN } });
      const c = login.cookies.find((x) => x.name.endsWith("pisowifi_session"))!;
      const call = () => app.inject({ method: "POST", url: `/api/v1/gateway/machines/${m1}/check`, headers: { origin: ORIGIN, cookie: `${c.name}=${c.value}` } });
      await call();
      expect(kick).not.toHaveBeenCalled();
      up = false;
      await call();
      expect(kick).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});
