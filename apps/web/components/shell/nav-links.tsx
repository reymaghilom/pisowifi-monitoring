"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV, REMOTE_MODE, routeKeyFor } from "@/lib/constants";
import { can } from "@pisowifi/shared";
import { useDemo } from "@/stores/demo-store";
import { Icon } from "@/components/ui/icon";

/** Main navigation, in the approved order. "Machine Details" opens the selected machine. */
export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const active = routeKeyFor(pathname);
  const sel = useDemo((s) => s.sel);
  const role = useDemo((s) => s.role);
  return (
    <nav className="pw-nav" aria-label="Main">
      {NAV.filter((n) => (n.key !== "remote" || REMOTE_MODE !== "disabled") && (!n.perm || can(role, n.perm))).map((n) => {
        const href = n.key === "detail" ? "/machines/" + (sel ?? "none") : n.href;
        return (
          <Link key={n.key} href={href} aria-current={active === n.key ? "page" : undefined} title={n.label} onClick={onNavigate}>
            <Icon name={n.icon} size={19} />
            <span className="nl">{n.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
