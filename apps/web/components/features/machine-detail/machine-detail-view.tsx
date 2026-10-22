"use client";

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { API_MODE, DEMO_MODE, REMOTE_MODE, STATUS_LABEL } from "@/lib/constants";
import { ago } from "@/lib/format";
import { chartCfg, points, summarize } from "@/lib/mock/history";
import type { MachineStatus } from "@/lib/types";
import { allEvents } from "@/lib/domain/history";
import { machineById } from "@/lib/domain/machines";
import { getServices } from "@/lib/services";
import { useDemo } from "@/stores/demo-store";
import { useRunCheck } from "@/hooks/use-run-check";
import { toast } from "@/stores/toast-store";
import { Banner } from "@/components/ui/banner";
import { Button, RowLink } from "@/components/ui/button";
import { Card, CardHead, StatIcon } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { SelectField } from "@/components/ui/form";
import { EventList, KeyValueList } from "@/components/ui/data-display";
import { EmptyState } from "@/components/ui/states";
import { ConnectivityBadge, StatusBadge } from "@/components/ui/status-badge";
import { ViewGate } from "@/components/demo/view-gate";
import { LineChart } from "@/components/charts/line-chart";
import { useCanManageMachines, useMachineNav } from "@/components/features/machines/machine-bits";
import { ApiMachineHistory } from "@/components/features/machine-detail/api-machine-history";

/** Demo only. "Monitoring failure" shows that a failed check run never changes the machine's status. */
const SIM_STATES: [MachineStatus | "none" | "monitor", string][] = [
  ["reachable", "Online"],
  ["unreachable", "Offline"],
  ["none", "— (no valid check yet)"],
  ["monitor", "Monitoring failure (status kept)"],
];

export function MachineDetailView() {
  return <ViewGate kpi>{() => <DetailBody />}</ViewGate>;
}

function DetailBody() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const nav = useMachineNav();
  const canManage = useCanManageMachines();
  const machines = useDemo((s) => s.machines);
  const extraEvents = useDemo((s) => s.extraEvents);
  const view = useDemo((s) => s.view);
  const check = useRunCheck();
  const m = machineById(machines, id);

  useEffect(() => {
    if (m) useDemo.getState().selectMachine(m.id);
  }, [m]);

  if (!m || view === "empty")
    return (
      <EmptyState
        icon="server"
        title="No machine selected"
        actions={
          <>
            {canManage && (
              <Button variant="primary" icon="plus" onClick={nav.add}>
                Add machine
              </Button>
            )}
            <Button onClick={() => router.push("/machines")}>Go to My PisoWiFi</Button>
          </>
        }
      >
        Add a machine, or pick one from My PisoWiFi.
      </EmptyState>
    );

  const ev = allEvents(machines, extraEvents).filter((e) => e.m === m.id);
  const cfg = m.hist ? chartCfg(machines, [m.id], "14", "rt", "Response time for " + m.name) : null;
  const s = m.hist ? summarize(points(m.id, "14")) : null;

  return (
    <>
      <div className="pw-row pw-wrap" style={{ alignItems: "flex-end", gap: 12 }}>
        <div style={{ minWidth: 220, flex: 1, maxWidth: 340 }}>
          <SelectField
            id="d-m"
            label="Machine"
            value={m.id}
            options={machines.map((x) => [x.id, x.name] as const)}
            onValue={(v) => {
              useDemo.getState().selectMachine(v);
              router.replace("/machines/" + v);
            }}
          />
        </div>
        {DEMO_MODE && !API_MODE && (
          <div style={{ minWidth: 220, flex: 1, maxWidth: 340 }}>
            <SelectField
              id="d-sim"
              label="Simulate state (demo)"
              value={m.status ?? "none"}
              options={SIM_STATES}
              help="Changes demo data only."
              onValue={async (v) => {
                if (v === "monitor") return toast("Demo: the check couldn’t run (monitoring issue), so " + m.name + " keeps its last result.");
                await getServices().machines.simulateStatus(m.id, v === "none" ? null : v);
                toast(m.name + (v === "none" ? " has no check result yet" : " set to " + STATUS_LABEL[v]) + " (demo)");
              }}
            />
          </div>
        )}
      </div>

      {m.status === "unreachable" && (
        <Banner kind="bad" icon="x">
          <strong>{m.name} is offline.</strong> The last valid check {ago(m.checkedAt)} got no answer from its admin page.
        </Banner>
      )}
      {!API_MODE && (
        <Banner kind="info" icon="info">
          Online means the machine’s admin page answered a check. It doesn’t prove that customers have internet.
        </Banner>
      )}

      {/* Overview */}
      <Card>
        <div className="pw-row pw-between pw-wrap" style={{ gap: 16 }}>
          <div className="pw-row" style={{ gap: 14, minWidth: 0 }}>
            <StatIcon icon="wifi" size={26} style={{ width: 52, height: 52, borderRadius: "var(--radius-lg)" }} />
            <div style={{ minWidth: 0 }}>
              <h2 className="pw-h2">{m.name}</h2>
              <div className="pw-muted" style={{ overflowWrap: "anywhere" }}>
                {m.loc || "No location"} · {m.sw} {m.ver || "(version unknown)"}
              </div>
            </div>
          </div>
          <div className="pw-row pw-wrap">
            {canManage && (
              <Button icon="edit" onClick={() => nav.edit(m.id)}>
                Edit machine
              </Button>
            )}
            {REMOTE_MODE !== "disabled" && (
              <Button variant="primary" icon="shield" onClick={() => nav.openRemote(m.id)}>
                Remote admin
              </Button>
            )}
          </div>
        </div>
        <KeyValueList
          wide
          rows={[
            ["Device ID", m.did || "demo-" + m.id, true],
            ["ZeroTier IP", m.ip, true],
            ["Admin path", m.path, true],
            ["Status", <ConnectivityBadge key="s" status={m.status} />],
            ["Last checked", ago(m.checkedAt)],
            ["Last online", ago(m.okAt)],
            ["Monitoring", m.monitor ? "On" : "Paused"],
          ]}
        />
      </Card>

      <div className="pw-grid pw-g-main">
        {API_MODE ? (
          <ApiMachineHistory machineId={m.id} name={m.name} onOpenHistory={() => nav.openHistory(m.id)} />
        ) : (
        <div className="pw-stack" style={{ gap: 24, minWidth: 0 }}>
          <Card>
            <CardHead title="Machine Status Overview" />
            {cfg && s ? (
              <>
                <div className="pw-grid pw-g3" style={{ gap: 16, marginBottom: 12 }}>
                  <div>
                    <div className="pw-label">Uptime 14 d</div>
                    <div className="pw-kpi">{s.up.toFixed(1)}%</div>
                  </div>
                  <div>
                    <div className="pw-label">Avg response</div>
                    <div className="pw-kpi">{Math.round(s.rt)} ms</div>
                  </div>
                  <div>
                    <div className="pw-label">Outages</div>
                    <div className="pw-kpi">{s.outs}</div>
                  </div>
                </div>
                <LineChart id="det" cfg={cfg} />
              </>
            ) : (
              <EmptyState tone="mute" icon="chart" title="Not enough checks">
                This machine has no history yet. <StatusBadge status="nodata" />
              </EmptyState>
            )}
          </Card>
          <Card>
            <div className="pw-card-head">
              <h2 className="pw-h2">Recent events</h2>
              <RowLink brand onClick={() => nav.openHistory(m.id)}>
                Open history
              </RowLink>
            </div>
            <EventList events={ev} machines={machines} n={5} />
          </Card>
        </div>
        )}

        <div className="pw-stack" style={{ gap: 24, minWidth: 0 }}>
          <Card>
            <h2 className="pw-h2" style={{ marginBottom: 12 }}>
              Machine actions
            </h2>
            <div className="pw-stack" style={{ gap: 8 }}>
              {REMOTE_MODE !== "disabled" && (
                <Button variant="primary" block icon="shield" onClick={() => nav.openRemote(m.id)}>
                  Open Remote Administration
                </Button>
              )}
              {/* API mode: the cloud monitoring worker checks this machine once a minute. */}
              {!API_MODE && (
                <Button
                  block
                  icon="refresh"
                  loading={check.busy}
                  loadingText="Checking…"
                  onClick={() => check.run([m.id], "Demo check done. No request was sent.")}
                >
                  Run check now (demo)
                </Button>
              )}
              {canManage && (
                <Button
                  block
                  icon={m.monitor ? "pause" : "play"}
                  onClick={async () => {
                    try {
                      const on = await getServices().machines.toggleMonitoring(m.id);
                      toast("Monitoring " + (on ? "resumed" : "paused") + (API_MODE ? "" : " (demo)"));
                    } catch (err) {
                      toast(err instanceof Error ? err.message : "Could not change monitoring");
                    }
                  }}
                >
                  {m.monitor ? "Pause monitoring" : "Resume monitoring"}
                </Button>
              )}
              {canManage && (
                <>
                  <Button block icon="edit" onClick={() => nav.edit(m.id)}>
                    Edit machine
                  </Button>
                  <Button variant="danger-outline" block icon="trash" onClick={() => nav.del(m.id)}>
                    Delete machine
                  </Button>
                </>
              )}
            </div>
          </Card>
          <Card>
            <h2 className="pw-h2" style={{ marginBottom: 12 }}>
              Status Legend
            </h2>
            <div className="pw-stack" style={{ gap: 10, alignItems: "flex-start" }}>
              <div>
                <StatusBadge status="reachable" />
                <div className="pw-small pw-muted" style={{ marginTop: 4 }}>The machine was successfully reached during the latest valid connectivity check.</div>
              </div>
              <div>
                <StatusBadge status="unreachable" />
                <div className="pw-small pw-muted" style={{ marginTop: 4 }}>The latest valid connectivity check confirmed the machine was unreachable.</div>
              </div>
              <div className="pw-small pw-muted pw-row" style={{ gap: 6, alignItems: "flex-start" }}>
                <span style={{ flex: "none", display: "inline-flex", marginTop: 4 }}>
                  <Icon name="info" size={14} />
                </span>
                <span>If a monitoring check fails internally, the last confirmed status remains unchanged until another valid check completes.</span>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
