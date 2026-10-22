/* Remote admin through the ZeroTier gateway: entry ticket issuing (POST /remote/machines/:id/ticket).
   No network access and no real keys: each run generates a throwaway Ed25519 pair in a temporary directory.
   When the gateway repository is checked out next to this one, its own verifier checks the tickets too. */
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateKeyPairSync, verify, type KeyObject } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { FastifyInstance } from "fastify";
import { GATEWAY_ENTRY_PATH, remoteTicketResponseSchema } from "@pisowifi/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema/index.js";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import { hashPassword } from "../src/auth/password.js";
import { bareIp, destinationRefusal, isSafeAdminPath, issueTicket, loadTicketKey, parseDenyList, type TicketClaims } from "../src/remote/ticket.js";
import { parseCidrList } from "../src/gateway/target.js";

const ORIGIN = "http://localhost:3000";
const GW = "https://gw.example.com";
const PW = "correct horse battery";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/* The gateway's accepted shapes (pisowifi-zerotier-gateway src/ticket.ts). */
const SHAPE = /^[A-Za-z0-9_-]{16,1600}\.[A-Za-z0-9_-]{86}$/;
const JTI = /^[A-Za-z0-9_-]{16,64}$/;

const keyDir = mkdtempSync(join(tmpdir(), "pw-remote-"));
const keys = generateKeyPairSync("ed25519");
const privateFile = join(keyDir, "ticket-private.pem");
const publicFile = join(keyDir, "ticket-public.pem");
writeFileSync(privateFile, keys.privateKey.export({ type: "pkcs8", format: "pem" }));
writeFileSync(publicFile, keys.publicKey.export({ type: "spki", format: "pem" }));
const PRIVATE_PEM = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const ENABLED = { REMOTE_GATEWAY_ENABLED: "true", REMOTE_GATEWAY_ORIGIN: GW, REMOTE_TICKET_PRIVATE_KEY_FILE: privateFile, ZT_ALLOWED_CIDRS: "192.168.194.0/24" };
/** The production deny list so far: the gateway VM's own ZeroTier IP and the former development PC. */
const DENY = "192.168.194.104,192.168.194.22";

function ticketOf(entryUrl: string): string {
  const u = new URL(entryUrl);
  expect(u.origin + u.pathname).toBe(GW + GATEWAY_ENTRY_PATH);
  expect(u.search).toBe("");
  return u.hash.replace(/^#t=/, "");
}

function decode(token: string, publicKey: KeyObject = keys.publicKey): TicketClaims {
  expect(token).toMatch(SHAPE);
  const [payload, signature] = token.split(".") as [string, string];
  expect(verify(null, Buffer.from(payload, "ascii"), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TicketClaims;
}

/** Addresses the gateway refuses with MACHINE_POLICY=signed, ZT_ALLOWED_CIDRS=192.168.194.0/24, ZT_DENY_IPS=DENY. */
const REFUSED_IPS = ["192.168.194.104", "192.168.194.22", "10.0.0.5", "192.168.195.10", "127.0.0.1", "169.254.169.254", "168.63.129.16",
  "0.0.0.0", "255.255.255.255", "224.0.0.1", "192.168.194.0", "192.168.194.255", "192.168.194.082", "192.168.194.08", "192.168.194.150:8080",
  "192.168.194.150/32", "pisowifi.local", "::1", "3232285334", ""];
const ACCEPTED_IPS = ["192.168.194.82", "192.168.194.127", "192.168.194.1", "192.168.194.150", "192.168.194.254"];

/* ---------------- unit: signer ---------------- */

describe("ticket signer", () => {
  it("loads only an Ed25519 private key, without echoing the file", () => {
    expect(loadTicketKey(privateFile).asymmetricKeyType).toBe("ed25519");
    expect(() => loadTicketKey(publicFile)).toThrow(/REMOTE_TICKET_PRIVATE_KEY_FILE: not a readable PEM private key/);
    expect(() => loadTicketKey(join(keyDir, "missing.pem"))).toThrow(/REMOTE_TICKET_PRIVATE_KEY_FILE/);
    const rsa = join(keyDir, "rsa.pem");
    writeFileSync(rsa, generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey.export({ type: "pkcs8", format: "pem" }));
    expect(() => loadTicketKey(rsa)).toThrow(/must be an Ed25519 private key/);
    const junk = join(keyDir, "junk.pem");
    writeFileSync(junk, "-----BEGIN PRIVATE KEY-----\nc2VjcmV0LXZhbHVl\n-----END PRIVATE KEY-----\n");
    try {
      loadTicketKey(junk);
    } catch (e) {
      expect(String(e)).not.toContain("c2VjcmV0LXZhbHVl");
    }
  });

  it("signs the gateway's exact format and claims", () => {
    const now = Date.UTC(2026, 9, 15, 4, 0, 0);
    const t = issueTicket({ origin: GW, userId: "u-1", machineId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", ip: "192.168.194.82", path: "/admin", ttlS: 60, nowMs: now }, keys.privateKey);
    const claims = decode(ticketOf(t.entryUrl));
    expect(Object.keys(claims)).toEqual(["v", "aud", "jti", "iat", "exp", "sub", "mid", "ip", "path"]);
    expect(claims).toMatchObject({ v: 1, aud: GW, iat: now / 1000, exp: now / 1000 + 60, sub: "u-1", mid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", ip: "192.168.194.82", path: "/admin" });
    expect(claims.jti).toMatch(JTI);
    expect(t.jti).toBe(claims.jti);
    expect(t.expiresAt.getTime()).toBe(now + 60_000);
    // Never longer than the gateway accepts.
    const long = decode(ticketOf(issueTicket({ origin: GW, userId: "u", machineId: "x", ip: "1.2.3.4", path: "/", ttlS: 999 }, keys.privateKey).entryUrl));
    expect(long.exp - long.iat).toBe(120);
  });

  it("admin paths and IPs follow the gateway's rules", () => {
    for (const ok of ["/admin", "/", "/admin/index.html?x=1", "/a%20b"]) expect(isSafeAdminPath(ok), ok).toBe(true);
    for (const bad of ["admin", "//evil.example/x", "/a/../b", "/%2e%2e/x", "/a\\b", "/a b", "/a\u0000", "/" + "a".repeat(200), "/%E0%A4%A"]) expect(isSafeAdminPath(bad), bad).toBe(false);
    expect(bareIp("192.168.194.82")).toBe("192.168.194.82");
    expect(bareIp("192.168.194.82/32")).toBe("192.168.194.82");
    expect(bareIp("::1")).toBeNull();
  });
});

/* ---------------- API ---------------- */

let pglite: PGlite;
let db: Db;
let app: FastifyInstance | undefined;
let admin: string;
let viewer: string;
let adminId: string;
let m82: string;
let mOther: string;
let mBadPath: string;

beforeAll(async () => {
  pglite = new PGlite();
  const orm = drizzle(pglite, { schema });
  await migrate(orm, { migrationsFolder: MIGRATIONS_FOLDER });
  db = { orm: orm as never, pool: null as never, check: async () => true, close: async () => {} };
  const hash = await hashPassword(PW);
  await pglite.query("insert into users (email, display_name, password_hash, role) values ('admin@example.com', 'Admin', $1, 'admin'), ('viewer@example.com', 'Viewer', $1, 'viewer')", [hash]);
  adminId = (await pglite.query<{ id: string }>("select id from users where email = 'admin@example.com'")).rows[0]!.id;
});
afterAll(() => pglite.close());

async function start(env: Record<string, string> = ENABLED) {
  app = await buildApp(loadConfig({ NODE_ENV: "test", APP_ORIGIN: ORIGIN, ...env }), { db });
  const signIn = async (email: string) => {
    const res = await app!.inject({ method: "POST", url: "/api/v1/auth/login", payload: { email, password: PW }, headers: { origin: ORIGIN } });
    const c = res.cookies.find((x) => x.name.endsWith("pisowifi_session"))!;
    return `${c.name}=${c.value}`;
  };
  admin = await signIn("admin@example.com");
  viewer = await signIn("viewer@example.com");
}

beforeEach(async () => {
  await pglite.exec("delete from machines; delete from audit_log; delete from sessions");
  const ins = async (name: string, ip: string, path = "/admin", software = "WiFi5Soft") =>
    (await pglite.query<{ id: string }>("insert into machines (name, zt_ip, admin_path, software) values ($1, $2, $3, $4) returning id", [name, ip, path, software])).rows[0]!.id;
  m82 = await ins("WiFi5Soft 01", "192.168.194.82");
  mOther = await ins("Other router", "192.168.194.90", "/", "Other");
  mBadPath = await ins("Bad path", "192.168.194.91", "/a/../../etc");
});
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const ticket = (id: string, cookie?: string, headers: Record<string, string> = { origin: ORIGIN }) =>
  app!.inject({ method: "POST", url: `/api/v1/remote/machines/${id}/ticket`, headers: { ...headers, ...(cookie ? { cookie } : {}) } });

describe("POST /remote/machines/:id/ticket", () => {
  it("needs a session with remote:open (Administrators and Limited Users) and the app's Origin", async () => {
    await start();
    expect((await ticket(m82)).statusCode).toBe(401);
    // RBAC-1: a Limited User (viewer) may open Remote Admin; the ticket is the same, bound to their own user id.
    const v = await ticket(m82, viewer);
    expect(v.statusCode).toBe(200);
    expect(decode(ticketOf(remoteTicketResponseSchema.parse(v.json()).entryUrl))).toMatchObject({ mid: m82, ip: "192.168.194.82" });
    expect((await ticket(m82, viewer, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await ticket(m82, admin, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await ticket(m82, admin, {})).statusCode).toBe(403);
    expect((await app!.inject({ method: "GET", url: `/api/v1/remote/machines/${m82}/ticket`, headers: { cookie: admin } })).statusCode).toBe(404);
    // Only the Limited User's ticket above was issued, and its audit row names the role.
    const issued = (await pglite.query<{ meta: { role: string } }>("select meta from audit_log where action = 'remote.ticket_issued'")).rows;
    expect(issued.map((r) => r.meta.role)).toEqual(["viewer"]);
  });

  it("is off by default (503 for every signed-in user, still 401 without a session)", async () => {
    await start({});
    const res = await ticket(m82, admin);
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "unavailable" } });
    expect((await ticket(m82)).statusCode).toBe(401);
    expect((await ticket(m82, viewer)).statusCode).toBe(503);
  });

  it("refuses to start with a key that isn't an Ed25519 private key", async () => {
    await expect(buildApp(loadConfig({ NODE_ENV: "test", ...ENABLED, REMOTE_TICKET_PRIVATE_KEY_FILE: publicFile }), { db })).rejects.toThrow(/REMOTE_TICKET_PRIVATE_KEY_FILE/);
  });

  it("validates the machine id: malformed, unknown, not WiFi5Soft, unsafe record", async () => {
    await start();
    for (const id of ["not-a-uuid", "00000000-0000-4000-8000-000000000000", mOther, "' or 1=1 --"]) {
      const res = await ticket(encodeURIComponent(id), admin);
      expect(res.statusCode, id).toBe(404);
      expect(res.json()).toMatchObject({ error: { code: "not_found" } });
    }
    const bad = await ticket(mBadPath, admin);
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: { code: "invalid_machine" } });
    expect((await pglite.query("select 1 from audit_log where action = 'remote.ticket_issued'")).rows).toHaveLength(0);
  });

  it("issues a signed, single-use, 60-second ticket built only from the session and the machine record", async () => {
    await start();
    const before = Math.floor(Date.now() / 1000);
    const res = await ticket(m82, admin);
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = remoteTicketResponseSchema.parse(res.json());
    const claims = decode(ticketOf(body.entryUrl));
    expect(claims).toMatchObject({ v: 1, aud: GW, sub: adminId, mid: m82, ip: "192.168.194.82", path: "/admin" });
    expect(claims.mid).toMatch(UUID);
    expect(claims.jti).toMatch(JTI);
    expect(claims.exp - claims.iat).toBe(60);
    expect(claims.iat).toBeGreaterThanOrEqual(before);
    expect(Date.parse(body.expiresAt)).toBe(claims.exp * 1000);

    // A second request is a different ticket.
    const again = decode(ticketOf(remoteTicketResponseSchema.parse((await ticket(m82, admin)).json()).entryUrl));
    expect(again.jti).not.toBe(claims.jti);

    // Audited with the jti only; neither the ticket nor the key is stored.
    const rows = (await pglite.query<{ user_id: string; target_type: string; target_id: string; meta: Record<string, unknown> }>("select user_id, target_type, target_id, meta from audit_log where action = 'remote.ticket_issued' order by id")).rows;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ user_id: adminId, target_type: "machine", target_id: m82, meta: { name: "WiFi5Soft 01", ztIp: "192.168.194.82", jti: claims.jti } });
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(ticketOf(body.entryUrl).split(".")[1]);
    expect(stored).not.toContain("PRIVATE KEY");
    expect(res.body).not.toContain(PRIVATE_PEM.split("\n")[1]);
  });

  it("ignores anything the request tries to add (body, query)", async () => {
    await start();
    const res = await app!.inject({
      method: "POST",
      url: `/api/v1/remote/machines/${m82}/ticket?ip=10.0.0.1&path=/evil&ttl=999`,
      headers: { origin: ORIGIN, cookie: admin },
      payload: { ip: "10.0.0.1", path: "//evil.example", mid: mOther, sub: "someone-else", aud: "https://evil.example", exp: 9999999999 },
    });
    const claims = decode(ticketOf(remoteTicketResponseSchema.parse(res.json()).entryUrl));
    expect(claims).toMatchObject({ aud: GW, sub: adminId, mid: m82, ip: "192.168.194.82", path: "/admin" });
    expect(claims.exp - claims.iat).toBe(60);
  });

  it("uses the configured lifetime", async () => {
    await start({ ...ENABLED, REMOTE_TICKET_TTL_S: "30" });
    const claims = decode(ticketOf(remoteTicketResponseSchema.parse((await ticket(m82, admin)).json()).entryUrl));
    expect(claims.exp - claims.iat).toBe(30);
  });

  it("is rate limited", async () => {
    await start();
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await ticket(m82, admin)).statusCode);
    expect(codes.slice(0, 20).every((c) => c === 200)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});

/* ---------------- dynamic registration: destination rules and machine changes ---------------- */

describe("destinationRefusal (same rules as the gateway's signed policy)", () => {
  const rules = { allowed: parseCidrList("192.168.194.0/24"), denied: parseDenyList(DENY) };
  it("accepts plain IPv4 host addresses in the allowed range only", () => {
    for (const ip of ACCEPTED_IPS) expect(destinationRefusal(ip, rules), ip).toBeNull();
    for (const ip of REFUSED_IPS) expect(destinationRefusal(ip, rules), ip).not.toBeNull();
  });
  it("names the rule that failed", () => {
    expect(destinationRefusal("192.168.194.104", rules)).toBe("denied");
    expect(destinationRefusal("10.0.0.5", rules)).toBe("outside_allowed");
    expect(destinationRefusal("169.254.169.254", rules)).toBe("blocked_range");
    expect(destinationRefusal("192.168.194.255", rules)).toBe("network_address");
    expect(destinationRefusal("192.168.194.082", rules)).toBe("invalid_ip");
    expect(destinationRefusal("192.168.194.82", { allowed: [], denied: new Set() })).toBe("outside_allowed");
  });
});

describe("dynamic machine registration (tickets follow the machine record)", () => {
  const insert = async (name: string, ip: string) =>
    (await pglite.query<{ id: string }>("insert into machines (name, zt_ip, admin_path, software) values ($1, $2, '/admin', 'WiFi5Soft') returning id", [name, ip])).rows[0]!.id;
  const claimsFor = async (id: string) => {
    const res = await ticket(id, admin);
    expect(res.statusCode, id).toBe(200);
    return decode(ticketOf(remoteTicketResponseSchema.parse(res.json()).entryUrl));
  };

  it("needs ZT_ALLOWED_CIDRS when remote administration is enabled", () => {
    expect(() => loadConfig({ NODE_ENV: "test", ...ENABLED, ZT_ALLOWED_CIDRS: undefined as unknown as string })).toThrow(/ZT_ALLOWED_CIDRS/);
    expect(() => loadConfig({ NODE_ENV: "test", ...ENABLED, REMOTE_GATEWAY_DENY_IPS: "gw.local" })).toThrow(/REMOTE_GATEWAY_DENY_IPS/);
  });

  it("issues tickets for each registered machine, bound to its own id and IP", async () => {
    await start({ ...ENABLED, REMOTE_GATEWAY_DENY_IPS: DENY });
    const m127 = await insert("PISOWIFI 1", "192.168.194.127");
    const a = await claimsFor(m82);
    const b = await claimsFor(m127);
    expect(a).toMatchObject({ mid: m82, ip: "192.168.194.82" });
    expect(b).toMatchObject({ mid: m127, ip: "192.168.194.127" });
    expect(a.jti).not.toBe(b.jti);
    // A machine added while the API runs works on its next click (no restart, no configuration).
    const added = await insert("PISOWIFI 3", "192.168.194.150");
    expect(await claimsFor(added)).toMatchObject({ mid: added, ip: "192.168.194.150" });
  });

  it("refuses to sign for unsafe or denied addresses, with a clear message and an audit entry", async () => {
    await start({ ...ENABLED, REMOTE_GATEWAY_DENY_IPS: DENY });
    const cases: [string, RegExp][] = [
      ["192.168.194.104", /isn’t a PisoWiFi machine/],
      ["192.168.194.22", /isn’t a PisoWiFi machine/],
      ["10.0.0.5", /outside the network the gateway may open/],
      ["192.168.194.0", /reserved address/],
      ["192.168.194.255", /reserved address/],
      ["127.0.0.1", /reserved address/],
      ["169.254.169.254", /reserved address/],
    ];
    for (const [ip, message] of cases) {
      const id = await insert(`Bad ${ip}`, ip);
      const res = await ticket(id, admin);
      expect(res.statusCode, ip).toBe(422);
      expect(res.json(), ip).toMatchObject({ error: { code: "invalid_machine" } });
      expect(res.json().error.message, ip).toMatch(message);
      expect(res.body, ip).not.toContain("#t=");
      // The gateway's configuration (ranges, other denied addresses) is never echoed.
      expect(res.body, ip).not.toContain("192.168.194.0/24");
      expect(res.body, ip).not.toContain(DENY);
    }
    const refused = (await pglite.query<{ meta: { reason: string } }>("select meta from audit_log where action = 'remote.ticket_refused'")).rows;
    expect(refused.map((r) => r.meta.reason)).toEqual(["denied", "denied", "outside_allowed", "network_address", "network_address", "blocked_range", "blocked_range"]);
    expect((await pglite.query("select 1 from audit_log where action = 'remote.ticket_issued'")).rows).toHaveLength(0);
  });

  it("an IP change in the machine record is reflected in the next ticket", async () => {
    await start(ENABLED);
    expect((await claimsFor(m82)).ip).toBe("192.168.194.82");
    await pglite.query("update machines set zt_ip = '192.168.194.83' where id = $1", [m82]);
    expect(await claimsFor(m82)).toMatchObject({ mid: m82, ip: "192.168.194.83" });
    await pglite.query("update machines set zt_ip = '10.1.2.3' where id = $1", [m82]);
    expect((await ticket(m82, admin)).statusCode).toBe(422);
  });

  it("exact authorization: only pinned machines at their pinned, approved IPs get tickets", async () => {
    const m127 = await insert("Rey Pisowifi", "192.168.194.127");
    const m150 = await insert("Unapproved", "192.168.194.150");
    await start({
      ...ENABLED,
      REMOTE_GATEWAY_DENY_IPS: "192.168.194.162,192.168.194.22",
      REMOTE_GATEWAY_MACHINES: `${m127}@192.168.194.127,${m82}@192.168.194.82`,
      MONITOR_APPROVED_IPS: "192.168.194.127,192.168.194.82",
    });
    expect(await claimsFor(m127)).toMatchObject({ mid: m127, ip: "192.168.194.127" });
    expect(await claimsFor(m82)).toMatchObject({ mid: m82, ip: "192.168.194.82" });
    // Renaming changes nothing: authorization is by id and IP.
    await pglite.query("update machines set name = 'Cris Pisowifi' where id = $1", [m82]);
    expect((await claimsFor(m82)).mid).toBe(m82);

    const refusedNow = async (id: string) => {
      const res = await ticket(id, admin);
      expect(res.statusCode, id).toBe(422);
      expect(res.json().error.message).toMatch(/isn’t approved for remote administration/);
      expect(res.body).not.toContain("#t=");
      expect(res.body).not.toContain("192.168.194.127,192.168.194.82");
    };
    // A third, otherwise valid device in the allowed range.
    await refusedNow(m150);
    // An approved machine whose IP changed to another valid address; an unpinned machine taking over an approved IP.
    await pglite.query("update machines set zt_ip = '192.168.194.83' where id = $1", [m82]);
    await refusedNow(m82);
    await pglite.query("update machines set zt_ip = '192.168.194.82' where id = $1", [m150]);
    await refusedNow(m150);
    await pglite.query("update machines set zt_ip = '192.168.194.150' where id = $1", [m150]);
    // Pinned but no longer in the monitoring boundary.
    await app!.close();
    await pglite.query("update machines set zt_ip = '192.168.194.82' where id = $1", [m82]);
    await start({ ...ENABLED, REMOTE_GATEWAY_MACHINES: `${m127}@192.168.194.127,${m82}@192.168.194.82`, MONITOR_APPROVED_IPS: "192.168.194.127" });
    await refusedNow(m82);
    expect((await claimsFor(m127)).ip).toBe("192.168.194.127");

    const reasons = (await pglite.query<{ meta: { reason: string } }>("select meta from audit_log where action = 'remote.ticket_refused' order by id")).rows.map((r) => r.meta.reason);
    expect(reasons).toEqual(["not_approved", "not_approved", "not_approved", "not_approved"]);
    expect((await pglite.query("select 1 from audit_log where action = 'remote.ticket_issued' and target_id = $1", [m150])).rows).toHaveLength(0);
  });

  it("validates REMOTE_GATEWAY_MACHINES", () => {
    const pair = "0106b182-5066-45d9-9691-88c4275d6696@192.168.194.127";
    expect(loadConfig({ NODE_ENV: "test", REMOTE_GATEWAY_MACHINES: `${pair},361d8efa-2711-497c-9bef-4e29b30ff0e6@192.168.194.82` }).REMOTE_GATEWAY_MACHINES).toBeDefined();
    for (const bad of ["192.168.194.127", "not-a-uuid@192.168.194.127", "0106B182-5066-45D9-9691-88C4275D6696@192.168.194.127", `${pair}:80`, `${pair},${pair}`, `${pair},361d8efa-2711-497c-9bef-4e29b30ff0e6@192.168.194.127`]) {
      expect(() => loadConfig({ NODE_ENV: "test", REMOTE_GATEWAY_MACHINES: bad }), bad).toThrow(/REMOTE_GATEWAY_MACHINES/);
    }
  });

  it("a deleted machine gets no more tickets", async () => {
    await start(ENABLED);
    expect((await ticket(m82, admin)).statusCode).toBe(200);
    await pglite.query("delete from machines where id = $1", [m82]);
    const res = await ticket(m82, admin);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("gives a Limited User exactly the Administrator's machine boundary, nothing wider", async () => {
    const m127 = await insert("Rey Pisowifi", "192.168.194.127");
    const added = await insert("Third device", "192.168.194.150");
    await start({ ...ENABLED, REMOTE_GATEWAY_MACHINES: `${m127}@192.168.194.127,${m82}@192.168.194.82`, MONITOR_APPROVED_IPS: "192.168.194.127,192.168.194.82" });
    for (const id of [m127, m82]) {
      expect((await ticket(id, viewer)).statusCode).toBe(200);
      expect((await ticket(id)).statusCode).toBe(401);
      expect((await ticket(id, viewer, { origin: "https://evil.example" })).statusCode).toBe(403);
    }
    // The unpinned device is refused for both roles, before anything is signed.
    for (const who of [viewer, admin]) {
      const res = await ticket(added, who);
      expect(res.statusCode).toBe(422);
      expect(res.body).not.toContain("#t=");
    }
    // Limited Users still can't change machines.
    const put = await app!.inject({ method: "DELETE", url: `/api/v1/machines/${m82}`, headers: { origin: ORIGIN, cookie: viewer } });
    expect(put.statusCode).toBe(403);
  });
});

/* ---------------- cross-check with the gateway's own verifier (when checked out alongside) ---------------- */

/** The parts of the gateway's src/ticket.ts used here (it lives in another repository, so it isn't type-imported). */
interface GatewayTicketModule {
  ReplayCache: new () => unknown;
  verifyTicket: (
    token: string,
    opts: {
      publicKey: KeyObject;
      audience: string;
      policy?: "static" | "signed";
      machines: ReadonlyMap<string, { id: string; ip: string }>;
      allowedCidrs?: readonly unknown[];
      deniedIps?: ReadonlySet<string>;
      replay: unknown;
      nowMs: number;
    },
  ) => { ok: true; claims: TicketClaims; machine: { id: string; ip: string } } | { ok: false; reason: string };
}

interface GatewayTargetModule {
  parseCidr: (text: string) => unknown;
}

const GATEWAY_TICKET = resolve(process.env.PISOWIFI_GATEWAY_REPO ?? resolve(import.meta.dirname, "../../../../pisowifi-zerotier-gateway"), "src/ticket.ts");

describe.skipIf(!existsSync(GATEWAY_TICKET))("gateway verifier (pisowifi-zerotier-gateway)", () => {
  it("accepts an issued ticket once, for the allowlisted machine and IP only", async () => {
    const gw = (await import(pathToFileURL(GATEWAY_TICKET).href)) as GatewayTicketModule;
    const mid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const machines = new Map([[mid, { id: mid, ip: "192.168.194.82" }]]);
    const replay = new gw.ReplayCache();
    const opts = { publicKey: keys.publicKey, audience: GW, machines, replay, nowMs: Date.now() };
    const token = ticketOf(issueTicket({ origin: GW, userId: adminId ?? "u", machineId: mid, ip: "192.168.194.82", path: "/admin", ttlS: 60 }, keys.privateKey).entryUrl);
    expect(gw.verifyTicket(token, opts)).toMatchObject({ ok: true, claims: { mid, ip: "192.168.194.82", path: "/admin" } });
    expect(gw.verifyTicket(token, opts)).toEqual({ ok: false, reason: "replayed" });
    const wrongIp = ticketOf(issueTicket({ origin: GW, userId: "u", machineId: mid, ip: "192.168.194.83", path: "/admin", ttlS: 60 }, keys.privateKey).entryUrl);
    expect(gw.verifyTicket(wrongIp, opts)).toEqual({ ok: false, reason: "ip_mismatch" });
    const otherAud = issueTicket({ origin: "https://other.example", userId: "u", machineId: mid, ip: "192.168.194.82", path: "/admin", ttlS: 60 }, keys.privateKey).entryUrl.split("#t=")[1]!;
    expect(gw.verifyTicket(otherAud, opts)).toEqual({ ok: false, reason: "wrong_audience" });
    const expired = ticketOf(issueTicket({ origin: GW, userId: "u", machineId: mid, ip: "192.168.194.82", path: "/admin", ttlS: 60, nowMs: Date.now() - 120_000 }, keys.privateKey).entryUrl);
    expect(gw.verifyTicket(expired, opts)).toEqual({ ok: false, reason: "expired" });
    const otherKey = generateKeyPairSync("ed25519").privateKey;
    const forged = ticketOf(issueTicket({ origin: GW, userId: "u", machineId: mid, ip: "192.168.194.82", path: "/admin", ttlS: 60 }, otherKey).entryUrl);
    expect(gw.verifyTicket(forged, opts)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe.skipIf(!existsSync(GATEWAY_TICKET))("gateway verifier, MACHINE_POLICY=signed", () => {
  const load = async () => ({
    gw: (await import(pathToFileURL(GATEWAY_TICKET).href)) as GatewayTicketModule,
    target: (await import(pathToFileURL(resolve(GATEWAY_TICKET, "../target.ts")).href)) as GatewayTargetModule,
  });

  it("accepts the API's ticket for a machine the gateway has never been configured with", async () => {
    await start({ ...ENABLED, REMOTE_GATEWAY_DENY_IPS: DENY });
    const added = (await pglite.query<{ id: string }>("insert into machines (name, zt_ip) values ('PISOWIFI 3', '192.168.194.150') returning id")).rows[0]!.id;
    const res = await ticket(added, admin);
    expect(res.statusCode).toBe(200);
    const token = ticketOf(remoteTicketResponseSchema.parse(res.json()).entryUrl);
    const { gw, target } = await load();
    const opts = {
      publicKey: keys.publicKey,
      audience: GW,
      policy: "signed" as const,
      machines: new Map([[m82, { id: m82, ip: "192.168.194.82" }]]),
      allowedCidrs: [target.parseCidr("192.168.194.0/24")],
      deniedIps: parseDenyList(DENY),
      replay: new gw.ReplayCache(),
      nowMs: Date.now(),
    };
    expect(gw.verifyTicket(token, opts)).toMatchObject({ ok: true, machine: { id: added, ip: "192.168.194.150" } });
    expect(gw.verifyTicket(token, opts)).toEqual({ ok: false, reason: "replayed" });
    // The pinned machine (PISOWIFI 2) keeps working; the static policy still refuses the new one.
    const pinned = ticketOf(remoteTicketResponseSchema.parse((await ticket(m82, admin)).json()).entryUrl);
    expect(gw.verifyTicket(pinned, opts)).toMatchObject({ ok: true, machine: { id: m82, ip: "192.168.194.82" } });
    const again = ticketOf(remoteTicketResponseSchema.parse((await ticket(added, admin)).json()).entryUrl);
    expect(gw.verifyTicket(again, { ...opts, policy: "static" })).toEqual({ ok: false, reason: "machine_not_allowed" });
  });

  it("the API and the gateway agree on every destination", async () => {
    const { gw, target } = await load();
    const rules = { allowed: parseCidrList("192.168.194.0/24"), denied: parseDenyList(DENY) };
    const mid = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    for (const ip of [...ACCEPTED_IPS, ...REFUSED_IPS]) {
      const token = ticketOf(issueTicket({ origin: GW, userId: "u", machineId: mid, ip, path: "/admin", ttlS: 60 }, keys.privateKey).entryUrl);
      const r = gw.verifyTicket(token, {
        publicKey: keys.publicKey,
        audience: GW,
        policy: "signed",
        machines: new Map(),
        allowedCidrs: [target.parseCidr("192.168.194.0/24")],
        deniedIps: parseDenyList(DENY),
        replay: new gw.ReplayCache(),
        nowMs: Date.now(),
      });
      expect(r.ok, ip).toBe(destinationRefusal(ip, rules) === null);
    }
  });
});
