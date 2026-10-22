/* Real PostgreSQL for tests (TEST_DATABASE_URL): a DISPOSABLE server only, never production.

   Refuses (throws, so the test file fails loudly instead of skipping) when TEST_DATABASE_URL:
   - names the production Supabase project, any Supabase/pooler host or the transaction-pooler port 6543;
   - uses the runtime role pisowifi_app;
   - points anywhere but loopback, unless TEST_DATABASE_ALLOW_HOST names that exact host (e.g. a CI service container).
   Tests never touch the database in the URL itself: createScratchDatabase() creates a fresh, uniquely named database
   on that server (the URL's role needs CREATEDB), runs everything there and drops it afterwards. */
import { randomBytes } from "node:crypto";
import pg from "pg";

const PRODUCTION_REFS = ["apgktwrpsrwljjeyslwi"];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** Why this URL may not be used, or null when it is a disposable server. Exported for the guard's own tests. */
export function unsafeReason(raw: string, allowHost = process.env.TEST_DATABASE_ALLOW_HOST): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "TEST_DATABASE_URL is not a URL";
  }
  if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return "TEST_DATABASE_URL must be a postgres:// URL";
  const host = u.hostname.toLowerCase();
  const whole = decodeURIComponent(raw).toLowerCase();
  if (PRODUCTION_REFS.some((ref) => whole.includes(ref))) return "TEST_DATABASE_URL names the production Supabase project";
  if (/supabase|pooler/.test(host)) return "TEST_DATABASE_URL points at a Supabase/pooler host; use a disposable local PostgreSQL";
  if (u.port === "6543") return "TEST_DATABASE_URL uses the transaction-pooler port 6543";
  if (decodeURIComponent(u.username).toLowerCase().startsWith("pisowifi_app")) return "TEST_DATABASE_URL uses the runtime role pisowifi_app";
  if (!LOOPBACK.has(host) && host !== (allowHost ?? "").toLowerCase()) {
    return `TEST_DATABASE_URL host ${host} is not loopback (set TEST_DATABASE_ALLOW_HOST=${host} only for a disposable CI server)`;
  }
  return null;
}

/** TEST_DATABASE_URL when set and safe; undefined when unset; throws when unsafe. */
export function disposableServerUrl(): string | undefined {
  const raw = process.env.TEST_DATABASE_URL;
  if (!raw) return undefined;
  const why = unsafeReason(raw);
  if (why) throw new Error(`Refusing to run real-database tests: ${why}`);
  return raw;
}

export interface ScratchDatabase {
  url: string;
  name: string;
  drop(): Promise<void>;
}

/** Creates an empty database with a unique name on the disposable server; drop() removes it (and its connections). */
export async function createScratchDatabase(serverUrl: string, label: string): Promise<ScratchDatabase> {
  const name = `pisowifi_t_${label.replace(/[^a-z0-9]/g, "")}_${randomBytes(4).toString("hex")}`;
  const admin = new pg.Client({ connectionString: serverUrl, application_name: "pisowifi-test-admin" });
  await admin.connect();
  try {
    await admin.query(`create database ${name}`);
  } finally {
    await admin.end();
  }
  const u = new URL(serverUrl);
  u.pathname = `/${name}`;
  return {
    url: u.toString(),
    name,
    async drop() {
      const c = new pg.Client({ connectionString: serverUrl, application_name: "pisowifi-test-admin" });
      await c.connect();
      try {
        await c.query(`drop database if exists ${name} with (force)`);
      } finally {
        await c.end();
      }
    },
  };
}
