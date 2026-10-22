/* Migration tests: apply the real SQL migrations, then exercise constraints, defaults, cascades and indexes.
   Always runs on PGlite (PostgreSQL compiled to WebAssembly, in-process). Also runs against a real server when
   TEST_DATABASE_URL is set (CI: PostgreSQL 17): a disposable server only (tests/support/real-db.ts refuses production,
   Supabase/pooler and non-loopback hosts), in a freshly created database that is dropped afterwards. Each test runs in
   a transaction that is rolled back. */
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import {
  CHECK_ERROR_KINDS,
  EVENT_TYPES,
  INTERNET_STATES,
  MACHINE_STATUSES,
  MONITOR_HEALTH_STATES,
  ROLES,
  SOFTWARE_TYPES,
  ZEROTIER_STATES,
} from "@pisowifi/shared";
import { MIGRATIONS_FOLDER } from "../src/db/migrations-path.js";
import { poolConfig } from "../src/db/pg-config.js";
import { createScratchDatabase, disposableServerUrl } from "./support/real-db.js";

/** What a Supabase project has before our migrations: Data API roles that receive grants on new tables. */
const SUPABASE_ROLES = [
  "create role anon nologin noinherit",
  "create role authenticated nologin noinherit",
  "grant usage on schema public to anon, authenticated",
  "alter default privileges in schema public grant all on tables to anon, authenticated",
  "alter default privileges in schema public grant all on sequences to anon, authenticated",
];

interface Target {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

async function pgliteTarget(before: string[] = []): Promise<Target> {
  const db = new PGlite();
  for (const stmt of before) await db.exec(stmt);
  await migratePglite(drizzlePglite(db), { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    query: async (text, params) => (await db.query(text, params)).rows as never,
    close: () => db.close(),
  };
}

/** A disposable real server, in a scratch database created for this run. */
async function serverTarget(serverUrl: string): Promise<Target> {
  const scratch = await createScratchDatabase(serverUrl, "migrations");
  const url = scratch.url;
  const pool = new pg.Pool(
    poolConfig(url, {
      tls: { mode: process.env.DATABASE_SSL === "verify" ? "verify" : "off", caPath: process.env.DATABASE_SSL_CA },
      max: 1,
      applicationName: "pisowifi-migration-tests",
      timeoutMs: 60_000,
    }),
  );
  await migratePg(drizzlePg(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  const client = await pool.connect();
  return {
    query: async (text, params) => (await client.query(text, params as unknown[])).rows,
    close: async () => {
      client.release();
      await pool.end();
      await scratch.drop();
    },
  };
}

const targets: [string, () => Promise<Target>][] = [
  ["PGlite (in-process PostgreSQL)", () => pgliteTarget()],
  ["PGlite with Supabase Data API roles", () => pgliteTarget(SUPABASE_ROLES)],
];
const serverUrl = disposableServerUrl();
if (serverUrl) targets.push(["PostgreSQL server (TEST_DATABASE_URL)", () => serverTarget(serverUrl)]);

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest();

describe.each(targets)("migrations on %s", (_name, make) => {
  let db: Target;
  let sp = 0;

  beforeAll(async () => {
    db = await make();
  }, 60_000);
  afterAll(async () => db?.close());
  beforeEach(async () => {
    await db.query("begin");
  });
  afterEach(async () => {
    await db.query("rollback");
  });

  /** Runs a statement that must fail, inside a savepoint so the test transaction stays usable. */
  async function rejects(text: string, params: unknown[], match: RegExp) {
    const name = "sp" + ++sp;
    await db.query(`savepoint ${name}`);
    try {
      await db.query(text, params);
    } catch (e) {
      await db.query(`rollback to savepoint ${name}`);
      expect((e as Error).message).toMatch(match);
      return;
    }
    throw new Error(`expected failure (${match}) but statement succeeded: ${text}`);
  }

  async function user(email = "admin@example.com", role = "admin") {
    const [u] = await db.query<{ id: string }>(
      "insert into users (email, display_name, password_hash, role) values ($1, 'Admin', '$argon2id$v=19$m=65536,t=3,p=4$x$y', $2) returning id",
      [email, role],
    );
    return u!.id;
  }
  async function machine(name = "PisoWiFi 01", ip = "192.168.194.82", extra: Record<string, unknown> = {}) {
    const cols = ["name", "zt_ip", ...Object.keys(extra)];
    const vals = [name, ip, ...Object.values(extra)];
    const [m] = await db.query<{ id: string }>(
      `insert into machines (${cols.join(", ")}) values (${cols.map((_, i) => "$" + (i + 1)).join(", ")}) returning id`,
      vals,
    );
    return m!.id;
  }

  describe("structure", () => {
    it("creates every table", async () => {
      const rows = await db.query<{ table_name: string }>("select table_name from information_schema.tables where table_schema = 'public' order by 1");
      expect(rows.map((r) => r.table_name)).toEqual([
        "audit_log",
        "check_rollups_hourly",
        "checks",
        "events",
        "machine_state",
        "machines",
        "monitoring_settings",
        "notification_deliveries",
        "notification_prefs",
        "outages",
        "password_reset_tokens",
        "sessions",
        "users",
      ]);
    });

    it("enums match the shared contracts exactly", async () => {
      const rows = await db.query<{ t: string; v: string[] }>(
        "select t.typname as t, array_agg(e.enumlabel::text order by e.enumsortorder) as v from pg_type t join pg_enum e on e.enumtypid = t.oid group by t.typname",
      );
      const enums = Object.fromEntries(rows.map((r) => [r.t, r.v]));
      expect(enums).toEqual({
        user_role: [...ROLES],
        software_type: [...SOFTWARE_TYPES],
        http_status: [...MACHINE_STATUSES],
        zerotier_state: [...ZEROTIER_STATES],
        internet_state: [...INTERNET_STATES],
        monitor_health: [...MONITOR_HEALTH_STATES],
        event_type: [...EVENT_TYPES],
        check_trigger: ["schedule", "manual"],
        check_error_kind: [...CHECK_ERROR_KINDS],
        notification_kind: ["unreachable", "reachable"],
        delivery_status: ["pending", "sending", "sent", "failed"],
      });
    });

    it("seeds one default monitoring settings row and keeps it single", async () => {
      expect(await db.query("select id, interval_seconds, timeout_seconds, stale_threshold from monitoring_settings")).toEqual([
        { id: 1, interval_seconds: 60, timeout_seconds: 5, stale_threshold: 3 },
      ]);
      await rejects("insert into monitoring_settings (id) values (2)", [], /monitoring_settings_singleton/);
      await rejects("update monitoring_settings set interval_seconds = 45", [], /monitoring_settings_interval/);
      await rejects("update monitoring_settings set timeout_seconds = 31", [], /monitoring_settings_timeout/);
      await rejects("update monitoring_settings set stale_threshold = 0", [], /monitoring_settings_threshold/);
    });
  });

  describe("users and credentials", () => {
    it("roles are admin/viewer only (viewer by default); email is unique ignoring case", async () => {
      const [u] = await db.query<{ role: string }>(
        "insert into users (email, display_name, password_hash) values ('v@example.com', 'Viewer', 'h') returning role",
      );
      expect(u!.role).toBe("viewer");
      await rejects("insert into users (email, display_name, password_hash, role) values ('o@example.com', 'O', 'h', 'owner')", [], /invalid input value for enum user_role/);
      await rejects("insert into users (email, display_name, password_hash) values ('V@Example.com', 'Dup', 'h')", [], /users_email_lower_key/);
      await rejects("insert into users (email, display_name, password_hash) values ('not-an-email', 'X', 'h')", [], /users_email_format/);
      await rejects("insert into users (email, display_name, password_hash) values ('x@example.com', '  ', 'h')", [], /users_display_name_len/);
    });

    it("has no two-factor storage (removed in 0003)", async () => {
      const cols = await db.query<{ c: string }>(
        "select table_name || '.' || column_name as c from information_schema.columns where table_schema = 'public' and (column_name like 'totp%' or column_name like 'mfa%')",
      );
      expect(cols).toEqual([]);
      expect(await db.query("select to_regclass('public.totp_backup_codes') as t")).toEqual([{ t: null }]);
    });

    it("sessions store only a 32-byte SHA-256 digest, unique, and cascade with the user", async () => {
      const uid = await user();
      const token = randomBytes(32).toString("base64url");
      await db.query("insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '12 hours')", [uid, sha256(token)]);
      const [row] = await db.query<{ token_hash: Buffer | Uint8Array }>("select token_hash from sessions");
      expect(Buffer.from(row!.token_hash).equals(sha256(token))).toBe(true);
      expect(Buffer.from(row!.token_hash).toString("utf8")).not.toContain(token);

      await rejects("insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')", [uid, Buffer.from(token)], /sessions_token_hash_len/);
      await rejects("insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 hour')", [uid, sha256(token)], /sessions_token_hash_key/);
      await rejects("insert into sessions (user_id, token_hash, expires_at) values ($1, $2, now() - interval '1 hour')", [uid, sha256("x")], /sessions_expiry_after_creation/);

      await db.query("insert into password_reset_tokens (user_id, token_hash, expires_at) values ($1, $2, now() + interval '30 minutes')", [uid, sha256("reset")]);
      await db.query("insert into notification_prefs (user_id) values ($1)", [uid]);
      await db.query("insert into audit_log (user_id, action) values ($1, 'user.created')", [uid]);
      await db.query("delete from users where id = $1", [uid]);
      for (const t of ["sessions", "password_reset_tokens", "notification_prefs"]) {
        expect(await db.query(`select 1 from ${t}`)).toHaveLength(0);
      }
      // The audit trail survives the user.
      expect(await db.query("select user_id from audit_log")).toEqual([{ user_id: null }]);
    });
  });

  describe("machines", () => {
    it("accepts a valid machine; ZeroTier Member ID is optional", async () => {
      const id = await machine();
      const [m] = await db.query<Record<string, unknown>>("select zt_member_id, zt_network_id, admin_path, software, tags, monitoring_enabled from machines where id = $1", [id]);
      expect(m).toEqual({ zt_member_id: null, zt_network_id: null, admin_path: "/admin", software: "WiFi5Soft", tags: [], monitoring_enabled: true });
      await machine("PisoWiFi 02", "192.168.194.127", { zt_network_id: "8056c2e21c000001", zt_member_id: "a1b2c3d4e5" });
    });

    it("names and IPs are unique (names ignoring case)", async () => {
      await machine();
      await rejects("insert into machines (name, zt_ip) values ('pisowifi 01', '192.168.194.90')", [], /machines_name_lower_key/);
      await rejects("insert into machines (name, zt_ip) values ('PisoWiFi 03', '192.168.194.82')", [], /machines_zt_ip_key/);
    });

    it.each([
      ["IPv6 address", { zt_ip: "fd00::1" }, /machines_zt_ip_ipv4_host/],
      ["CIDR range", { zt_ip: "192.168.194.0/24" }, /machines_zt_ip_ipv4_host/],
      ["untrimmed name", { name: " PisoWiFi 09" }, /machines_name_valid/],
      ["empty name", { name: "" }, /machines_name_valid/],
      ["path without /", { admin_path: "admin" }, /machines_admin_path_format/],
      ["bad network ID", { zt_network_id: "XYZ" }, /machines_zt_network_id_format/],
      ["uppercase network ID", { zt_network_id: "8056C2E21C000001" }, /machines_zt_network_id_format/],
      ["bad member ID", { zt_network_id: "8056c2e21c000001", zt_member_id: "123" }, /machines_zt_member_id_format/],
      ["member ID without network", { zt_member_id: "a1b2c3d4e5" }, /machines_zt_member_needs_network/],
      ["unknown software", { software: "Mikrotik" }, /invalid input value for enum software_type/],
    ])("rejects %s", async (_label, cols, match) => {
      const row: Record<string, unknown> = { name: "PisoWiFi 09", zt_ip: "192.168.194.99", ...cols };
      const keys = Object.keys(row);
      await rejects(`insert into machines (${keys.join(", ")}) values (${keys.map((_, i) => "$" + (i + 1)).join(", ")})`, Object.values(row), match);
    });

    it("rejects more than 8 tags and member IDs reused within a network", async () => {
      await rejects("insert into machines (name, zt_ip, tags) values ('X', '192.168.194.98', $1)", [Array.from({ length: 9 }, (_, i) => "t" + i)], /machines_tags_limit/);
      await machine("A", "192.168.194.11", { zt_network_id: "8056c2e21c000001", zt_member_id: "a1b2c3d4e5" });
      await rejects(
        "insert into machines (name, zt_ip, zt_network_id, zt_member_id) values ('B', '192.168.194.12', '8056c2e21c000001', 'a1b2c3d4e5')",
        [],
        /machines_zt_member_key/,
      );
    });

    it("machine_state keeps four separate signals with honest defaults", async () => {
      const id = await machine();
      await db.query("insert into machine_state (machine_id) values ($1)", [id]);
      expect(await db.query("select http_status, zt_state, internet_state, monitor_health, consecutive_failures from machine_state")).toEqual([
        { http_status: "unknown", zt_state: "unknown", internet_state: "unverified", monitor_health: "unknown", consecutive_failures: 0 },
      ]);
      await rejects("update machine_state set internet_state = 'verified'", [], /invalid input value for enum internet_state/);
      await rejects("update machine_state set last_success_at = now()", [], /machine_state_success_not_after_check/);
      // Reachable admin with an unknown ZeroTier sighting is a valid, independent combination.
      await db.query("update machine_state set http_status = 'reachable', last_check_at = now(), last_success_at = now(), zt_state = 'unknown'");
    });
  });

  describe("monitoring history", () => {
    it("checks: success has no error, failure says why, HTTP codes in range", async () => {
      const id = await machine();
      await db.query("insert into checks (machine_id, started_at, duration_ms, ok, http_code) values ($1, now(), 42, true, 200)", [id]);
      await db.query("insert into checks (machine_id, started_at, ok, error_kind, trigger) values ($1, now(), false, 'timeout', 'manual')", [id]);
      await rejects("insert into checks (machine_id, started_at, ok, error_kind) values ($1, now(), true, 'timeout')", [id], /checks_ok_xor_error/);
      await rejects("insert into checks (machine_id, started_at, ok) values ($1, now(), false)", [id], /checks_ok_xor_error/);
      await rejects("insert into checks (machine_id, started_at, ok, http_code) values ($1, now(), true, 700)", [id], /checks_http_code_range/);
    });

    it("outages: one open outage per machine, end after start", async () => {
      const id = await machine();
      await db.query("insert into outages (machine_id, started_at) values ($1, now() - interval '10 minutes')", [id]);
      await rejects("insert into outages (machine_id, started_at) values ($1, now())", [id], /outages_one_open_per_machine/);
      await db.query("update outages set ended_at = now()");
      await db.query("insert into outages (machine_id, started_at) values ($1, now())", [id]);
      await rejects("insert into outages (machine_id, started_at, ended_at) values ($1, now(), now() - interval '1 minute')", [id], /outages_end_after_start/);
    });

    it("events: machine events need a machine; system events may be workspace-level", async () => {
      await db.query("insert into events (type, message, occurred_at) values ('system', 'Monitoring interval changed', now())");
      await rejects("insert into events (type, status, message, occurred_at) values ('outage', 'unreachable', 'x', now())", [], /events_machine_unless_system/);
      await rejects("insert into events (type, message, occurred_at) values ('system', '', now())", [], /events_message_len/);
    });

    it("hourly rollups: whole-hour buckets, consistent counts, one row per machine and hour", async () => {
      const id = await machine();
      await db.query("insert into check_rollups_hourly (machine_id, bucket_start, checks, ok_count, avg_response_ms, down_seconds) values ($1, '2026-10-11T06:00:00Z', 60, 58, 44, 120)", [id]);
      await rejects("insert into check_rollups_hourly (machine_id, bucket_start) values ($1, '2026-10-11T06:00:00Z')", [id], /check_rollups_hourly_pkey/);
      await rejects("insert into check_rollups_hourly (machine_id, bucket_start) values ($1, '2026-10-11T06:30:00Z')", [id], /rollups_bucket_on_hour/);
      await rejects("insert into check_rollups_hourly (machine_id, bucket_start, checks, ok_count) values ($1, '2026-10-11T07:00:00Z', 10, 11)", [id], /rollups_counts_valid/);
      await rejects("insert into check_rollups_hourly (machine_id, bucket_start, down_seconds) values ($1, '2026-10-11T08:00:00Z', 3601)", [id], /rollups_down_seconds_range/);
    });

    it("deleting a machine removes its state and history", async () => {
      const id = await machine();
      await db.query("insert into machine_state (machine_id) values ($1)", [id]);
      await db.query("insert into checks (machine_id, started_at, ok, http_code) values ($1, now(), true, 200)", [id]);
      await db.query("insert into events (machine_id, type, status, message, occurred_at) values ($1, 'check', 'reachable', 'ok', now())", [id]);
      await db.query("insert into outages (machine_id, started_at) values ($1, now())", [id]);
      await db.query("insert into check_rollups_hourly (machine_id, bucket_start) values ($1, '2026-10-11T06:00:00Z')", [id]);
      await db.query("delete from machines where id = $1", [id]);
      for (const t of ["machine_state", "checks", "events", "outages", "check_rollups_hourly"]) {
        expect(await db.query(`select 1 from ${t}`)).toHaveLength(0);
      }
    });

    it("time-series queries use the (machine, time desc) indexes", async () => {
      const id = await machine();
      await db.query(
        "insert into checks (machine_id, started_at, ok, http_code) select $1, now() - (g || ' minutes')::interval, true, 200 from generate_series(1, 500) g",
        [id],
      );
      await db.query("analyze checks");
      await db.query("set local enable_seqscan = off");
      const plan = (await db.query<{ "QUERY PLAN": string }>(`explain select * from checks where machine_id = '${id}' order by started_at desc limit 50`))
        .map((r) => r["QUERY PLAN"])
        .join("\n");
      expect(plan).toContain("checks_machine_started_idx");
      const evPlan = (await db.query<{ "QUERY PLAN": string }>(`explain select * from events where machine_id = '${id}' order by occurred_at desc limit 20`))
        .map((r) => r["QUERY PLAN"])
        .join("\n");
      expect(evPlan).toContain("events_machine_occurred_idx");
    });
  });

  describe("Supabase hardening and least privilege (0002)", () => {
    /** Runs fn as another role inside a savepoint, then undoes everything (including the role switch). */
    async function asRole(role: string, fn: () => Promise<void>) {
      const name = "role" + ++sp;
      await db.query(`savepoint ${name}`);
      try {
        await db.query(`set local role ${role}`);
        await fn();
      } finally {
        await db.query(`rollback to savepoint ${name}`);
      }
    }
    /** Like rejects(), but the failing statement runs as `role`. */
    async function rejectsAs(role: string, text: string, params: unknown[], match: RegExp) {
      await asRole(role, () => rejects(text, params, match));
    }

    it("every table has RLS enabled and a policy for the runtime role (guards future migrations)", async () => {
      const rows = await db.query<{ table: string; rls: boolean; policies: number }>(
        `select c.relname as "table", c.relrowsecurity as rls,
                (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname and 'pisowifi_app' = any(p.roles)) as policies
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind = 'r' order by 1`,
      );
      expect(rows).toHaveLength(13);
      for (const r of rows) {
        expect(r.rls, r.table + " RLS").toBe(true);
        expect(r.policies, r.table + " policies").toBeGreaterThan(0);
      }
      // No policy grants anything to roles other than the runtime role.
      expect(await db.query("select policyname from pg_policies where schemaname = 'public' and not ('pisowifi_app' = any(roles))")).toEqual([]);
    });

    it("runtime role is least-privilege: no login until provisioned, no bypass, timeouts set", async () => {
      const [r] = await db.query<Record<string, boolean>>(
        "select rolcanlogin, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit from pg_roles where rolname = 'pisowifi_app'",
      );
      expect(r).toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false, rolinherit: false });
      const [s] = await db.query<{ setconfig: string[] }>(
        "select setconfig from pg_db_role_setting where setrole = (select oid from pg_roles where rolname = 'pisowifi_app')",
      );
      expect(s!.setconfig).toEqual(expect.arrayContaining(["statement_timeout=15s", "lock_timeout=5s", "idle_in_transaction_session_timeout=30s"]));
    });

    it("runtime role can read and write application data", async () => {
      await asRole("pisowifi_app", async () => {
        const [m] = await db.query<{ id: string }>("insert into machines (name, zt_ip) values ('PisoWiFi 01', '192.168.194.82') returning id");
        await db.query("insert into machine_state (machine_id) values ($1)", [m!.id]);
        await db.query("insert into checks (machine_id, started_at, ok, http_code) values ($1, now(), true, 200)", [m!.id]);
        await db.query("update monitoring_settings set interval_seconds = 300");
        await db.query("insert into audit_log (action) values ('machine.created')");
        expect(await db.query("select name from machines")).toEqual([{ name: "PisoWiFi 01" }]);
        expect(await db.query("select count(*)::int as n from audit_log")).toEqual([{ n: 1 }]);
        await db.query("delete from checks");
      });
    });

    it("runtime role cannot change the schema, rewrite the audit trail or reach migration metadata", async () => {
      await rejectsAs("pisowifi_app", "create table evil (id int)", [], /permission denied for schema public/);
      await rejectsAs("pisowifi_app", "alter table machines add column x int", [], /must be owner of table machines/);
      await rejectsAs("pisowifi_app", "drop table machines", [], /must be owner of table machines/);
      await rejectsAs("pisowifi_app", "truncate machines", [], /permission denied for table machines/);
      await db.query("insert into audit_log (action) values ('user.login')");
      await rejectsAs("pisowifi_app", "update audit_log set action = 'x'", [], /permission denied for table audit_log/);
      await rejectsAs("pisowifi_app", "delete from audit_log", [], /permission denied for table audit_log/);
      await rejectsAs("pisowifi_app", "insert into monitoring_settings (id) values (1)", [], /permission denied for table monitoring_settings/);
      await rejectsAs("pisowifi_app", "delete from monitoring_settings", [], /permission denied for table monitoring_settings/);
      await rejectsAs("pisowifi_app", "select * from drizzle.__drizzle_migrations", [], /permission denied for schema drizzle/);
      await rejectsAs("pisowifi_app", "alter role pisowifi_app with login", [], /permission denied|must have CREATEROLE/);
    });

    it("RLS denies rows to any other role, even with table privileges", async () => {
      await machine();
      await db.query("create role rls_probe nologin");
      await db.query("grant select on machines to rls_probe");
      await asRole("rls_probe", async () => {
        expect(await db.query("select * from machines")).toEqual([]);
      });
    });

    it("Supabase Data API roles have no access (only when they exist)", async () => {
      const exists = (await db.query("select 1 from pg_roles where rolname = 'anon'")).length > 0;
      if (!exists) return; // plain PostgreSQL: nothing to revoke
      const granted = await db.query<{ role: string; table: string }>(
        `select r.role, c.relname as "table" from pg_class c join pg_namespace n on n.oid = c.relnamespace
           cross join (values ('anon'), ('authenticated')) r(role)
          where n.nspname = 'public' and c.relkind = 'r'
            and (has_table_privilege(r.role, c.oid, 'select') or has_table_privilege(r.role, c.oid, 'insert')
              or has_table_privilege(r.role, c.oid, 'update') or has_table_privilege(r.role, c.oid, 'delete'))`,
      );
      expect(granted).toEqual([]);
      await rejectsAs("anon", "select * from users", [], /permission denied for table users/);
      await rejectsAs("authenticated", "select * from sessions", [], /permission denied for table sessions/);
      // Future tables created by the migration role don't get Data API grants either.
      await db.query("create table future_probe (id int)");
      expect((await db.query<{ ok: boolean }>("select has_table_privilege('anon', 'future_probe', 'select') as ok"))[0]!.ok).toBe(false);
    });
  });
});
