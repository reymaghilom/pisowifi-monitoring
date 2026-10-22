/* RBAC-1: deny-by-default access, the route × role matrix, Manage Users, account lifecycle, session revocation,
   privilege-escalation attempts, the last-active-Administrator guarantee (API + database trigger), and the 0005
   rollback script. PGlite only (no network, no real keys: a throwaway Ed25519 pair in a temporary directory).
   Fixtures mirror the intended accounts: two Administrators (Rey, Cris) and one Limited User (the sibling). */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { PERMISSIONS, can, userCreatedResponseSchema, usersResponseSchema, type Permission } from "@pisowifi/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema/index.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import { hashPassword } from "../src/auth/password.js";

const ORIGIN = "http://localhost:3000";
const PW = "correct horse battery";
const NEW_PW = "a brand new long password";
const keyDir = mkdtempSync(join(tmpdir(), "pw-rbac-"));
const keyFile = join(keyDir, "ticket-private.pem");
writeFileSync(keyFile, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }));
const ENV = {
  NODE_ENV: "test",
  APP_ORIGIN: ORIGIN,
  LOGIN_RATE_LIMIT: "1000",
  REMOTE_GATEWAY_ENABLED: "true",
  REMOTE_GATEWAY_ORIGIN: "https://gw.example.com",
  REMOTE_TICKET_PRIVATE_KEY_FILE: keyFile,
  ZT_ALLOWED_CIDRS: "192.168.194.0/24",
};
const REY = { email: "rey@example.com", name: "Rey Maghilom", role: "admin" };
const CRIS = { email: "cris@example.com", name: "Cris Basco", role: "admin" };
const SIB = { email: "sibling@example.com", name: "Sibling", role: "viewer" };

let pglite: PGlite;
let db: Db;
let app: FastifyInstance;
const ids: Record<string, string> = {};
let mR: string;

const q = async <T = Record<string, unknown>>(text: string, params: unknown[] = []) => (await pglite.query<T>(text, params)).rows;

beforeAll(async () => {
  pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  await migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
  db = { orm: orm as never, pool: null as never, check: async () => true, close: async () => {} };
  app = await buildApp(loadConfig(ENV), { db });
});
afterAll(async () => {
  await app.close();
  await pglite.close();
});
beforeEach(async () => {
  // Fresh fixture set for every test: Rey and Cris are Administrators, the sibling is a Limited User.
  await pglite.exec("delete from sessions; delete from password_reset_tokens; delete from audit_log; delete from machines; delete from users");
  const hash = await hashPassword(PW);
  for (const u of [REY, CRIS, SIB]) {
    ids[u.email] = (await q<{ id: string }>("insert into users (email, display_name, password_hash, role) values ($1, $2, $3, $4) returning id", [u.email, u.name, hash, u.role]))[0]!.id;
  }
  mR = (await q<{ id: string }>("insert into machines (name, zt_ip, admin_path, software) values ('Rey Pisowifi', '192.168.194.127', '/admin', 'WiFi5Soft') returning id"))[0]!.id;
});

const signIn = async (email: string, password = PW) => {
  const res = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password }, headers: { origin: ORIGIN } });
  const c = res.cookies.find((x) => x.name.endsWith("pisowifi_session"));
  return { status: res.statusCode, cookie: c ? `${c.name}=${c.value}` : "" };
};
const call = (method: string, url: string, cookie?: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method: method as never, url: "/api/v1" + url, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...headers }, ...(payload === undefined ? {} : { payload: payload as never }) });

/* ---------------- deny-by-default and the route × role matrix ---------------- */

/** Every route the API serves and who may call it. A new or changed route fails this test until it is reviewed here. */
const EXPECTED: Record<string, "public" | "session" | Permission> = {
  "GET /api/v1/healthz": "public",
  "GET /api/v1/readyz": "public",
  "POST /api/v1/auth/login": "public",
  "POST /api/v1/auth/logout": "public",
  "POST /api/v1/auth/password-reset": "public",
  "POST /api/v1/auth/password-reset/confirm": "public",
  "GET /api/v1/auth/me": "session",
  "PATCH /api/v1/account/profile": "account:self",
  "POST /api/v1/account/password": "account:self",
  "GET /api/v1/account/sessions": "account:self",
  "DELETE /api/v1/account/sessions/:id": "account:self",
  "POST /api/v1/account/sessions/revoke-others": "account:self",
  "GET /api/v1/machines/policy": "machines:view",
  "GET /api/v1/machines": "machines:view",
  "GET /api/v1/machines/:id": "machines:view",
  "POST /api/v1/machines": "machines:manage",
  "PUT /api/v1/machines/:id": "machines:manage",
  "PATCH /api/v1/machines/:id/monitoring": "machines:manage",
  "DELETE /api/v1/machines/:id": "machines:manage",
  "GET /api/v1/history": "history:view",
  "GET /api/v1/gateway/status": "gateway:check",
  "POST /api/v1/gateway/machines/:id/check": "gateway:check",
  "POST /api/v1/gateway/check": "gateway:check",
  "POST /api/v1/remote/machines/:id/ticket": "remote:open",
  "GET /api/v1/users": "users:manage",
  "GET /api/v1/users/:id": "users:manage",
  "POST /api/v1/users": "users:manage",
  "PATCH /api/v1/users/:id": "users:manage",
  "PUT /api/v1/users/:id/role": "users:manage",
  "PUT /api/v1/users/:id/status": "users:manage",
  "POST /api/v1/users/:id/password-link": "users:manage",
  "GET /api/v1/users/:id/activity": "audit:view",
  "GET /api/v1/audit": "audit:view",
};

describe("deny-by-default", () => {
  it("every served route declares exactly the reviewed access", () => {
    const declared = Object.fromEntries(app.routeAccess.filter((r) => r.method !== "HEAD").map((r) => [`${r.method} ${r.url}`, r.access]));
    expect(declared).toEqual(EXPECTED);
    // Automatic HEAD routes inherit their GET route's access.
    for (const h of app.routeAccess.filter((r) => r.method === "HEAD")) expect(h.access).toBe(EXPECTED[`GET ${h.url}`]);
  });

  it("refuses to start with a route that declares no access", async () => {
    const extra = await buildApp(loadConfig(ENV), { db });
    expect(() => extra.get("/api/v1/forgotten", async () => ({ leaked: true }))).toThrow(/must declare config\.access/);
    expect(() => extra.get("/api/v1/typo", { config: { access: "users:manges" as never } }, async () => ({}))).toThrow(/must declare config\.access/);
    await extra.close();
  });

  it("the role map: Administrators hold every permission, Limited Users only the approved ones", () => {
    expect(PERMISSIONS.every((p) => can("admin", p))).toBe(true);
    expect(PERMISSIONS.filter((p) => can("viewer", p))).toEqual(["dashboard:view", "machines:view", "history:view", "remote:open", "account:self", "notifications:receive"]);
    expect(can(null, "dashboard:view")).toBe(false);
    expect(can("superuser" as never, "users:manage")).toBe(false);
  });

  it("route × role matrix: anonymous 401, missing permission 403, granted never 401/403", async () => {
    const rey = (await signIn(REY.email)).cookie;
    const sib = (await signIn(SIB.email)).cookie;
    const fill = (url: string) => url.replace(":id", "00000000-0000-4000-8000-000000000000").replace("/api/v1", "");
    for (const [route, access] of Object.entries(EXPECTED)) {
      const [method, url] = route.split(" ") as [string, string];
      const body = method === "GET" || method === "DELETE" ? undefined : {};
      if (access === "public") {
        if (route.endsWith("/logout")) continue; // would end nobody's session; covered in auth tests
        const res = await call(method, fill(url), undefined, body);
        expect([401, 403], route).not.toContain(res.statusCode);
        continue;
      }
      expect((await call(method, fill(url), undefined, body)).statusCode, `${route} anonymous`).toBe(401);
      for (const [who, role, cookie] of [["sibling", "viewer", sib], ["rey", "admin", rey]] as const) {
        const res = await call(method, fill(url), cookie, body);
        if (access === "session" || can(role, access)) expect([401, 403], `${route} ${who}`).not.toContain(res.statusCode);
        else expect(res.statusCode, `${route} ${who}`).toBe(403);
      }
    }
  });

  it("CSRF: every state change still needs the app's Origin, whatever the role", async () => {
    const rey = (await signIn(REY.email)).cookie;
    for (const route of Object.keys(EXPECTED).filter((r) => !r.startsWith("GET ") && !r.includes("/auth/"))) {
      const [method, url] = route.split(" ") as [string, string];
      const res = await app.inject({ method: method as never, url: url.replace(":id", ids[SIB.email]!), headers: { cookie: rey, origin: "https://evil.example" }, payload: {} });
      expect(res.statusCode, route).toBe(403);
    }
  });

  it("there is no self-registration", async () => {
    for (const url of ["/auth/register", "/auth/signup", "/register", "/users/register"]) expect((await call("POST", url, undefined, { email: "x@example.com" })).statusCode).toBe(404);
    expect((await call("POST", "/users", undefined, { email: "x@example.com", displayName: "X" })).statusCode).toBe(401);
    expect((await q("select 1 from users where email = 'x@example.com'")).length).toBe(0);
  });
});

/* ---------------- Manage Users ---------------- */

describe("Manage Users (Administrators only)", () => {
  it("lists accounts without any secret, with search and filters", async () => {
    const rey = (await signIn(REY.email)).cookie;
    const res = await call("GET", "/users", rey);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const list = usersResponseSchema.parse(res.json());
    const byName = list.items.map((u) => [u.displayName, u.role, u.status]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    expect(byName).toEqual([["Cris Basco", "admin", "active"], ["Rey Maghilom", "admin", "active"], ["Sibling", "viewer", "active"]]);
    expect(res.body).not.toMatch(/argon2|password|token/i);
    expect(usersResponseSchema.parse((await call("GET", "/users?q=cris", rey)).json()).items).toHaveLength(1);
    expect(usersResponseSchema.parse((await call("GET", "/users?q=%25", rey)).json()).items).toHaveLength(0); // LIKE wildcards are literal
    expect(usersResponseSchema.parse((await call("GET", "/users?role=viewer", rey)).json()).items.map((u) => u.email)).toEqual([SIB.email]);
    expect((await call("GET", "/users?sort=password_hash", rey)).statusCode).toBe(400);
  });

  it("creates an account with a one-time set-password link; the new person sets their own password", async () => {
    const rey = (await signIn(REY.email)).cookie;
    const res = await call("POST", "/users", rey, { displayName: "New Person", email: "New@Example.com" });
    expect(res.statusCode).toBe(201);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = userCreatedResponseSchema.parse(res.json());
    expect(body.user).toMatchObject({ displayName: "New Person", role: "viewer", status: "active", lastLoginAt: null });
    expect(body.setPasswordUrl.startsWith(`${ORIGIN}/reset-password#token=`)).toBe(true);
    const token = body.setPasswordUrl.split("#token=")[1]!;
    // Nobody knows the initial password; the link is not stored or audited.
    expect((await signIn("new@example.com", "")).status).toBe(400);
    expect(JSON.stringify(await q("select meta from audit_log"))).not.toContain(token);
    expect((await call("POST", "/auth/password-reset/confirm", undefined, { token, password: NEW_PW })).statusCode).toBe(204);
    expect((await call("POST", "/auth/password-reset/confirm", undefined, { token, password: NEW_PW + "!" })).statusCode).toBe(400); // single use
    const login = await signIn("new@example.com", NEW_PW);
    expect(login.status).toBe(200);
    expect((await call("GET", "/users", login.cookie)).statusCode).toBe(403); // a Limited User
    const created = await q<{ user_id: string; target_id: string; meta: { role: string } }>("select user_id, target_id, meta from audit_log where action = 'user.created'");
    expect(created).toEqual([expect.objectContaining({ user_id: ids[REY.email], target_id: body.user.id, meta: expect.objectContaining({ role: "viewer", via: "admin" }) })]);
  });

  it("validates input and rejects mass assignment and duplicates", async () => {
    const rey = (await signIn(REY.email)).cookie;
    for (const payload of [
      { displayName: "X", email: "x@example.com", passwordHash: "x" },
      { displayName: "X", email: "x@example.com", id: "00000000-0000-4000-8000-000000000000" },
      { displayName: "X", email: "x@example.com", disabledAt: null },
      { displayName: "X", email: "x@example.com", role: "superuser" },
      { displayName: "", email: "x@example.com" },
      { displayName: "X", email: "not-an-email" },
    ]) expect((await call("POST", "/users", rey, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    expect((await call("POST", "/users", rey, { displayName: "Dup", email: "CRIS@example.com" })).statusCode).toBe(409);
    expect((await call("PATCH", `/users/${ids[SIB.email]}`, rey, { role: "admin" })).statusCode).toBe(400);
    expect((await call("PATCH", `/users/${ids[SIB.email]}`, rey, { displayName: "Sib", active: false })).statusCode).toBe(400);
    expect((await call("PATCH", `/users/${ids[SIB.email]}`, rey, { email: "rey@EXAMPLE.com" })).statusCode).toBe(409);
    expect((await call("PATCH", `/users/not-a-uuid`, rey, { displayName: "x" })).statusCode).toBe(404);
    expect((await q("select count(*)::int n from users"))[0]).toEqual({ n: 3 });
    const ok = await call("PATCH", `/users/${ids[SIB.email]}`, rey, { displayName: "Little Sibling" });
    expect(ok.json().user).toMatchObject({ displayName: "Little Sibling", role: "viewer" });
    expect((await q<{ meta: unknown }>("select meta from audit_log where action = 'user.updated'"))[0]!.meta).toEqual({ fields: ["displayName"] });
  });

  it("Limited Users can't manage anyone, including escalating themselves (no IDOR, no escalation)", async () => {
    const sib = (await signIn(SIB.email)).cookie;
    const me = ids[SIB.email]!;
    for (const [method, url, body] of [
      ["GET", "/users", undefined],
      ["GET", `/users/${ids[REY.email]}`, undefined],
      ["POST", "/users", { displayName: "Evil", email: "evil@example.com", role: "admin" }],
      ["PATCH", `/users/${ids[REY.email]}`, { email: "sibling2@example.com" }],
      ["PUT", `/users/${me}/role`, { role: "admin" }],
      ["PUT", `/users/${ids[REY.email]}/status`, { active: false }],
      ["POST", `/users/${ids[CRIS.email]}/password-link`, {}],
      ["GET", `/users/${me}/activity`, undefined],
      ["GET", "/audit", undefined],
      ["POST", "/machines", { name: "x" }],
      ["DELETE", `/machines/${mR}`, undefined],
    ] as const) expect((await call(method, url, sib, body)).statusCode, `${method} ${url}`).toBe(403);
    expect((await q<{ role: string }>("select role from users where id = $1", [me]))[0]!.role).toBe("viewer");
    expect((await q("select 1 from machines")).length).toBe(1);
  });

  it("role changes sign the person out; nobody changes their own role", async () => {
    const rey = (await signIn(REY.email)).cookie;
    const cris = (await signIn(CRIS.email)).cookie;
    expect((await call("PUT", `/users/${ids[REY.email]}/role`, rey, { role: "viewer" })).statusCode).toBe(409);
    const demote = await call("PUT", `/users/${ids[CRIS.email]}/role`, rey, { role: "viewer" });
    expect(demote.statusCode).toBe(200);
    expect(demote.json()).toMatchObject({ user: { role: "viewer" }, sessionsRevoked: 1 });
    expect((await call("GET", "/auth/me", cris)).statusCode).toBe(401);
    const again = (await signIn(CRIS.email)).cookie;
    expect((await call("GET", "/users", again)).statusCode).toBe(403);
    expect((await call("PUT", `/users/${ids[CRIS.email]}/role`, rey, { role: "admin" })).statusCode).toBe(200);
    expect((await q<{ meta: unknown }>("select meta from audit_log where action = 'user.role_changed' order by id")).map((r) => r.meta)).toEqual([
      { from: "admin", to: "viewer", sessionsRevoked: 1 },
      { from: "viewer", to: "admin", sessionsRevoked: 1 },
    ]);
  });

  it("deactivation ends access at once: sessions, sign-in, reset links, Remote Admin; reactivation restores it", async () => {
    const rey = (await signIn(REY.email)).cookie;
    const sib = (await signIn(SIB.email)).cookie;
    expect((await call("POST", `/remote/machines/${mR}/ticket`, sib)).statusCode).toBe(200);
    const link = (await call("POST", `/users/${ids[SIB.email]}/password-link`, rey)).json() as { setPasswordUrl: string };
    const sib2 = (await signIn(SIB.email)).cookie;
    const off = await call("PUT", `/users/${ids[SIB.email]}/status`, rey, { active: false });
    expect(off.json()).toMatchObject({ user: { status: "deactivated" }, sessionsRevoked: 1 });
    expect((await call("GET", "/auth/me", sib2)).statusCode).toBe(401);
    expect((await call("POST", `/remote/machines/${mR}/ticket`, sib2)).statusCode).toBe(401);
    const login = await signIn(SIB.email);
    expect(login.status).toBe(401);
    expect(login.cookie).toBe("");
    expect((await call("POST", "/auth/password-reset/confirm", undefined, { token: link.setPasswordUrl.split("#token=")[1], password: NEW_PW })).statusCode).toBe(400);
    expect((await call("POST", `/users/${ids[SIB.email]}/password-link`, rey)).statusCode).toBe(409);
    // A session row that escaped revocation still can't be used (findSession checks the account).
    await q("update sessions set revoked_at = null where user_id = $1", [ids[SIB.email]]);
    expect((await call("GET", "/auth/me", sib)).statusCode).toBe(401);
    expect((await q("select action from audit_log where action in ('user.deactivated', 'auth.login.deactivated') order by id")).map((r) => r.action)).toEqual(["user.deactivated", "auth.login.deactivated"]);
    expect((await call("PUT", `/users/${ids[SIB.email]}/status`, rey, { active: true })).json()).toMatchObject({ user: { status: "active" } });
    expect((await signIn(SIB.email)).status).toBe(200);
    expect((await q<{ disabled_by: string | null }>("select disabled_by from users where id = $1", [ids[SIB.email]]))[0]!.disabled_by).toBeNull();
  });

  it("a set-password link signs the person out and replaces older links; no links for yourself", async () => {
    const rey = (await signIn(REY.email)).cookie;
    const cris = (await signIn(CRIS.email)).cookie;
    const first = (await call("POST", `/users/${ids[CRIS.email]}/password-link`, rey)).json() as { setPasswordUrl: string };
    expect((await call("GET", "/auth/me", cris)).statusCode).toBe(401);
    const second = (await call("POST", `/users/${ids[CRIS.email]}/password-link`, rey)).json() as { setPasswordUrl: string };
    expect((await call("POST", "/auth/password-reset/confirm", undefined, { token: first.setPasswordUrl.split("#token=")[1], password: NEW_PW })).statusCode).toBe(400);
    expect((await call("POST", "/auth/password-reset/confirm", undefined, { token: second.setPasswordUrl.split("#token=")[1], password: NEW_PW })).statusCode).toBe(204);
    expect((await signIn(CRIS.email, NEW_PW)).status).toBe(200);
    expect((await call("POST", `/users/${ids[REY.email]}/password-link`, rey)).statusCode).toBe(409);
    expect((await call("POST", `/users/${ids[SIB.email]}/password-link`, rey, { password: "chosen-by-admin" })).statusCode).toBe(400);
  });

  it("activity history and the audit log are for Administrators", async () => {
    const rey = (await signIn(REY.email)).cookie;
    await call("PATCH", `/users/${ids[SIB.email]}`, rey, { displayName: "Sib" });
    await signIn(SIB.email);
    const act = await call("GET", `/users/${ids[SIB.email]}/activity?limit=1`, rey);
    expect(act.statusCode).toBe(200);
    const page = act.json() as { items: { action: string; actor: { displayName: string } | null }[]; nextBefore: number | null };
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.action).toBe("auth.login.succeeded");
    expect(page.nextBefore).not.toBeNull();
    const older = (await call("GET", `/users/${ids[SIB.email]}/activity?before=${page.nextBefore}`, rey)).json() as typeof page;
    expect(older.items[0]).toMatchObject({ action: "user.updated", actor: { displayName: "Rey Maghilom" } });
    expect((await call("GET", "/audit?action=user.", rey)).json().items.every((e: { action: string }) => e.action.startsWith("user."))).toBe(true);
    expect((await call("GET", "/audit?action=x'--", rey)).statusCode).toBe(400);
  });
});

/* ---------------- last active Administrator ---------------- */

describe("at least one active Administrator, always", () => {
  it("API: can't demote or deactivate the last active Administrator (deactivated admins don't count)", async () => {
    const rey = (await signIn(REY.email)).cookie;
    expect((await call("PUT", `/users/${ids[CRIS.email]}/status`, rey, { active: false })).statusCode).toBe(200);
    // Rey is now the only active Administrator (Cris is deactivated, still role admin).
    const cris = ids[CRIS.email]!;
    expect((await call("PUT", `/users/${cris}/role`, rey, { role: "viewer" })).statusCode).toBe(200); // a deactivated admin may be demoted
    expect((await call("PUT", `/users/${ids[REY.email]}/status`, rey, { active: false })).statusCode).toBe(409);
    await q("update users set role = 'admin', disabled_at = null, disabled_by = null where id = $1", [cris]);
    const crisCookie = (await signIn(CRIS.email)).cookie;
    expect((await call("PUT", `/users/${ids[REY.email]}/role`, crisCookie, { role: "viewer" })).statusCode).toBe(200);
    const last = await call("PUT", `/users/${ids[REY.email]}/status`, crisCookie, { active: false });
    expect(last.statusCode).toBe(200); // Rey (now Limited) may be deactivated; Cris remains
    expect((await q("select count(*)::int n from users where role = 'admin' and disabled_at is null"))[0]).toEqual({ n: 1 });
  });

  it("database trigger refuses any statement that would leave none (SQL, CLI, anything)", async () => {
    await expect(q("update users set role = 'viewer' where role = 'admin'")).rejects.toThrow(/at least one active admin/);
    await expect(q("update users set disabled_at = now() where role = 'admin'")).rejects.toThrow(/at least one active admin/);
    await expect(q("delete from users where role = 'admin'")).rejects.toThrow(/at least one active admin/);
    expect((await q("select count(*)::int n from users where role = 'admin' and disabled_at is null"))[0]).toEqual({ n: 2 });
    await q("update users set role = 'viewer' where id = $1", [ids[CRIS.email]]); // one of two: fine
    await q("update users set role = 'admin' where id = $1", [ids[CRIS.email]]);
  });

  it("concurrent cross-demotion by the two Administrators leaves exactly one active Administrator", async () => {
    const rey = (await signIn(REY.email)).cookie;
    const cris = (await signIn(CRIS.email)).cookie;
    const [a, b] = await Promise.all([
      call("PUT", `/users/${ids[CRIS.email]}/role`, rey, { role: "viewer" }),
      call("PUT", `/users/${ids[REY.email]}/role`, cris, { role: "viewer" }),
    ]);
    // Exactly one wins. The other is refused: signed out by the winner (401), no longer an Administrator when
    // re-checked under the lock (403), or blocked as the last active Administrator (409).
    const codes = [a.statusCode, b.statusCode];
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect([401, 403, 409]).toContain(codes.find((c) => c !== 200));
    expect((await q("select count(*)::int n from users where role = 'admin' and disabled_at is null"))[0]).toEqual({ n: 1 });
  });

  it("an Administrator demoted while their request is in flight can't finish it (re-checked under the lock)", async () => {
    const cris = (await signIn(CRIS.email)).cookie;
    await q("update users set role = 'viewer' where id = $1", [ids[CRIS.email]]); // demoted after authentication
    // The session still resolves (role is read per request), so this is the permission check at the edge:
    expect((await call("PUT", `/users/${ids[SIB.email]}/status`, cris, { active: false })).statusCode).toBe(403);
    expect((await q<{ disabled_at: Date | null }>("select disabled_at from users where id = $1", [ids[SIB.email]]))[0]!.disabled_at).toBeNull();
  });

  it("re-checks the acting Administrator inside the transaction (demoted after authorization, before the change)", async () => {
    const racy = await buildApp(loadConfig(ENV), { db });
    // Runs after the access check passed and before the route handler: another Administrator demotes Cris right now.
    racy.addHook("preHandler", async (req) => {
      if (req.headers["x-test-demote-actor"]) await q("update users set role = 'viewer' where id = $1", [ids[CRIS.email]]);
    });
    const login = await racy.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: CRIS.email, password: PW }, headers: { origin: ORIGIN } });
    const c = login.cookies.find((x) => x.name.endsWith("pisowifi_session"))!;
    const res = await racy.inject({
      method: "PUT",
      url: `/api/v1/users/${ids[SIB.email]}/status`,
      headers: { origin: ORIGIN, cookie: `${c.name}=${c.value}`, "x-test-demote-actor": "1" },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(403);
    expect((await q<{ disabled_at: Date | null }>("select disabled_at from users where id = $1", [ids[SIB.email]]))[0]!.disabled_at).toBeNull();
    expect((await q("select 1 from audit_log where action = 'user.deactivated'")).length).toBe(0);
    await racy.close();
  });

  // Real two-connection races (every isolation level) run on a disposable PostgreSQL in tests/rbac-postgres.test.ts.
});

/* ---------------- own account ---------------- */

describe("own account (account:self)", () => {
  it("a Limited User manages their own name, password and sessions, but not their sign-in email", async () => {
    const sib = (await signIn(SIB.email)).cookie;
    const email = await call("PATCH", "/account/profile", sib, { displayName: "Sibling", email: "elsewhere@example.com" });
    expect(email.statusCode).toBe(403);
    expect(email.json()).toMatchObject({ error: { fields: { email: expect.stringMatching(/Administrator/) } } });
    expect((await call("PATCH", "/account/profile", sib, { displayName: "Sib", email: SIB.email })).statusCode).toBe(200);
    expect((await call("GET", "/account/sessions", sib)).statusCode).toBe(200);
    expect((await call("POST", "/account/password", sib, { currentPassword: PW, newPassword: NEW_PW, confirmPassword: NEW_PW })).statusCode).toBe(200);
    const rey = (await signIn(REY.email)).cookie;
    expect((await call("PATCH", "/account/profile", rey, { displayName: REY.name, email: "rey2@example.com" })).statusCode).toBe(200);
  });
});

/* ---------------- rollback script (last: it changes the schema) ---------------- */

describe("migration 0005 rollback script", () => {
  const down = readFileSync(resolve(__dirname, "../../../deploy/rbac/0005_user_management.down.sql"), "utf8");
  it("refuses while an account is deactivated, then removes exactly what 0005 added", async () => {
    await q("update users set disabled_at = now() where id = $1", [ids[SIB.email]]);
    await expect(pglite.exec(down)).rejects.toThrow(/reactivate or delete deactivated accounts first/);
    await pglite.exec("rollback");
    expect((await q("select column_name from information_schema.columns where table_name = 'users' and column_name = 'disabled_at'")).length).toBe(1);
    await q("update users set disabled_at = null where id = $1", [ids[SIB.email]]);
    await pglite.exec(down);
    expect((await q("select column_name from information_schema.columns where table_name = 'users' and column_name like 'disabled%'")).length).toBe(0);
    expect((await q("select 1 from pg_trigger where tgname = 'users_keep_active_admin'")).length).toBe(0);
    expect((await q("select 1 from pg_proc where proname = 'users_keep_active_admin'")).length).toBe(0);
    expect((await q<{ n: number }>("select count(*)::int n from drizzle.__drizzle_migrations"))[0]!.n).toBe(5);
    // And 0005 applies again cleanly afterwards.
    await migrate(drizzle(pglite, { schema }), { migrationsFolder: MIGRATIONS_FOLDER });
    expect((await q("select 1 from pg_trigger where tgname = 'users_keep_active_admin'")).length).toBe(1);
  });
});

afterEach(() => undefined);
