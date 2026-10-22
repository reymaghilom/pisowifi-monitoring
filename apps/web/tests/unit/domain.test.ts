import { beforeEach, describe, expect, it } from "vitest";
import { DAY, MIN } from "@/lib/format";
import { outages } from "@/lib/mock/history";
import { filterMachines, machineCounts, machineName, monitoringText, unreachableMachines } from "@/lib/domain/machines";
import {
  DEFAULT_HIST,
  allEvents,
  filterEvents,
  histWindow,
  historyIds,
  historyTotals,
  outagesInWindow,
  paginate,
  timeline,
} from "@/lib/domain/history";
import { measuredUptime, nextSort, outageGroups, periodSummary, reliabilityRows, summaryText } from "@/lib/domain/reports";
import { adminUrl, guessPlatform, networkIdFor, nextStep, stepState } from "@/lib/domain/remote";
import { makeMachine } from "@/stores/demo-store";
import type { Machine, MonitoringEvent } from "@/lib/types";
import { FIXED_NOW, freezeTime } from "../helpers";

let machines: Machine[];
beforeEach(() => {
  freezeTime();
  machines = [
    makeMachine({ id: "m1", name: "PisoWiFi 01", ip: "192.168.194.82", loc: "Main store", tags: ["primary"], hist: true }, "reachable"),
    makeMachine({ id: "m2", name: "PisoWiFi 02", ip: "192.168.194.127", hist: true }, "unreachable"),
    makeMachine({ id: "m3", name: "PisoWiFi 10", ip: "192.168.194.9" }, "reachable"),
    makeMachine({ id: "m4", name: "PisoWiFi 03", ip: "10.0.0.4" }),
  ];
});

describe("machines", () => {
  it("filters by name, IP, location and tag (case-insensitive)", () => {
    expect(filterMachines(machines, "main", "all", "name").map((m) => m.id)).toEqual(["m1"]);
    expect(filterMachines(machines, "PRIMARY", "all", "name").map((m) => m.id)).toEqual(["m1"]);
    expect(filterMachines(machines, "10.0.0", "all", "name").map((m) => m.id)).toEqual(["m4"]);
    expect(filterMachines(machines, "", "unreachable", "name").map((m) => m.id)).toEqual(["m2"]);
    expect(filterMachines(machines, "", "reachable", "name").map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("sorts names naturally (02 before 10) and IPs numerically", () => {
    expect(filterMachines(machines, "", "all", "name").map((m) => m.name)).toEqual(["PisoWiFi 01", "PisoWiFi 02", "PisoWiFi 03", "PisoWiFi 10"]);
    expect(filterMachines(machines, "", "all", "ip").map((m) => m.id)).toEqual(["m4", "m3", "m1", "m2"]);
  });

  it("does not mutate the input list", () => {
    const before = machines.map((m) => m.id);
    filterMachines(machines, "", "all", "ip");
    expect(machines.map((m) => m.id)).toEqual(before);
  });

  it("KPI counts: two statuses; a machine without a valid check has none", () => {
    expect(machineCounts(machines)).toEqual({ tot: 4, ok: 2, bad: 1, none: 1 });
    expect(unreachableMachines(machines).map((m) => m.id)).toEqual(["m2"]);
    expect(machines[3]).toMatchObject({ status: null, checkedAt: null, okAt: null });
  });

  it("monitoring text", () => {
    expect(monitoringText({ interval: "60", timeout: "5", thr: "3" })).toBe("Every 1 min · timeout 5 s · Offline on a verified failed check");
    expect(monitoringText({ interval: "30", timeout: "5", thr: "3" })).toMatch(/^Every 30 s/);
    expect(machineName(machines, "gone")).toBe("Removed machine");
  });
});

describe("history", () => {
  const extra: MonitoringEvent[] = [
    { t: FIXED_NOW - MIN, m: "m1", type: "check", st: "reachable", msg: "Demo check" },
    { t: FIXED_NOW - MIN, m: "deleted", type: "check", st: "reachable", msg: "orphan" },
  ];

  it("merges sample and session events newest first, dropping removed machines", () => {
    const all = allEvents(machines, extra);
    expect(all[0].msg).toBe("Demo check");
    expect(all.some((e) => e.m === "deleted")).toBe(false);
    for (let i = 1; i < all.length; i++) expect(all[i - 1].t).toBeGreaterThanOrEqual(all[i].t);
  });

  it("windows: 24 h, N days, and clamped/swapped custom ranges", () => {
    expect(histWindow({ ...DEFAULT_HIST, range: "24" }, FIXED_NOW)).toMatchObject({ a: FIXED_NOW - DAY, b: FIXED_NOW });
    const w14 = histWindow(DEFAULT_HIST, FIXED_NOW);
    expect(new Date(w14.a).getDate()).toBe(28); // Sep 28 … Oct 11
    const custom = histWindow({ ...DEFAULT_HIST, range: "custom", from: "2026-10-09", to: "2026-08-01" }, FIXED_NOW);
    expect(new Date(custom.from!).getMonth()).toBe(8); // clamped to 30 days back (September)
    expect(new Date(custom.to!).getDate()).toBe(9);
  });

  it("filters by machine and status; events carry only the two statuses and no causes", () => {
    const all = allEvents(machines, []);
    const win = histWindow({ ...DEFAULT_HIST, range: "30" }, FIXED_NOW);
    const outs = filterEvents(all, { ...DEFAULT_HIST, m: "m2", status: "unreachable", range: "30" }, win);
    expect(outs.length).toBeGreaterThan(0);
    expect(outs.every((e) => e.m === "m2" && e.type === "outage")).toBe(true);
    expect(all.every((e) => e.st === "reachable" || e.st === "unreachable")).toBe(true);
    expect(all.every((e) => !/timed out|refused|power|ISP/i.test(e.msg))).toBe(true);
  });

  it("ids, totals, outages and pagination", () => {
    expect(historyIds(machines, "all")).toEqual(["m1", "m2"]);
    expect(historyIds(machines, "m3")).toEqual(["m3"]);
    const win = histWindow(DEFAULT_HIST, FIXED_NOW);
    const tot = historyTotals(["m1", "m2"], DEFAULT_HIST, win);
    expect(tot.up).toBeGreaterThan(90);
    expect(tot.down).toBeGreaterThan(0);
    const outs = outagesInWindow(allEvents(machines, []), ["m1", "m2"], win);
    expect(outs.every((e) => e.type === "outage")).toBe(true);
    const pg = paginate(Array.from({ length: 31 }, (_, i) => i), 9);
    expect(pg).toMatchObject({ pages: 4, page: 3 });
    expect(pg.slice).toEqual([24, 25, 26, 27, 28, 29, 30]);
  });

  it("timeline marks buckets with downtime as Offline", () => {
    const o = outages("m2")[0];
    const t = timeline("m2", "PisoWiFi 02", o.s - DAY, o.s + DAY);
    expect(t.states).toHaveLength(48);
    expect(t.states).toContain("bad");
    expect(t.tips[0]).toMatch(/^PisoWiFi 02 · /);
  });
});

describe("reports", () => {
  it("reliability rows put machines without history last and sort by uptime", () => {
    const rows = reliabilityRows(machines, "weekly", "up", -1, FIXED_NOW);
    expect(rows.slice(-2).every((r) => r.none)).toBe(true);
    expect(rows[0].up).toBeGreaterThanOrEqual(rows[1].up);
  });

  it("column sort toggles direction; a new column starts descending (name ascending)", () => {
    expect(nextSort({ sort: "up", dir: -1 }, "up")).toEqual({ sort: "up", dir: 1 });
    expect(nextSort({ sort: "up", dir: -1 }, "rt")).toEqual({ sort: "rt", dir: -1 });
    expect(nextSort({ sort: "up", dir: -1 }, "name")).toEqual({ sort: "name", dir: 1 });
  });

  it("outage groups: 7 days weekly, 4 weeks monthly, even y max ≥ 2", () => {
    const w = outageGroups(["m1", "m2"], "weekly", FIXED_NOW);
    expect(w.groups).toHaveLength(7);
    expect(w.groups.at(-1)!.label).toBe("11");
    const m = outageGroups(["m1", "m2"], "monthly", FIXED_NOW);
    expect(m.groups.map((g) => g.label)).toEqual(["Wk 1", "Wk 2", "Wk 3", "Wk 4"]);
    expect(m.max % 2).toBe(0);
    expect(m.max).toBeGreaterThanOrEqual(2);
  });

  it("period summary and copyable text", () => {
    const s = periodSummary(machines, ["m1", "m2"], "30", FIXED_NOW);
    expect(s.o).toBe(outages("m1").length + outages("m2").length);
    expect(s.best).toBe("PisoWiFi 01");
    const text = summaryText(machines, "weekly");
    expect(text.split("\n")[0]).toBe("PisoWiFi Monitoring · weekly summary (sample data)");
    expect(text).toContain("PisoWiFi 10: not enough checks");
  });

  it("measured uptime shows — without history", () => {
    expect(measuredUptime([machines[2]], "14")).toMatchObject({ value: "—", sub: "Not enough checks yet" });
    expect(measuredUptime(machines, "24").sub).toBe("Sample · 24 hours");
  });
});

describe("remote access (direct ZeroTier)", () => {
  it("setup steps per platform: Android adds the VPN step; progress is only what the user confirmed", () => {
    expect(nextStep("windows", [])).toBe("install");
    expect(nextStep("windows", ["install", "join"])).toBe("authorize");
    expect(nextStep("windows", ["install", "join", "authorize"])).toBe("test");
    expect(nextStep("android", ["install", "join", "authorize"])).toBe("vpn");
    expect(nextStep("windows", ["install", "join", "authorize", "test"])).toBeNull();
    expect(nextStep("android", ["install", "join", "authorize", "test"])).toBe("vpn");
    expect(stepState("windows", ["install"], "install")).toBe("ok");
    expect(stepState("windows", ["install"], "join")).toBe("now");
    expect(stepState("windows", ["install"], "test")).toBe("");
  });

  it("guesses the operating system only", () => {
    expect(guessPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36")).toBe("android");
    expect(guessPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
  });

  it("admin URL: the machine's own ZeroTier IP and path, nothing else", () => {
    expect(adminUrl({ ip: "192.168.194.82", path: "/admin" })).toBe("http://192.168.194.82/admin");
    expect(adminUrl({ ip: "192.168.194.127", path: "" })).toBe("http://192.168.194.127/");
    for (const [ip, path] of [
      ["pisowifi.local", "/admin"],
      ["192.168.194.300", "/admin"],
      ["192.168.194.82", "//evil.example/admin"],
      ["192.168.194.82", "admin"],
      ["192.168.194.82", "/\\evil.example"],
      ["192.168.194.82", "/a b"],
    ]) {
      expect(adminUrl({ ip, path }), ip + path).toBeNull();
    }
  });

  it("network ID: the machine's own, else the configured one; 16 hex or nothing", () => {
    expect(networkIdFor({ ztNet: "" }, "A1B2C3D4E5F60718")).toBe("a1b2c3d4e5f60718");
    expect(networkIdFor({ ztNet: "0123456789abcdef" }, "a1b2c3d4e5f60718")).toBe("0123456789abcdef");
    expect(networkIdFor({ ztNet: "" }, "")).toBeNull();
    expect(networkIdFor(undefined, "not-an-id")).toBeNull();
  });
});
