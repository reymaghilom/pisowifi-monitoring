"use client";

import { useEffect } from "react";
import { Dialog as D } from "radix-ui";
import { APP_NAME } from "@/lib/constants";
import { useDemo } from "@/stores/demo-store";
import { IconButton } from "@/components/ui/button";
import { LogoMark } from "@/components/shell/brand";
import { NavLinks } from "@/components/shell/nav-links";

/** Left navigation drawer below 900px. Closes on Esc, scrim click, navigation, or widening to desktop. */
export function MobileDrawer() {
  const open = useDemo((s) => s.drawer);
  const patch = useDemo((s) => s.patch);
  const close = () => patch({ drawer: false });

  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      if (window.innerWidth >= 900) patch({ drawer: false });
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [open, patch]);

  return (
    <D.Root open={open} onOpenChange={(o) => patch({ drawer: o })}>
      <D.Portal>
        <D.Content className="drawer-wrap" aria-label="Navigation" aria-describedby={undefined}>
          <D.Title className="sr">Navigation</D.Title>
          <div className="pw-drawer-panel">
            <div className="pw-row pw-between" style={{ padding: "4px 8px 14px" }}>
              <div className="pw-row" style={{ gap: 10 }}>
                <LogoMark />
                <strong>{APP_NAME}</strong>
              </div>
              <D.Close asChild>
                <IconButton icon="x" aria-label="Close navigation menu" />
              </D.Close>
            </div>
            <NavLinks onNavigate={close} />
          </div>
          <button type="button" className="pw-drawer-scrim" aria-label="Close navigation" onClick={close} />
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
