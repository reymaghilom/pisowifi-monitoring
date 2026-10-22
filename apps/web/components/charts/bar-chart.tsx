"use client";

import type { BarChartConfig } from "@/lib/types";
import { useDemo } from "@/stores/demo-store";
import { useElementWidth } from "@/components/charts/use-element-width";
import { useTip } from "@/components/charts/tooltip";

/** Grouped bars (prototype drawBars) with per-bar tooltips. */
export function BarChart({ id, cfg }: { id: string; cfg: BarChartConfig }) {
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  const hide = useDemo((s) => s.hide);
  const { show, hide: hideTip } = useTip();

  const w = Math.max(260, measured || 320);
  const h = w < 420 ? 210 : 250;
  const L = 34,
    B = 26,
    T = 10,
    ih = h - T - B;
  const n = cfg.groups.length;
  const gw = (w - L - 8) / n;
  const vis = cfg.series.filter((s) => !hide[id + s.id]);
  const bw = Math.min(24, gw / (vis.length + 1));
  let mx = Math.max(1, cfg.max);
  const nt = mx <= 4 ? mx : 4;
  if (mx > 4) mx = Math.ceil(mx / 4) * 4;

  return (
    <div className="cw" ref={ref} role="img" aria-label={cfg.alt}>
      {measured > 0 && (
        <svg className="pw-chart" viewBox={`0 0 ${w} ${h}`} onPointerLeave={hideTip}>
          {Array.from({ length: nt + 1 }, (_, t) => {
            const y = T + ih - (ih * t) / nt;
            return (
              <g key={"t" + t}>
                <line className="gridline" x1={L} x2={w - 8} y1={y} y2={y} />
                <text x={L - 6} y={y + 4} textAnchor="end">
                  {Math.round((mx * t) / nt)}
                </text>
              </g>
            );
          })}
          {cfg.groups.map((g, i) => {
            const cx = L + gw * i + gw / 2;
            const x0 = cx - (vis.length * bw) / 2;
            return (
              <g key={g.label + i}>
                {vis.map((se, j) => {
                  const v = g.v[se.id] || 0;
                  const bh = (v / mx) * ih;
                  const tip = g.label + " · " + se.name + ": " + v + " " + (cfg.unit || "");
                  return (
                    <rect
                      key={se.id}
                      className={se.cls}
                      x={x0 + j * bw + 1}
                      y={T + ih - bh}
                      width={bw - 2}
                      height={Math.max(bh, 0)}
                      rx={4}
                      data-tip={tip}
                      onPointerMove={(e) => show(e.clientX, e.clientY, [tip])}
                      onPointerDown={(e) => show(e.clientX, e.clientY, [tip])}
                      onPointerLeave={hideTip}
                    />
                  );
                })}
                <text x={cx} y={h - 6} textAnchor="middle">
                  {g.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
    </div>
  );
}
