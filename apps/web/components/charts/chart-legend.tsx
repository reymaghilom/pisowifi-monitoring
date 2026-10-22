"use client";

import type { ChartSeriesClass } from "@/lib/types";
import { useDemo } from "@/stores/demo-store";

/** Legend that doubles as series toggles (aria-pressed; strikethrough when hidden). */
export function ChartLegend({ id, series }: { id: string; series: { id: string; name: string; cls: ChartSeriesClass }[] }) {
  const hide = useDemo((s) => s.hide);
  const toggle = useDemo((s) => s.toggleHide);
  return (
    <div className="pw-legend" style={{ marginTop: 8 }}>
      {series.map((s) => {
        const off = !!hide[id + s.id];
        const bar = s.cls.charAt(0) === "b";
        return (
          <button key={s.id} type="button" aria-pressed={!off} title={"Show or hide " + s.name} onClick={() => toggle(id + s.id)}>
            {bar ? (
              <i className="sq" style={{ background: s.cls === "b1" ? "var(--chart-1)" : "var(--chart-2)" }} />
            ) : (
              <i className={s.cls === "l2" ? "d2" : ""} />
            )}
            {s.name}
          </button>
        );
      })}
    </div>
  );
}
