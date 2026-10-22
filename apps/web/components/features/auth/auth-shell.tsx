import type { ReactNode } from "react";
import { BrandRow } from "@/components/shell/brand";

/** Split sign-in layout: teal hero (≥900px) + focused form. Below 900px only the form shows. */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="pw-auth">
      <div className="pw-auth-hero">
        <BrandRow inverse />
        <div>
          <div style={{ font: "700 36px/42px var(--font-sans)", letterSpacing: "-.02em", maxWidth: 440 }}>Know when your PisoWiFi is down.</div>
          <p style={{ marginTop: 16, maxWidth: 420, opacity: 0.92, fontSize: 15, lineHeight: "24px" }}>
            Monitor machines, review history and, in a later phase, reach each admin panel securely from one place.
          </p>
        </div>
        {/* Empty third slot: keeps the headline centred in the space-between column. */}
        <div aria-hidden="true" />
        <svg className="rings" width="420" height="420" viewBox="0 0 420 420" fill="none" stroke="currentColor" strokeWidth="14" aria-hidden="true">
          <circle cx="210" cy="210" r="60" />
          <circle cx="210" cy="210" r="130" />
          <circle cx="210" cy="210" r="200" />
        </svg>
      </div>
      <div className="pw-auth-form">
        <main id="main" className="pw-auth-card">
          <div className="login-m pw-row" style={{ gap: 10 }}>
            <BrandRow />
          </div>
          {children}
        </main>
      </div>
    </div>
  );
}
