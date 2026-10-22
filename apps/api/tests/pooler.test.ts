/* Supabase transaction-pooler compatibility (Supavisor, port 6543) and connection security:
   - Drizzle must send unnamed statements (no server-side named prepared statements)
   - TLS settings: CA verification on, no unverified mode
   - SCRAM verifier accepted by a real SCRAM client (node-postgres) */
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../src/db/schema/index.js";
import { poolConfig } from "../src/db/pg-config.js";
import { scramSha256Verifier } from "../src/db/scram.js";

interface Captured {
  text: string;
  name?: string;
}

/** A stand-in node-postgres client that records the query configs Drizzle sends. */
function recordingClient() {
  const calls: Captured[] = [];
  const client = {
    async query(cfg: string | Captured) {
      calls.push(typeof cfg === "string" ? { text: cfg } : cfg);
      return { rows: [], fields: [], rowCount: 0, command: "SELECT" };
    },
  };
  return { calls, db: drizzle(client as never, { schema }) };
}

describe("transaction pooler compatibility", () => {
  it("Drizzle sends unnamed statements for selects, inserts, updates, deletes and relational queries", async () => {
    const { calls, db } = recordingClient();
    const id = "7f1b0c9e-2d3a-4b5c-8d9e-0f1a2b3c4d5e";
    await db.select().from(schema.machines).where(eq(schema.machines.id, id));
    await db.insert(schema.events).values({ type: "system", message: "x", occurredAt: new Date() });
    await db.update(schema.machineState).set({ httpStatus: "reachable" }).where(eq(schema.machineState.machineId, id));
    await db.delete(schema.checks).where(eq(schema.checks.machineId, id));
    await db.query.machines.findMany({ limit: 5 });
    expect(calls.length).toBe(5);
    for (const c of calls) expect(c.name, c.text).toBeUndefined();
  });

  it("only .prepare(name) creates named statements (banned by ESLint in src/)", async () => {
    const { calls, db } = recordingClient();
    await db.select().from(schema.machines).prepare("machines_all").execute();
    expect(calls[0]!.name).toBe("machines_all");
  });
});

describe("TLS settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "pw-ca-"));
  const caPath = join(dir, "ca.pem");
  writeFileSync(caPath, "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----\n");

  it("verify: CA pinned and certificate verification on", () => {
    const cfg = poolConfig("postgresql://u:p@db.example.com:6543/postgres", { tls: { mode: "verify", caPath }, applicationName: "t" });
    expect(cfg.ssl).toEqual({ ca: expect.stringContaining("BEGIN CERTIFICATE"), rejectUnauthorized: true });
    expect(cfg.max).toBe(5);
  });

  it("slow links: separate connect timeout, connections kept with keep-alive", () => {
    const cfg = poolConfig("postgresql://u:p@db.example.com:6543/postgres", { tls: { mode: "verify", caPath }, applicationName: "t", timeoutMs: 10_000, connectTimeoutMs: 20_000 });
    expect(cfg).toMatchObject({ connectionTimeoutMillis: 20_000, query_timeout: 10_000, keepAlive: true });
    expect(cfg.idleTimeoutMillis).toBeGreaterThanOrEqual(300_000);
    expect(poolConfig("postgresql://u:p@127.0.0.1/x", { tls: { mode: "off" }, applicationName: "t", timeoutMs: 500 }).connectionTimeoutMillis).toBe(500);
  });

  it("off: no TLS; verify without a CA is refused", () => {
    expect(poolConfig("postgresql://u:p@127.0.0.1:5432/x", { tls: { mode: "off" }, applicationName: "t" }).ssl).toBe(false);
    expect(() => poolConfig("postgresql://u:p@db.example.com/x", { tls: { mode: "verify" }, applicationName: "t" })).toThrow(/DATABASE_SSL_CA/);
  });
});

describe("SCRAM-SHA-256 verifier for the runtime role", () => {
  // node-postgres' own SCRAM client (the code path used when the app logs in).
  const sasl = createRequire(import.meta.url)("pg/lib/crypto/sasl.js") as {
    startSession(mechanisms: string[]): { clientNonce: string; response: string; serverSignature?: string };
    continueSession(session: object, password: string, serverData: string): Promise<void>;
  };

  it("has PostgreSQL's pg_authid format and never contains the password", () => {
    const pw = "Zq7!pW4r#Lm9tX2vB8nK6sD1";
    const v = scramSha256Verifier(pw);
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    expect(v).not.toContain(pw);
    expect(scramSha256Verifier(pw)).not.toBe(v); // random salt
    expect(() => scramSha256Verifier("short")).toThrow(/24–128 printable ASCII/);
  });

  it("a real SCRAM client's proof verifies against it, as the server would check", async () => {
    const password = randomBytes(32).toString("base64");
    const [, iter, salt, storedB64, serverB64] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(scramSha256Verifier(password))!;
    const session = sasl.startSession(["SCRAM-SHA-256"]);
    const nonce = session.clientNonce + "server-nonce";
    const serverFirst = `r=${nonce},s=${salt},i=${iter}`;
    await sasl.continueSession(session, password, serverFirst);

    const proof = Buffer.from(/,p=(.+)$/.exec(session.response)![1]!, "base64");
    const authMessage = `n=*,r=${session.clientNonce},${serverFirst},c=biws,r=${nonce}`;
    const storedKey = Buffer.from(storedB64!, "base64");
    const clientSignature = createHmac("sha256", storedKey).update(authMessage).digest();
    const clientKey = Buffer.from(proof.map((b, i) => b ^ clientSignature[i]!));
    expect(createHash("sha256").update(clientKey).digest().equals(storedKey)).toBe(true);
    // The client also accepts the server's signature derived from our ServerKey.
    expect(createHmac("sha256", Buffer.from(serverB64!, "base64")).update(authMessage).digest("base64")).toBe(session.serverSignature);
  });

  it("a wrong password does not verify", async () => {
    const [, iter, salt, storedB64] = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(scramSha256Verifier("a".repeat(24)))!;
    const session = sasl.startSession(["SCRAM-SHA-256"]);
    const nonce = session.clientNonce + "x";
    const serverFirst = `r=${nonce},s=${salt},i=${iter}`;
    await sasl.continueSession(session, "b".repeat(24), serverFirst);
    const proof = Buffer.from(/,p=(.+)$/.exec(session.response)![1]!, "base64");
    const storedKey = Buffer.from(storedB64!, "base64");
    const sig = createHmac("sha256", storedKey).update(`n=*,r=${session.clientNonce},${serverFirst},c=biws,r=${nonce}`).digest();
    expect(createHash("sha256").update(Buffer.from(proof.map((b, i) => b ^ sig[i]!))).digest().equals(storedKey)).toBe(false);
  });
});
