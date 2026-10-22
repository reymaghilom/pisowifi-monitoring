/* Read-only RBAC database checks, shared by the API's start-up gate (server.ts), the deployment CLI
   (rbac-check.ts, run on the VM by deploy/rbac scripts) and the tests. Every query runs in a READ ONLY transaction
   and returns counts only: no emails, hashes or tokens. Works as the runtime role pisowifi_app. */
import type pg from "pg";

/** Marker prefix of a password hash replaced by deploy/rbac/neutralize-deactivated.sql. Never a valid Argon2 PHC
 *  string, so every release (including pre-RBAC ones) treats it as a wrong password. */
export const NEUTRALIZED_PREFIX = "!rbac-neutralized:";

export interface Rbac0005State {
  /** users.disabled_at and users.disabled_by exist. */
  columns: boolean;
  /** Trigger users_keep_active_admin exists and is enabled. */
  trigger: boolean;
  /** Function public.users_keep_active_admin exists. */
  fn: boolean;
}

export const schemaReady = (s: Rbac0005State) => s.columns && s.trigger && s.fn;

async function readOnly<T>(client: pg.ClientBase, run: () => Promise<T>): Promise<T> {
  await client.query("begin transaction read only");
  try {
    return await run();
  } finally {
    await client.query("rollback");
  }
}

const state0005 = async (client: pg.ClientBase): Promise<Rbac0005State> => {
  const { rows } = await client.query<Rbac0005State>(`select
      (select count(*) = 2 from information_schema.columns
        where table_schema = 'public' and table_name = 'users' and column_name in ('disabled_at', 'disabled_by')) as columns,
      exists(select 1 from pg_trigger where tgrelid = to_regclass('public.users') and tgname = 'users_keep_active_admin'
        and not tgisinternal and tgenabled <> 'D') as trigger,
      exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'users_keep_active_admin') as fn`);
  return rows[0]!;
};

/** Whether migration 0005_user_management's objects are present. */
export const read0005State = (client: pg.ClientBase) => readOnly(client, () => state0005(client));

export interface AccountCounts {
  total: number;
  activeAdmins: number;
  admins: number;
  viewers: number;
  deactivated: number;
}

export interface RollbackSafety extends AccountCounts {
  schema0005: boolean;
  /** Deactivated accounts a pre-RBAC release would let back in: a usable password, a live session or an open
   *  reset link. Must be 0 before any release older than RBAC-1 serves sign-ins. */
  unsafeDeactivated: number;
}

/** One start-up check of the schema this release needs: "ready", "missing" (definitive) or "unreachable". */
export async function checkSchemaOnce(pool: pg.Pool): Promise<"ready" | "missing" | "unreachable"> {
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
  } catch {
    return "unreachable";
  }
  try {
    const ready = schemaReady(await read0005State(client));
    client.release();
    return ready ? "ready" : "missing";
  } catch (err) {
    client.release(err as Error);
    return "unreachable";
  }
}

/** Account counts and whether a pre-RBAC release could reactivate anyone (see deploy/rbac/rbac-rollback.sh). */
export const readRollbackSafety = (client: pg.ClientBase) =>
  readOnly(client, async (): Promise<RollbackSafety> => {
    const s = await state0005(client);
    if (!s.columns) {
      // Before 0005 nobody can be deactivated.
      const { rows } = await client.query<AccountCounts>(`select count(*)::int total,
          count(*) filter (where role = 'admin')::int "activeAdmins", count(*) filter (where role = 'admin')::int admins,
          count(*) filter (where role = 'viewer')::int viewers, 0 deactivated from public.users`);
      return { ...rows[0]!, schema0005: false, unsafeDeactivated: 0 };
    }
    const { rows } = await client.query<AccountCounts & { unsafeDeactivated: number }>(
      `select count(*)::int total,
          count(*) filter (where role = 'admin' and disabled_at is null)::int "activeAdmins",
          count(*) filter (where role = 'admin')::int admins,
          count(*) filter (where role = 'viewer')::int viewers,
          count(*) filter (where disabled_at is not null)::int deactivated,
          count(*) filter (where disabled_at is not null and (
            left(password_hash, $1) <> $2
            or exists(select 1 from public.sessions s where s.user_id = u.id and s.revoked_at is null and s.expires_at > now())
            or exists(select 1 from public.password_reset_tokens t where t.user_id = u.id and t.used_at is null and t.expires_at > now())
          ))::int "unsafeDeactivated"
        from public.users u`,
      [NEUTRALIZED_PREFIX.length, NEUTRALIZED_PREFIX],
    );
    return { ...rows[0]!, schema0005: schemaReady(s) };
  });
