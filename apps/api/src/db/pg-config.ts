/* node-postgres pool settings shared by every connection (API, worker, migrations, provisioning, tests).

   TLS: "verify" checks the server certificate against DATABASE_SSL_CA (rejectUnauthorized: true, hostname checked).
   There is no "TLS without verification" mode.

   Supabase transaction pooler (Supavisor, port 6543) compatibility:
   - node-postgres sends unnamed (unprepared) statements unless a query has a `name`. Drizzle only sets a name
     when code calls `.prepare("name")`, so never call `.prepare()` on runtime queries (ESLint enforces this).
   - No session state across queries: no SET (use role defaults), LISTEN/NOTIFY or session advisory locks on
     this connection. The migration runner and, later, the job queue use the session pooler (port 5432). */
import { readFileSync } from "node:fs";
import type pg from "pg";

export interface TlsOptions {
  mode: "verify" | "off";
  /** Path to the PEM CA certificate; required for "verify". */
  caPath?: string;
}

export interface PoolOptions {
  tls: TlsOptions;
  max?: number;
  applicationName: string;
  /** Client-side query timeout, in ms; also the connect timeout unless connectTimeoutMs is set. */
  timeoutMs?: number;
  /** Connect timeout, in ms. A pooler connection (TCP, TLS, SCRAM) can take several seconds on a slow link. */
  connectTimeoutMs?: number;
}

export function poolConfig(connectionString: string, opts: PoolOptions): pg.PoolConfig {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    connectionString,
    ssl: opts.tls.mode === "verify" ? { ca: readFileSync(requireCa(opts.tls), "utf8"), rejectUnauthorized: true } : false,
    max: opts.max ?? 5,
    connectionTimeoutMillis: opts.connectTimeoutMs ?? timeoutMs,
    query_timeout: timeoutMs,
    // Connecting is the expensive part, so idle connections are kept (with TCP keep-alive) instead of re-opened.
    idleTimeoutMillis: 600_000,
    keepAlive: true,
    application_name: opts.applicationName,
  };
}

function requireCa(tls: TlsOptions): string {
  if (!tls.caPath) throw new Error('DATABASE_SSL_CA is required when DATABASE_SSL is "verify"');
  return tls.caPath;
}

/** TLS options from validated config. */
export const tlsFromConfig = (c: { DATABASE_SSL: "verify" | "off"; DATABASE_SSL_CA?: string | undefined }): TlsOptions => ({
  mode: c.DATABASE_SSL,
  caPath: c.DATABASE_SSL_CA,
});
