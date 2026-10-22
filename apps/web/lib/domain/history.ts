/* Monitoring history queries over the sample engine: event feed, filter window, totals, timeline. */
import { DAY, dTime, startDay } from "@/lib/format";
import { downIn, historyEvents, points, summarize } from "@/lib/mock/history";
import type { HistRange, Machine, MachineStatus, MonitoringEvent } from "@/lib/types";
import { machineById } from "@/lib/domain/machines";

export interface HistFilters {
  m: string;
  range: HistRange;
  from: string;
  to: string;
  status: "all" | MachineStatus;
  page: number;
}

export const DEFAULT_HIST: HistFilters = { m: "all", range: "14", from: "", to: "", status: "all", page: 0 };
export const EVENTS_PER_PAGE = 8;

export interface HistWindow {
  a: number;
  b: number;
  /** whole-day bounds for custom ranges, else null */
  from: number | null;
  to: number | null;
}

/** Sample history events plus session events (for machines that still exist), newest first. */
export function allEvents(machines: Machine[], extra: MonitoringEvent[]) {
  let a: MonitoringEvent[] = [];
  machines.forEach((m) => {
    if (m.hist) a = a.concat(historyEvents(m.id));
  });
  a = a.concat(extra.filter((e) => machines.some((m) => m.id === e.m)));
  return a.sort((x, y) => y.t - x.t);
}

/** Time window for the filters. Custom ranges are clamped to the last 30 days and may be given in either order. */
export function histWindow(h: HistFilters, now = Date.now()): HistWindow {
  if (h.range === "24") return { a: now - DAY, b: now, from: null, to: null };
  if (h.range === "custom") {
    let f = h.from ? new Date(h.from + "T00:00:00").getTime() : startDay(now) - 13 * DAY;
    let t = h.to ? new Date(h.to + "T00:00:00").getTime() : startDay(now);
    if (f > t) [f, t] = [t, f];
    f = Math.max(f, startDay(now) - 29 * DAY);
    t = Math.min(t, startDay(now));
    return { a: f, b: Math.min(t + DAY, now), from: f, to: t };
  }
  return { a: startDay(now) - (+h.range - 1) * DAY, b: now, from: null, to: null };
}

export function filterEvents(all: MonitoringEvent[], h: HistFilters, win: HistWindow) {
  return all.filter(
    (e) =>
      e.t >= win.a &&
      e.t <= win.b &&
      (h.m === "all" || e.m === h.m) &&
      (h.status === "all" || e.st === h.status),
  );
}

/** Machine ids the history view charts: one machine, or every machine with sample history. */
export function historyIds(machines: Machine[], m: string) {
  return m === "all" ? machines.filter((x) => x.hist).map((x) => x.id) : [m];
}

/** KPI totals across the selection: downtime minutes (sum), uptime % and response ms (averages). */
export function historyTotals(ids: string[], h: HistFilters, win: HistWindow) {
  const tot = { down: 0, up: 0, rt: 0 };
  ids.forEach((id) => {
    const s = summarize(points(id, h.range, win.from, win.to));
    tot.down += s.down;
    tot.up += s.up;
    tot.rt += s.rt;
  });
  if (ids.length) {
    tot.up /= ids.length;
    tot.rt /= ids.length;
  }
  return tot;
}

export function outagesInWindow(all: MonitoringEvent[], ids: string[], win: HistWindow) {
  return all.filter((e) => e.type === "outage" && e.t >= win.a && e.t <= win.b && ids.includes(e.m));
}

export function lastSuccessfulCheck(machines: Machine[], ids: string[]) {
  return ids.reduce((a, id) => Math.max(a, machineById(machines, id)?.okAt || 0), 0);
}

export function paginate<T>(list: T[], page: number, size = EVENTS_PER_PAGE) {
  const pages = Math.max(1, Math.ceil(list.length / size));
  const pg = Math.min(Math.max(0, page), pages - 1);
  return { pages, page: pg, slice: list.slice(pg * size, pg * size + size) };
}

/** ok: reached · bad: a valid check failed · none: no valid check in the slot (API history only) */
export type StripState = "ok" | "bad" | "none";

/** 48-bucket status timeline: Offline if any recorded downtime in the bucket, else Online. */
export function timeline(id: string, name: string, a: number, b: number, buckets = 48) {
  const L = b - a;
  const states: StripState[] = [];
  const tips: string[] = [];
  for (let i = 0; i < buckets; i++) {
    const s = a + (L * i) / buckets;
    const e = a + (L * (i + 1)) / buckets;
    const k: StripState = downIn(id, s, e) > 0 ? "bad" : "ok";
    states.push(k);
    tips.push(name + " · " + dTime(s) + " · " + (k === "bad" ? "Offline" : "Online"));
  }
  return { states, tips };
}
