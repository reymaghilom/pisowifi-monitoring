"use client";

import { useEffect, useState } from "react";
import type { HistoryResponse } from "@pisowifi/shared";
import type { HistFilters } from "@/lib/domain/history";
import { HistoryError, fetchHistory, historyRequest } from "@/lib/services/api/history";

/** Same cadence as the monitor (one round a minute). */
export const HISTORY_REFRESH_MS = 60_000;

export interface HistoryState {
  data: HistoryResponse | null;
  /** last failure; with `data` set it means the shown history is from an earlier successful load */
  error: HistoryError | null;
  loading: boolean;
  reload: () => void;
}

/** Recorded monitoring history for the filters (API mode), refreshed every minute while the page is visible.
 *  A failed refresh keeps the last good data; results are tagged with their filters, so another filter's data
 *  never shows. */
export function useHistory(filters: Pick<HistFilters, "range" | "from" | "to" | "m">, { enabled = true, refreshMs = HISTORY_REFRESH_MS } = {}): HistoryState {
  const { range, from, to, m } = filters;
  const key = `${range}|${from}|${to}|${m}`;
  const [state, setState] = useState<{ key: string; data: HistoryResponse | null; error: HistoryError | null }>({ key: "", data: null, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let ctrl: AbortController | null = null;
    const load = async () => {
      ctrl?.abort();
      const c = (ctrl = new AbortController());
      try {
        const data = await fetchHistory(historyRequest({ range, from, to, m }), c.signal);
        if (!c.signal.aborted) setState({ key, data, error: null });
      } catch (e) {
        if (c.signal.aborted) return;
        const error = e instanceof HistoryError ? e : new HistoryError("Monitoring history could not be loaded.", "server");
        setState((s) => ({ key, data: s.key === key ? s.data : null, error }));
      }
    };
    void load();
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, refreshMs);
    const onVisible = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      ctrl?.abort();
    };
  }, [key, range, from, to, m, enabled, refreshMs, attempt]);

  const current = state.key === key;
  return {
    data: current ? state.data : null,
    error: current ? state.error : null,
    loading: !current || (!state.data && !state.error),
    reload: () => setAttempt((n) => n + 1),
  };
}
