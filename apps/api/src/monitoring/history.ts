/* Monitoring history from recorded results.

   GET /history?from&to&buckets&machine     any signed-in user

   Read-only. Everything is derived from what the monitor stored: valid checks (checks), status changes (events)
   and outages. Uptime is the share of valid checks that reached the machine; a slot without a valid check is
   "none" and never counts as Reachable. Monitoring-side failures write no check, so they never appear here as
   downtime. The client sends the exact window (it knows the viewer's local day boundaries); slots are even. */
import type { FastifyPluginAsync } from "fastify";
import { and, asc, desc, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import {
  HISTORY_MAX_EVENTS,
  HISTORY_RECENT_CHECKS,
  TIMELINE_SLOTS,
  apiError,
  fieldErrors,
  historyQuerySchema,
  type HistoryMachineDto,
  type HistoryResponse,
  type MonitoringEventDto,
  type TimelineState,
} from "@pisowifi/shared";
import type { Db } from "../db/client.js";
import { checks, events, machineState, machines, outages } from "../db/schema/index.js";
import { requireOrm } from "../auth/helpers.js";

export interface HistoryRoutesOptions {
  db: Db | null;
}

const MIN = 60_000;
const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (ok: number, n: number) => (n ? round1((ok / n) * 100) : null);

interface Slot {
  n: number;
  ok: number;
  rt: number | null;
}

/** Overlap of [a, b) with [s, e), in ms. */
const overlap = (a: number, b: number, s: number, e: number) => Math.max(0, Math.min(b, e) - Math.max(a, s));

export const historyRoutes: FastifyPluginAsync<HistoryRoutesOptions> = async (app, opts) => {
  const orm = () => requireOrm(opts.db);

  /** Checks per machine per slot of [from, end): count, reached, average response of the reached ones. Only
   *  checks before `to` (now at the latest) are read; `end` may be later so calendar slots stay aligned. */
  async function slots(from: Date, end: Date, to: Date, n: number, ids: string[]) {
    const width = (end.getTime() - from.getTime()) / n;
    const slot = sql<number>`least(floor(extract(epoch from (${checks.startedAt} - ${from.toISOString()}::timestamptz)) * 1000 / ${width})::int, ${n - 1})`;
    const rows = await orm()
      .select({
        machineId: checks.machineId,
        slot: slot.mapWith(Number),
        n: sql<number>`count(*)::int`.mapWith(Number),
        ok: sql<number>`(count(*) filter (where ${checks.ok}))::int`.mapWith(Number),
        rt: sql<string | null>`avg(${checks.durationMs}) filter (where ${checks.ok})`,
      })
      .from(checks)
      .where(and(inArray(checks.machineId, ids), gte(checks.startedAt, from), lt(checks.startedAt, to)))
      // By position: drizzle would bind the slot expression's parameters again, and Postgres needs the same expression.
      .groupBy(sql`1`, sql`2`);
    const out = new Map<string, Slot[]>(ids.map((id) => [id, Array.from({ length: n }, () => ({ n: 0, ok: 0, rt: null }))]));
    for (const r of rows) {
      const s = out.get(r.machineId)?.[r.slot];
      if (s) Object.assign(s, { n: r.n, ok: r.ok, rt: r.rt === null ? null : Number(r.rt) });
    }
    return { width, out };
  }

  app.get("/history", { config: { access: "history:view" } }, async (req, reply) => {
    const parsed = historyQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) return reply.code(400).send(apiError("validation_failed", "Check the history filters.", fieldErrors(parsed.error)));
    const q = parsed.data;
    const now = new Date();
    const from = new Date(q.from);
    // Chart slots span the requested window (e.g. whole local days); data, totals and the status strip stop at now,
    // so the future never reads as "not checked".
    const slotsEnd = new Date(q.to);
    const to = new Date(Math.min(slotsEnd.getTime(), now.getTime()));
    if (to <= from) return reply.code(400).send(apiError("validation_failed", "Check the history filters.", { from: "The range must start in the past" }));

    const list = await orm()
      .select({ id: machines.id, lastSuccessAt: machineState.lastSuccessAt })
      .from(machines)
      .leftJoin(machineState, eq(machineState.machineId, machines.id))
      .where(q.machine ? eq(machines.id, q.machine) : undefined)
      .orderBy(asc(sql`lower(${machines.name})`));
    if (q.machine && !list.length) return reply.code(404).send(apiError("not_found", "Machine not found"));
    const ids = list.map((m) => m.id);
    const body: HistoryResponse = { from: from.toISOString(), to: to.toISOString(), generatedAt: now.toISOString(), machines: [], events: [], outages: [] };
    if (!ids.length) return body;

    const inWindow = (col: typeof outages.startedAt): SQL => sql`${col} < ${to.toISOString()}::timestamptz`;
    const [points, strip, outageRows, eventRows, recent] = await Promise.all([
      slots(from, slotsEnd, to, q.buckets, ids),
      slots(from, to, to, TIMELINE_SLOTS, ids),
      orm()
        .select({ machineId: outages.machineId, startedAt: outages.startedAt, endedAt: outages.endedAt })
        .from(outages)
        .where(and(inArray(outages.machineId, ids), inWindow(outages.startedAt), sql`coalesce(${outages.endedAt}, ${now.toISOString()}::timestamptz) > ${from.toISOString()}::timestamptz`))
        .orderBy(desc(outages.startedAt)),
      orm()
        .select({
          id: events.id,
          machineId: events.machineId,
          type: events.type,
          status: events.status,
          message: events.message,
          occurredAt: events.occurredAt,
          // A recovery closes its outage in the same transaction, with the same timestamp.
          outageStartedAt: outages.startedAt,
        })
        .from(events)
        .leftJoin(outages, and(eq(events.type, "recovery"), eq(outages.machineId, events.machineId), eq(outages.endedAt, events.occurredAt)))
        .where(and(inArray(events.machineId, ids), inArray(events.type, ["outage", "recovery"]), gte(events.occurredAt, from), lt(events.occurredAt, to)))
        .orderBy(desc(events.occurredAt))
        .limit(HISTORY_MAX_EVENTS),
      // Latest checks per machine (window functions keep this one query on the (machine, time desc) index).
      orm().execute(sql`
        select machine_id, started_at, ok, http_code, duration_ms from (
          select ${checks.machineId} as machine_id, ${checks.startedAt} as started_at, ${checks.ok} as ok, ${checks.httpCode} as http_code,
                 ${checks.durationMs} as duration_ms, row_number() over (partition by ${checks.machineId} order by ${checks.startedAt} desc) as rn
          from ${checks}
          where ${inArray(checks.machineId, ids)} and ${checks.startedAt} >= ${from.toISOString()}::timestamptz and ${checks.startedAt} < ${to.toISOString()}::timestamptz
        ) latest where rn <= ${HISTORY_RECENT_CHECKS} order by started_at desc`),
    ]);

    const end = (o: { endedAt: Date | null }) => (o.endedAt ?? now).getTime();
    body.outages = outageRows.map((o) => ({
      machineId: o.machineId,
      startedAt: o.startedAt.toISOString(),
      endedAt: o.endedAt?.toISOString() ?? null,
      durationMinutes: round1((end(o) - o.startedAt.getTime()) / MIN),
    }));

    body.events = eventRows.map(
      (e): MonitoringEventDto => ({
        id: String(e.id),
        machineId: e.machineId,
        type: e.type,
        status: e.status ?? "system",
        message: e.message,
        occurredAt: e.occurredAt.toISOString(),
        ...(e.outageStartedAt ? { durationMinutes: round1((e.occurredAt.getTime() - e.outageStartedAt.getTime()) / MIN) } : {}),
      }),
    );

    const recentRows = ((recent as unknown as { rows?: Record<string, unknown>[] }).rows ?? (recent as unknown as Record<string, unknown>[])).map((r) => ({
      machineId: String(r.machine_id),
      startedAt: new Date(r.started_at as string | Date),
      ok: Boolean(r.ok),
      httpCode: r.http_code === null ? null : Number(r.http_code),
      durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
    }));

    const a = from.getTime();
    for (const m of list) {
      const mine = outageRows.filter((o) => o.machineId === m.id);
      const pts = points.out.get(m.id)!.map((s, i) => {
        const s0 = a + i * points.width;
        const s1 = s0 + points.width;
        const down = mine.reduce((sum, o) => sum + overlap(s0, s1, o.startedAt.getTime(), end(o)), 0);
        return {
          start: new Date(s0).toISOString(),
          end: new Date(s1).toISOString(),
          checks: s.n,
          okChecks: s.ok,
          uptimePercent: pct(s.ok, s.n),
          avgResponseMs: s.rt === null ? null : Math.round(s.rt),
          downMinutes: round1(down / MIN),
        };
      });
      const n = pts.reduce((x, p) => x + p.checks, 0);
      const ok = pts.reduce((x, p) => x + p.okChecks, 0);
      const rtWeight = points.out.get(m.id)!.reduce((x, s) => (s.rt === null ? x : { sum: x.sum + s.rt * s.ok, n: x.n + s.ok }), { sum: 0, n: 0 });
      const machine: HistoryMachineDto = {
        machineId: m.id,
        totals: {
          checks: n,
          okChecks: ok,
          uptimePercent: pct(ok, n),
          avgResponseMs: rtWeight.n ? Math.round(rtWeight.sum / rtWeight.n) : null,
          downMinutes: round1(mine.reduce((sum, o) => sum + overlap(a, to.getTime(), o.startedAt.getTime(), end(o)), 0) / MIN),
          outages: mine.length,
          lastSuccessAt: m.lastSuccessAt?.toISOString() ?? null,
        },
        points: pts,
        timeline: strip.out.get(m.id)!.map((s): TimelineState => (s.n === 0 ? "none" : s.ok < s.n ? "bad" : "ok")),
        recentChecks: recentRows
          .filter((r) => r.machineId === m.id)
          .map((r) => ({ startedAt: r.startedAt.toISOString(), ok: r.ok, httpCode: r.httpCode, durationMs: r.durationMs })),
      };
      body.machines.push(machine);
    }
    return body;
  });
};
