/* Account management (B4): profile, change password, sessions, password reset by email.
   Real migrations on PGlite; a fake mailer records messages instead of sending them. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { AUTH_MESSAGES, sessionsResponseSchema } from "@pisowifi/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema/index.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import type { MailMessage, Mailer } from "../src/mail/mailer.js";
import { hashPassword } from "../src/auth/password.js";
import { hashToken } from "../src/auth/sessions.js";
import { sessionLabel } from "../src/auth/user-agent.js";
import { MAX_RESETS_PER_HOUR } from "../src/auth/password-reset.js";

const ORIGIN = "http://localhost:3000";
const PW = "correct horse battery";
const NEW_PW = "a brand new passphrase";
const ME = { email: "rey@example.com", name: "Rey" };
const OTHER = { email: "partner@example.com", name: "Partner" };
const CHROME_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const SAFARI_IOS = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

let pglite: PGlite;
let db: Db;
let app: FastifyInstance | undefined;
let sent: MailMessage[];
const fakeMailer: Mailer = {
  send: async (m) => {
    sent.push(m);
  },
};

beforeAll(async () => {
  pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  await migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
  db = { orm: orm as never, pool: null as never, check: async () => true, close: async () => {} };
});
afterAll(() => pglite.close());

beforeEach(async () => {
  sent = [];
  await pglite.exec("delete from sessions; delete from password_reset_tokens; delete from audit_log; delete from users");
  const hash = await hashPassword(PW);
  await pglite.query("insert into users (email, display_name, password_hash, role) values ($1, $2, $3, 'admin'), ($4, $5, $3, 'admin')", [
    ME.email,
    ME.name,
    hash,
    OTHER.email,
    OTHER.name,
  ]);
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(mailer: Mailer | null = fakeMailer) {
  app = await buildApp(loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN }), { db, mailer });
  return app;
}

const cookieOf = (res: LightMyRequestResponse) => {
  const c = res.cookies.find((x) => x.name.endsWith("pisowifi_session"))!;
  return `${c.name}=${c.value}`;
};
async function signIn(email = ME.email, password = PW, ua = CHROME_WIN) {
  const res = await app!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password }, headers: { origin: ORIGIN, "user-agent": ua } });
  expect(res.statusCode).toBe(200);
  return cookieOf(res);
}
const call = (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, cookie?: string, payload?: unknown) =>
  app!.inject({ method, url: "/api/v1" + url, payload: payload as never, headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}) } });
const me = async (cookie: string) => (await call("GET", "/auth/me", cookie)).statusCode;
const audits = async () => (await pglite.query<{ action: string }>("select action from audit_log order by id")).rows.map((r) => r.action);

describe("profile", () => {
  it("updates name and email; the old address is told about the email change", async () => {
    await start();
    const cookie = await signIn();
    const res = await call("PATCH", "/account/profile", cookie, { displayName: " Rey M ", email: "rey.new@example.com" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: { id: expect.any(String), email: "rey.new@example.com", displayName: "Rey M", role: "admin" } });
    expect((await call("GET", "/auth/me", cookie)).json().user.email).toBe("rey.new@example.com");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: ME.email, subject: expect.stringContaining("email was changed") });
    expect(sent[0]!.text).toContain("rey.new@example.com");
    expect(await audits()).toContain("account.profile_updated");
  });

  it("a name-only change sends no email", async () => {
    await start();
    const cookie = await signIn();
    expect((await call("PATCH", "/account/profile", cookie, { displayName: "Rey", email: "REY@example.com" })).statusCode).toBe(200);
    expect(sent).toEqual([]);
  });

  it("refuses an email another account uses (ignoring case) and validates input", async () => {
    await start();
    const cookie = await signIn();
    const dup = await call("PATCH", "/account/profile", cookie, { displayName: "Rey", email: "PARTNER@example.com" });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.fields).toEqual({ email: AUTH_MESSAGES.emailTaken });
    const bad = await call("PATCH", "/account/profile", cookie, { displayName: " ", email: "nope" });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.fields).toEqual({ displayName: AUTH_MESSAGES.displayNameRequired, email: AUTH_MESSAGES.emailInvalid });
  });

  it("requires a session and the app's Origin", async () => {
    await start();
    expect((await call("PATCH", "/account/profile", undefined, { displayName: "X", email: "x@example.com" })).statusCode).toBe(401);
    const cookie = await signIn();
    const res = await app!.inject({ method: "PATCH", url: "/api/v1/account/profile", payload: { displayName: "X", email: "x@example.com" }, headers: { cookie } });
    expect(res.statusCode).toBe(403);
  });
});

describe("change password", () => {
  it("needs the current password; nothing changes when it is wrong", async () => {
    await start();
    const cookie = await signIn();
    const res = await call("POST", "/account/password", cookie, { currentPassword: "not my password", newPassword: NEW_PW, confirmPassword: NEW_PW });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.fields).toEqual({ currentPassword: AUTH_MESSAGES.currentPasswordIncorrect });
    expect((await call("POST", "/auth/login", undefined, { email: ME.email, password: PW })).statusCode).toBe(200);
    expect(sent).toEqual([]);
  });

  it("uses the shared rules (length, unchanged, confirmation)", async () => {
    await start();
    const cookie = await signIn();
    const res = await call("POST", "/account/password", cookie, { currentPassword: PW, newPassword: "short", confirmPassword: "other" });
    expect(res.json().error.fields).toEqual({ newPassword: AUTH_MESSAGES.passwordTooShort, confirmPassword: AUTH_MESSAGES.passwordMismatch });
    const same = await call("POST", "/account/password", cookie, { currentPassword: PW, newPassword: PW, confirmPassword: PW });
    expect(same.json().error.fields).toEqual({ newPassword: AUTH_MESSAGES.passwordUnchanged });
  });

  it("changes it, keeps this session, signs out the others, voids reset links and notifies", async () => {
    await start();
    const here = await signIn();
    const phone = await signIn(ME.email, PW, SAFARI_IOS);
    await call("POST", "/auth/password-reset", undefined, { email: ME.email });
    sent = [];

    const res = await call("POST", "/account/password", here, { currentPassword: PW, newPassword: NEW_PW, confirmPassword: NEW_PW });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: 1 });
    expect(await me(here)).toBe(200);
    expect(await me(phone)).toBe(401);
    expect((await call("POST", "/auth/login", undefined, { email: ME.email, password: PW })).statusCode).toBe(401);
    expect((await call("POST", "/auth/login", undefined, { email: ME.email, password: NEW_PW })).statusCode).toBe(200);
    expect((await pglite.query("select count(*)::int as n from password_reset_tokens where used_at is null")).rows).toEqual([{ n: 0 }]);
    expect(sent.map((m) => [m.to, m.subject])).toEqual([[ME.email, expect.stringContaining("password was changed")]]);
    const [row] = (await pglite.query<{ h: string }>("select password_hash as h from users where email = $1", [ME.email])).rows;
    expect(row!.h).toMatch(/^\$argon2id\$/);
  });
});

describe("sessions", () => {
  it("lists live sessions with a device label, current first-class", async () => {
    await start();
    const here = await signIn();
    await signIn(ME.email, PW, SAFARI_IOS);
    await signIn(OTHER.email); // someone else's session is never listed
    const res = await call("GET", "/account/sessions", here);
    const { items } = sessionsResponseSchema.parse(res.json());
    expect(items.map((s) => [s.label, s.current]).sort()).toEqual([
      ["Chrome on Windows", true],
      ["Safari on iOS", false],
    ]);
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("revokes one other session; not the current one, not someone else's", async () => {
    await start();
    const here = await signIn();
    const phone = await signIn(ME.email, PW, SAFARI_IOS);
    const partner = await signIn(OTHER.email);
    const items = sessionsResponseSchema.parse((await call("GET", "/account/sessions", here)).json()).items;
    const current = items.find((s) => s.current)!;
    const other = items.find((s) => !s.current)!;
    const partnerId = sessionsResponseSchema.parse((await call("GET", "/account/sessions", partner)).json()).items[0]!.id;

    expect((await call("DELETE", `/account/sessions/${current.id}`, here)).statusCode).toBe(400);
    expect((await call("DELETE", `/account/sessions/${partnerId}`, here)).statusCode).toBe(404);
    expect((await call("DELETE", "/account/sessions/not-a-uuid", here)).statusCode).toBe(404);
    expect((await call("DELETE", `/account/sessions/${other.id}`, here)).statusCode).toBe(204);
    expect(await me(phone)).toBe(401);
    expect(await me(here)).toBe(200);
    expect(await me(partner)).toBe(200);
    expect((await call("DELETE", `/account/sessions/${other.id}`, here)).statusCode).toBe(404);
  });

  it("signs out all other sessions", async () => {
    await start();
    const here = await signIn();
    const a = await signIn(ME.email, PW, SAFARI_IOS);
    const b = await signIn(ME.email, PW, "curl/8");
    expect((await call("POST", "/account/sessions/revoke-others", here)).json()).toEqual({ revoked: 2 });
    expect([await me(here), await me(a), await me(b)]).toEqual([200, 401, 401]);
    expect(await audits()).toContain("account.other_sessions_revoked");
  });

  it("labels devices from the user agent", () => {
    expect(sessionLabel(CHROME_WIN)).toBe("Chrome on Windows");
    expect(sessionLabel(SAFARI_IOS)).toBe("Safari on iOS");
    expect(sessionLabel("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/141.0 Mobile Safari/537.36 EdgA/141.0")).toBe("Edge on Android");
    expect(sessionLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:131.0) Gecko/20100101 Firefox/131.0")).toBe("Firefox on macOS");
    expect(sessionLabel(undefined)).toBe("Unknown device");
  });
});

describe("password reset", () => {
  const tokenFrom = (m: MailMessage) => /reset-password#token=([A-Za-z0-9_-]{43})/.exec(m.text)?.[1];

  it("is unavailable (503) until email is enabled, without revealing accounts", async () => {
    await start(null);
    for (const email of [ME.email, "nobody@example.com"]) {
      const res = await call("POST", "/auth/password-reset", undefined, { email });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: { code: "unavailable", message: AUTH_MESSAGES.resetUnavailable } });
    }
  });

  it("answers 202 for any email and mails a one-time link only to real accounts", async () => {
    await start();
    expect((await call("POST", "/auth/password-reset", undefined, { email: "nobody@example.com" })).statusCode).toBe(202);
    expect(sent).toEqual([]);
    expect((await call("POST", "/auth/password-reset", undefined, { email: " REY@example.com " })).statusCode).toBe(202);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(ME.email);
    expect(sent[0]!.text).toContain(`${ORIGIN}/reset-password#token=`);
    const token = tokenFrom(sent[0]!)!;
    const [row] = (await pglite.query<{ token_hash: Uint8Array; mins: number }>(
      "select token_hash, round(extract(epoch from expires_at - created_at) / 60)::int as mins from password_reset_tokens",
    )).rows;
    expect(Buffer.from(row!.token_hash).equals(hashToken(token))).toBe(true);
    expect(row!.mins).toBe(30);
    expect(await call("POST", "/auth/password-reset", undefined, { email: "bad" }).then((r) => r.statusCode)).toBe(400);
  });

  it("resets once: new password works, sessions end, account unlocks, link can't be reused", async () => {
    await start();
    const session = await signIn();
    await pglite.query("update users set locked_until = now() + interval '10 minutes', failed_login_count = 3 where email = $1", [ME.email]);
    await call("POST", "/auth/password-reset", undefined, { email: ME.email });
    const token = tokenFrom(sent[0]!)!;
    sent = [];

    const res = await call("POST", "/auth/password-reset/confirm", undefined, { token, password: NEW_PW });
    expect(res.statusCode).toBe(204);
    expect(await me(session)).toBe(401);
    expect((await call("POST", "/auth/login", undefined, { email: ME.email, password: NEW_PW })).statusCode).toBe(200);
    expect(sent.map((m) => m.subject)).toEqual([expect.stringContaining("password was changed")]);

    const again = await call("POST", "/auth/password-reset/confirm", undefined, { token, password: "yet another passphrase" });
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({ error: { code: "invalid_token", message: AUTH_MESSAGES.resetLinkInvalid } });
    expect(await audits()).toEqual(expect.arrayContaining(["auth.password_reset.requested", "auth.password_reset.completed"]));
  });

  it("rejects expired, replaced and malformed links; checks the new password", async () => {
    await start();
    await call("POST", "/auth/password-reset", undefined, { email: ME.email });
    await call("POST", "/auth/password-reset", undefined, { email: ME.email });
    const [first, second] = [tokenFrom(sent[0]!)!, tokenFrom(sent[1]!)!];
    const confirm = (token: string, password = NEW_PW) => call("POST", "/auth/password-reset/confirm", undefined, { token, password });

    expect((await confirm(first)).statusCode).toBe(400); // replaced by the second request
    expect((await confirm("short")).json().error.code).toBe("invalid_token");
    const weak = await confirm(second, "short");
    expect(weak.json().error.fields).toEqual({ password: AUTH_MESSAGES.passwordTooShort });
    await pglite.exec("update password_reset_tokens set created_at = now() - interval '2 hours', expires_at = now() - interval '1 minute'");
    expect((await confirm(second)).statusCode).toBe(400);
    expect((await call("POST", "/auth/login", undefined, { email: ME.email, password: PW })).statusCode).toBe(200);
  });

  it(`sends at most ${MAX_RESETS_PER_HOUR} links per account per hour`, async () => {
    await start();
    for (let i = 0; i < MAX_RESETS_PER_HOUR + 1; i++) expect((await call("POST", "/auth/password-reset", undefined, { email: ME.email })).statusCode).toBe(202);
    expect(sent).toHaveLength(MAX_RESETS_PER_HOUR);
    expect(await audits()).toContain("auth.password_reset.throttled");
  });

  it("rate-limits reset requests per IP", async () => {
    await start();
    for (let i = 0; i < 5; i++) await call("POST", "/auth/password-reset", undefined, { email: `n${i}@example.com` });
    const res = await call("POST", "/auth/password-reset", undefined, { email: ME.email });
    expect(res.statusCode).toBe(429);
    expect(res.json()).toEqual({ error: { code: "rate_limited", message: "Too many attempts. Try again in 15 minutes." } });
  });

  it("has no registration endpoint", async () => {
    await start();
    expect((await call("POST", "/account/register", undefined, {})).statusCode).toBe(404);
    expect((await call("POST", "/auth/register", undefined, {})).statusCode).toBe(404);
  });
});
