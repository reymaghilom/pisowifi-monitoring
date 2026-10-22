"use client";

import { useEffect, useState } from "react";
import { API_MODE, REMOTE_MODE } from "@/lib/constants";
import type { Machine } from "@/lib/types";
import { leavePage, openPendingTab, requestRemoteTicket } from "@/lib/services/api/remote";
import { toast } from "@/stores/toast-store";
import { Icon } from "@/components/ui/icon";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StateHead } from "@/components/features/remote/remote-view";

/** idle → requesting → opened (in the new tab) | blocked (popup blocked: the user follows the link themselves,
 *  until it expires) | expired | failed. */
export type GatewayAttempt =
  { kind: "idle" | "requesting" | "opened" | "expired" } | { kind: "blocked"; entryUrl: string; expiresAt: string } | { kind: "failed"; message: string };

/** Remote access through the secure gateway: no ZeroTier on this device. Each open asks the API for a one-time
 *  ticket (remote:open permission; the API decides) and hands it to a new tab. Keyed by machine: switching drops any link. */
export function GatewayAccess({ m }: { m: Machine }) {
  const [attempt, setAttempt] = useState<GatewayAttempt>({ kind: "idle" });

  // An unused fallback link is useless after its ticket expires; drop it from the page then.
  const expiresAt = attempt.kind === "blocked" ? attempt.expiresAt : null;
  useEffect(() => {
    if (!expiresAt) return;
    const t = setTimeout(() => setAttempt({ kind: "expired" }), Math.max(0, Date.parse(expiresAt) - Date.now()));
    return () => clearTimeout(t);
  }, [expiresAt]);

  const open = async () => {
    if (REMOTE_MODE !== "gateway") return;
    if (attempt.kind === "requesting") return;
    if (!API_MODE) {
      toast("Simulated: a one-time gateway link for " + m.name + " would open in a new tab. Nothing was sent.");
      return setAttempt({ kind: "opened" });
    }
    // Before any await: browsers only allow a new tab during the click itself.
    const tab = openPendingTab();
    setAttempt({ kind: "requesting" });
    const res = await requestRemoteTicket(m.id);
    if (!res.ok) {
      tab?.close();
      return setAttempt({ kind: "failed", message: res.message });
    }
    if (tab?.go(res.entryUrl)) return setAttempt({ kind: "opened" });
    setAttempt({ kind: "blocked", entryUrl: res.entryUrl, expiresAt: res.expiresAt });
  };

  const used = () => setAttempt({ kind: "opened" });

  return (
    <Card stack>
      <StateHead tone="ok" icon="shield" title="Ready for Remote Access">
        Open {m.name}&apos;s administration interface securely in a new tab through the Remote Admin Gateway. No additional VPN setup is required on this
        device. <strong>Machine login credentials may be required.</strong>
      </StateHead>
      <div className="pw-row pw-wrap">
        <Button variant="primary" icon="external" onClick={open} disabled={attempt.kind === "requesting"}>
          {attempt.kind === "requesting" ? "Opening…" : "Open admin page"}
        </Button>
      </div>
      {attempt.kind === "requesting" && (
        <p className="pw-small pw-muted" role="status">
          Requesting a one-time link…
        </p>
      )}
      {attempt.kind === "opened" && (
        <p className="pw-small pw-muted" role="status">
          Opened in a new tab. Each link works once and expires within a minute; use Open admin page again for a new one. The machine keeps its own sign-in
          session.
        </p>
      )}
      {attempt.kind === "expired" && (
        <p className="pw-small pw-muted" role="status">
          That link expired unused. Use Open admin page for a new one.
        </p>
      )}
      {attempt.kind === "blocked" && (
        <Banner kind="warn" icon="alert">
          <div className="pw-stack" style={{ gap: 8 }} role="status">
            <span>
              <strong>Your browser blocked the new tab.</strong> The one-time link is ready: open it yourself within a minute.
            </span>
            <span className="pw-row pw-wrap">
              <a className="pw-btn primary sm" href={attempt.entryUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={used}>
                <Icon name="external" size={16} />
                Open in new tab
              </a>
              <Button
                size="sm"
                onClick={() => {
                  used();
                  leavePage.to(attempt.entryUrl);
                }}
              >
                Open in this tab
              </Button>
            </span>
          </div>
        </Banner>
      )}
      {attempt.kind === "failed" && (
        <Banner kind="bad" icon="x">
          <div className="pw-stack" style={{ gap: 8 }}>
            <span>
              <strong>Couldn’t open the admin page.</strong> {attempt.message}
            </span>
            <span className="pw-row pw-wrap">
              <Button size="sm" icon="refresh" onClick={open}>
                Try again
              </Button>
            </span>
          </div>
        </Banner>
      )}
    </Card>
  );
}
