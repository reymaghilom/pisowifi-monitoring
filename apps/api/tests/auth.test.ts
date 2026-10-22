/* Authentication (B3): sign-in, session cookie, sign-out, lockout, rate limit, CSRF origin check and role guards.
   Runs the real migrations on PGlite (in-process PostgreSQL) and drives the API through app.inject(). */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { AUTH_MESSAGES, apiErrorSchema, sessionUserResponseSchema } from "@pisowifi/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema/index.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import { MAX_FAILED_LOGINS } from "../src/auth/plugin.js";
import { hashPassword, needsRehash, verifyPassword } from "../src/auth/password.js";
import { hashToken } from "../src/auth/sessions.js";

const ORIGIN = "http://localhost:3000";
const ADMIN = { email: "rey@example.com", password: "correct horse battery", name: "Rey" };
const VIEWER = { email: "viewer@example.com", password: "another long passphrase", name: "Viewer" };

let pglite: PGlite;
let db: Db;
let app: FastifyInstance | undefined;

beforeAll(async () => {
  pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  await migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
  // Same query API as node-postgres; the app only uses `orm`.
  db = { orm: orm as never, pool: null as never, check: async () => true, close: async () => {} };
  await pglite.query("insert into users (email, display_name, password_hash, role) values ($1, $2, $3, 'admin'), ($4, $5, $6, 'viewer')", [
    ADMIN.email,
    ADMIN.name,
    await hashPassword(ADMIN.password),
    VIEWER.email,
    VIEWER.name,
    await hashPassword(VIEWER.password),
  ]);
});

afterAll(async () => {
  await pglite.close();
});

beforeEach(async () => {
  await pglite.exec("delete from sessions; delete from audit_log; update users set failed_login_count = 0, locked_until = null");
});

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(env: Record<string, string> = {}) {
  app = await buildApp(loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN, ...env }), { db });
  app.get("/api/v1/test/admin-only", { config: { access: "public" }, preHandler: app.auth.requireAdmin }, async (req) => ({ ok: true, role: req.user!.role }));
  return app;
}

const login = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
  app!.inject({ method: "POST", url: "/api/v1/auth/login", payload: body, headers: { origin: ORIGIN, ...headers } });

const sessionCookie = (res: LightMyRequestResponse) => res.cookies.find((c) => c.name.endsWith("pisowifi_session"));
const cookieHeader = (res: LightMyRequestResponse) => {
  const c = sessionCookie(res)!;
  return `${c.name}=${c.value}`;
};

describe("POST /auth/login", () => {
  it("signs in with email + password and sets an HttpOnly, SameSite=Lax session cookie", async () => {
    await start();
    const res = await login({ email: " REY@example.com ", password: ADMIN.password, remember: false });
    expect(res.statusCode).toBe(200);
    expect(sessionUserResponseSchema.parse(res.json())).toEqual({
      user: { id: expect.any(String), email: ADMIN.email, displayName: ADMIN.name, role: "admin" },
    });
    expect(res.json().user).not.toHaveProperty("twoFactorEnabled");
    expect(res.headers["cache-control"]).toBe("no-store");

    const c = sessionCookie(res)!;
    expect(c).toMatchObject({ name: "pisowifi_session", httpOnly: true, sameSite: "Lax", path: "/" });
    expect(c.expires).toBeUndefined(); // not remembered: browser-session cookie
    expect(c.value).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Only the SHA-256 digest is stored.
    const rows = (await pglite.query<{ token_hash: Uint8Array; remember: boolean }>("select token_hash, remember from sessions")).rows;
    expect(rows).toHaveLength(1);
    expect(Buffer.from(rows[0]!.token_hash).equals(hashToken(c.value))).toBe(true);
    expect(rows[0]!.remember).toBe(false);
    expect((await pglite.query("select action from audit_log")).rows).toEqual([{ action: "auth.login.succeeded" }]);
  });

  it("remember me sets a persistent cookie (30 days)", async () => {
    await start();
    const c = sessionCookie(await login({ email: ADMIN.email, password: ADMIN.password, remember: true }))!;
    const days = (new Date(c.expires!).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);
  });

  it("uses the __Host- prefix and Secure flag when SESSION_COOKIE_SECURE is on", async () => {
    await start({ SESSION_COOKIE_SECURE: "true" });
    const c = sessionCookie(await login({ email: ADMIN.email, password: ADMIN.password }))!;
    expect(c).toMatchObject({ name: "__Host-pisowifi_session", secure: true, httpOnly: true, path: "/" });
    expect(c.domain).toBeUndefined();
  });

  it("gives the same generic error for a wrong password and an unknown email", async () => {
    await start();
    const wrong = await login({ email: ADMIN.email, password: "wrong password here" });
    const unknown = await login({ email: "nobody@example.com", password: "wrong password here" });
    for (const res of [wrong, unknown]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: { code: "unauthorized", message: AUTH_MESSAGES.invalidCredentials } });
      expect(sessionCookie(res)).toBeUndefined();
    }
  });

  it("validates input with the shared messages", async () => {
    await start();
    const res = await login({ email: "", password: "" });
    expect(res.statusCode).toBe(400);
    expect(apiErrorSchema.parse(res.json()).error.fields).toEqual({ email: AUTH_MESSAGES.emailRequired, password: AUTH_MESSAGES.passwordRequired });
  });

  it(`locks the account for 15 minutes after ${MAX_FAILED_LOGINS} wrong passwords, even for the right one`, async () => {
    await start();
    for (let i = 0; i < MAX_FAILED_LOGINS; i++) expect((await login({ email: ADMIN.email, password: "wrong password here" })).statusCode).toBe(401);
    const res = await login({ email: ADMIN.email, password: ADMIN.password });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe("rate_limited");
    expect(sessionCookie(res)).toBeUndefined();
    const [u] = (await pglite.query<{ locked: boolean }>("select locked_until > now() + interval '14 minutes' as locked from users where email = $1", [ADMIN.email])).rows;
    expect(u!.locked).toBe(true);
    // The other account is unaffected.
    expect((await login({ email: VIEWER.email, password: VIEWER.password })).statusCode).toBe(200);
  });

  it("a successful sign-in resets the failure count", async () => {
    await start();
    for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) await login({ email: ADMIN.email, password: "wrong password here" });
    expect((await login({ email: ADMIN.email, password: ADMIN.password })).statusCode).toBe(200);
    expect((await pglite.query("select failed_login_count from users where email = $1", [ADMIN.email])).rows).toEqual([{ failed_login_count: 0 }]);
  });

  it("rate-limits sign-in attempts per IP", async () => {
    await start({ LOGIN_RATE_LIMIT: "3" });
    for (let i = 0; i < 3; i++) await login({ email: "nobody@example.com", password: "x" });
    const res = await login({ email: ADMIN.email, password: ADMIN.password });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: { code: "rate_limited", message: expect.stringContaining("Too many sign-in attempts") } });
    expect(res.headers["retry-after"]).toBeDefined();
  });

  it("rotates the session: a cookie sent at sign-in is revoked", async () => {
    await start();
    const first = await login({ email: ADMIN.email, password: ADMIN.password });
    const second = await login({ email: ADMIN.email, password: ADMIN.password }, { cookie: cookieHeader(first) });
    expect(sessionCookie(second)!.value).not.toBe(sessionCookie(first)!.value);
    expect((await app!.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: cookieHeader(first) } })).statusCode).toBe(401);
    expect((await app!.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: cookieHeader(second) } })).statusCode).toBe(200);
  });

  it("has no registration or two-factor endpoints", async () => {
    await start();
    for (const url of ["/api/v1/auth/register", "/api/v1/auth/signup", "/api/v1/auth/2fa/verify"]) {
      expect((await app!.inject({ method: "POST", url, payload: {}, headers: { origin: ORIGIN } })).statusCode).toBe(404);
    }
  });
});

describe("sessions", () => {
  it("GET /auth/me returns the user for a live session and 401 otherwise", async () => {
    await start();
    const res = await login({ email: ADMIN.email, password: ADMIN.password });
    const me = await app!.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: cookieHeader(res) } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual(res.json());

    for (const cookie of [undefined, "pisowifi_session=" + "A".repeat(43), "pisowifi_session=not-a-token"]) {
      const r = await app!.inject({ method: "GET", url: "/api/v1/auth/me", headers: cookie ? { cookie } : {} });
      expect(r.statusCode).toBe(401);
      expect(r.json().error.code).toBe("unauthorized");
    }
  });

  it("expired sessions are rejected", async () => {
    await start();
    const res = await login({ email: ADMIN.email, password: ADMIN.password });
    await pglite.exec("update sessions set created_at = now() - interval '2 days', expires_at = now() - interval '1 second'");
    expect((await app!.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie: cookieHeader(res) } })).statusCode).toBe(401);
  });

  it("POST /auth/logout revokes the session and clears the cookie", async () => {
    await start();
    const cookie = cookieHeader(await login({ email: ADMIN.email, password: ADMIN.password }));
    const out = await app!.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie, origin: ORIGIN } });
    expect(out.statusCode).toBe(204);
    const cleared = sessionCookie(out)!;
    expect(cleared.value).toBe("");
    expect(new Date(cleared.expires!).getTime()).toBeLessThan(Date.now());
    expect((await app!.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);
    expect((await pglite.query("select count(*)::int as n from sessions where revoked_at is not null")).rows).toEqual([{ n: 1 }]);
  });
});

describe("CSRF origin check", () => {
  it("accepts the exact HTTPS web origin for login and logout, and rejects other origins", async () => {
    const httpsOrigin = "https://web.example.test";
    await start({ APP_ORIGIN: httpsOrigin, SESSION_COOKIE_SECURE: "true" });
    const payload = { email: ADMIN.email, password: ADMIN.password };
    const signedIn = await app!.inject({ method: "POST", url: "/api/v1/auth/login", payload, headers: { origin: httpsOrigin } });
    expect(signedIn.statusCode).toBe(200);
    expect(sessionCookie(signedIn)).toMatchObject({ name: "__Host-pisowifi_session", secure: true, httpOnly: true, sameSite: "Lax", path: "/" });

    for (const headers of [
      {},
      { origin: "http://web.example.test" },
      { origin: "https://outside.example.test", "sec-fetch-site": "cross-site" },
      { origin: "null" },
      { origin: "https://web.example.test/path" },
    ]) {
      const response = await app!.inject({ method: "POST", url: "/api/v1/auth/login", payload, headers });
      expect(response.statusCode, JSON.stringify(headers)).toBe(403);
      expect(sessionCookie(response)).toBeUndefined();
    }

    const cookie = cookieHeader(signedIn);
    expect((await app!.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie, origin: "https://outside.example.test" } })).statusCode).toBe(403);
    expect((await app!.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(200);
    const signedOut = await app!.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { cookie, origin: httpsOrigin } });
    expect(signedOut.statusCode).toBe(204);
    expect((await app!.inject({ method: "GET", url: "/api/v1/auth/me", headers: { cookie } })).statusCode).toBe(401);
  });

  it("blocks state-changing requests without the app's Origin", async () => {
    await start();
    for (const headers of [{}, { origin: "https://evil.example" }, { origin: "http://localhost:3000.evil.example" }]) {
      const res = await app!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: ADMIN.email, password: ADMIN.password }, headers });
      expect(res.statusCode).toBe(403);
      expect(sessionCookie(res)).toBeUndefined();
    }
    // Same-origin fetches that omit Origin are allowed.
    const ok = await app!.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { email: ADMIN.email, password: ADMIN.password },
      headers: { "sec-fetch-site": "same-origin" },
    });
    expect(ok.statusCode).toBe(200);
  });

  it("APP_EXTRA_ORIGINS: listed origins pass exactly; APP_ORIGIN still passes; others are still blocked", async () => {
    const LAN = "http://192.168.100.226:3000";
    await start({ APP_EXTRA_ORIGINS: LAN });
    const post = (origin: string) =>
      app!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email: ADMIN.email, password: ADMIN.password }, headers: { origin } });
    for (const origin of [LAN, ORIGIN]) expect((await post(origin)).statusCode).toBe(200);
    for (const origin of [
      "http://192.168.100.226:3001",
      "https://192.168.100.226:3000",
      "http://192.168.100.227:3000",
      "http://192.168.100.226:3000.evil.example",
      "http://192.168.100.226:3000/",
      "https://evil.example",
      "null",
    ]) {
      const res = await post(origin);
      expect(res.statusCode, origin).toBe(403);
      expect(sessionCookie(res)).toBeUndefined();
    }
  });

  it("without APP_EXTRA_ORIGINS the LAN origin is blocked", async () => {
    await start();
    const res = await app!.inject({ method: "POST", url: "/api/v1/auth/logout", headers: { origin: "http://192.168.100.226:3000" } });
    expect(res.statusCode).toBe(403);
  });
});

describe("role guard", () => {
  it("requireAdmin: 401 signed out, 403 for viewers, allowed for admins", async () => {
    await start();
    const url = "/api/v1/test/admin-only";
    expect((await app!.inject({ method: "GET", url })).statusCode).toBe(401);
    const viewer = await app!.inject({ method: "GET", url, headers: { cookie: cookieHeader(await login({ email: VIEWER.email, password: VIEWER.password })) } });
    expect(viewer.statusCode).toBe(403);
    expect(viewer.json().error.code).toBe("forbidden");
    const admin = await app!.inject({ method: "GET", url, headers: { cookie: cookieHeader(await login({ email: ADMIN.email, password: ADMIN.password })) } });
    expect(admin.json()).toEqual({ ok: true, role: "admin" });
  });
});

describe("password hashing", () => {
  it("uses Argon2id (OWASP parameters) with a unique salt", async () => {
    const a = await hashPassword(ADMIN.password);
    const b = await hashPassword(ADMIN.password);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, ADMIN.password)).toBe(true);
    expect(await verifyPassword(a, ADMIN.password + "x")).toBe(false);
    expect(await verifyPassword("not a hash", ADMIN.password)).toBe(false);
    expect(needsRehash(a)).toBe(false);
    expect(needsRehash("$argon2id$v=19$m=4096,t=3,p=1$abc$def")).toBe(true);
    await expect(hashPassword("short")).rejects.toThrow(RangeError);
  });
});
