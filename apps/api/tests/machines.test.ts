/* Machine management (B6): CRUD, Admin-only writes, validation, duplicates, honest state, audit.
   Real migrations on PGlite; requests through app.inject(). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { MACHINE_MESSAGES, machineListResponseSchema, machineSchema } from "@pisowifi/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema/index.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import { hashPassword } from "../src/auth/password.js";

const ORIGIN = "http://localhost:3000";
const PW = "correct horse battery";
const ADMIN = "admin@example.com";
const VIEWER = "viewer@example.com";

let pglite: PGlite;
let db: Db;
let app: FastifyInstance | undefined;
let admin: string;
let viewer: string;

const body = (o: Record<string, unknown> = {}) => ({
  name: "PisoWiFi 01",
  location: "Main store",
  description: "",
  software: "WiFi5Soft",
  softwareVersion: "v3.5.84",
  ztNetworkId: "",
  ztIp: "192.168.194.82",
  adminPath: "/admin",
  tags: ["Primary", "primary", " "],
  ...o,
});

beforeAll(async () => {
  pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  await migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
  db = { orm: orm as never, pool: null as never, check: async () => true, close: async () => {} };
  const hash = await hashPassword(PW);
  await pglite.query("insert into users (email, display_name, password_hash, role) values ($1, 'Admin', $3, 'admin'), ($2, 'Viewer', $3, 'viewer')", [ADMIN, VIEWER, hash]);
});
afterAll(() => pglite.close());

beforeEach(async () => {
  await pglite.exec("delete from machines; delete from audit_log; delete from sessions");
  app = await buildApp(loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }), { db });
  const signIn = async (email: string) => {
    const res = await app!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW }, headers: { origin: ORIGIN } });
    const c = res.cookies.find((x) => x.name.endsWith("pisowifi_session"))!;
    return `${c.name}=${c.value}`;
  };
  admin = await signIn(ADMIN);
  viewer = await signIn(VIEWER);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, cookie?: string, payload?: unknown) =>
  app!.inject({ method, url: "/api/v1" + url, payload: payload as never, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
const create = async (o: Record<string, unknown> = {}) => {
  const res = await call("POST", "/machines", admin, body(o));
  expect(res.statusCode).toBe(201);
  return machineSchema.parse(res.json());
};
const fields = (res: LightMyRequestResponse) => res.json().error.fields;
const audits = async () =>
  (await pglite.query<{ action: string; target_type: string | null; meta: Record<string, unknown> }>("select action, target_type, meta from audit_log where action like 'machine.%' order by id")).rows;

describe("create", () => {
  it("stores a WiFi5Soft machine with normalized fields and an honest, never-checked state", async () => {
    const m = await create();
    expect(m).toMatchObject({
      name: "PisoWiFi 01",
      location: "Main store",
      description: null,
      software: "WiFi5Soft",
      ztNetworkId: null,
      ztMemberId: null,
      ztIp: "192.168.194.82",
      adminPath: "/admin",
      tags: ["primary"],
      state: {
        http: "unknown",
        lastCheckAt: null,
        lastSuccessAt: null,
        zeroTier: "unknown",
        zeroTierLastSeenAt: null,
        internet: "unverified",
        monitor: "unknown",
        monitoringEnabled: true,
      },
    });
    expect((await pglite.query("select http_status, zt_state, monitor_health from machine_state")).rows).toEqual([
      { http_status: "unknown", zt_state: "unknown", monitor_health: "unknown" },
    ]);
    const [a] = await audits();
    expect(a).toMatchObject({ action: "machine.created", target_type: "machine", meta: { name: "PisoWiFi 01", ztIp: "192.168.194.82" } });
  });

  it("validates with the shared messages; only WiFi5Soft is accepted", async () => {
    let res = await call("POST", "/machines", admin, body({ name: " ", ztIp: "192.168.194", adminPath: "admin", ztNetworkId: "xyz" }));
    expect(res.statusCode).toBe(400);
    expect(fields(res)).toEqual({
      name: MACHINE_MESSAGES.nameRequired,
      ztIp: MACHINE_MESSAGES.ipInvalid,
      adminPath: MACHINE_MESSAGES.pathInvalid,
      ztNetworkId: MACHINE_MESSAGES.ztNetworkIdInvalid,
    });
    res = await call("POST", "/machines", admin, body({ software: "Other" }));
    expect(fields(res)).toEqual({ software: MACHINE_MESSAGES.softwareUnsupported });
    expect((await pglite.query("select count(*)::int as n from machines")).rows).toEqual([{ n: 0 }]);
  });

  it("refuses duplicate names (ignoring case) and IPs with field errors", async () => {
    await create();
    let res = await call("POST", "/machines", admin, body({ name: "pisowifi 01", ztIp: "192.168.194.90" }));
    expect(res.statusCode).toBe(409);
    expect(fields(res)).toEqual({ name: MACHINE_MESSAGES.nameTaken });
    res = await call("POST", "/machines", admin, body({ name: "PisoWiFi 02" }));
    expect(res.statusCode).toBe(409);
    expect(fields(res)).toEqual({ ztIp: MACHINE_MESSAGES.ipTaken });
  });

  it("can start paused", async () => {
    const m = await create({ monitoringEnabled: false });
    expect(m.state).toMatchObject({ monitoringEnabled: false, monitor: "paused" });
  });
});

describe("access", () => {
  it("signed-out requests get 401; viewers can read but not write", async () => {
    const m = await create();
    expect((await call("GET", "/machines")).statusCode).toBe(401);
    expect((await call("GET", `/machines/${m.id}`)).statusCode).toBe(401);
    expect((await call("GET", "/machines", viewer)).statusCode).toBe(200);
    expect((await call("GET", `/machines/${m.id}`, viewer)).statusCode).toBe(200);
    for (const [method, url, payload] of [
      ["POST", "/machines", body({ name: "X", ztIp: "192.168.194.99" })],
      ["PUT", `/machines/${m.id}`, body()],
      ["PATCH", `/machines/${m.id}/monitoring`, { enabled: false }],
      ["DELETE", `/machines/${m.id}`, undefined],
    ] as const) {
      const res = await call(method, url, viewer, payload);
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    }
    expect((await pglite.query("select count(*)::int as n from machines")).rows).toEqual([{ n: 1 }]);
  });

  it("writes need the app's Origin (CSRF)", async () => {
    const res = await app!.inject({ method: "POST", url: "/api/v1/machines", payload: body(), headers: { cookie: admin } });
    expect(res.statusCode).toBe(403);
  });

  it("unknown or malformed ids are 404", async () => {
    for (const id of ["6f1c2a4e-8b1d-4c3e-9f2a-1b2c3d4e5f60", "not-a-uuid"]) {
      expect((await call("GET", `/machines/${id}`, admin)).statusCode).toBe(404);
      expect((await call("PUT", `/machines/${id}`, admin, body())).statusCode).toBe(404);
      expect((await call("DELETE", `/machines/${id}`, admin)).statusCode).toBe(404);
    }
  });
});

describe("update", () => {
  it("replaces the editable fields, audits what changed, keeps its own name and IP", async () => {
    const m = await create();
    const res = await call("PUT", `/machines/${m.id}`, admin, body({ location: "Annex", ztNetworkId: "8056C2E21C000001", tags: ["store"] }));
    expect(res.statusCode).toBe(200);
    expect(machineSchema.parse(res.json())).toMatchObject({ name: "PisoWiFi 01", location: "Annex", ztNetworkId: "8056c2e21c000001", tags: ["store"] });
    const updated = (await audits()).find((a) => a.action === "machine.updated")!;
    expect((updated.meta.changed as string[]).sort()).toEqual(["location", "tags", "ztNetworkId"]);
  });

  it("refuses another machine's name or IP", async () => {
    await create();
    const b = await create({ name: "PisoWiFi 02", ztIp: "192.168.194.127" });
    expect(fields(await call("PUT", `/machines/${b.id}`, admin, body({ name: "PISOWIFI 01", ztIp: "192.168.194.127" })))).toEqual({ name: MACHINE_MESSAGES.nameTaken });
    expect(fields(await call("PUT", `/machines/${b.id}`, admin, body({ name: "PisoWiFi 02" })))).toEqual({ ztIp: MACHINE_MESSAGES.ipTaken });
  });

  it("keeps the backend-only ZeroTier member ID unless the network is removed", async () => {
    const m = await create({ ztNetworkId: "8056c2e21c000001" });
    await pglite.query("update machines set zt_member_id = 'a1b2c3d4e5' where id = $1", [m.id]);
    let res = await call("PUT", `/machines/${m.id}`, admin, body({ ztNetworkId: "8056c2e21c000001", location: "Annex" }));
    expect(res.json().ztMemberId).toBe("a1b2c3d4e5");
    res = await call("PUT", `/machines/${m.id}`, admin, body({ ztNetworkId: "" }));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ztNetworkId: null, ztMemberId: null });
  });

  it("never changes the stored state (no fabricated status)", async () => {
    const m = await create();
    await call("PUT", `/machines/${m.id}`, admin, body({ ztIp: "192.168.194.83" }));
    expect((await call("GET", `/machines/${m.id}`, admin)).json().state).toEqual(m.state);
  });
});

describe("monitoring toggle", () => {
  it("pauses and resumes; resuming means 'not checked yet', not 'ok'", async () => {
    const m = await create();
    let res = await call("PATCH", `/machines/${m.id}/monitoring`, admin, { enabled: false });
    expect(res.json().state).toMatchObject({ monitoringEnabled: false, monitor: "paused", http: "unknown" });
    res = await call("PATCH", `/machines/${m.id}/monitoring`, admin, { enabled: true });
    expect(res.json().state).toMatchObject({ monitoringEnabled: true, monitor: "unknown" });
    expect((await call("PATCH", `/machines/${m.id}/monitoring`, admin, { enabled: "yes" })).statusCode).toBe(400);
    expect((await audits()).map((a) => a.action)).toEqual(["machine.created", "machine.monitoring_paused", "machine.monitoring_resumed"]);
  });
});

describe("delete", () => {
  it("removes the machine and its state; audited with name and IP", async () => {
    const m = await create();
    expect((await call("DELETE", `/machines/${m.id}`, admin)).statusCode).toBe(204);
    expect((await call("GET", `/machines/${m.id}`, admin)).statusCode).toBe(404);
    expect((await pglite.query("select count(*)::int as n from machine_state")).rows).toEqual([{ n: 0 }]);
    expect((await audits()).at(-1)).toMatchObject({ action: "machine.deleted", target_type: "machine", meta: { name: "PisoWiFi 01", ztIp: "192.168.194.82" } });
    expect((await call("DELETE", `/machines/${m.id}`, admin)).statusCode).toBe(404);
  });
});

describe("list", () => {
  it("searches name, location, IP and tags; filters by status; sorts", async () => {
    await create({ name: "Bravo", location: "Annex", ztIp: "192.168.194.20", tags: ["store"] });
    await create({ name: "alpha", location: "Main", ztIp: "192.168.194.10", tags: [] });
    const names = async (qs: string) => machineListResponseSchema.parse((await call("GET", "/machines" + qs, viewer)).json()).items.map((m) => m.name);

    expect(await names("")).toEqual(["alpha", "Bravo"]);
    expect(await names("?q=annex")).toEqual(["Bravo"]);
    expect(await names("?q=194.10")).toEqual(["alpha"]);
    expect(await names("?q=STORE")).toEqual(["Bravo"]);
    expect(await names("?q=100%25")).toEqual([]);
    expect(await names("?status=unknown")).toEqual(["alpha", "Bravo"]);
    expect(await names("?status=reachable")).toEqual([]);
    expect(await names("?sort=ip")).toEqual(["alpha", "Bravo"]);
    expect((await call("GET", "/machines?sort=bogus", viewer)).statusCode).toBe(400);
  });
});
