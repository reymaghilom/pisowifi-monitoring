"use client";

import { useId, useState } from "react";
import type { LineChartConfig } from "@/lib/types";
import { useDemo } from "@/stores/demo-store";
import { useElementWidth } from "@/components/charts/use-element-width";
import { useTip } from "@/components/charts/tooltip";

const L = 50,
  R = 14,
  T = 12,
  B = 26;

/** The original prototype line chart (P.line + drawCharts + hover cursor), as SVG.
 *  Series 1 is solid with an area fill, series 2 is dashed. Hidden series come from the legend. */
export function LineChart({ id, cfg }: { id: string; cfg: LineChartConfig }) {
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  const hide = useDemo((s) => s.hide);
  const { show, hide: hideTip } = useTip();
  const [cur, setCur] = useState<number | null>(null);
  const [said, setSaid] = useState("");
  const hintId = "ch-" + useId().replace(/[^a-zA-Z0-9_-]/g, "");

  const w = Math.max(260, measured || 320);
  const h = w < 420 ? 210 : 250;
  const { labels, min, max, unit } = cfg;
  const ticks = cfg.ticks ?? 4;
  const n = labels.length;
  const iw = w - L - R;
  const ih = h - T - B;
  const X = (i: number) => L + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
  const Y = (v: number) => T + ih - ((v - min) / (max - min)) * ih;
  const vis = cfg.series.filter((s) => !hide[id + s.id]);
  const step = Math.ceil(n / (w < 420 ? 4 : 7));

  const lines = (i: number) => [labels[i], ...vis.map((s) => s.name + ": " + (s.v[i] == null ? "no checks" : s.v[i] + unit))];
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) * (w / r.width);
    let i = Math.round(((x - L) / (w - L - R)) * (n - 1));
    i = Math.max(0, Math.min(n - 1, i));
    setCur(i);
    show(e.clientX, e.clientY, lines(i));
  };
  const onLeave = () => {
    setCur(null);
    hideTip();
  };
  // Keyboard: the same values as hover/tap. Left/Right step through the points, Home/End jump, Escape hides.
  const onKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!n) return;
    const keys: Record<string, number> = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 };
    let i: number;
    if (e.key in keys) i = cur == null ? (keys[e.key]! > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, cur + keys[e.key]!));
    else if (e.key === "Home") i = 0;
    else if (e.key === "End") i = n - 1;
    else if (e.key === "Escape") return onLeave();
    else return;
    e.preventDefault();
    setCur(i);
    const svg = e.currentTarget.querySelector("svg");
    const r = svg?.getBoundingClientRect();
    if (r) show(r.left + X(i) * (r.width / w), r.top + r.height / 3, lines(i));
    setSaid(lines(i).join(", "));
  };

  return (
    <>
    <div className="cw" ref={ref} role="img" aria-label={cfg.alt} aria-describedby={hintId} tabIndex={n ? 0 : undefined} onKeyDown={onKey} onBlur={onLeave}>
      {measured > 0 && (
        <svg className="pw-chart" viewBox={`0 0 ${w} ${h}`} onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={onLeave}>
          {Array.from({ length: ticks + 1 }, (_, t) => {
            const v = min + ((max - min) * t) / ticks;
            const y = Y(v);
            return (
              <g key={"t" + t}>
                <line className="gridline" x1={L} x2={w - R} y1={y} y2={y} />
                <text x={L - 8} y={y + 4} textAnchor="end">
                  {Math.round(v * 10) / 10 + unit}
                </text>
              </g>
            );
          })}
          {labels.map((lb, i) =>
            i % step === 0 ? (
              /* the last label ends at the right edge so it isn't clipped */
              <text key={"x" + i} x={X(i)} y={h - 6} textAnchor={n > 1 && i === n - 1 ? "end" : "middle"}>
                {lb}
              </text>
            ) : null,
          )}
          {vis.map((s) => {
            // A slot without data breaks the line (a new "M"); a lone value between gaps is drawn as a dot.
            const pt = (v: number, i: number) => X(i).toFixed(1) + " " + Y(Math.max(min, Math.min(max, v))).toFixed(1);
            const d = s.v.map((v, i) => (v == null ? "" : (i && s.v[i - 1] != null ? "L" : "M") + pt(v, i))).join(" ");
            const gaps = s.v.some((v) => v == null);
            const dots = s.v.flatMap((v, i) => (v != null && s.v[i - 1] == null && s.v[i + 1] == null ? [{ v, i }] : []));
            return (
              <g key={s.id}>
                {s.cls === "l1" && vis.length < 3 && !gaps && <path className="a1" d={`${d} L${X(n - 1)} ${T + ih} L${X(0)} ${T + ih} Z`} />}
                <path className={s.cls} d={d} />
                {dots.map(({ v, i }) => (
                  <circle key={i} className={s.cls + " pt"} cx={X(i)} cy={Y(Math.max(min, Math.min(max, v)))} r={2.5} />
                ))}
              </g>
            );
          })}
          <line className="cur" x1={cur == null ? 0 : X(cur)} x2={cur == null ? 0 : X(cur)} y1={12} y2={h - 26} style={{ opacity: cur == null ? 0 : 1 }} />
        </svg>
      )}
    </div>
    <span id={hintId} className="pw-sr">
      Use the left and right arrow keys to read each point.
    </span>
    <span className="pw-sr" aria-live="polite">
      {said}
    </span>
    </>
  );
}
