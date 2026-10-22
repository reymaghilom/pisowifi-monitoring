import { describe, expect, it } from "vitest";
import { DAY, HR, MIN, ago, dShort, dTime, dur, iso, pad, startDay } from "@/lib/format";

const NOW = new Date(2026, 9, 11, 14, 0, 0).getTime();

describe("ago", () => {
  it.each([
    [null, "Never"],
    [NOW - 10_000, "just now"],
    [NOW - 14 * MIN, "14 min ago"],
    [NOW - 3 * HR, "3 h ago"],
    [NOW - (2 * HR + 5 * MIN), "2 h 5 min ago"],
    [NOW - DAY, "1 day ago"],
    [NOW - 3 * DAY, "3 days ago"],
  ])("%s → %s", (t, out) => {
    expect(ago(t as number | null, NOW)).toBe(out);
  });

  it("never returns a negative time for future timestamps", () => {
    expect(ago(NOW + 5 * MIN, NOW)).toBe("just now");
  });
});

describe("dur", () => {
  it.each([
    [5, "5 min"],
    [59.6, "1 h"],
    [70, "1 h 10 min"],
    [120, "2 h"],
  ])("%s min → %s", (m, out) => expect(dur(m)).toBe(out));
});

describe("dates", () => {
  it("formats short, time and ISO dates in local time", () => {
    const t = new Date(2026, 9, 3, 7, 5).getTime();
    expect(dShort(t)).toBe("Oct 3");
    expect(dTime(t)).toBe("Oct 3, 07:05");
    expect(iso(t)).toBe("2026-10-03");
    expect(pad(7)).toBe("07");
  });

  it("startDay returns local midnight", () => {
    const d = new Date(startDay(NOW));
    expect([d.getHours(), d.getMinutes(), d.getDate()]).toEqual([0, 0, 11]);
  });
});
