/* Recorded history → view shapes: request window, chart gaps, strip labels, events, totals. */
import { describe, expect, it } from "vitest";
import { historyResponseSchema } from "@pisowifi/shared";
import { DAY, HR, startDay } from "@/lib/format";
import { historyRequest } from "@/lib/services/api/history";
import { historyChart, historyEvents, historyStrip, historySummary, slotLabel } from "@/lib/domain/api-history";
import { makeMachine } from "@/stores/demo-store";
import { M1, M2, historyFixture } from "../history-fixture";

const machines = [makeMachine({ id: M1, name: "PISOWIFI 1", ip: "192.168.194.127" }), makeMachine({ id: M2, name: "PISOWIFI 2", ip: "192.168.194.82" })];

describe("historyRequest", () => {
  const now = new Date(2026, 9, 18, 13, 25).getTime();
  it("24 hours: 24 hourly slots ending now", () => {
    expect(historyRequest({ range: "24", from: "", to: "", m: "all" }, now)).toMatchObject({ from: now - DAY, to: now, buckets: 24, machine: undefined });
  });
  it("N days: one slot per local day, today's slot ending at the coming midnight", () => {
    const r = historyRequest({ range: "7", from: "", to: "", m: M1 }, now);
    expect(r).toMatchObject({ from: startDay(now) - 6 * DAY, to: startDay(now) + DAY, buckets: 7, machine: M1 });
  });
  it("custom ranges cover whole days, either order", () => {
    const r = historyRequest({ range: "custom", from: "2026-10-16", to: "2026-10-10", m: "all" }, now);
    expect(r.buckets).toBe(7);
    expect(r.from).toBe(new Date(2026, 9, 10).getTime());
    expect(r.to).toBe(new Date(2026, 9, 17).getTime());
  });
});

describe("recorded history adapters", () => {
  const data = historyResponseSchema.parse(historyFixture(new Date(2026, 9, 18, 12).getTime()));

  it("charts only machines with checks, and slots without checks are gaps (null), not values", () => {
    const up = historyChart(data, machines, "24", "up", "alt")!;
    expect(up.series.map((s) => s.name)).toEqual(["PISOWIFI 1"]);
    expect(up.series[0]!.v).toEqual([100, 50, null, 100]);
    expect(up).toMatchObject({ max: 100, unit: "%" });
    expect(up.min).toBeLessThanOrEqual(50);
    const rt = historyChart(data, machines, "24", "rt", "alt")!;
    expect(rt.series[0]!.v).toEqual([250, 400, null, 100]);
    expect(rt).toMatchObject({ min: 0, max: 400, unit: " ms" });
    expect(up.labels).toEqual(["08:00", "09:00", "10:00", "11:00"]);
    expect(slotLabel(data.from, "7")).toMatch(/Oct 18|18 Oct/);
  });

  it("returns no chart when nothing was checked", () => {
    expect(historyChart({ ...data, machines: [data.machines[1]!] }, machines, "24", "up", "alt")).toBeNull();
  });

  it("labels strip slots Online / Offline / Not checked", () => {
    const s = historyStrip(data, data.machines[0]!, "PISOWIFI 1");
    expect(s.states).toHaveLength(48);
    expect(s.tips[0]).toMatch(/^PISOWIFI 1 · .* · Online$/);
    expect(s.tips[12]).toMatch(/Offline$/);
    expect(s.tips[24]).toMatch(/Not checked$/);
  });

  it("turns status changes into events with the outage length on recoveries", () => {
    const ev = historyEvents(data);
    expect(ev.map((e) => [e.type, e.st])).toEqual([
      ["recovery", "reachable"],
      ["outage", "unreachable"],
    ]);
    expect(ev[0]!.msg).toBe("Back online after 60 min offline");
  });

  it("weights totals by checks and never invents an uptime", () => {
    expect(historySummary(data)).toMatchObject({ checks: 5, ok: 4, uptime: 80, avgResponseMs: 250, downMinutes: 60, outages: 1 });
    expect(historySummary({ ...data, machines: [data.machines[1]!] })).toMatchObject({ checks: 0, uptime: null, avgResponseMs: null, lastSuccessAt: null });
  });

  it("keeps the request window within the API limits", () => {
    for (const range of ["24", "7", "14", "30"] as const) {
      const r = historyRequest({ range, from: "", to: "", m: "all" });
      expect(r.buckets).toBeLessThanOrEqual(48);
      expect(r.to - r.from).toBeLessThanOrEqual(31 * DAY);
      expect(r.to - r.from).toBeGreaterThanOrEqual(HR);
    }
  });
});
