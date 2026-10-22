"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { API_MODE, EXEC, RULES, msgPreview, type RuleKey } from "@/lib/constants";
import { machineById } from "@/lib/domain/machines";
import { getServices } from "@/lib/services";
import { useDemo, type NotifPrefs } from "@/stores/demo-store";
import { toast } from "@/stores/toast-store";
import { Icon, type IconName } from "@/components/ui/icon";
import { Banner } from "@/components/ui/banner";
import { Button, RowLink } from "@/components/ui/button";
import { Card, CardHead, StatIcon } from "@/components/ui/card";
import { Tabs, Toggle } from "@/components/ui/controls";
import { SelectField } from "@/components/ui/form";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { ViewGate } from "@/components/demo/view-gate";

type Tab = "rules" | "history" | "failed" | "prefs";
const TABS: [Tab, string][] = [
  ["rules", "Rules"],
  ["history", "Execution history"],
  ["failed", "Failed workflows"],
  ["prefs", "Notification preferences"],
];
const RULE_KEYS = Object.keys(RULES) as RuleKey[];

export function AutomationsView() {
  // API mode: the server sends the alerts (when N8N_ENABLED); the web app has no delivery records to show, so it shows none.
  if (API_MODE)
    return (
      <ViewGate machines={false}>
        {() => (
          <EmptyState tone="mute" icon="zap" title="Alert controls and delivery history are not available here yet">
            When status alerts are enabled on the monitoring server, one email is sent when a machine goes Offline and one when it is back Online. This page
            does not show delivery records yet.
          </EmptyState>
        )}
      </ViewGate>
    );
  return <ViewGate>{() => <AutomationsBody />}</ViewGate>;
}

function IntegrationCard({ icon, title, desc, action }: { icon: IconName; title: string; desc: string; action: string }) {
  return (
    <Card stack>
      <div className="pw-row pw-between pw-wrap">
        <div className="pw-row">
          <StatIcon icon={icon} />
          <h2 className="pw-h2">{title}</h2>
        </div>
        <StatusBadge status="notconn" />
      </div>
      <p className="pw-muted">{desc}</p>
      <Button disabled title="Not available in this prototype">
        {action} (Coming Soon)
      </Button>
    </Card>
  );
}

function AutomationsBody() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view = useDemo((s) => s.view);
  const tabParam = params.get("tab") as Tab | null;
  const tab: Tab = tabParam && TABS.some(([t]) => t === tabParam) ? tabParam : "rules";
  const setTab = (t: Tab) => router.replace(pathname + (t === "rules" ? "" : "?tab=" + t), { scroll: false });

  if (view === "empty")
    return (
      <EmptyState tone="mute" icon="zap" title="No automation rules">
        Rules will appear here once n8n is connected. This module is Coming Soon.
      </EmptyState>
    );

  return (
    <>
      <Banner kind="warn" icon="alert">
        <strong>Coming Soon · Not Connected Yet · Prototype UI only.</strong> No n8n workflow or Gmail connection exists. Switches change this demo only.
      </Banner>
      <div className="pw-grid pw-g2">
        <IntegrationCard icon="zap" title="n8n integration" desc="Planned: n8n runs automations when monitoring events happen. Instance URL and webhook secret are not configured." action="Connect n8n" />
        <IntegrationCard icon="mail" title="Gmail notifications" desc="Planned: one email when a machine goes Offline and one when it is back Online, with the machine name, IP, date and time (Asia/Manila). No repeats while the status stays the same. Gmail is not connected." action="Connect Gmail" />
      </div>
      <Tabs value={tab} items={TABS} onChange={setTab} label="Automation sections" />
      {tab === "rules" && <RulesTab />}
      {tab === "history" && <HistoryTab />}
      {tab === "failed" && <FailedTab />}
      {tab === "prefs" && <PrefsTab />}
    </>
  );
}

function RulesTab() {
  const auto = useDemo((s) => s.auto);
  const machines = useDemo((s) => s.machines);
  const sel = useDemo((s) => s.sel);
  const patch = useDemo((s) => s.patch);
  const pm = machineById(machines, sel) ?? machines[0];
  return (
    <div className="pw-grid pw-g-main" style={{ alignItems: "start" }}>
      <Card>
        <CardHead title="Automation rules" style={{ marginBottom: 0 }}>
          <StatusBadge status="soon" />
        </CardHead>
        {RULE_KEYS.map((k) => {
          const r = RULES[k];
          return (
            <div key={k} className="rule">
              <StatIcon icon={r.icon} tone={auto.rules[k] ? "" : "mute"} />
              <div className="pw-grow" style={{ minWidth: 0 }}>
                <div className="pw-h3">{r.title}</div>
                <div className="pw-muted" style={{ fontSize: 13 }}>
                  {r.desc}
                </div>
                <RowLink brand style={{ fontSize: 12, fontWeight: 600 }} onClick={() => patch({ auto: { ...auto, rule: k } })}>
                  Preview message
                </RowLink>
              </div>
              <Toggle
                on={auto.rules[k]}
                label={r.title + " (demo, takes effect when connected)"}
                onChange={async (on) => {
                  await getServices().automations.setRule(k, on);
                  toast(r.title + (on ? " on" : " off") + " (demo only)");
                }}
              />
            </div>
          );
        })}
        <p className="pw-small pw-muted" style={{ marginTop: 8 }}>
          Switches save only in this demo. Nothing runs until n8n exists.
        </p>
      </Card>
      <Card stack>
        <CardHead title="Message preview" style={{ margin: 0 }} />
        <div style={{ maxWidth: 340 }}>
          <SelectField id="a-rule" label="Rule" value={auto.rule} options={RULE_KEYS.map((k) => [k, RULES[k].title] as const)} onValue={(v) => patch({ auto: { ...auto, rule: v } })} />
        </div>
        <div className="tg">
          <div className="pw-small pw-muted" style={{ marginBottom: 8 }}>
            Gmail · Coming Soon
          </div>
          <div className="tg-b">{msgPreview(auto.rule, pm?.name, pm?.ip)}</div>
        </div>
        <p className="pw-small pw-muted">{RULES[auto.rule].flow}</p>
      </Card>
    </div>
  );
}

function HistoryTab() {
  const auto = useDemo((s) => s.auto);
  const patch = useDemo((s) => s.patch);
  const list = EXEC.filter((e) => auto.hf === "all" || e.result === auto.hf);
  return (
    <Card>
      <CardHead title="Execution history" />
      <div style={{ maxWidth: 240, marginBottom: 12 }}>
        <SelectField
          id="a-hf"
          label="Result"
          value={auto.hf}
          options={[
            ["all", "All results"],
            ["failed", "Failed"],
            ["skipped", "Skipped"],
          ]}
          onValue={(v) => patch({ auto: { ...auto, hf: v } })}
        />
      </div>
      {list.length ? (
        <div className="pw-tablewrap" style={{ boxShadow: "none" }}>
          <table className="pw-table">
            <caption className="sr">Data table</caption>
            <thead>
              <tr>
                <th scope="col">Workflow</th>
                <th scope="col">Result</th>
                <th scope="col">Reason</th>
                <th scope="col">When</th>
              </tr>
            </thead>
            <tbody>
              {list.map((e, i) => (
                <tr key={i}>
                  <td style={{ fontWeight: 600 }}>{e.name}</td>
                  <td className="nw">{e.result === "failed" ? <StatusBadge status="failed" /> : <StatusBadge status="paused" label="Skipped" />}</td>
                  <td className="pw-muted">{e.reason}</td>
                  <td className="nw">{e.when}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState tone="mute" icon="inbox" title="No executions match">
          Change the result filter.
        </EmptyState>
      )}
      <p className="pw-small pw-muted" style={{ marginTop: 12 }}>
        Sample rows. No workflow has ever run.
      </p>
    </Card>
  );
}

function FailedTab() {
  return (
    <Card>
      <CardHead title="Failed workflows" />
      <ul className="pw-events">
        {EXEC.filter((e) => e.result === "failed").map((e, i) => (
          <li key={i}>
            <span className="pw-ev-ic bad">
              <Icon name="x" size={16} />
            </span>
            <div className="pw-grow">
              <strong>{e.name}</strong>
              <div className="pw-muted" style={{ fontSize: 13 }}>
                {e.reason} (example failure) · {e.when}
              </div>
            </div>
            <Button size="sm" disabled title="Not connected yet">
              Retry
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function PrefsTab() {
  const notif = useDemo((s) => s.notif);
  const set = (k: keyof NotifPrefs) => async (on: boolean) => {
    await getServices().settings.setNotification(k, on);
    toast("Saved in the demo only");
  };
  const rows: [keyof NotifPrefs, string, string][] = [
    ["offline", "Notify me when a machine goes Offline", "Used by the Offline alert once connected"],
    ["recovery", "Notify me when it is back Online", "Used by the recovery notification once connected"],
    ["email", "Gmail channel", "Needs a connected Gmail account"],
    ["quiet", "Quiet hours 22:00–06:00", "Hold non-critical alerts overnight"],
  ];
  return (
    <Card stack>
      <CardHead title="Notification preferences" style={{ margin: 0 }}>
        <StatusBadge status="soon" />
      </CardHead>
      {rows.map(([k, title, desc]) => (
        <div key={k} className="rule">
          <div className="pw-grow">
            <div className="pw-h3">{title}</div>
            <div className="pw-small pw-muted">{desc}</div>
          </div>
          <Toggle on={notif[k]} label={k === "quiet" ? "Quiet hours" : title} onChange={set(k)} />
        </div>
      ))}
    </Card>
  );
}
