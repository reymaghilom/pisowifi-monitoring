/* Migration engine used by `db:migrate` (src/db/migrate.ts) and the real-PostgreSQL tests.

   Same bookkeeping as drizzle-kit/drizzle-orm: table drizzle.__drizzle_migrations (hash = SHA-256 of the .sql file,
   created_at = the journal's `when`), and a migration is pending when its `when` is newer than the newest applied row.
   Differences, for production safety:
   - One transaction for everything: the guard lock, the pending check, every statement and the bookkeeping rows.
     Either all pending migrations apply or nothing does.
   - Bounded waiting: SET LOCAL lock_timeout / statement_timeout, so DDL that can't get its lock fails in seconds
     (SQLSTATE 55P03) instead of queueing every API query on the table behind it.
   - expectPending: refuses unless the pending set is exactly the approved list (e.g. only 0005_user_management).
   - Drift: refuses when an applied migration's hash no longer matches its local file.
   - status(): read-only report (READ ONLY transaction), nothing created. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type pg from "pg";

/** Serializes concurrent migration runs (pg_advisory_xact_lock key; 7240001 is the active-admin guard). */
export const MIGRATION_LOCK = 7240002;

export interface LocalMigration {
  tag: string;
  when: number;
  hash: string;
  statements: string[];
}

export interface MigrationStatus {
  /** Local migrations already recorded in the database, oldest first. */
  applied: { tag: string; when: number; hashMatches: boolean }[];
  /** Local migrations a run would apply now, oldest first. */
  pending: string[];
  /** Database rows with no local migration (applied from a newer checkout, or edited bookkeeping). */
  unknown: { when: number; hash: string }[];
  /** Whether drizzle.__drizzle_migrations exists. */
  tracked: boolean;
}

export interface ApplyOptions {
  /** lock_timeout for the migration transaction, in ms (default 3000, 100-30000). */
  lockTimeoutMs?: number;
  /** statement_timeout for the migration transaction, in ms (default 60000, 1000-600000). */
  statementTimeoutMs?: number;
  /** When set, the pending tags must equal this list exactly (same order), or nothing is applied. */
  expectPending?: string[];
}

export class MigrationRefused extends Error {}

export function localMigrations(folder: string): LocalMigration[] {
  const journal = JSON.parse(readFileSync(join(folder, "meta", "_journal.json"), "utf8")) as { entries: { tag: string; when: number }[] };
  const files = readMigrationFiles({ migrationsFolder: folder });
  if (files.length !== journal.entries.length) throw new Error("migration journal and files disagree");
  return journal.entries.map((e, i) => {
    if (files[i]!.folderMillis !== e.when) throw new Error(`migration ${e.tag}: journal order mismatch`);
    return { tag: e.tag, when: e.when, hash: files[i]!.hash, statements: files[i]!.sql };
  });
}

const bounded = (v: number | undefined, def: number, min: number, max: number, name: string) => {
  const n = v ?? def;
  if (!Number.isInteger(n) || n < min || n > max) throw new MigrationRefused(`${name} must be an integer between ${min} and ${max} ms`);
  return n;
};

async function readState(client: pg.ClientBase, local: LocalMigration[]): Promise<MigrationStatus> {
  const { rows: t } = await client.query<{ ok: boolean }>("select to_regclass('drizzle.__drizzle_migrations') is not null as ok");
  const tracked = t[0]!.ok;
  const rows = tracked
    ? (await client.query<{ hash: string; created_at: string }>("select hash, created_at from drizzle.__drizzle_migrations order by created_at")).rows
    : [];
  const byWhen = new Map(local.map((m) => [m.when, m]));
  const newest = rows.reduce((max, r) => Math.max(max, Number(r.created_at)), -Infinity);
  const applied: MigrationStatus["applied"] = [];
  const unknown: MigrationStatus["unknown"] = [];
  for (const r of rows) {
    const m = byWhen.get(Number(r.created_at));
    if (m) applied.push({ tag: m.tag, when: m.when, hashMatches: m.hash === r.hash });
    else unknown.push({ when: Number(r.created_at), hash: r.hash });
  }
  // drizzle-orm's rule: everything newer than the newest applied row.
  const pending = local.filter((m) => !rows.length || newest < m.when).map((m) => m.tag);
  return { applied, pending, unknown, tracked };
}

/** Read-only report. Runs in a READ ONLY transaction and creates nothing. */
export async function migrationStatus(client: pg.ClientBase, folder: string): Promise<MigrationStatus> {
  const local = localMigrations(folder);
  await client.query("begin transaction read only");
  try {
    return await readState(client, local);
  } finally {
    await client.query("rollback");
  }
}

/** Applies pending migrations in one bounded transaction. Returns the applied tags (empty when up to date). */
export async function applyMigrations(client: pg.ClientBase, folder: string, opts: ApplyOptions = {}): Promise<{ applied: string[]; lockTimeoutMs: number; statementTimeoutMs: number }> {
  const lockTimeoutMs = bounded(opts.lockTimeoutMs, 3000, 100, 30_000, "lock timeout");
  const statementTimeoutMs = bounded(opts.statementTimeoutMs, 60_000, 1000, 600_000, "statement timeout");
  const local = localMigrations(folder);
  await client.query("begin");
  try {
    // SET LOCAL: confined to this transaction, so it is safe on any connection and can't leak to a pooled session.
    await client.query(`set local lock_timeout = ${lockTimeoutMs}`);
    await client.query(`set local statement_timeout = ${statementTimeoutMs}`);
    await client.query(`set local idle_in_transaction_session_timeout = ${Math.max(statementTimeoutMs, 60_000)}`);
    const { rows: eff } = await client.query<{ l: string; s: string }>("select current_setting('lock_timeout') l, current_setting('statement_timeout') s");
    if (eff[0]!.l !== `${lockTimeoutMs}ms` && eff[0]!.l !== `${lockTimeoutMs / 1000}s`) throw new MigrationRefused(`lock_timeout not in effect (${eff[0]!.l})`);
    await client.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await client.query("create schema if not exists drizzle");
    await client.query("create table if not exists drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)");
    const state = await readState(client, local);
    const drift = state.applied.filter((a) => !a.hashMatches).map((a) => a.tag);
    if (drift.length) throw new MigrationRefused(`applied migrations differ from the local files: ${drift.join(", ")}`);
    if (state.unknown.length) throw new MigrationRefused(`the database has ${state.unknown.length} migration(s) this checkout does not know; use the matching release`);
    if (opts.expectPending && opts.expectPending.join(",") !== state.pending.join(",")) {
      throw new MigrationRefused(`pending migrations are [${state.pending.join(", ") || "none"}], expected [${opts.expectPending.join(", ") || "none"}]`);
    }
    for (const tag of state.pending) {
      const m = local.find((x) => x.tag === tag)!;
      for (const stmt of m.statements) if (stmt.trim()) await client.query(stmt);
      await client.query("insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)", [m.hash, m.when]);
    }
    await client.query("commit");
    return { applied: state.pending, lockTimeoutMs, statementTimeoutMs };
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  }
}
