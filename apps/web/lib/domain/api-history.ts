/* Recorded history (GET /history) in the shapes the existing views draw: chart configs, status strips,
   event rows and totals. Pure functions; nothing is estimated or filled in. */
import type { HistoryMachineDto, HistoryResponse, TimelineState } from "@pisowifi/shared";
import { dShort, dTime, pad } from "@/lib/format";
import type { HistRange, LineChartConfig, Machine, MonitoringEvent } from "@/lib/types";
import { machineName } from "@/lib/domain/machines";
import type { StripState } from "@/lib/domain/history";

export const STRIP_LABEL: Record<TimelineState, string> = { ok: "Online", bad: "Offline", none: "Not checked" };

/** Hourly slots show the hour, daily slots the date. */
export const slotLabel = (start: string, range: HistRange) => (range === "24" ? pad(new Date(start).getHours()) + ":00" : dShort(Date.parse(start)));

/** Machines with at least one valid check in the window. */
export const checkedMachines = (data: HistoryResponse) => data.machines.filter((m) => m.totals.checks > 0);

export function historyChart(data: HistoryResponse, machines: Machine[], range: HistRange, metric: "up" | "rt", alt: string): LineChartConfig | null {
  const withData = checkedMachines(data);
  if (!withData.length) return null;
  const labels = withData[0]!.points.map((p) => slotLabel(p.start, range));
  const series = withData.map((m, i) => ({
    id: m.machineId,
    name: machineName(machines, m.machineId),
    cls: (i % 2 ? "l2" : "l1") as "l1" | "l2",
    v: m.points.map((p) => (metric === "up" ? p.uptimePercent : p.avgResponseMs)),
  }));
  const values = series.flatMap((s) => s.v).filter((v): v is number => v !== null);
  if (!values.length) return null;
  if (metric === "up") {
    const low = Math.min(...values);
    const min = low >= 99 ? 95 : Math.max(0, Math.floor((low - 5) / 10) * 10);
    return { labels, series, min, max: 100, unit: "%", alt };
  }
  return { labels, series, min: 0, max: Math.max(20, Math.ceil(Math.max(...values) / 20) * 20), unit: " ms", alt };
}

/** Status strip for one machine; slot times come from the window. */
export function historyStrip(data: HistoryResponse, m: HistoryMachineDto, name: string) {
  const a = Date.parse(data.from);
  const width = (Date.parse(data.to) - a) / Math.max(1, m.timeline.length);
  const states = m.timeline.map((s): StripState => s);
  const tips = m.timeline.map((s, i) => `${name} · ${dTime(a + i * width)} · ${STRIP_LABEL[s]}`);
  return { states, tips };
}

/** Status changes as event rows (newest first). */
export function historyEvents(data: HistoryResponse): MonitoringEvent[] {
  return data.events.flatMap((e) =>
    e.machineId && (e.type === "outage" || e.type === "recovery")
      ? [
          {
            t: Date.parse(e.occurredAt),
            m: e.machineId,
            type: e.type,
            st: e.type === "outage" ? "unreachable" : "reachable",
            // Worded from the event type (the stored message text predates the Online/Offline wording).
            msg: e.type === "outage" ? "Went offline" : e.durationMinutes !== undefined ? `Back online after ${Math.round(e.durationMinutes)} min offline` : "Back online",
            dur: e.durationMinutes,
          } satisfies MonitoringEvent,
        ]
      : [],
  );
}

/** Totals across the selection: uptime and response weighted by checks, downtime summed. */
export function historySummary(data: HistoryResponse) {
  const ms = data.machines;
  const checks = ms.reduce((n, m) => n + m.totals.checks, 0);
  const ok = ms.reduce((n, m) => n + m.totals.okChecks, 0);
  const rt = ms.reduce((acc, m) => (m.totals.avgResponseMs === null ? acc : { sum: acc.sum + m.totals.avgResponseMs * m.totals.okChecks, n: acc.n + m.totals.okChecks }), { sum: 0, n: 0 });
  const lastOk = ms.reduce((t, m) => Math.max(t, m.totals.lastSuccessAt ? Date.parse(m.totals.lastSuccessAt) : 0), 0);
  return {
    checks,
    ok,
    uptime: checks ? (ok / checks) * 100 : null,
    avgResponseMs: rt.n ? Math.round(rt.sum / rt.n) : null,
    downMinutes: ms.reduce((n, m) => n + m.totals.downMinutes, 0),
    outages: ms.reduce((n, m) => n + m.totals.outages, 0),
    lastSuccessAt: lastOk || null,
  };
}
