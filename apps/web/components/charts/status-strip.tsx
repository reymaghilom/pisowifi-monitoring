"use client";

import type { StripState } from "@/lib/domain/history";
import { useTip } from "@/components/charts/tooltip";

export type { StripState };

/** Segmented up/down timeline (prototype strip()), one tooltip per segment. */
export function StatusStrip({ states, tips, label = "Sample status timeline" }: { states: StripState[]; tips: string[]; label?: string }) {
  const { show, hide } = useTip();
  const w = 600,
    g = 2,
    cw = (w - g * (states.length - 1)) / states.length;
  return (
    <svg className="pw-chart" viewBox={`0 0 ${w} 32`} role="img" aria-label={label} onPointerLeave={hide}>
      {states.map((k, i) => (
        <rect
          key={i}
          className={"s-" + k}
          x={(i * (cw + g)).toFixed(1)}
          y={0}
          width={cw.toFixed(1)}
          height={32}
          rx={3}
          data-tip={tips[i]}
          onPointerMove={(e) => show(e.clientX, e.clientY, [tips[i]])}
          onPointerDown={(e) => show(e.clientX, e.clientY, [tips[i]])}
        />
      ))}
    </svg>
  );
}
