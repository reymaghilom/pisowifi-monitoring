/* Sample monitoring history. Every number here is invented for the prototype.
   Faithful port of the prototype's genHist / downIn / rtAt / points / summarize / chartCfg.
   Generated in the browser (relative to Date.now()), never on the server. */
import { DAY, HR, MIN, dShort, dur, pad, startDay } from "@/lib/format";
import type { HistRange, HistoryPoint, LineChartConfig, Machine, MonitoringEvent } from "@/lib/types";

interface Outage {
  s: number;
  e: number;
}

interface MachineHistory {
  outs: Outage[];
  events: MonitoringEvent[];
  base: number;
  seed: number;
}

/** Seeded PRNG (mulberry32), identical to the prototype's rng(). */
export function rng(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HIST: Record<string, MachineHistory> = {};
let generated = false;

function genHist(id: string, q: number, base: number, seed: number, dmax: number, now: number) {
  const r = rng(seed);
  const today = startDay(now);
  const outs: Outage[] = [];
  let ev: MonitoringEvent[] = [];
  for (let i = 29; i >= 0; i--) {
    const day = today - i * DAY;
    const n = r() < q ? (r() < 0.3 ? 2 : 1) : 0;
    for (let k = 0; k < n; k++) {
      const s = day + Math.floor(r() * 20 * HR) + HR;
      const d = Math.round(5 + r() * dmax) * MIN;
      const e = s + d;
      if (e > now - 5 * MIN) continue;
      outs.push({ s, e });
      // Status changes only. No causes are given: a check can't tell an ISP outage from a power cut.
      r(); // keeps the seeded sequence (and so the sample numbers) unchanged
      ev.push({ t: s, m: id, type: "outage", st: "unreachable", dur: d / MIN, msg: "Went offline" });
      ev.push({ t: e, m: id, type: "recovery", st: "reachable", msg: "Back online after " + dur(d / MIN) });
    }
    r();
  }
  ev = ev.filter((e) => e.t < now);
  HIST[id] = { outs, events: ev, base, seed };
}

/** Generates the two demo machines' history once, on first use in the browser. */
export function ensureHistory() {
  if (generated) return;
  const now = Date.now();
  genHist("m1", 0.2, 44, 11, 45, now);
  genHist("m2", 0.5, 102, 29, 70, now);
  generated = true;
}

export function hasHistory(id: string) {
  ensureHistory();
  return !!HIST[id];
}

export function historyEvents(id: string): MonitoringEvent[] {
  ensureHistory();
  return HIST[id]?.events ?? [];
}

export function outages(id: string): Outage[] {
  ensureHistory();
  return HIST[id]?.outs ?? [];
}

/** Minutes of downtime for a machine inside [a, b). */
export function downIn(id: string, a: number, b: number) {
  let t = 0;
  outages(id).forEach((o) => {
    const s = Math.max(o.s, a);
    const e = Math.min(o.e, b);
    if (e > s) t += e - s;
  });
  return t / MIN;
}

function rtAt(id: string, t: number, down: boolean) {
  const h = HIST[id];
  const r = rng(Math.floor(t / HR) * 7 + h.seed);
  return Math.round(h.base * (0.88 + r() * 0.3) + (down ? h.base * 0.6 : 0));
}

/** Range → bucketed points (hourly for 24 h, daily otherwise). */
export function points(id: string, range: HistRange, from?: number | null, to?: number | null): HistoryPoint[] {
  ensureHistory();
  const pts: HistoryPoint[] = [];
  const now = Date.now();
  if (range === "24") {
    const endH = Math.floor(now / HR) * HR;
    for (let i = 23; i >= 0; i--) {
      const a = endH - i * HR;
      const b = a + HR;
      const dn = downIn(id, a, Math.min(b, now));
      pts.push({ a, b, label: pad(new Date(a).getHours()) + ":00", up: 100 - (dn / 60) * 100, rt: rtAt(id, a, dn > 0), down: dn, mins: 60 });
    }
  } else {
    const days =
      range === "custom" ? Math.max(1, Math.round((startDay(to!) - startDay(from!)) / DAY) + 1) : +range;
    const last = range === "custom" ? startDay(to!) : startDay(now);
    for (let i = days - 1; i >= 0; i--) {
      const a = last - i * DAY;
      const b = a + DAY;
      const eb = Math.min(b, now);
      const mins = (eb - a) / MIN;
      const dn = downIn(id, a, eb);
      const outN = outages(id).filter((o) => o.s >= a && o.s < b).length;
      pts.push({ a, b, label: dShort(a), up: 100 - (dn / Math.max(mins, 1)) * 100, rt: rtAt(id, a + 12 * HR, dn > 0), down: dn, mins, outs: outN });
    }
  }
  return pts;
}

export function summarize(pts: HistoryPoint[]) {
  let d = 0,
    m = 0,
    o = 0,
    rt = 0;
  pts.forEach((p) => {
    d += p.down;
    m += p.mins;
    o += p.outs || 0;
    rt += p.rt;
  });
  return { down: d, up: 100 - (d / Math.max(m, 1)) * 100, outs: o, rt: pts.length ? rt / pts.length : 0 };
}

function uptimeBounds(list: number[]) {
  let m = 100;
  list.forEach((v) => {
    if (v < m) m = v;
  });
  return Math.max(0, Math.floor(m) - 2);
}

/** Line chart config for machines with sample history. Returns null when none have history. */
export function chartCfg(
  machines: Machine[],
  ids: string[],
  range: HistRange,
  metric: "up" | "rt",
  alt: string,
  from?: number | null,
  to?: number | null,
): LineChartConfig | null {
  let labels: string[] = [];
  const series: LineChartConfig["series"] = [];
  ids.forEach((id) => {
    const m = machines.find((x) => x.id === id);
    if (!m || !m.hist || !hasHistory(id)) return;
    const pts = points(id, range, from, to);
    labels = pts.map((p) => p.label);
    series.push({
      id,
      name: m.name,
      cls: id === "m1" ? "l1" : "l2",
      v: pts.map((p) => (metric === "up" ? Math.round(Math.max(p.up, 0) * 10) / 10 : p.rt)),
    });
  });
  if (!series.length) return null;
  const all = series.flatMap((s) => s.v).filter((v): v is number => v !== null);
  const min = metric === "up" ? uptimeBounds(all) : 0;
  const max = metric === "up" ? 100 : Math.ceil(Math.max(...all) / 20) * 20;
  return { labels, series, min, max, unit: metric === "up" ? "%" : " ms", alt };
}

/** Tests only: discard generated history so the next call regenerates it (e.g. under a fixed clock). */
export function resetHistoryForTesting() {
  for (const k of Object.keys(HIST)) delete HIST[k];
  generated = false;
}
