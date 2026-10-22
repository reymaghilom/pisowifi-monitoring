"use client";

import { useToasts } from "@/stores/toast-store";
import { Icon } from "@/components/ui/icon";

/** Bottom-centre toast stack (`#toasts` / `pw-toast`), polite live region. */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div id="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className="pw-toast">
          <span style={{ color: t.kind === "bad" ? "var(--danger)" : "var(--success)" }}>
            <Icon name={t.kind === "bad" ? "alert" : "check"} size={20} />
          </span>
          <div style={{ minWidth: 0, overflowWrap: "anywhere" }}>
            <strong style={{ fontSize: 13 }}>{t.msg}</strong>
          </div>
        </div>
      ))}
    </div>
  );
}
