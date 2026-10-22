"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { DAY, iso } from "@/lib/format";
import { DEFAULT_HIST, histWindow, type HistFilters } from "@/lib/domain/history";
import { machineById } from "@/lib/domain/machines";
import type { HistRange } from "@/lib/types";
import { useDemo } from "@/stores/demo-store";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SelectField, TextField } from "@/components/ui/form";

/** Machine / range / status filters (both modes). ?machine=<id> preselects a machine. */
export function HistoryFilters() {
  const params = useSearchParams();
  const machines = useDemo((s) => s.machines);
  const H = useDemo((s) => s.hist);
  const setH = (p: Partial<HistFilters>) => useDemo.getState().patch({ hist: { ...useDemo.getState().hist, page: 0, ...p } });
  const reset = () => useDemo.getState().patch({ hist: DEFAULT_HIST });
  const qm = params.get("machine");
  useEffect(() => {
    if (qm && machineById(useDemo.getState().machines, qm)) useDemo.getState().patch({ hist: { ...useDemo.getState().hist, m: qm, page: 0 } });
  }, [qm]);
  const win = histWindow(H);
  return (
    <Card>
      <div className="pw-grid g-auto" style={{ gap: 12, alignItems: "end" }}>
        <SelectField id="h-m" label="Machine" value={H.m} options={[["all", "All machines"] as const, ...machines.map((m) => [m.id, m.name] as const)]} onValue={(v) => setH({ m: v })} />
        <SelectField
          id="h-r"
          label="Date range"
          value={H.range}
          options={[
            ["24", "Last 24 hours"],
            ["7", "Last 7 days"],
            ["14", "Last 14 days"],
            ["30", "Last 30 days"],
            ["custom", "Custom range"],
          ] as [HistRange, string][]}
          onValue={(v) => setH(v === "custom" ? { range: v, from: iso(Date.now() - 13 * DAY), to: iso(Date.now()) } : { range: v })}
        />
        {H.range === "custom" && (
          <>
            <TextField id="h-from" label="From" type="date" value={H.from || iso(win.from!)} onValue={(v) => setH({ from: v })} />
            <TextField id="h-to" label="To" type="date" value={H.to || iso(win.to!)} onValue={(v) => setH({ to: v })} />
          </>
        )}
        <SelectField
          id="h-s"
          label="Status"
          value={H.status}
          options={[
            ["all", "Any status"],
            ["reachable", "Online"],
            ["unreachable", "Offline"],
          ] as [HistFilters["status"], string][]}
          onValue={(v) => setH({ status: v })}
        />
        <Button onClick={reset}>Reset filters</Button>
      </div>
    </Card>
  );
}
