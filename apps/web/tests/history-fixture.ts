/* A recorded-history response (GET /history) for tests: PISOWIFI 1 checked with one outage, PISOWIFI 2 never checked. */
import type { HistoryResponse } from "@pisowifi/shared";

export const M1 = "6f1c2a4e-8b1d-4c3e-9f2a-1b2c3d4e5f60";
export const M2 = "7a2d3b5f-9c2e-4d4f-8a3b-2c3d4e5f6a71";
const HOUR = 3_600_000;

export function historyFixture(now = Date.now()): HistoryResponse {
  const from = now - 4 * HOUR;
  const at = (h: number) => new Date(from + h * HOUR).toISOString();
  const slot = (i: number, checks: number, ok: number, rt: number | null, down = 0) => ({
    start: at(i),
    end: at(i + 1),
    checks,
    okChecks: ok,
    uptimePercent: checks ? (ok / checks) * 100 : null,
    avgResponseMs: rt,
    downMinutes: down,
  });
  return {
    from: at(0),
    to: at(4),
    generatedAt: new Date(now).toISOString(),
    machines: [
      {
        machineId: M1,
        totals: { checks: 5, okChecks: 4, uptimePercent: 80, avgResponseMs: 250, downMinutes: 60, outages: 1, lastSuccessAt: at(3.2) },
        points: [slot(0, 2, 2, 250), slot(1, 2, 1, 400, 30), slot(2, 0, 0, null, 30), slot(3, 1, 1, 100)],
        timeline: [...Array(12).fill("ok"), ...Array(12).fill("bad"), ...Array(12).fill("none"), ...Array(12).fill("ok")],
        recentChecks: [
          { startedAt: at(3.2), ok: true, httpCode: 200, durationMs: 210 },
          { startedAt: at(1.5), ok: false, httpCode: null, durationMs: null },
        ],
      },
      {
        machineId: M2,
        totals: { checks: 0, okChecks: 0, uptimePercent: null, avgResponseMs: null, downMinutes: 0, outages: 0, lastSuccessAt: null },
        points: [slot(0, 0, 0, null), slot(1, 0, 0, null), slot(2, 0, 0, null), slot(3, 0, 0, null)],
        timeline: Array(48).fill("none"),
        recentChecks: [],
      },
    ],
    events: [
      { id: "2", machineId: M1, type: "recovery", status: "reachable", message: "Became Reachable", occurredAt: at(2.5), durationMinutes: 60 },
      { id: "1", machineId: M1, type: "outage", status: "unreachable", message: "Became Unreachable", occurredAt: at(1.5) },
    ],
    outages: [{ machineId: M1, startedAt: at(1.5), endedAt: at(2.5), durationMinutes: 60 }],
  };
}
