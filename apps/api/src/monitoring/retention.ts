/* History retention (worker only): raw checks older than CHECK_RETENTION_DAYS are deleted in small batches.
   Status-change events and outages are kept. Each batch is one transaction holding a transaction-scoped advisory
   lock, so two workers never prune at once and nothing is held between batches (transaction pooler safe). */
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { checks } from "../db/schema/index.js";

const BATCH = 5000;
const MAX_BATCHES = 20;
const HOUR_MS = 3_600_000;

const rowsOf = <T>(r: unknown) => ((r as { rows?: T[] }).rows ?? (r as T[]));

/** Deletes expired checks; returns how many were deleted (0 when another worker holds the lock). */
export async function pruneChecks(db: Db, retentionDays: number, opts: { batch?: number; maxBatches?: number } = {}) {
  const batch = opts.batch ?? BATCH;
  let total = 0;
  for (let i = 0; i < (opts.maxBatches ?? MAX_BATCHES); i++) {
    const deleted = await db.orm.transaction(async (tx) => {
      const [lock] = rowsOf<{ acquired: boolean }>(await tx.execute(sql`select pg_try_advisory_xact_lock(7488194, 81) as acquired`));
      if (!lock?.acquired) return -1;
      const res = await tx.execute(sql`
        delete from ${checks} where ${checks.id} in (
          select ${checks.id} from ${checks}
          where ${checks.startedAt} < now() - make_interval(days => ${retentionDays}::int)
          order by ${checks.startedAt} limit ${batch}
        )`);
      return (res as { rowCount?: number; affectedRows?: number }).rowCount ?? (res as { affectedRows?: number }).affectedRows ?? 0;
    });
    if (deleted < 0) break;
    total += deleted;
    if (deleted < batch) break;
  }
  return total;
}

/** Hourly pruning (first run a few minutes after start). Timers are unref'd like the check scheduler's. */
export function startRetention(opts: { db: Db; retentionDays: number; log: (msg: string, meta?: Record<string, unknown>) => void; firstDelayMs?: number }) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;
  async function run() {
    if (stopped) return;
    running = pruneChecks(opts.db, opts.retentionDays)
      .then((n) => {
        if (n) opts.log("pruned expired checks", { deleted: n, retentionDays: opts.retentionDays });
      })
      .catch((err) => opts.log("check pruning failed", { error: err instanceof Error ? err.name : "error" }));
    await running;
    running = null;
    if (stopped) return;
    timer = setTimeout(() => void run(), HOUR_MS);
    timer.unref?.();
  }
  timer = setTimeout(() => void run(), opts.firstDelayMs ?? 5 * 60_000);
  timer.unref?.();
  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
