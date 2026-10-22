"use client";

import { APP_NAME } from "@/lib/constants";
import { useDemo } from "@/stores/demo-store";
import { Icon } from "@/components/ui/icon";
import { LogoMark } from "@/components/shell/brand";
import { NavLinks } from "@/components/shell/nav-links";

/** Desktop sidebar (≥900px), collapsible to a 72px icon rail. */
export function Sidebar() {
  const collapsed = useDemo((s) => s.collapsed);
  const patch = useDemo((s) => s.patch);
  const label = (collapsed ? "Expand" : "Collapse") + " sidebar";
  return (
    <aside className="pw-side" aria-label="Sidebar">
      <div className="pw-logo">
        <LogoMark />
        <span className="pw-logo-t">{APP_NAME}</span>
      </div>
      <NavLinks />
      <button type="button" className="collapse-btn" aria-expanded={!collapsed} aria-label={label} title={label} onClick={() => patch({ collapsed: !collapsed })}>
        <Icon name="chevron" size={19} className="fl" />
        <span className="nl">Collapse</span>
      </button>
    </aside>
  );
}
