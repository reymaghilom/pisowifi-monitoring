import { beforeEach, describe, expect, it } from "vitest";
import { DAY, HR } from "@/lib/format";
import { chartCfg, downIn, historyEvents, outages, points, rng, summarize } from "@/lib/mock/history";
import { makeMachine } from "@/stores/demo-store";
import { FIXED_NOW, freezeTime } from "../helpers";

beforeEach(() => freezeTime());

describe("seeded sample history", () => {
  it("rng is deterministic per seed", () => {
    const a = rng(11),
      b = rng(11);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("generates the same history for the same clock", () => {
    const first = JSON.stringify([outages("m1"), outages("m2"), historyEvents("m2")]);
    freezeTime();
    expect(JSON.stringify([outages("m1"), outages("m2"), historyEvents("m2")])).toBe(first);
  });

  it("only demo machines m1 and m2 have history; events are in the past", () => {
    expect(outages("m3")).toEqual([]);
    expect(outages("m2").length).toBeGreaterThan(outages("m1").length); // m2 is the flakier sample machine
    for (const e of [...historyEvents("m1"), ...historyEvents("m2")]) expect(e.t).toBeLessThan(FIXED_NOW);
  });

  it("every outage has a matching outage and recovery event", () => {
    const ev = historyEvents("m2");
    for (const o of outages("m2")) {
      expect(ev.some((e) => e.type === "outage" && e.t === o.s)).toBe(true);
      expect(ev.some((e) => e.type === "recovery" && e.t === o.e)).toBe(true);
    }
  });
});

describe("points and summaries", () => {
  it("24 h range gives 24 hourly buckets labelled HH:00", () => {
    const p = points("m1", "24");
    expect(p).toHaveLength(24);
    expect(p[0].label).toMatch(/^\d\d:00$/);
  });

  it("day ranges give one bucket per day ending today", () => {
    expect(points("m1", "7")).toHaveLength(7);
    expect(points("m1", "30")).toHaveLength(30);
    expect(points("m1", "14").at(-1)!.label).toBe("Oct 11");
  });

  it("custom range covers from..to inclusive", () => {
    const to = FIXED_NOW - 2 * DAY;
    expect(points("m1", "custom", to - 4 * DAY, to)).toHaveLength(5);
  });

  it("uptime equals 100 minus downtime share, and downtime matches downIn", () => {
    const p = points("m2", "30");
    const s = summarize(p);
    const total = p.reduce((a, x) => a + x.down, 0);
    expect(s.down).toBeCloseTo(total);
    expect(s.up).toBeGreaterThan(90);
    expect(s.up).toBeLessThanOrEqual(100);
    expect(downIn("m2", p[0].a, FIXED_NOW)).toBeCloseTo(total);
  });

  it("chart config: m1 solid (l1), m2 dashed (l2), uptime axis 2 below the minimum", () => {
    const machines = [makeMachine({ id: "m1", name: "PisoWiFi 01", ip: "1.1.1.1", hist: true }), makeMachine({ id: "m2", name: "PisoWiFi 02", ip: "1.1.1.2", hist: true })];
    const cfg = chartCfg(machines, ["m1", "m2"], "14", "up", "alt")!;
    expect(cfg.series.map((s) => s.cls)).toEqual(["l1", "l2"]);
    expect(cfg.labels).toHaveLength(14);
    expect(cfg.max).toBe(100);
    expect(cfg.min).toBe(Math.max(0, Math.floor(Math.min(...cfg.series.flatMap((s) => s.v).map(Number))) - 2));
    const rt = chartCfg(machines, ["m1", "m2"], "14", "rt", "alt")!;
    expect(rt.min).toBe(0);
    expect(rt.max % 20).toBe(0);
    expect(rt.unit).toBe(" ms");
  });

  it("chart config is null when no machine has history", () => {
    expect(chartCfg([makeMachine({ id: "m9", name: "X", ip: "1.1.1.9" })], ["m9"], "14", "up", "alt")).toBeNull();
  });

  it("hourly response times stay near the machine's base", () => {
    const rt = points("m1", "24").map((p) => p.rt);
    expect(Math.min(...rt)).toBeGreaterThan(30);
    expect(Math.max(...rt)).toBeLessThan(44 * 1.18 + 44 * 0.6 + 1);
    expect(HR).toBe(3_600_000);
  });
});
