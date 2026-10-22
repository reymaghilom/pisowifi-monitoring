"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "@/components/ui/icon";

/** On/off switch (`pw-toggle`, role=switch). */
export function Toggle({
  on,
  onChange,
  label,
  disabled,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn("pw-toggle", on && "on")}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

/** Checkbox styled as `pw-box` (used for "Remember me"). */
export function Checkbox({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="pw-check"
      role="checkbox"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      style={{ border: 0, background: "none", padding: 0, color: "inherit", font: "inherit" }}
    >
      <span className={cn("pw-box", checked && "on")} aria-hidden="true">
        {checked && <Icon name="check" size={14} />}
      </span>
      {children}
    </button>
  );
}

/** Segmented control (`pw-seg`), wrapped so it can scroll on narrow screens. */
export function Segmented<T extends string>({
  value,
  items,
  onChange,
  label,
}: {
  value: T;
  items: readonly (readonly [T, React.ReactNode, IconName?])[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg-wrap">
      <div className="pw-seg" role="group" aria-label={label}>
        {items.map(([v, text, icon]) => (
          <button key={v} type="button" aria-pressed={value === v} onClick={() => onChange(v)}>
            {icon && <Icon name={icon} size={14} />}
            {icon ? " " : null}
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Underlined tabs (`pw-tabs`) with Left/Right arrow-key movement. */
export function Tabs<T extends string>({
  value,
  items,
  onChange,
  label,
}: {
  value: T;
  items: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  label: string;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div className="pw-tabs" role="tablist" aria-label={label}>
      {items.map(([v, text], i) => (
        <button
          key={v}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="tab"
          aria-selected={value === v}
          tabIndex={value === v ? 0 : -1}
          onClick={() => onChange(v)}
          onKeyDown={(e) => {
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
            e.preventDefault();
            const n = (i + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length;
            onChange(items[n][0]);
            refs.current[n]?.focus();
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}
