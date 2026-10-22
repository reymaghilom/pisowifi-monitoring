/* Reports & Analytics and Dashboard aggregations over the sample engine. */
import { DAY, MIN, dShort, startDay } from "@/lib/format";
import { outages, points, summarize } from "@/lib/mock/history";
import type { BarGroup, Machine, Range } from "@/lib/types";
import { machineName } from "@/lib/domain/machines";

export type ReportPeriod = "weekly" | "monthly";
export type ReportSort = "name" | "up" | "outs" | "rt";

export const periodDays = (p: ReportPeriod) => (p === "weekly" ? "7" : "30") as "7" | "30";

export interface ReliabilityRow {
  m: Machine;
  none: boolean;
  up: number;
  outs: number;
  rt: number;
}

/** Device reliability table. Machines without history are always listed last. */
export function reliabilityRows(machines: Machine[], period: ReportPeriod, sort: ReportSort, dir: 1 | -1, now = Date.now()) {
  const days = periodDays(period);
  const win = startDay(now) - (+days - 1) * DAY;
  const rows: ReliabilityRow[] = machines.map((m) => {
    if (!m.hist) return { m, none: true, up: -1, outs: -1, rt: -1 };
    const s = summarize(points(m.id, days));
    return { m, none: false, up: s.up, outs: outages(m.id).filter((o) => o.s >= win).length, rt: s.rt };
  });
  return rows.sort((a, b) => {
    if (a.none !== b.none) return a.none ? 1 : -1;
    if (sort === "name") return dir * a.m.name.localeCompare(b.m.name, undefined, { numeric: true }) * -1;
    return dir * (a[sort] - b[sort]);
  });
}

/** Next sort state for a column click: same column flips, a new column starts descending (name ascending). */
export function nextSort(cur: { sort: ReportSort; dir: 1 | -1 }, k: ReportSort): { sort: ReportSort; dir: 1 | -1 } {
  if (cur.sort === k) return { sort: k, dir: (cur.dir * -1) as 1 | -1 };
  return { sort: k, dir: k === "name" ? 1 : -1 };
}

/** Outage frequency: 7 daily groups (weekly) or 4 weekly groups (monthly), plus a rounded-up y max (≥ 2). */
export function outageGroups(ids: string[], period: ReportPeriod, now = Date.now()) {
  const groups: BarGroup[] = [];
  if (period === "weekly") {
    for (let i = 6; i >= 0; i--) {
      const a = startDay(now) - i * DAY;
      const v: Record<string, number> = {};
      ids.forEach((id) => (v[id] = outages(id).filter((o) => o.s >= a && o.s < a + DAY).length));
      groups.push({ label: dShort(a).replace(/^\w+ /, ""), v });
    }
  } else {
    for (let w = 3; w >= 0; w--) {
      const a = startDay(now) - (w * 7 + 6) * DAY;
      const b = a + 7 * DAY;
      const v: Record<string, number> = {};
      ids.forEach((id) => (v[id] = outages(id).filter((o) => o.s >= a && o.s < b).length));
      groups.push({ label: "Wk " + (4 - w), v });
    }
  }
  let max = 2;
  groups.forEach((g) => ids.forEach((id) => (max = Math.max(max, g.v[id]))));
  return { groups, max: Math.ceil(max / 2) * 2 };
}

/** Weekly / monthly summary card: average uptime, outage count, longest outage (min), most reliable machine. */
export function periodSummary(machines: Machine[], ids: string[], d: "7" | "30", now = Date.now()) {
  const from = startDay(now) - (+d - 1) * DAY;
  let up = 0,
    o = 0,
    lg = 0;
  ids.forEach((id) => {
    up += summarize(points(id, d)).up;
    outages(id).forEach((x) => {
      if (x.s >= from) {
        o++;
        lg = Math.max(lg, (x.e - x.s) / MIN);
      }
    });
  });
  const best = ids.slice().sort((a, b) => summarize(points(b, d)).up - summarize(points(a, d)).up)[0];
  return { up: ids.length ? up / ids.length : 0, o, lg, best: best ? machineName(machines, best) : "—" };
}

/** "Copy summary" text. */
export function summaryText(machines: Machine[], period: ReportPeriod) {
  const d = periodDays(period);
  const lines = ["PisoWiFi Monitoring · " + (d === "7" ? "weekly" : "monthly") + " summary (sample data)"];
  machines.forEach((m) => {
    if (m.hist) {
      const s = summarize(points(m.id, d));
      lines.push(m.name + ": uptime " + s.up.toFixed(1) + "%, avg " + Math.round(s.rt) + " ms");
    } else lines.push(m.name + ": not enough checks");
  });
  return lines.join("\n");
}

/** Dashboard "Measured uptime": average of machines with history, or "—" with "Not enough checks yet". */
export function measuredUptime(machines: Machine[], range: Range) {
  const withHist = machines.filter((m) => m.hist);
  if (!withHist.length) return { value: "—", sub: "Not enough checks yet", perMachine: [] as { m: Machine; up: number }[] };
  const per = withHist.map((m) => ({ m, up: summarize(points(m.id, range)).up }));
  const avg = per.reduce((a, x) => a + x.up, 0) / per.length;
  return { value: avg.toFixed(1) + "%", sub: "Sample · " + (range === "24" ? "24 hours" : range + " days"), perMachine: per };
}
