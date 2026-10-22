/* Applies pending SQL migrations from apps/api/drizzle/ using the migration credentials
   (MIGRATION_DATABASE_URL, falling back to DATABASE_URL for local development). On Supabase use the
   `postgres` role via the session pooler (port 5432); the runtime role cannot change the schema.
     npm run db:migrate -w apps/api                                    local development
     node dist/db/migrate.js --status                                  read-only: applied / pending / drift
     node dist/db/migrate.js --expect-pending=0005_user_management     production: applies only that exact set
   Options: --lock-timeout-ms (default 3000), --statement-timeout-ms (default 60000). See src/db/migrator.ts. */
import { parseArgs } from "node:util";
import pg from "pg";
import { isLoopbackUrl, urlHost } from "../config/env.js";
import { loadConfigOrExit } from "../lifecycle.js";
import { MIGRATIONS_FOLDER } from "./migrations-path.js";
import { applyMigrations, migrationStatus, MigrationRefused } from "./migrator.js";
import { poolConfig, tlsFromConfig } from "./pg-config.js";

const { values: args } = parseArgs({
  options: {
    status: { type: "boolean" },
    "expect-pending": { type: "string" },
    "lock-timeout-ms": { type: "string" },
    "statement-timeout-ms": { type: "string" },
  },
});

const config = loadConfigOrExit();
const url = config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL;
if (!url) {
  console.error("MIGRATION_DATABASE_URL (or DATABASE_URL) is required to run migrations.");
  process.exit(78);
}
if (new URL(url).port === "6543") {
  console.error("Refusing the transaction pooler (port 6543) for migrations: use the session pooler or a direct connection (port 5432).");
  process.exit(78);
}
// Anything but a local development database must name the exact migrations it is approved to apply.
const expectPending = args["expect-pending"] === undefined ? undefined : args["expect-pending"].split(",").map((s) => s.trim()).filter(Boolean);
if (!args.status && !expectPending && !isLoopbackUrl(url)) {
  console.error("Refusing to migrate a non-local database without --expect-pending=<tag,...> (run --status first).");
  process.exit(78);
}
const ms = (v: string | undefined) => (v === undefined ? undefined : Number(v));

// Show which server is targeted (host only, never credentials) so the wrong database is easy to spot.
console.log(`${args.status ? "Migration status of" : "Applying migrations to"} host ${urlHost(url)} (TLS ${config.DATABASE_SSL})…`);
const client = new pg.Client(poolConfig(url, { tls: tlsFromConfig(config), applicationName: "pisowifi-migrate", timeoutMs: 120_000, connectTimeoutMs: 30_000 }));
try {
  await client.connect();
  if (args.status) {
    const s = await migrationStatus(client, MIGRATIONS_FOLDER);
    for (const a of s.applied) console.log(`applied  ${a.tag}${a.hashMatches ? "" : "  !! DIFFERS FROM LOCAL FILE"}`);
    for (const p of s.pending) console.log(`pending  ${p}`);
    for (const u of s.unknown) console.log(`unknown  created_at=${u.when} (not in this checkout)`);
    if (!s.tracked) console.log("no migration table yet (nothing applied)");
    console.log(`STATUS pending=[${s.pending.join(",")}] drift=${s.applied.filter((a) => !a.hashMatches).length} unknown=${s.unknown.length}`);
  } else {
    const r = await applyMigrations(client, MIGRATIONS_FOLDER, {
      expectPending,
      lockTimeoutMs: ms(args["lock-timeout-ms"]),
      statementTimeoutMs: ms(args["statement-timeout-ms"]),
    });
    console.log(r.applied.length ? `Migrations applied: ${r.applied.join(", ")} (lock_timeout ${r.lockTimeoutMs} ms, statement_timeout ${r.statementTimeoutMs} ms).` : "Already up to date.");
  }
} catch (err) {
  // Never print the connection string.
  const code = (err as { code?: string }).code;
  const hint = code === "55P03" ? " (lock not available within the lock timeout: nothing was applied; retry when traffic is quiet)" : "";
  console.error(`Migration ${err instanceof MigrationRefused ? "refused" : "failed"}${code ? ` [${code}]` : ""}: ${err instanceof Error ? err.message : err}${hint}`);
  process.exitCode = err instanceof MigrationRefused ? 3 : 1;
} finally {
  await client.end().catch(() => {});
}
