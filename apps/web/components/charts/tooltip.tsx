"use client";

import { useLayoutEffect, useRef } from "react";
import { create } from "zustand";

/* One shared chart tooltip (`#tip`), like the prototype: fixed, inverted colours, follows the pointer. */
interface TipState {
  tip: { x: number; y: number; lines: string[] } | null;
  show: (x: number, y: number, lines: string[]) => void;
  hide: () => void;
}

export const useTip = create<TipState>()((set) => ({
  tip: null,
  show: (x, y, lines) => set({ tip: { x, y, lines } }),
  hide: () => set({ tip: null }),
}));

export function ChartTooltip() {
  const tip = useTip((s) => s.tip);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !tip) return;
    const r = el.getBoundingClientRect();
    el.style.left = Math.max(8, Math.min(tip.x + 14, innerWidth - r.width - 8)) + "px";
    let top = tip.y - r.height - 12;
    if (top < 8) top = tip.y + 16;
    el.style.top = top + "px";
  }, [tip]);
  if (!tip) return null;
  return (
    <div id="tip" ref={ref} role="tooltip">
      {tip.lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  );
}
