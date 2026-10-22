"use client";

import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { can } from "@pisowifi/shared";
import { useSearchParams } from "next/navigation";
import { API_MODE, REMOTE_MODE, ZT_NETWORK_ID } from "@/lib/constants";
import { ago } from "@/lib/format";
import { cn } from "@/lib/utils";
import { machineById } from "@/lib/domain/machines";
import { SETUP_STEPS, adminUrl, guessPlatform, networkIdFor, nextStep, type Platform } from "@/lib/domain/remote";
import type { Machine } from "@/lib/types";
import { useDemo } from "@/stores/demo-store";
import { useRemoteSetup } from "@/stores/remote-setup-store";
import { toast } from "@/stores/toast-store";
import { Icon, type IconName } from "@/components/ui/icon";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card, CardHead } from "@/components/ui/card";
import { KeyValueList } from "@/components/ui/data-display";
import { EmptyState, PageSkeleton } from "@/components/ui/states";
import { ConnectivityBadge, StatusBadge } from "@/components/ui/status-badge";
import { ViewGate } from "@/components/demo/view-gate";
import { useCanManageMachines, useMachineNav } from "@/components/features/machines/machine-bits";
import { LoadQuestion, NetworkIdBox, SetupWizard } from "@/components/features/remote/setup-wizard";
import { Troubleshooting } from "@/components/features/remote/troubleshooting";
import { GatewayAccess } from "@/components/features/remote/gateway-access";

/** idle → opened in a new tab and waiting for the user's answer (asked) → loaded or failed. */
export type OpenAttempt = "idle" | "asked" | "loaded" | "failed";

/** NEXT_PUBLIC_REMOTE_MODE=gateway: no ZeroTier on the user's device; a secure gateway on the private network. */
const GATEWAY = REMOTE_MODE === "gateway";

/** Connectivity Status text for the selected machine. Only a confirmed Online result gets the affirmative wording, and
 *  even then it promises neither gateway access nor customer internet. Offline and "no valid check yet" stay factual. */
export function connectivityText(m: Pick<Machine, "status">): string {
  if (!API_MODE) return "Demo status. It doesn’t prove your device’s connection to the machine, or customer internet.";
  if (m.status === "reachable")
    return GATEWAY
      ? "The machine is Online based on the latest successful connectivity check from the monitoring server. Remote access through the secure gateway is expected to be available. This does not confirm customer internet connectivity."
      : "The machine is Online based on the latest successful connectivity check from the monitoring server, not from this device. This does not confirm your device’s ZeroTier connection or customer internet connectivity.";
  if (m.status === "unreachable")
    return "The machine is Offline: the latest valid connectivity check from the monitoring server could not reach it. Remote access is unlikely to work until a later check finds it Online.";
  return "No valid connectivity check has completed for this machine yet, so no status is shown.";
}

const subscribe = (cb: () => void) => useRemoteSetup.persist.onFinishHydration(cb);
const useSetupHydrated = () =>
  useSyncExternalStore(
    subscribe,
    () => useRemoteSetup.persist.hasHydrated(),
    () => false,
  );

export function RemoteView() {
  if (REMOTE_MODE === "disabled") return <RemoteUnavailable />;
  return <ViewGate>{() => <RemoteBody />}</ViewGate>;
}

function RemoteUnavailable() {
  return (
    <Card stack>
      <StateHead tone="warn" icon="lock" title="Remote Administration unavailable">
        Remote Administration is disabled for this deployment. No admin page or gateway ticket can be opened here.
      </StateHead>
    </Card>
  );
}

function RemoteBody() {
  const params = useSearchParams();
  const nav = useMachineNav();
  const canManage = useCanManageMachines();
  const machines = useDemo((s) => s.machines);
  const remote = useDemo((s) => s.remote);
  const view = useDemo((s) => s.view);
  const role = useDemo((s) => s.role);
  const hydrated = useSetupHydrated();
  const saved = useRemoteSetup((s) => s.platform);
  const done = useRemoteSetup((s) => s.done);
  const [attempt, setAttempt] = useState<OpenAttempt>("idle");
  const [review, setReview] = useState(false);

  // ?machine=<id> preselects a machine.
  const qm = params.get("machine");
  useEffect(() => {
    if (qm && machineById(useDemo.getState().machines, qm)) useDemo.getState().patch({ remote: { m: qm } });
  }, [qm]);

  // First visit on this device: start on the tab matching the operating system (a guess about the OS only).
  useEffect(() => {
    if (hydrated && !useRemoteSetup.getState().platform) useRemoteSetup.getState().setPlatform(guessPlatform(navigator.userAgent));
  }, [hydrated]);

  const m = machineById(machines, remote.m) ?? machines[0];
  if (!m || view === "empty")
    return (
      <EmptyState
        icon="shield"
        title="No machines to administer"
        actions={
          canManage ? (
            <Button variant="primary" icon="plus" onClick={nav.add}>
              Add machine
            </Button>
          ) : undefined
        }
      >
        Register a machine first.
      </EmptyState>
    );
  if (!hydrated) return <PageSkeleton />;

  const platform: Platform = saved ?? "windows";
  const complete = nextStep(platform, done[platform]) === null;
  const networkId = networkIdFor(m, ZT_NETWORK_ID);
  const url = adminUrl(m);
  // Permission remote:open (Administrators and Members). The API checks it again for every ticket.
  const canOpen = !API_MODE || can(role, "remote:open");

  const select = (id: string) => {
    setAttempt("idle");
    useDemo.getState().selectMachine(id);
    useDemo.getState().patch({ remote: { m: id } });
  };

  const open = () => {
    if (REMOTE_MODE !== "direct") return;
    if (!url) return toast("This machine’s ZeroTier IP or admin path can’t form an admin link. Check it in My PisoWiFi.", "bad");
    if (API_MODE) window.open(url, "_blank", "noopener,noreferrer");
    else toast("Simulated: " + url + " would open in a new tab. Nothing was sent.");
    setAttempt("asked");
  };

  const answer = (loaded: boolean) => {
    setAttempt(loaded ? "loaded" : "failed");
    if (loaded && !complete) {
      useRemoteSetup.getState().confirm(platform, "test");
      toast("Setup complete on this device");
    }
  };

  return (
    <>
      {GATEWAY ? (
        <Banner kind="info" icon="shield">
          {/* Matches the deployed gateway: REMOTE_TICKET_TTL_S=60, single-use tickets, admin page opened in a new tab. */}
          <strong>Secure Remote Access</strong>
          <br />
          Access your PisoWiFi machines securely through the Remote Admin Gateway. No additional VPN setup is required on your device. Each access request
          generates a single-use link that expires within one minute and opens the selected machine&apos;s administration interface in a new tab.
          <br />
          <strong>Authentication on the PisoWiFi machine may still be required.</strong>
        </Banner>
      ) : (
        <Banner kind="info" icon="shield">
          <strong>Direct access through your own ZeroTier connection.</strong> Install ZeroTier One on this device, join the private network and get it authorized, then open a
          machine’s admin page in a new tab. This app never proxies, frames or signs in to the machine.{" "}
          <strong>Authentication on the PisoWiFi machine may still be required.</strong>
        </Banner>
      )}
      {!API_MODE && (
        <Banner kind="warn" icon="alert">
          <strong>Prototype.</strong> Opening an admin page is simulated here: no request is sent to the machines.
        </Banner>
      )}

      <div className="pw-grid pw-g-main" style={{ alignItems: "start" }}>
        <div className="pw-stack" style={{ gap: 24, minWidth: 0 }}>
          <Card stack>
            <CardHead title="Select machine" style={{ margin: 0 }}>
              {!API_MODE && <StatusBadge status="demo" />}
            </CardHead>
            <div className="pw-grid g-auto" style={{ gap: 12 }}>
              {machines.map((x) => (
                <button
                  key={x.id}
                  type="button"
                  className={cn("pw-card flat pw-stack", x.id === m.id && "sel")}
                  style={{ gap: 10, textAlign: "left", color: "inherit", font: "inherit" }}
                  aria-pressed={x.id === m.id}
                  onClick={() => select(x.id)}
                >
                  <span className="pw-row pw-between" style={{ alignItems: "flex-start" }}>
                    <span className="pw-h3" style={{ overflowWrap: "anywhere" }}>
                      {x.name}
                    </span>
                    <ConnectivityBadge status={x.status} />
                  </span>
                  <span className="pw-mono pw-muted" style={{ overflowWrap: "anywhere" }}>
                    {x.ip}
                    {x.path}
                  </span>
                </button>
              ))}
            </div>
          </Card>

          {!canOpen ? (
            <Card stack>
              <StateHead tone="bad" icon="lock" title="Not authorized">
                Your account can’t open remote administration from PisoWiFi Monitoring. Ask an Administrator for access.
              </StateHead>
            </Card>
          ) : GATEWAY ? (
            <GatewayAccess key={m.id} m={m} />
          ) : (
            <>
              {attempt === "failed" && <ConnectionFailed m={m} url={url} platform={platform} onRetry={open} onDismiss={() => setAttempt("idle")} />}
              {complete && !review ? (
                <ReadyCard m={m} url={url} attempt={attempt} onOpen={open} onAnswer={answer} />
              ) : (
                <SetupWizard platform={platform} networkId={networkId} machine={m} attempt={attempt} onOpen={open} onAnswer={answer} />
              )}
            </>
          )}
        </div>

        <div className="pw-stack" style={{ gap: 24, minWidth: 0 }}>
          <Card>
            <h2 className="pw-h2" style={{ marginBottom: 12 }}>
              Selected machine
            </h2>
            <KeyValueList
              rows={[
                ["Name", m.name],
                ["Software", m.sw + " " + (m.ver || "")],
                ["Admin page", url ?? "Invalid address", true],
                ["Monitoring status", <ConnectivityBadge key="a" status={m.status} />],
                ["Last online", ago(m.okAt)],
              ]}
            />
            <h3 className="pw-h3" style={{ marginTop: 12 }}>
              Connectivity Status
            </h3>
            <p className="pw-small pw-muted" style={{ marginTop: 4 }}>
              {connectivityText(m)}
            </p>
            <Button size="sm" style={{ marginTop: 8 }} onClick={() => nav.openDetail(m.id)}>
              View machine details
            </Button>
          </Card>

          <Card>
            <h2 className="pw-h2" style={{ marginBottom: 12 }}>
              This device
            </h2>
            {GATEWAY ? (
              <KeyValueList
                rows={[
                  ["Access", "Through the secure gateway"],
                  ["ZeroTier on this device", "Not needed"],
                  ["Credentials", "Never stored by PisoWiFi Monitoring"],
                ]}
              />
            ) : (
              <KeyValueList
                rows={[
                  ["Device type", platform === "windows" ? "Windows PC" : "Android phone"],
                  ["Setup", complete ? <StatusBadge key="s" status="enabled" label="Confirmed by you" /> : <StatusBadge key="s" status="notconn" label="Not finished" />],
                  ["Credentials", "Never stored by PisoWiFi Monitoring"],
                ]}
              />
            )}
            {!GATEWAY && complete && (
              <div className="pw-row pw-wrap" style={{ marginTop: 8 }}>
                <Button size="sm" onClick={() => setReview((r) => !r)}>
                  {review ? "Back to remote access" : "Review setup steps"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    useRemoteSetup.getState().reset(platform);
                    setAttempt("idle");
                    setReview(false);
                    toast("Setup reset on this device");
                  }}
                >
                  Reset setup
                </Button>
              </div>
            )}
          </Card>

          {!GATEWAY && (
            <Troubleshooting platform={platform} open={attempt === "failed" ? (platform === "android" ? ["vpn", "noload"] : ["denied", "noload"]) : []} />
          )}
        </div>
      </div>
    </>
  );
}

export function StateHead({ tone, icon, title, children }: { tone: string; icon: IconName; title: string; children: ReactNode }) {
  return (
    <div className="pw-row" style={{ gap: 12, alignItems: "flex-start" }}>
      <span className={"pw-ev-ic " + tone} style={{ width: 44, height: 44 }} aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <div style={{ minWidth: 0 }} role="status" aria-live="polite">
        <h2 className="pw-h2">{title}</h2>
        <div className="pw-muted">{children}</div>
      </div>
    </div>
  );
}

/** Remote Access Ready: setup confirmed on this device; open the machine's own admin page. */
function ReadyCard({ m, url, attempt, onOpen, onAnswer }: { m: Machine; url: string | null; attempt: OpenAttempt; onOpen: () => void; onAnswer: (loaded: boolean) => void }) {
  return (
    <Card stack>
      <StateHead tone="ok" icon="shield" title="Ready for Remote Access">
        Opens {m.name}’s own admin page in a new tab through this device’s ZeroTier connection. <strong>Machine login credentials may be required.</strong>
      </StateHead>
      <div className="rs-netid">
        <span className="pw-small pw-muted">Admin page</span>
        <code className="pw-mono rs-code">{url ?? "Invalid address: check the machine’s ZeroTier IP and admin path"}</code>
      </div>
      <div className="pw-row pw-wrap">
        <Button variant="primary" icon="external" onClick={onOpen} disabled={!url}>
          Open admin page
        </Button>
      </div>
      {attempt === "asked" && <LoadQuestion onAnswer={onAnswer} />}
      {attempt === "loaded" && (
        <p className="pw-small pw-muted" role="status">
          Opened in a new tab. Close that tab when you’re done; the machine keeps its own sign-in session.
        </p>
      )}
    </Card>
  );
}

/** Connection Failed: what the server-side check says, and the next things to try. */
function ConnectionFailed({ m, url, platform, onRetry, onDismiss }: { m: Machine; url: string | null; platform: Platform; onRetry: () => void; onDismiss: () => void }) {
  const machineDown = m.status === "unreachable";
  const undoAuth = () => {
    const steps = SETUP_STEPS[platform];
    useRemoteSetup.getState().undo(platform, steps.slice(steps.indexOf("authorize")));
    onDismiss();
  };
  return (
    <Card stack style={{ borderColor: "var(--danger)" }}>
      <StateHead tone="bad" icon="x" title="Connection failed">
        Your browser couldn’t open {url ?? m.name + "’s admin page"}.
      </StateHead>
      <Banner kind={machineDown ? "warn" : "info"} icon="info">
        {machineDown ? (
          <>
            Monitoring also reports {m.name} as <strong>Offline</strong>. The machine itself may be switched off or disconnected.
          </>
        ) : m.status === "reachable" ? (
          <>Monitoring last reached {m.name}&apos;s admin page. Check this device&apos;s ZeroTier connection or authorization.</>
        ) : (
          <>Monitoring has no result for {m.name} yet. Check this device’s ZeroTier connection first.</>
        )}
      </Banner>
      <ul className="pw-muted" style={{ margin: 0, paddingLeft: 18, fontSize: 13, lineHeight: "22px" }}>
        <li>ZeroTier shows the network as OK with an IP address?</li>
        {platform === "android" && <li>The network is switched on and the VPN key icon is in the status bar?</li>}
        <li>Same network ID as your administrator gave you?</li>
      </ul>
      <NetworkIdBox networkId={networkIdFor(m, ZT_NETWORK_ID)} />
      <div className="pw-row pw-wrap">
        <Button variant="primary" icon="refresh" onClick={onRetry}>
          Try again
        </Button>
        <Button onClick={undoAuth}>Re-check authorization steps</Button>
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </Card>
  );
}
