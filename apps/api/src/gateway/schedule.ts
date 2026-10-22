/* Scheduled admin-HTTP checks (MONITOR_SCHEDULE_ENABLED). Every monitoring_settings.interval_seconds (default 60,
   measured start to start), all registered WiFi5Soft machines with monitoring on are checked with trigger
   "schedule"; paused machines are skipped. Rounds never overlap. Results, status changes and notifications follow the same rules as manual checks
   (./checker.ts). Run it in one process only: the host must be an authorized, online ZeroTier member. */
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { monitoringSettings } from "../db/schema/index.js";
import type { GatewayChecker } from "./checker.js";

const DEFAULT_INTERVAL_S = 60;
const MIN_GAP_MS = 1000;

/** Fixed rate: the next round starts one interval after this one started (not after it ended), so the time a
 *  round takes doesn't stretch the interval. A round that overran starts the next one after a short gap. */
export function nextDelayMs(startedAt: number, intervalSeconds: number, now = Date.now()) {
  return Math.max(MIN_GAP_MS, startedAt + intervalSeconds * 1000 - now);
}

/** One round, serialized across worker instances by a transaction-scoped PostgreSQL advisory lock. */
export async function runScheduledRound(checker: GatewayChecker, db: Db, log: (msg: string, meta?: Record<string, unknown>) => void = () => {}) {
  return db.orm.transaction(async (tx) => {
    const locked = await tx.execute(sql`select pg_try_advisory_xact_lock(7488194, 80) as acquired`);
    const rows = (locked as unknown as { rows?: { acquired: boolean }[] }).rows ?? (locked as unknown as { acquired: boolean }[]);
    if (!rows[0]?.acquired) return false;
    const results = await checker.checkAll({ trigger: "schedule", skipPaused: true });
    const skipped = results.filter((r) => r.refusal && r.adminHttp === "unknown").length;
    if (skipped) log("scheduled check: some machines were not checked (monitoring-side issue, nothing recorded)", { skipped, total: results.length });
    return true;
  });
}

export function startScheduledChecks(opts: { checker: GatewayChecker; db: Db; log?: (msg: string, meta?: Record<string, unknown>) => void }) {
  const { checker, db } = opts;
  const log = opts.log ?? (() => {});
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let stopped = false;

  async function intervalSeconds() {
    try {
      const [row] = await db.orm.select({ s: monitoringSettings.intervalSeconds }).from(monitoringSettings).where(eq(monitoringSettings.id, 1)).limit(1);
      return row?.s ?? DEFAULT_INTERVAL_S;
    } catch {
      return DEFAULT_INTERVAL_S;
    }
  }

  async function round() {
    try {
      await runScheduledRound(checker, db, log);
    } catch (err) {
      log("scheduled check round failed", { error: err instanceof Error ? err.name : "error" });
    }
  }

  async function loop() {
    if (stopped) return;
    const startedAt = Date.now();
    running = round();
    await running;
    running = null;
    if (stopped) return;
    timer = setTimeout(() => void loop(), nextDelayMs(startedAt, await intervalSeconds()));
    timer.unref?.();
  }

  timer = setTimeout(() => void loop(), 1000);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
    },
  };
}
