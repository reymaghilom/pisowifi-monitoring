/* PostgreSQL connection for the API and the worker (runtime role `pisowifi_app`, least privilege).
   The pool connects lazily, so the API starts (and reports "not ready") when the database is down.
   Pooler rules (no named prepared statements, no session state): see ./pg-config.ts. */
import pg from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema/index.js";
import { poolConfig, type TlsOptions } from "./pg-config.js";

export interface Db {
  pool: pg.Pool;
  orm: NodePgDatabase<typeof schema>;
  /** True when `select 1` succeeds within the timeout. Never throws. */
  check(): Promise<boolean>;
  close(): Promise<void>;
}

export interface DbOptions {
  tls?: TlsOptions;
  /** Query timeout, in ms (default 10 s). */
  timeoutMs?: number;
  /** Connect timeout, in ms (default 20 s; DATABASE_CONNECT_TIMEOUT_MS). */
  connectTimeoutMs?: number;
  /** Upper bound for check() (readyz), in ms (default 3 s). */
  checkTimeoutMs?: number;
  max?: number;
  applicationName?: string;
  onError?: (err: Error) => void;
}

/** Creates the database handle, or returns null when no DATABASE_URL is configured. */
export function createDb(url: string | undefined, opts: DbOptions = {}): Db | null {
  if (!url) return null;
  const pool = new pg.Pool(
    poolConfig(url, {
      tls: opts.tls ?? { mode: "off" },
      max: opts.max,
      timeoutMs: opts.timeoutMs ?? 10_000,
      connectTimeoutMs: opts.connectTimeoutMs ?? 20_000,
      applicationName: opts.applicationName ?? "pisowifi-api",
    }),
  );
  // An idle client losing its connection must not crash the process.
  pool.on("error", (err) => opts.onError?.(err));
  const checkTimeoutMs = opts.checkTimeoutMs ?? 3000;

  let closed = false;
  return {
    pool,
    orm: drizzle(pool, { schema }),
    async check() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Readiness answers quickly even while a slow first connection is still being opened.
        await Promise.race([
          pool.query("select 1"),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("check timeout")), checkTimeoutMs);
          }),
        ]);
        return true;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await pool.end();
    },
  };
}
