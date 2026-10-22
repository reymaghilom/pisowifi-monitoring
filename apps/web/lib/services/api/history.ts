/* Monitoring history from the API (GET /history): recorded checks, status changes and outages only.
   The browser computes the window (its local day boundaries) and the API buckets it evenly. */
import { historyResponseSchema, type HistoryResponse } from "@pisowifi/shared";
import { DAY, HR } from "@/lib/format";
import { histWindow, type HistFilters } from "@/lib/domain/history";

const API = "/api/v1";

export class HistoryError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "session" | "server",
  ) {
    super(message);
  }
}

/** Window and slot count for the filters: hourly for the last 24 hours, else one slot per local day. */
export function historyRequest(h: Pick<HistFilters, "range" | "from" | "to" | "m">, now = Date.now()) {
  const win = histWindow({ ...h, status: "all", page: 0 }, now);
  const machine = h.m === "all" ? undefined : h.m;
  if (h.range === "24") return { from: win.a, to: win.a + 24 * HR, buckets: 24, machine, win };
  // Daily slots run local midnight to midnight; today's slot ends at the coming midnight (the API reads up to now).
  const days = win.from !== null && win.to !== null ? Math.round((win.to - win.from) / DAY) + 1 : Math.ceil((win.b - win.a) / DAY);
  return { from: win.a, to: win.a + days * DAY, buckets: Math.max(1, Math.min(31, days)), machine, win };
}

export async function fetchHistory(q: { from: number; to: number; buckets: number; machine?: string }, signal?: AbortSignal): Promise<HistoryResponse> {
  const params = new URLSearchParams({ from: new Date(q.from).toISOString(), to: new Date(q.to).toISOString(), buckets: String(q.buckets) });
  if (q.machine) params.set("machine", q.machine);
  const res = await fetch(`${API}/history?${params}`, { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" }, signal }).catch((e) => {
    if ((e as Error).name === "AbortError") throw e;
    return null;
  });
  if (!res) throw new HistoryError("Can't reach the server. Check your connection and try again.", "network");
  if (res.status === 401) throw new HistoryError("Your session has ended. Sign in again.", "session");
  if (!res.ok) throw new HistoryError(`Monitoring history could not be loaded (error ${res.status}).`, "server");
  const parsed = historyResponseSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new HistoryError("Monitoring history could not be read.", "server");
  return parsed.data;
}
