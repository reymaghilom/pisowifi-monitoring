/* Enables login for the runtime role `pisowifi_app` (created NOLOGIN by migration 0002) and sets its password.
   Run after `db:migrate`, with the migration credentials:
     APP_DB_PASSWORD=$(openssl rand -base64 32) npm run db:provision-app-role -w apps/api
   The password is hashed locally into a SCRAM-SHA-256 verifier; the plaintext is never sent to the server
   and never printed. Store it only in the API/worker's DATABASE_URL (secret store or .env, never git). */
import pg from "pg";
import { urlHost } from "../config/env.js";
import { loadConfigOrExit } from "../lifecycle.js";
import { poolConfig, tlsFromConfig } from "./pg-config.js";
import { ROLE_PASSWORD_PATTERN, scramSha256Verifier } from "./scram.js";

export const APP_ROLE = "pisowifi_app";

const config = loadConfigOrExit();
const url = config.MIGRATION_DATABASE_URL ?? config.DATABASE_URL;
const password = process.env.APP_DB_PASSWORD ?? "";
if (!url) {
  console.error("MIGRATION_DATABASE_URL (or DATABASE_URL) is required.");
  process.exit(78);
}
if (!ROLE_PASSWORD_PATTERN.test(password)) {
  console.error("APP_DB_PASSWORD must be 24–128 printable ASCII characters (e.g. `openssl rand -base64 32`).");
  process.exit(78);
}

console.log(`Provisioning role ${APP_ROLE} on host ${urlHost(url)} (TLS ${config.DATABASE_SSL})…`);
const pool = new pg.Pool(poolConfig(url, { tls: tlsFromConfig(config), max: 1, applicationName: "pisowifi-provision" }));
try {
  const { rowCount } = await pool.query("select 1 from pg_roles where rolname = $1", [APP_ROLE]);
  if (!rowCount) throw new Error(`role ${APP_ROLE} does not exist: run db:migrate first`);
  // format(%L) quotes the verifier server-side; it is a salted hash, not the password.
  const { rows } = await pool.query<{ sql: string }>("select format('alter role %I with login password %L', $1::text, $2::text) as sql", [
    APP_ROLE,
    scramSha256Verifier(password),
  ]);
  await pool.query(rows[0]!.sql);
  console.log(`Role ${APP_ROLE} can now log in. Use it in DATABASE_URL (Supabase pooler user: ${APP_ROLE}.<project-ref>).`);
} catch (err) {
  console.error("Provisioning failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
