/* RBAC on a real, DISPOSABLE PostgreSQL server (TEST_DATABASE_URL, see tests/support/real-db.ts). Skipped when unset;
   refuses production, Supabase/pooler hosts and non-loopback servers. Every block works in its own freshly created
   database with its own seeded test accounts (example.test addresses), dropped afterwards.

   Covers what PGlite (single connection) can't: concurrent demotion/deactivation under every isolation level,
   the trigger running as the RLS-bound runtime role, compatibility with the pre-RBAC API's statements, migration
   lock contention with bounded waiting, the rollback script, re-applying 0005, and app-rollback safety.

   Local run (PowerShell, disposable server on loopback):
     $env:TEST_DATABASE_URL="postgres://pgtest@127.0.0.1:55417/postgres"; npx vitest run tests/rbac-postgres.test.ts */
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import { applyMigrations, localMigrations, migrationStatus, MigrationRefused } from "../src/db/migrator.js";
import { NEUTRALIZED_PREFIX, read0005State, readRollbackSafety, schemaReady } from "../src/db/rbac-state.js";
import { verifyPassword } from "../src/auth/password.js";
import { createScratchDatabase, disposableServerUrl, type ScratchDatabase } from "./support/real-db.js";

const serverUrl = disposableServerUrl();
const DOWN_SQL = readFileSync(resolve(__dirname, "../../../deploy/rbac/0005_user_management.down.sql"), "utf8");
const NEUTRALIZE_SQL = readFileSync(resolve(__dirname, "../../../deploy/rbac/neutralize-deactivated.sql"), "utf8");
const HASH = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaA";
type Iso = "read committed" | "repeatable read" | "serializable";

/** A copy of the migrations folder that stops before `stopBefore` (for "production today" = 0000-0004). */
function migrationsUpTo(stopBefore: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pisowifi-mig-"));
  mkdirSync(join(dir, "meta"));
  const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: { tag: string }[] };
  const cut = journal.entries.findIndex((e) => e.tag === stopBefore);
  journal.entries = journal.entries.slice(0, cut);
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify(journal));
  for (const e of journal.entries) copyFileSync(join(MIGRATIONS_FOLDER, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  return dir;
}

async function connect(url: string, name = "pisowifi-rbac-pg-test") {
  const c = new pg.Client({ connectionString: url, application_name: name });
  await c.connect();
  return c;
}

/** The test accounts: two Administrators and one Limited User, unique per call. */
async function seed(c: pg.Client) {
  await c.query("truncate public.users cascade"); // TRUNCATE doesn't fire the per-statement DELETE trigger
  const tag = Math.random().toString(36).slice(2, 8);
  const ins = async (name: string, role: string) =>
    (await c.query<{ id: string }>("insert into public.users (email, display_name, password_hash, role) values ($1, $2, $3, $4) returning id", [`${name}-${tag}@example.test`, name, HASH, role])).rows[0]!.id;
  return { a: await ins("admin-a", "admin"), b: await ins("admin-b", "admin"), v: await ins("limited", "viewer") };
}

const activeAdmins = async (c: pg.Client) => Number((await c.query("select count(*) n from public.users where role = 'admin' and disabled_at is null")).rows[0].n);

/** Waits until `pid` is blocked on a lock (so the race really overlaps). */
async function waitBlocked(mon: pg.Client, pid: number) {
  for (let i = 0; i < 200; i++) {
    const { rows } = await mon.query("select count(*)::int n from pg_locks where pid = $1 and not granted", [pid]);
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("second transaction never blocked");
}

/** Starts the real API entry point (src/server.ts) against `databaseUrl` on a free loopback port. No .env is loaded. */
function startApi(databaseUrl: string) {
  const port = 43000 + Math.floor(Math.random() * 2000);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, NODE_ENV: "development", HOST: "127.0.0.1", PORT: String(port),
    APP_ORIGIN: "http://localhost:3000", DATABASE_URL: databaseUrl, DATABASE_SSL: "off", DATABASE_CONNECT_TIMEOUT_MS: "2000", LOG_LEVEL: "info",
  };
  const proc = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], { cwd: resolve(__dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  proc.stdout.on("data", (d) => (output += d));
  proc.stderr.on("data", (d) => (output += d));
  const exited = new Promise<number | null>((r) => proc.on("exit", (code) => r(code)));
  const get = async (path: string) => {
    for (let i = 0; i < 120; i++) {
      try {
        return (await fetch(`http://127.0.0.1:${port}/api/v1/${path}`)).status;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    throw new Error(`API never answered: ${output.slice(-500)}`);
  };
  return { proc, exited, get, output: () => output, stop: async () => (proc.kill(), await exited) };
}

const DEMOTE = (id: string) => [`update public.users set role = 'viewer' where id = $1`, [id]] as const;
const DEACTIVATE = (id: string) => [`update public.users set disabled_at = now() where id = $1`, [id]] as const;

describe.skipIf(!serverUrl)("RBAC on a disposable PostgreSQL server", () => {
  describe("active-admin guard under concurrency", () => {
    let db: ScratchDatabase;
    let owner: pg.Client, c1: pg.Client, c2: pg.Client, mon: pg.Client;

    beforeAll(async () => {
      db = await createScratchDatabase(serverUrl!, "race");
      owner = await connect(db.url);
      expect((await applyMigrations(owner, MIGRATIONS_FOLDER)).applied).toContain("0005_user_management");
      [c1, c2, mon] = [await connect(db.url), await connect(db.url), await connect(db.url)];
    }, 60_000);
    afterAll(async () => {
      for (const c of [owner, c1, c2, mon]) await c?.end().catch(() => {});
      await db?.drop();
    });

    /** T2 takes its snapshot first, T1 changes one admin, T2 changes the other while T1 still holds the guard lock,
     *  then T1 commits. Returns T2's outcome. With 2 admins, at most one change may commit. */
    async function race(iso: Iso, first: readonly [string, readonly unknown[]], second: readonly [string, readonly unknown[]], asRole?: string) {
      for (const c of [c1, c2]) {
        await c.query(`begin isolation level ${iso}`);
        if (asRole) await c.query(`set local role ${asRole}`);
      }
      await c2.query("select count(*) from public.users"); // fixes T2's snapshot before T1 commits (REPEATABLE READ worst case)
      await c1.query(first[0], [...first[1]]);
      const pid2 = (await c2.query("select pg_backend_pid() pid")).rows[0].pid as number;
      const p2 = c2.query(second[0], [...second[1]]).then(
        () => "updated" as const,
        (e: { code?: string }) => e.code ?? "error",
      );
      await waitBlocked(mon, pid2);
      await c1.query("commit");
      const outcome = await p2;
      if (outcome === "updated") {
        const commit = await c2.query("commit").then(() => "committed" as const, (e: { code?: string }) => e.code ?? "error");
        return commit;
      }
      await c2.query("rollback");
      return outcome;
    }

    const cases: [string, (ids: { a: string; b: string }) => [readonly [string, readonly unknown[]], readonly [string, readonly unknown[]]]][] = [
      ["demote vs demote", ({ a, b }) => [DEMOTE(a), DEMOTE(b)]],
      ["demote vs deactivate", ({ a, b }) => [DEMOTE(a), DEACTIVATE(b)]],
      ["deactivate vs demote", ({ a, b }) => [DEACTIVATE(a), DEMOTE(b)]],
      ["deactivate vs deactivate", ({ a, b }) => [DEACTIVATE(a), DEACTIVATE(b)]],
    ];

    it.each(cases)("%s (READ COMMITTED): the second change is refused and one active admin remains", async (_n, make) => {
      const ids = await seed(owner);
      const [first, second] = make(ids);
      expect(await race("read committed", first, second)).toBe("23514"); // users_active_admin_required, never "committed"
      expect(await activeAdmins(owner)).toBe(1);
    });

    // Without the isolation check both REPEATABLE READ demotions committed (zero admins), reproduced on PostgreSQL 17.
    it.each(["repeatable read", "serializable"] as const)("%s: role and deactivation changes are refused outright", async (iso) => {
      const ids = await seed(owner);
      for (const [stmt, args] of [DEMOTE(ids.a), DEACTIVATE(ids.v), ["delete from public.users where id = $1", [ids.v]] as const]) {
        await c1.query(`begin isolation level ${iso}`);
        await expect(c1.query(stmt, [...args])).rejects.toMatchObject({ code: "25000", message: expect.stringMatching(/READ COMMITTED/) });
        await c1.query("rollback");
      }
      // Ordinary account updates (sign-in bookkeeping, profile) are unaffected in any isolation level.
      await c1.query(`begin isolation level ${iso}`);
      await c1.query("update public.users set last_login_at = now(), failed_login_count = 0 where id = $1", [ids.a]);
      await c1.query("commit");
      expect(await activeAdmins(owner)).toBe(2);
    });

    it("runs as the RLS-bound runtime role pisowifi_app (as the API does)", async () => {
      const ids = await seed(owner);
      expect(await race("read committed", DEMOTE(ids.a), DEACTIVATE(ids.b), "pisowifi_app")).toBe("23514");
      expect(await activeAdmins(owner)).toBe(1);
    });

    it("still allows every change that leaves an active admin, including concurrent ones", async () => {
      const ids = await seed(owner);
      expect(await race("read committed", DEMOTE(ids.a), DEACTIVATE(ids.v))).toBe("committed");
      expect(await activeAdmins(owner)).toBe(1);
      await owner.query("update public.users set disabled_at = null where id = $1", [ids.v]);
      await owner.query("update public.users set role = 'admin' where id = $1", [ids.v]); // promote the Limited User
      expect(await activeAdmins(owner)).toBe(2);
    });

    it("refuses single statements that remove every active admin (SQL, CLI or API alike)", async () => {
      await seed(owner);
      for (const stmt of ["update public.users set role = 'viewer'", "update public.users set disabled_at = now()", "delete from public.users where role = 'admin'"]) {
        await expect(owner.query(stmt)).rejects.toMatchObject({ code: "23514", constraint: "users_active_admin_required" });
      }
      expect(await activeAdmins(owner)).toBe(2);
    });

    it("leaves the pre-RBAC API's statements unaffected (no trigger on login, password, profile or account creation)", async () => {
      const ids = await seed(owner);
      await owner.query("set role pisowifi_app");
      try {
        // R3-era statements: explicit column lists (Drizzle), never role/disabled_at.
        await owner.query("select id, email, display_name, password_hash, role, failed_login_count, locked_until, last_login_at, created_at, updated_at from public.users");
        await owner.query("update public.users set failed_login_count = 0, locked_until = null, last_login_at = now() where id = $1", [ids.a]);
        await owner.query("update public.users set password_hash = $2, failed_login_count = 0, locked_until = null where id = $1", [ids.a, HASH]);
        await owner.query("update public.users set display_name = 'A', email = $2 where id = $1", [ids.a, `a2-${ids.a.slice(0, 6)}@example.test`]);
        await owner.query("insert into public.users (email, display_name, password_hash, role) values ($1, 'New', $2, 'viewer')", [`new-${ids.a.slice(0, 6)}@example.test`, HASH]);
      } finally {
        await owner.query("reset role");
      }
    });
  });

  describe("migration 0005 on a production-like database (0000-0004 + accounts)", () => {
    let db: ScratchDatabase;
    let owner: pg.Client, holder: pg.Client, reader: pg.Client;
    let upTo0004: string;

    beforeAll(async () => {
      upTo0004 = migrationsUpTo("0005_user_management");
      db = await createScratchDatabase(serverUrl!, "mig");
      owner = await connect(db.url, "pisowifi-migrate-test");
      holder = await connect(db.url, "pisowifi-api-like");
      reader = await connect(db.url, "pisowifi-api-like-2");
      expect((await applyMigrations(owner, upTo0004)).applied).toHaveLength(5);
      await seed(owner);
    }, 60_000);
    afterAll(async () => {
      for (const c of [owner, holder, reader]) await c?.end().catch(() => {});
      await db?.drop();
      rmSync(upTo0004, { recursive: true, force: true });
    });

    it("status is read-only and reports exactly 0005 pending", async () => {
      const s = await migrationStatus(owner, MIGRATIONS_FOLDER);
      expect(s.pending).toEqual(["0005_user_management"]);
      expect(s.applied.every((a) => a.hashMatches)).toBe(true);
      expect(s.unknown).toEqual([]);
      expect(schemaReady(await read0005State(owner))).toBe(false);
    });

    it("start-up gate: the RBAC API refuses to serve a database without 0005 (exit 78), and starts when unreachable", async () => {
      const api = startApi(db.url);
      const code = await Promise.race([api.exited, new Promise((r) => setTimeout(() => r("still running"), 25_000))]);
      if (code === "still running") await api.stop();
      expect(code).toBe(78);
      expect(api.output()).toMatch(/migration 0005_user_management is not applied/);
      // Unreachable database: not proof either way, so it starts (readyz 503) and keeps checking.
      const down = startApi("postgres://nobody@127.0.0.1:1/none");
      try {
        expect(await down.get("healthz")).toBe(200);
        expect(await down.get("readyz")).toBe(503);
        expect(down.output()).toMatch(/schema check deferred/);
      } finally {
        await down.stop();
      }
    }, 60_000);

    it("refuses when the pending set isn't exactly the approved list, applying nothing", async () => {
      await expect(applyMigrations(owner, MIGRATIONS_FOLDER, { expectPending: [] })).rejects.toBeInstanceOf(MigrationRefused);
      await expect(applyMigrations(owner, MIGRATIONS_FOLDER, { expectPending: ["0006_other"] })).rejects.toThrow(/expected \[0006_other\]/);
      expect((await migrationStatus(owner, MIGRATIONS_FOLDER)).pending).toEqual(["0005_user_management"]);
    });

    it("refuses on migration drift (an applied file edited afterwards)", async () => {
      await owner.query("update drizzle.__drizzle_migrations set hash = 'edited' where created_at = (select min(created_at) from drizzle.__drizzle_migrations)");
      try {
        await expect(applyMigrations(owner, MIGRATIONS_FOLDER, { expectPending: ["0005_user_management"] })).rejects.toThrow(/differ from the local files: 0000_init/);
      } finally {
        const { hash } = localMigrations(MIGRATIONS_FOLDER)[0]!;
        await owner.query("update drizzle.__drizzle_migrations set hash = $1 where hash = 'edited'", [hash]);
      }
    });

    it("lock contention: fails within the lock timeout, applies nothing and stalls other queries only briefly", async () => {
      // An API-like transaction holds a read lock on users (as any in-flight request might).
      await holder.query("begin");
      await holder.query("select count(*) from public.users");
      const t0 = Date.now();
      const migrating = applyMigrations(owner, MIGRATIONS_FOLDER, { lockTimeoutMs: 1000, expectPending: ["0005_user_management"] }).then(
        () => "applied",
        (e: { code?: string }) => e.code ?? String(e),
      );
      // Meanwhile a new request touches users: it queues behind the waiting ALTER TABLE, but only until it gives up.
      await new Promise((r) => setTimeout(r, 200));
      const r0 = Date.now();
      await reader.query("select count(*) from public.users");
      const readerWaitMs = Date.now() - r0;
      expect(await migrating).toBe("55P03"); // lock_not_available
      const elapsed = Date.now() - t0;
      expect(elapsed).toBeLessThan(5000);
      expect(readerWaitMs).toBeLessThan(2500);
      await holder.query("commit");
      expect(schemaReady(await read0005State(owner))).toBe(false);
      expect((await migrationStatus(owner, MIGRATIONS_FOLDER)).pending).toEqual(["0005_user_management"]);
    });

    it("applies 0005 in one transaction with the bounded timeouts, accounts untouched", async () => {
      const before = (await owner.query("select id, role, password_hash from public.users order by id")).rows;
      const r = await applyMigrations(owner, MIGRATIONS_FOLDER, { expectPending: ["0005_user_management"] });
      expect(r).toEqual({ applied: ["0005_user_management"], lockTimeoutMs: 3000, statementTimeoutMs: 60_000 });
      expect(schemaReady(await read0005State(owner))).toBe(true);
      expect((await owner.query("select id, role, password_hash from public.users order by id")).rows).toEqual(before);
      expect((await owner.query("select count(*)::int n from public.users where disabled_at is not null")).rows[0].n).toBe(0);
      // Session settings were transaction-local: nothing leaks to the connection.
      expect((await owner.query("show lock_timeout")).rows[0].lock_timeout).toBe("0");
      // Running again is a no-op; expecting 0005 again is refused.
      expect((await applyMigrations(owner, MIGRATIONS_FOLDER)).applied).toEqual([]);
      await expect(applyMigrations(owner, MIGRATIONS_FOLDER, { expectPending: ["0005_user_management"] })).rejects.toThrow(/pending migrations are \[none\]/);
    });

    it("start-up gate: with 0005 applied the RBAC API serves and is ready", async () => {
      const api = startApi(db.url);
      try {
        expect(await api.get("readyz")).toBe(200);
        expect(await api.get("users")).toBe(401); // the RBAC route exists, deny-by-default without a session
        expect(api.proc.exitCode).toBeNull();
      } finally {
        await api.stop();
      }
    }, 60_000);

    it("rollback safety: deactivated accounts block an app rollback until neutralized (never reactivated)", async () => {
      const { v } = (await owner.query<{ v: string }>("select id v from public.users where role = 'viewer' limit 1")).rows[0]!;
      await owner.query("insert into public.sessions (user_id, token_hash, expires_at) values ($1, decode(repeat('01', 32), 'hex'), now() + interval '1 day')", [v]);
      expect(await readRollbackSafety(owner)).toMatchObject({ schema0005: true, deactivated: 0, unsafeDeactivated: 0, activeAdmins: 2 });
      await owner.query("update public.users set disabled_at = now() where id = $1", [v]);
      expect(await readRollbackSafety(owner)).toMatchObject({ deactivated: 1, unsafeDeactivated: 1 });
      await owner.query(NEUTRALIZE_SQL);
      const after = await readRollbackSafety(owner);
      expect(after).toMatchObject({ deactivated: 1, unsafeDeactivated: 0, activeAdmins: 2 });
      const row = (await owner.query("select password_hash, disabled_at from public.users where id = $1", [v])).rows[0];
      expect(row.disabled_at).not.toBeNull(); // still deactivated
      expect(row.password_hash.startsWith(NEUTRALIZED_PREFIX)).toBe(true);
      expect(await verifyPassword(row.password_hash, "any password")).toBe(false); // every release rejects it
      // Idempotent; active accounts untouched.
      await owner.query(NEUTRALIZE_SQL);
      expect((await owner.query("select count(*)::int n from public.users where left(password_hash, 18) = $1", [NEUTRALIZED_PREFIX])).rows[0].n).toBe(1);
    });

    it("the down script refuses while anyone is deactivated, so the schema rollback can't silently reactivate", async () => {
      await expect(owner.query(DOWN_SQL)).rejects.toThrow(/rollback refused/);
      await owner.query("rollback"); // the script's own BEGIN left an aborted transaction
      expect(schemaReady(await read0005State(owner))).toBe(true);
    });

    it("down script removes exactly 0005, then 0005 re-applies cleanly and guards again", async () => {
      await owner.query("update public.users set disabled_at = null, disabled_by = null"); // test data only
      await owner.query(DOWN_SQL);
      expect(await read0005State(owner)).toEqual({ columns: false, trigger: false, fn: false });
      expect((await migrationStatus(owner, MIGRATIONS_FOLDER)).pending).toEqual(["0005_user_management"]);
      const cols = (await owner.query("select count(*)::int n from information_schema.columns where table_name = 'users'")).rows[0].n;
      expect(cols).toBe(10); // the 0004 shape: what the R3 API was built for
      expect((await applyMigrations(owner, MIGRATIONS_FOLDER, { expectPending: ["0005_user_management"] })).applied).toEqual(["0005_user_management"]);
      await expect(owner.query("update public.users set role = 'viewer'")).rejects.toMatchObject({ code: "23514" });
    });
  });
});

describe("real-database guard", () => {
  it("refuses production, Supabase, pooler, runtime-role and non-loopback URLs", async () => {
    const { unsafeReason } = await import("./support/real-db.js");
    for (const bad of [
      "postgres://postgres.apgktwrpsrwljjeyslwi:x@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres",
      "postgres://postgres:x@db.apgktwrpsrwljjeyslwi.supabase.co:5432/postgres",
      "postgres://u:x@aws-0-ap-southeast-2.pooler.supabase.com:6543/postgres",
      "postgres://pisowifi_app:x@127.0.0.1:5432/postgres",
      "postgres://u:x@127.0.0.1:6543/postgres",
      "postgres://u:x@10.0.0.5:5432/postgres",
      "mysql://u:x@127.0.0.1/db",
    ]) {
      expect(unsafeReason(bad, undefined), bad).not.toBeNull();
    }
    expect(unsafeReason("postgres://pgtest@127.0.0.1:55417/postgres", undefined)).toBeNull();
    expect(unsafeReason("postgres://u@ci-postgres:5432/postgres", "ci-postgres")).toBeNull();
    expect(unsafeReason("postgres://u@db.apgktwrpsrwljjeyslwi.supabase.co:5432/postgres", "db.apgktwrpsrwljjeyslwi.supabase.co")).not.toBeNull();
  });
});
