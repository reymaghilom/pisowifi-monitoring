/* End-to-end harness only (never production): the real API on an in-memory PGlite database with real migrations
   and seeded monitoring results, for the API-mode Playwright run (apps/web/playwright.api.config.ts).
   - API on 127.0.0.1:E2E_API_PORT (default 4310)
   - harness control on 127.0.0.1:E2E_CTL_PORT (default 4311): POST /check {"machine":"PISOWIFI 2","ok":true} records a
     check exactly like the monitor does (check row, machine_state, and an event + outage on a status change), for
     any registered machine (also ones added in the web app), standing in for the worker's next round.
   Nothing here contacts Supabase, ZeroTier or a device. */
import { createServer } from "node:http";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { buildApp } from "../../src/app.js";
import { loadConfig } from "../../src/config/env.js";
import type { Db } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { MIGRATIONS_FOLDER } from "../../src/db/migrations-path.js";
import { hashPassword } from "../../src/auth/password.js";
import { createGatewayChecker } from "../../src/gateway/checker.js";
import type { GatewayTransport } from "../../src/gateway/probe.js";

const API_PORT = Number(process.env.E2E_API_PORT ?? 4310);
const CTL_PORT = Number(process.env.E2E_CTL_PORT ?? 4311);
const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? "http://localhost:3310";
export const E2E_USER = { email: "e2e-admin@example.test", password: "e2e correct horse battery" };
const MIN = 60_000;

const pglite = new PGlite();
const orm = drizzle(pglite, { schema });
await migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
const db: Db = { orm: orm as never, pool: null as never, check: async () => true, close: async () => {} };

await pglite.query("insert into users (email, display_name, password_hash, role) values ($1, 'E2E Admin', $2, 'admin')", [E2E_USER.email, await hashPassword(E2E_USER.password)]);
const ids = (await pglite.query<{ id: string; name: string }>(
  "insert into machines (name, location, zt_ip) values ('PISOWIFI 1', 'Store 1', '192.168.194.127'), ('PISOWIFI 2', 'Store 2', '192.168.194.82') returning id, name",
)).rows;
const id = (name: string) => ids.find((r) => r.name === name)!.id;

// PISOWIFI 1: a check every 10 minutes for 3 days, Unreachable for 30 minutes about 5 hours ago.
const now = Date.now();
const downFrom = now - 5 * 60 * MIN;
const downTo = downFrom + 30 * MIN;
for (let t = now - 3 * 24 * 60 * MIN; t <= now - MIN; t += 10 * MIN) {
  const ok = !(t >= downFrom && t < downTo);
  await pglite.query("insert into checks (machine_id, started_at, ok, http_code, duration_ms, error_kind, trigger) values ($1, $2, $3, $4, $5, $6, 'schedule')", [
    id("PISOWIFI 1"),
    new Date(t).toISOString(),
    ok,
    ok ? 200 : null,
    ok ? 180 + Math.round(40 * Math.sin(t / 3_600_000)) : null,
    ok ? null : "timeout",
  ]);
}
const firstDown = new Date(Math.ceil(downFrom / (10 * MIN)) * 10 * MIN).toISOString();
const recovered = new Date(Math.ceil(downTo / (10 * MIN)) * 10 * MIN).toISOString();
await pglite.query("insert into outages (machine_id, started_at, ended_at) values ($1, $2, $3)", [id("PISOWIFI 1"), firstDown, recovered]);
await pglite.query(
  "insert into events (machine_id, type, status, message, occurred_at) values ($1, 'outage', 'unreachable', 'Became Unreachable', $2), ($1, 'recovery', 'reachable', 'Became Reachable', $3)",
  [id("PISOWIFI 1"), firstDown, recovered],
);
const last = (await pglite.query<{ t: string }>("select max(started_at)::text t from checks")).rows[0]!.t;
await pglite.query("insert into machine_state (machine_id, http_status, last_check_at, last_success_at) values ($1, 'reachable', $2, $2)", [id("PISOWIFI 1"), last]);
// PISOWIFI 2: never checked (no machine_state row): the app must show "Not checked yet".

// The production registration policy: the PisoWiFi ZeroTier range, the monitoring host and an admin PC denied.
const app = await buildApp(
  loadConfig({
    NODE_ENV: "development",
    HOST: "127.0.0.1",
    PORT: String(API_PORT),
    APP_ORIGIN: WEB_ORIGIN,
    LOG_LEVEL: "warn",
    ZT_ALLOWED_CIDRS: "192.168.194.0/24",
    ZT_DENY_IPS: "192.168.194.1,192.168.194.22",
    ZT_NETWORK_ID: "8286ac0e4705c5aa",
  }),
  { db },
);
await app.listen({ host: "127.0.0.1", port: API_PORT });

/** Records one check the way the monitor does. */
async function record(machine: string, ok: boolean) {
  // By name, so machines registered through the web app during the run work too.
  const found = (await pglite.query<{ id: string }>("select id from machines where name = $1", [machine])).rows[0];
  if (!found) throw new Error(`no machine named ${machine}`);
  const mid = found.id;
  const at = new Date();
  const prev = (await pglite.query<{ s: string }>("select http_status::text s from machine_state where machine_id = $1", [mid])).rows[0]?.s ?? "unknown";
  const to = ok ? "reachable" : "unreachable";
  await pglite.query("insert into checks (machine_id, started_at, ok, http_code, duration_ms, error_kind, trigger) values ($1, $2, $3, $4, $5, $6, 'schedule')", [
    mid,
    at.toISOString(),
    ok,
    ok ? 200 : null,
    ok ? 190 : null,
    ok ? null : "timeout",
  ]);
  await pglite.query(
    `insert into machine_state (machine_id, http_status, last_check_at, last_success_at, consecutive_failures) values ($1, $2, $3, $4, $5)
     on conflict (machine_id) do update set http_status = excluded.http_status, last_check_at = excluded.last_check_at,
       last_success_at = coalesce(excluded.last_success_at, machine_state.last_success_at),
       consecutive_failures = case when $2 = 'reachable' then 0 else machine_state.consecutive_failures + 1 end`,
    [mid, to, at.toISOString(), ok ? at.toISOString() : null, ok ? 0 : 1],
  );
  if ((prev === "reachable" && !ok) || (prev === "unreachable" && ok)) {
    await pglite.query("insert into events (machine_id, type, status, message, occurred_at) values ($1, $2, $3, $4, $5)", [mid, ok ? "recovery" : "outage", to, ok ? "Became Reachable" : "Became Unreachable", at.toISOString()]);
    if (ok) await pglite.query("update outages set ended_at = $2 where machine_id = $1 and ended_at is null", [mid, at.toISOString()]);
    else await pglite.query("insert into outages (machine_id, started_at) values ($1, $2)", [mid, at.toISOString()]);
  }
  return { machine, from: prev, to };
}

// One real scheduled round (the worker's own code and policy) against a fake network: every address answers 200,
// except those listed as down (connection refused). Returns which addresses were contacted.
const contacted: string[] = [];
let down = new Set<string>();
const fakeNetwork: GatewayTransport = async (url) => {
  const ip = new URL(url).hostname;
  contacted.push(ip);
  if (down.has(ip)) throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
  return new Response("<html>WiFi5Soft</html>", { status: 200 });
};
const workerConfig = loadConfig({
  NODE_ENV: "development", GATEWAY_ENABLED: "true", MONITOR_SCHEDULE_ENABLED: "true",
  ZT_ALLOWED_CIDRS: "192.168.194.0/24", ZT_DENY_IPS: "192.168.194.1,192.168.194.22", ZT_NETWORK_ID: "8286ac0e4705c5aa",
});
const checker = createGatewayChecker({ config: workerConfig, db, transport: fakeNetwork, zerotier: { nodeState: async () => "online" } });

createServer((req, res) => {
  if (req.method === "POST" && req.url === "/round") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      try {
        down = new Set((JSON.parse(body || "{}") as { down?: string[] }).down ?? []);
        contacted.length = 0;
        const out = await checker.checkAll({ trigger: "schedule", skipPaused: true });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ contacted: [...contacted].sort(), refused: out.filter((o) => o.refusal && o.refusal !== "admin_unreachable").length }));
      } catch (e) {
        res.writeHead(500).end(String(e));
      }
    });
    return;
  }
  if (req.method !== "POST" || req.url !== "/check") return res.writeHead(404).end();
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    try {
      const { machine, ok } = JSON.parse(body) as { machine: string; ok: boolean };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(await record(machine, ok)));
    } catch (e) {
      res.writeHead(400).end(String(e));
    }
  });
}).listen(CTL_PORT, "127.0.0.1");

console.log(`e2e API on http://127.0.0.1:${API_PORT} (PGlite, seeded), control on :${CTL_PORT}`);
