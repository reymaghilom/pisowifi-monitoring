"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { DATA_SOURCE, getServices } from "@/lib/services";
import { strength } from "@/lib/validation";
import { REMOTE_MODE, ZT_NETWORK_ID } from "@/lib/constants";
import { ZT_LINKS, networkIdFor } from "@/lib/domain/remote";
import { useDemo, type NotifPrefs, type SettingsSection } from "@/stores/demo-store";
import { toast } from "@/stores/toast-store";
import { Icon, type IconName } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Segmented, Toggle } from "@/components/ui/controls";
import { SelectField, TextField } from "@/components/ui/form";
import { KeyValueList } from "@/components/ui/data-display";
import { StatusBadge } from "@/components/ui/status-badge";
import { ViewGate } from "@/components/demo/view-gate";
import { switchTheme } from "@/lib/theme-transition";
import { can, type Permission } from "@pisowifi/shared";
import { useCan } from "@/lib/permissions";

/** Mock data source: copy says what is simulated. API data source: profile, password and sessions are real. */
const DEMO = DATA_SOURCE === "mock";

export const SECTIONS: [SettingsSection, IconName, string][] = [
  ["profile", "user", "Profile"],
  ["security", "lock", "Security"],
  ["sessions", "phone", "Sessions"],
  ["theme", "sun", "Theme"],
  ["monitoring", "pulse", "Monitoring"],
  ["zerotier", "network", "ZeroTier"],
  ["notifications", "bell", "Notifications"],
  ["automation", "zap", "Automation"],
];

/** Sections that change the workspace (not your own account) need a permission; the API enforces the same. */
const SECTION_PERM: Partial<Record<SettingsSection, Permission>> = {
  monitoring: "settings:manage",
  zerotier: "settings:manage",
  notifications: "notifications:manage",
  automation: "settings:manage",
};

export function SettingsView() {
  return <ViewGate machines={false}>{() => <SettingsBody />}</ViewGate>;
}

function SettingsBody() {
  const { section } = useParams<{ section: string }>();
  const router = useRouter();
  const role = useDemo((s) => s.role);
  const visible = SECTIONS.filter(([s]) => !SECTION_PERM[s] || can(role, SECTION_PERM[s]!));
  const sec = (visible.some(([s]) => s === section) ? section : "profile") as SettingsSection;
  return (
    <div className="set-layout">
      <div className="pw-card" style={{ padding: 8 }}>
        <nav className="set-nav" aria-label="Settings sections">
          {visible.map(([s, icon, label]) => (
            <button key={s} type="button" aria-current={sec === s} onClick={() => router.replace("/settings/" + s, { scroll: false })}>
              <Icon name={icon} size={18} />
              {label}
            </button>
          ))}
        </nav>
      </div>
      <div className="pw-stack" style={{ gap: 24, minWidth: 0 }}>
        {sec === "profile" && <ProfileSection />}
        {sec === "security" && <SecuritySection />}
        {sec === "sessions" && <SessionsSection />}
        {sec === "theme" && <ThemeSection />}
        {sec === "monitoring" && <MonitoringSection />}
        {sec === "zerotier" && <ZeroTierSection />}
        {sec === "notifications" && <NotificationsSection />}
        {sec === "automation" && <AutomationSection />}
      </div>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <section className="pw-card pw-stack">
      <div>
        <h2 className="pw-h2">{title}</h2>
        <div className="pw-muted" style={{ fontSize: 13 }}>
          {desc}
        </div>
      </div>
      {children}
    </section>
  );
}

function ProfileSection() {
  const profile = useDemo((s) => s.profile);
  const canEmail = useCan("account:email");
  const [name, setName] = useState(profile.name);
  const [email, setEmail] = useState(profile.email);
  const [err, setErr] = useState<{ name?: string; email?: string }>({});
  return (
    <Section title="Profile" desc={DEMO ? "Your account details (demo)." : "Your name and the email you sign in with."}>
      <form
        className="pw-stack"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await getServices().settings.saveProfile({ name, email });
          setErr(res.ok ? {} : res.error);
          if (res.ok) toast(DEMO ? "Profile saved (demo only)" : "Profile saved");
        }}
      >
        <div className="pw-grid pw-g2" style={{ gap: 16 }}>
          <TextField id="p-name" label="Display name" value={name} onValue={(v) => (setName(v), setErr((x) => ({ ...x, name: undefined })))} error={err.name} />
          <TextField
            id="p-email"
            label="Email"
            type="email"
            value={email}
            onValue={(v) => (setEmail(v), setErr((x) => ({ ...x, email: undefined })))}
            error={err.email}
            readOnly={!canEmail}
            help={canEmail ? undefined : "Your sign-in email. Ask an Administrator to change it."}
          />
        </div>
        <div>
          <Button variant="primary" type="submit">
            Save changes
          </Button>
        </div>
      </form>
    </Section>
  );
}

const METER = ["var(--danger)", "var(--danger)", "var(--warning)", "var(--warning)", "var(--success)", "var(--success)"];
const STRENGTH = ["Very weak", "Weak", "Fair", "Good", "Strong", "Strong"];

function SecuritySection() {
  const [w, setW] = useState({ cur: "", nw: "", cf: "" });
  const [err, setErr] = useState<{ cur?: string; nw?: string; cf?: string }>({});
  const sc = strength(w.nw);
  const field = (k: keyof typeof w) => (v: string) => {
    setW((x) => ({ ...x, [k]: v }));
    setErr((x) => ({ ...x, [k]: undefined }));
  };
  return (
    <>
      <Section title="Security" desc="Change your password.">
        <form
          className="pw-stack"
          noValidate
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await getServices().settings.changePassword(w.cur, w.nw, w.cf);
            setErr(res.ok ? {} : res.error);
            if (!res.ok) return;
            setW({ cur: "", nw: "", cf: "" });
            toast(DEMO ? "Password updated (demo only)" : "Password updated. Other devices were signed out.");
          }}
        >
          <div className="pw-grid pw-g3" style={{ gap: 16 }}>
            <TextField id="w-cur" label="Current password" type="password" value={w.cur} onValue={field("cur")} error={err.cur} autoComplete="current-password" />
            <TextField id="w-nw" label="New password" type="password" value={w.nw} onValue={field("nw")} error={err.nw} help="At least 12 characters" autoComplete="new-password" />
            <TextField id="w-cf" label="Confirm password" type="password" value={w.cf} onValue={field("cf")} error={err.cf} autoComplete="new-password" />
          </div>
          {w.nw && (
            <div>
              <div className="meter" aria-hidden="true">
                <i style={{ width: (sc / 5) * 100 + "%", background: METER[sc] }} />
              </div>
              <div className="pw-small pw-muted" style={{ marginTop: 4 }}>
                Strength: {STRENGTH[sc]}
              </div>
            </div>
          )}
          <div>
            <Button variant="primary" type="submit">
              Update password
            </Button>
          </div>
        </form>
      </Section>
    </>
  );
}

function SessionsSection() {
  const sessions = useDemo((s) => s.sessions);
  const svc = getServices().settings;
  useEffect(() => {
    void getServices().settings.listSessions();
  }, []);
  return (
    <Section title="Sessions" desc={DEMO ? "Where you are signed in (sample list)." : "Where you are signed in. Sign out devices you don't recognize."}>
      <div className="cardlist">
        {sessions.map((s) => (
          <div key={s.id} className="pw-row pw-between pw-wrap pw-card flat" style={{ gap: 12 }}>
            <div>
              <strong>{s.name}</strong>
              <div className="pw-small pw-muted">{s.meta}</div>
            </div>
            {s.cur ? (
              <StatusBadge status="enabled" label="Current" />
            ) : (
              <Button
                variant="danger-outline"
                size="sm"
                onClick={async () => {
                  await svc.signOutSession(s.id);
                  toast(DEMO ? "Session signed out (sample)" : "Session signed out");
                }}
              >
                Sign out
              </Button>
            )}
          </div>
        ))}
      </div>
      {sessions.length > 1 ? (
        <div>
          <Button
            onClick={async () => {
              await svc.signOutOtherSessions();
              toast(DEMO ? "Other sessions signed out (sample)" : "Other sessions signed out");
            }}
          >
            Sign out all other sessions
          </Button>
        </div>
      ) : (
        <p className="pw-muted">No other sessions.</p>
      )}
    </Section>
  );
}

function ThemeSection() {
  const theme = useDemo((s) => s.theme);
  return (
    <Section title="Theme" desc="Choose how the app looks. Saved in this browser.">
      <div className="pw-row">
        <Segmented
          value={theme}
          label="Theme"
          onChange={(t) => switchTheme(t)}
          items={[
            ["light", "Light", "sun"],
            ["dark", "Dark", "moon"],
            ["system", "System"],
          ]}
        />
      </div>
    </Section>
  );
}

function MonitoringSection() {
  const mon = useDemo((s) => s.mon);
  const [q, setQ] = useState(mon);
  const [err, setErr] = useState<{ timeout?: string; thr?: string }>({});
  return (
    <Section title="Monitoring preferences" desc="Used by the demo labels. Real monitoring does not exist yet.">
      <form
        className="pw-stack"
        noValidate
        onSubmit={async (e) => {
          e.preventDefault();
          const res = await getServices().settings.saveMonitoring(q);
          setErr(res.ok ? {} : res.error);
          if (res.ok) toast("Monitoring preferences saved (demo)");
        }}
      >
        <div className="pw-grid pw-g3" style={{ gap: 16 }}>
          <SelectField
            id="s-int"
            label="Check interval"
            value={q.interval}
            options={[
              ["30", "30 seconds"],
              ["60", "60 seconds"],
              ["300", "5 minutes"],
              ["900", "15 minutes"],
            ]}
            onValue={(v) => setQ((x) => ({ ...x, interval: v }))}
          />
          <TextField id="s-to" label="Timeout (seconds)" type="number" value={q.timeout} error={err.timeout} help="1 to 30" onValue={(v) => (setQ((x) => ({ ...x, timeout: v })), setErr((x) => ({ ...x, timeout: undefined })))} />
          <TextField
            id="s-thr"
            label="Consecutive failure preference"
            type="number"
            value={q.thr}
            error={err.thr}
            help="Saved for a future alert policy. Monitoring currently reports a verified failed check as Offline immediately."
            onValue={(v) => (setQ((x) => ({ ...x, thr: v })), setErr((x) => ({ ...x, thr: undefined })))}
          />
        </div>
        <div>
          <Button variant="primary" type="submit">
            Save preferences
          </Button>
        </div>
      </form>
    </Section>
  );
}

function ZeroTierSection() {
  const router = useRouter();
  const networkId = networkIdFor(undefined, ZT_NETWORK_ID);
  return (
    <Section title="ZeroTier" desc={REMOTE_MODE === "disabled" ? "Remote Administration is unavailable for this deployment." : REMOTE_MODE === "gateway" ? "Remote Administration uses the secure gateway." : "Remote administration uses direct ZeroTier client access: each person’s own device joins the private network."}>
      <KeyValueList
        rows={[
          ["Network ID", networkId ?? "Not configured (NEXT_PUBLIC_ZT_NETWORK_ID)", true],
          ["Device authorization", "By an administrator in ZeroTier Central, one device at a time. Never automatic."],
          ["This device", REMOTE_MODE === "disabled" ? "Remote Administration unavailable" : REMOTE_MODE === "gateway" ? "ZeroTier is not needed on this device" : "Set up in Remote Administration (steps you confirm)"],
        ]}
      />
      <div className="pw-row pw-wrap">
        {REMOTE_MODE !== "disabled" && (
          <Button variant="primary" icon="shield" onClick={() => router.push("/remote")}>
            Open remote access setup
          </Button>
        )}
        {REMOTE_MODE !== "disabled" && (
          <a className="pw-btn secondary" href={ZT_LINKS.central} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={16} />
            ZeroTier Central
          </a>
        )}
      </div>
      <div className="pw-stack" style={{ gap: 12, paddingTop: 12, borderTop: "1px solid var(--border)" }}>
        <div className="pw-row pw-between">
          <h3 className="pw-h3">ZeroTier Central API</h3>
          <StatusBadge status="soon" />
        </div>
        <p className="pw-muted" style={{ fontSize: 13, margin: 0 }}>
          Later, the server could read which members are authorized. The API token stays on the server; it is never entered or shown in the browser. Even then, an
          authorized member doesn’t prove that the browser you’re using belongs to that device.
        </p>
        <TextField id="z-t" label="API token" value="" disabled placeholder="Server-side only" mono help="Never entered, displayed or stored in the browser." />
      </div>
    </Section>
  );
}

function NotificationsSection() {
  const notif = useDemo((s) => s.notif);
  const rows: [keyof NotifPrefs, string][] = [
    ["offline", "Offline alerts"],
    ["recovery", "Recovery notifications"],
    ["email", "Gmail channel"],
  ];
  return (
    <Section title="Notification preferences" desc={DEMO ? "Channels are not connected yet. These switches change demo settings only." : "Notification controls are coming soon in API mode. No preferences are sent to the server."}>
      {!DEMO ? <p className="pw-muted">Gmail and n8n are not connected. No alerts are configured here yet.</p> : (
      <div>
        {rows.map(([k, label]) => (
          <div key={k} className="rule">
            <div className="pw-grow pw-h3">
              {label}
              {k === "email" && (
                <>
                  {" "}
                  <StatusBadge status="soon" />
                </>
              )}
            </div>
            <Toggle
              on={notif[k]}
              label={label}
              onChange={async (on) => {
                await getServices().settings.setNotification(k, on);
                toast("Saved in the demo only");
              }}
            />
          </div>
        ))}
      </div>
      )}
    </Section>
  );
}

function AutomationSection() {
  const router = useRouter();
  return (
    <Section title="Automation preferences" desc="n8n and Gmail placeholders.">
      <div>
        <StatusBadge status="soon" />
      </div>
      <div className="pw-grid pw-g2" style={{ gap: 16 }}>
        <TextField id="au-w" label="n8n webhook URL" value="" disabled placeholder="Not configured" mono />
        <TextField id="au-b" label="Gmail account" value="" disabled placeholder="Not connected" mono />
      </div>
      <div>
        <Button onClick={() => router.push("/automations")}>Open Automations</Button>
      </div>
    </Section>
  );
}
