"use client";

import { useState, type ReactNode } from "react";
import type { Machine } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PLATFORMS, SETUP_STEPS, STEP_TITLE, ZT_LINKS, nextStep, stepState, type Platform, type SetupStepId } from "@/lib/domain/remote";
import { useRemoteSetup } from "@/stores/remote-setup-store";
import { copyText, toast } from "@/stores/toast-store";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Card, CardHead } from "@/components/ui/card";
import { Tabs } from "@/components/ui/controls";
import { TextField } from "@/components/ui/form";
import { StatusBadge } from "@/components/ui/status-badge";
import type { OpenAttempt } from "@/components/features/remote/remote-view";

/** Remote Access Setup Wizard: one stepper per platform. Each step is confirmed by the user; a web page cannot
 *  detect ZeroTier on this device, so the wizard never claims to. */
export function SetupWizard({
  platform,
  networkId,
  machine,
  attempt,
  onOpen,
  onAnswer,
}: {
  platform: Platform;
  networkId: string | null;
  machine: Machine;
  attempt: OpenAttempt;
  onOpen: () => void;
  onAnswer: (loaded: boolean) => void;
}) {
  const done = useRemoteSetup((s) => s.done[platform]);
  const { setPlatform, confirm, undo } = useRemoteSetup.getState();
  const steps = SETUP_STEPS[platform];
  const current = nextStep(platform, done);
  const count = steps.filter((s) => done.includes(s)).length;

  /** Undoing a step also undoes every later one: they depended on it. */
  const undoFrom = (step: SetupStepId) => undo(platform, steps.slice(steps.indexOf(step)));

  return (
    <Card stack>
      <CardHead title="Remote access setup" sub={`For this device · ${count} of ${steps.length} steps confirmed`}>
        <StatusBadge status={current ? "notconn" : "enabled"} label={current ? "Setup in progress" : "Setup confirmed"} />
      </CardHead>
      <Tabs label="Device type" value={platform} items={PLATFORMS} onChange={setPlatform} />
      <ol className="pw-stepper rs-steps" aria-label={"Setup steps for " + (platform === "windows" ? "Windows" : "Android")}>
        {steps.map((step, i) => {
          const k = stepState(platform, done, step);
          return (
            <li key={step} className="pw-step" aria-current={k === "now" ? "step" : undefined}>
              <span className={cn("pw-step-dot", k)} aria-hidden="true">
                {k === "ok" ? <Icon name="check" size={14} /> : i + 1}
              </span>
              <div className="rs-step-body">
                <div className="pw-row pw-between" style={{ alignItems: "baseline", gap: 8 }}>
                  <h3 className="pw-h3">{STEP_TITLE[step]}</h3>
                  {k === "ok" && (
                    <button type="button" className="rs-link" onClick={() => undoFrom(step)} aria-label={"Mark “" + STEP_TITLE[step] + "” as not done"}>
                      Not done?
                    </button>
                  )}
                </div>
                <div className="pw-small pw-muted">{k === "ok" ? "Confirmed by you" : k === "now" ? "Current step" : "Waiting for the previous step"}</div>
                {k === "now" && (
                  <div className="rs-panel">
                    <StepContent step={step} platform={platform} networkId={networkId} machine={machine} attempt={attempt} onOpen={onOpen} onAnswer={onAnswer} onDone={() => confirm(platform, step)} />
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function StepContent({
  step,
  platform,
  networkId,
  machine,
  attempt,
  onOpen,
  onAnswer,
  onDone,
}: {
  step: SetupStepId;
  platform: Platform;
  networkId: string | null;
  machine: Machine;
  attempt: OpenAttempt;
  onOpen: () => void;
  onAnswer: (loaded: boolean) => void;
  onDone: () => void;
}) {
  const win = platform === "windows";
  const confirmButton = (label = "I've completed this step") => (
    <Button variant="primary" icon="check" onClick={onDone}>
      {label}
    </Button>
  );

  if (step === "install")
    return (
      <>
        <Steps>
          {win ? (
            <>
              <li>Download <strong>ZeroTier One for Windows</strong> (the MSI installer) from ZeroTier’s official download page.</li>
              <li>Run the installer and accept the Windows prompt (it needs administrator rights on this PC).</li>
              <li>When it finishes, a ZeroTier icon appears in the system tray, near the clock.</li>
            </>
          ) : (
            <>
              <li>Open Google Play and install <strong>ZeroTier One</strong> by ZeroTier, Inc.</li>
              <li>Open the app once. You don’t need a ZeroTier account to join a network.</li>
            </>
          )}
        </Steps>
        <div className="pw-row pw-wrap">
          <a className="pw-btn secondary" href={win ? ZT_LINKS.windows : ZT_LINKS.android} target="_blank" rel="noopener noreferrer">
            <Icon name="download" size={16} />
            {win ? "Official download page" : "ZeroTier One on Google Play"}
          </a>
          {confirmButton("ZeroTier One is installed")}
        </div>
      </>
    );

  if (step === "join")
    return (
      <>
        <NetworkIdBox networkId={networkId} />
        <Steps>
          {win ? (
            <>
              <li>Click the ZeroTier tray icon and choose <strong>Join New Network…</strong></li>
              <li>Paste the Network ID and select <strong>Join</strong>. Allow Windows to treat the new network as private if it asks.</li>
            </>
          ) : (
            <>
              <li>In ZeroTier One, tap <strong>+</strong> (Add Network).</li>
              <li>Enter the Network ID and tap <strong>Add Network</strong>.</li>
            </>
          )}
          <li>Leave the default options. Don’t turn on “Route all traffic” / default route: only the private network is needed.</li>
        </Steps>
        <div className="pw-row pw-wrap">{confirmButton(networkId ? "I've joined the network" : "I've joined the network my administrator gave me")}</div>
      </>
    );

  if (step === "authorize") return <AuthorizeStep platform={platform} networkId={networkId} onDone={onDone} />;

  if (step === "vpn")
    return (
      <>
        <Steps>
          <li>In ZeroTier One, switch the network <strong>on</strong>.</li>
          <li>Android asks “ZeroTier One wants to set up a VPN connection”. Tap <strong>OK</strong>. ZeroTier uses Android’s VPN slot to reach the private network.</li>
          <li>A key icon appears in the status bar while the network is on. The network should show <strong>OK</strong> and an assigned IP address.</li>
        </Steps>
        <p className="pw-small pw-muted">Android allows one VPN app at a time. If another VPN is on, turn it off first, or ZeroTier will disconnect.</p>
        <div className="pw-row pw-wrap">{confirmButton("The network is on and the VPN is allowed")}</div>
      </>
    );

  return <TestStep machine={machine} attempt={attempt} onOpen={onOpen} onAnswer={onAnswer} />;
}

function Steps({ children }: { children: ReactNode }) {
  return <ol className="rs-howto">{children}</ol>;
}

export function NetworkIdBox({ networkId }: { networkId: string | null }) {
  if (!networkId)
    return (
      <div className="rs-netid">
        <span className="pw-small pw-muted">Network ID</span>
        <span>Not configured here. Ask your administrator for the 16-character Network ID.</span>
      </div>
    );
  return (
    <div className="rs-netid">
      <span className="pw-small pw-muted">Network ID</span>
      <div className="pw-row pw-wrap" style={{ gap: 8 }}>
        <code className="pw-mono rs-code">{networkId}</code>
        <Button size="sm" icon="link" onClick={() => copyText(networkId, "Network ID copied")}>
          Copy
        </Button>
      </div>
    </div>
  );
}

function AuthorizeStep({ platform, networkId, onDone }: { platform: Platform; networkId: string | null; onDone: () => void }) {
  const [address, setAddress] = useState("");
  const valid = /^[0-9a-f]{10}$/i.test(address.trim());
  const request = `Please authorize my ${platform === "windows" ? "Windows PC" : "Android phone"} on the PisoWiFi ZeroTier network${networkId ? " " + networkId : ""}. My ZeroTier address: ${address.trim().toLowerCase()}`;
  return (
    <>
      <div className="rs-pending" role="status">
        <span className="pw-ev-ic warn" aria-hidden="true">
          <Icon name="clock" size={16} />
        </span>
        <div>
          <strong>Pending authorization</strong>
          <div className="pw-small pw-muted">An administrator must approve this device in ZeroTier Central. This page can’t see that approval, so confirm it below once ZeroTier shows it.</div>
        </div>
      </div>
      <Steps>
        <li>
          Find this device’s ZeroTier address (10 characters):{" "}
          {platform === "windows" ? <>tray icon → <strong>My Address</strong>.</> : <>shown at the top of the ZeroTier One app.</>}
        </li>
        <li>Send it to your administrator. They approve it in ZeroTier Central → your network → <strong>Members</strong>.</li>
        <li>
          Until then ZeroTier shows the network as <strong>ACCESS DENIED</strong> or <strong>REQUESTING CONFIGURATION</strong>. When approved it shows{" "}
          <strong>OK</strong> with an assigned IP address.
        </li>
      </Steps>
      <div className="rs-request">
        <TextField
          id="rs-addr"
          label="Your ZeroTier address (optional)"
          value={address}
          onValue={setAddress}
          placeholder="e.g. a1b2c3d4e5"
          mono
          maxLength={10}
          error={address && !valid ? "10 characters, 0–9 and a–f" : undefined}
          help="Only used to write the message below. Not saved or sent anywhere."
        />
        <Button size="sm" disabled={!valid} onClick={() => copyText(request, "Request copied. Send it to your administrator.")}>
          Copy authorization request
        </Button>
      </div>
      <p className="pw-small pw-muted">Administrators: authorize only devices you recognise. New members are never authorized automatically.</p>
      <div className="pw-row pw-wrap">
        <Button variant="primary" icon="check" onClick={onDone}>
          ZeroTier shows OK: I’m authorized
        </Button>
        <Button
          variant="ghost"
          onClick={() => toast("Still pending. Ask your administrator to approve the address in ZeroTier Central, then come back.")}
        >
          Still pending
        </Button>
      </div>
    </>
  );
}

function TestStep({ machine, attempt, onOpen, onAnswer }: { machine: Machine; attempt: OpenAttempt; onOpen: () => void; onAnswer: (loaded: boolean) => void }) {
  return (
    <>
      <p>
        Open <strong>{machine.name}</strong>’s admin page through your ZeroTier connection. If the machine&apos;s login page appears, setup is complete.
      </p>
      <div className="pw-row pw-wrap">
        <Button variant="primary" icon="external" onClick={onOpen}>
          Open {machine.name} admin page
        </Button>
      </div>
      {attempt === "asked" && <LoadQuestion onAnswer={onAnswer} />}
    </>
  );
}

/** The browser can't see the other tab's result, so the user says what happened. */
export function LoadQuestion({ onAnswer }: { onAnswer: (loaded: boolean) => void }) {
  return (
    <div className="rs-question" role="group" aria-labelledby="rs-q">
      <strong id="rs-q">Did the machine&apos;s login page load in the new tab?</strong>
      <div className="pw-row pw-wrap">
        <Button variant="primary" icon="check" onClick={() => onAnswer(true)}>
          Yes, it loaded
        </Button>
        <Button icon="x" onClick={() => onAnswer(false)}>
          No, it didn’t load
        </Button>
      </div>
    </div>
  );
}
