/* Monitoring history (GET /history): measured totals, slots without checks stay "none", outages and recovery
   durations, machine filter, auth and validation. Real migrations on PGlite; requests through app.inject(). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { TIMELINE_SLOTS, historyResponseSchema } from "@pisowifi/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema/index.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import { hashPassword } from "../src/auth/password.js";

const ORIGIN = "http://localhost:3000";
const PW = "correct horse battery";
const HOUR = 3_600_000;
const MIN = 60_000;

let pglite: PGlite;
let app: FastifyInstance;
let cookie: string;
let m1: string;
let m2: string;
// A fixed 4-hour window that ends 1 hour ago, so "now" never clips it.
const to = new Date(Math.floor(Date.now() / HOUR) * HOUR - HOUR);
const from = new Date(to.getTime() - 4 * HOUR);
const at = (h: number, m = 0) => new Date(from.getTime() + h * HOUR + m * MIN).toISOString();

const get = (qs: string, c: string | null = cookie) => app.inject({ method: "GET", url: "/api/v1/history?" + qs, headers: c ? { cookie: c } : {} });
const win = (extra = "") => `from=${from.toISOString()}&to=${to.toISOString()}&buckets=4${extra}`;

beforeAll(async () => {
  pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  await migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
  const db: Db = { orm: orm as never, pool: null as never, check: async () => true, close: async () => {} };
  await pglite.query("insert into users (email, display_name, password_hash, role) values ('viewer@example.com', 'Viewer', $1, 'viewer')", [await hashPassword(PW)]);
  const ins = await pglite.query<{ id: string }>(
    "insert into machines (name, zt_ip) values ('PISOWIFI 1', '192.168.194.127'), ('PISOWIFI 2', '192.168.194.82') returning id",
  );
  [m1, m2] = ins.rows.map((r) => r.id) as [string, string];
  // PISOWIFI 1: hour 0 two good checks, hour 1 one good + one failed (outage 1:30 -> 2:30), hour 2 nothing, hour 3 good.
  const check = (m: string, t: string, ok: boolean, ms: number | null) =>
    pglite.query("insert into checks (machine_id, started_at, ok, http_code, duration_ms, error_kind, trigger) values ($1, $2, $3, $4, $5, $6, 'schedule')", [
      m,
      t,
      ok,
      ok ? 200 : null,
      ms,
      ok ? null : "timeout",
    ]);
  await check(m1, at(0, 10), true, 200);
  await check(m1, at(0, 40), true, 300);
  await check(m1, at(1, 10), true, 400);
  await check(m1, at(1, 30), false, null);
  await check(m1, at(3, 10), true, 100);
  await check(m1, at(-1), true, 999); // before the window: ignored
  await pglite.query("insert into outages (machine_id, started_at, ended_at) values ($1, $2, $3)", [m1, at(1, 30), at(2, 30)]);
  await pglite.query("insert into events (machine_id, type, status, message, occurred_at) values ($1, 'outage', 'unreachable', 'Became Unreachable', $2), ($1, 'recovery', 'reachable', 'Became Reachable', $3)", [
    m1,
    at(1, 30),
    at(2, 30),
  ]);
  await pglite.query("insert into machine_state (machine_id, http_status, last_check_at, last_success_at) values ($1, 'reachable', $2, $2)", [m1, at(3, 10)]);
  // PISOWIFI 2: never checked; an outage that is still ongoing started before the window.
  await pglite.query("insert into outages (machine_id, started_at) values ($1, $2)", [m2, at(-2)]);

  app = await buildApp(loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }), { db });
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: "viewer@example.com", password: PW }, headers: { origin: ORIGIN } });
  const c = res.cookies.find((x) => x.name.endsWith("pisowifi_session"))!;
  cookie = `${c.name}=${c.value}`;
});
afterAll(async () => {
  await app?.close();
  await pglite.close();
});

describe("GET /history", () => {
  it("requires a session", async () => {
    expect((await get(win(), null)).statusCode).toBe(401);
  });

  it("reports measured totals, slots and outages for each machine", async () => {
    const res = await get(win());
    expect(res.statusCode, res.body).toBe(200);
    const body = historyResponseSchema.parse(res.json());
    expect(body.machines.map((m) => m.machineId)).toEqual([m1, m2]);
    const a = body.machines[0]!;
    expect(a.totals).toMatchObject({ checks: 5, okChecks: 4, uptimePercent: 80, avgResponseMs: 250, downMinutes: 60, outages: 1 });
    expect(a.totals.lastSuccessAt).toBe(at(3, 10));
    expect(a.points.map((p) => [p.checks, p.okChecks, p.uptimePercent, p.avgResponseMs, p.downMinutes])).toEqual([
      [2, 2, 100, 250, 0],
      [2, 1, 50, 400, 30],
      [0, 0, null, null, 30], // no check: not Reachable, just not checked; the outage still counts as downtime
      [1, 1, 100, 100, 0],
    ]);
    expect(a.timeline).toHaveLength(TIMELINE_SLOTS);
    expect(a.timeline.filter((s) => s === "bad")).toHaveLength(1);
    expect(a.timeline.filter((s) => s === "ok")).toHaveLength(4);
    expect(a.recentChecks.map((c) => c.startedAt)).toEqual([at(3, 10), at(1, 30), at(1, 10), at(0, 40), at(0, 10)]);
    expect(a.recentChecks[1]).toMatchObject({ ok: false, httpCode: null, durationMs: null });
  });

  it("never invents a status for a machine without checks", async () => {
    const b = historyResponseSchema.parse((await get(win())).json()).machines[1]!;
    expect(b.totals).toMatchObject({ checks: 0, okChecks: 0, uptimePercent: null, avgResponseMs: null, lastSuccessAt: null });
    expect(b.timeline.every((s) => s === "none")).toBe(true);
    expect(b.recentChecks).toEqual([]);
    // The ongoing outage is clipped to the window.
    expect(b.totals).toMatchObject({ outages: 1, downMinutes: 240 });
  });

  it("lists status changes newest first, with the outage duration on recoveries", async () => {
    const body = historyResponseSchema.parse((await get(win())).json());
    expect(body.events.map((e) => [e.type, e.status, e.occurredAt])).toEqual([
      ["recovery", "reachable", at(2, 30)],
      ["outage", "unreachable", at(1, 30)],
    ]);
    expect(body.events[0]!.durationMinutes).toBe(60);
    expect(body.events[1]!.durationMinutes).toBeUndefined();
    expect(body.outages.find((o) => o.machineId === m2)).toMatchObject({ endedAt: null });
  });

  it("filters to one machine and answers 404 for an unknown one", async () => {
    const one = historyResponseSchema.parse((await get(win(`&machine=${m2}`))).json());
    expect(one.machines.map((m) => m.machineId)).toEqual([m2]);
    expect(one.events).toEqual([]);
    expect((await get(win("&machine=00000000-0000-4000-8000-000000000000"))).statusCode).toBe(404);
  });

  it("reads data up to now but keeps the requested calendar slots", async () => {
    const end = new Date(from.getTime() + 24 * HOUR); // e.g. today's daily slot ends at the coming midnight
    const res = historyResponseSchema.parse((await get(`from=${from.toISOString()}&to=${end.toISOString()}&buckets=2`)).json());
    expect(Date.parse(res.to)).toBeLessThanOrEqual(Date.now());
    const pts = res.machines[0]!.points;
    expect([pts[0]!.start, pts[0]!.end, pts[1]!.end]).toEqual([from.toISOString(), new Date(from.getTime() + 12 * HOUR).toISOString(), end.toISOString()]);
    expect(pts[0]!.checks + pts[1]!.checks).toBe(5);
  });

  it("rejects invalid windows", async () => {
    expect((await get(`from=${to.toISOString()}&to=${from.toISOString()}`)).statusCode).toBe(400);
    expect((await get(`from=${new Date(to.getTime() - 40 * 24 * HOUR).toISOString()}&to=${to.toISOString()}`)).statusCode).toBe(400);
    expect((await get(win().replace("buckets=4", "buckets=99"))).statusCode).toBe(400);
    expect((await get("from=yesterday&to=today")).statusCode).toBe(400);
    expect((await get(`from=${new Date(Date.now() + HOUR).toISOString()}&to=${new Date(Date.now() + 2 * HOUR).toISOString()}`)).statusCode).toBe(400);
  });
});
