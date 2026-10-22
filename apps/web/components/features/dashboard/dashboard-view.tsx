"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import type { HistoryResponse } from "@pisowifi/shared";
import { API_MODE, RANGES, REMOTE_MODE } from "@/lib/constants";
import { ago } from "@/lib/format";
import { chartCfg } from "@/lib/mock/history";
import { allEvents } from "@/lib/domain/history";
import { historyChart, historyEvents, historySummary } from "@/lib/domain/api-history";
import { machineById } from "@/lib/domain/machines";
import { useHistory } from "@/hooks/use-history";
import { Skeleton } from "@/components/ui/states";
import { machineCounts, unreachableMachines } from "@/lib/domain/machines";
import { measuredUptime } from "@/lib/domain/reports";
import type { Machine } from "@/lib/types";
import { useDemo } from "@/stores/demo-store";
import { useRunCheck } from "@/hooks/use-run-check";
import { Banner } from "@/components/ui/banner";
import { Button, RowLink } from "@/components/ui/button";
import { Card, CardHead, KpiCard } from "@/components/ui/card";
import { Segmented } from "@/components/ui/controls";
import { EventList } from "@/components/ui/data-display";
import { EmptyState } from "@/components/ui/states";
import { ConnectivityBadge } from "@/components/ui/status-badge";
import { ViewGate } from "@/components/demo/view-gate";
import { LineChart } from "@/components/charts/line-chart";
import { ChartLegend } from "@/components/charts/chart-legend";
import { useCanManageMachines, useMachineNav } from "@/components/features/machines/machine-bits";

export function DashboardView() {
  const nav = useMachineNav();
  const canManage = useCanManageMachines();
  const empty = useDemo((s) => s.view === "empty" || !s.machines.length);
  const addBtn = empty || !canManage ? undefined : (
    <Button variant="primary" icon="plus" onClick={nav.add}>
      Add machine
    </Button>
  );
  return (
    <ViewGate kpi actions={addBtn}>
      {() => <DashboardBody />}
    </ViewGate>
  );
}

function DashboardBody() {
  const router = useRouter();
  const nav = useMachineNav();
  const canManage = useCanManageMachines();
  const machines = useDemo((s) => s.machines);
  const extraEvents = useDemo((s) => s.extraEvents);
  const dashRange = useDemo((s) => s.dashRange);
  const view = useDemo((s) => s.view);
  const patch = useDemo((s) => s.patch);
  const check = useRunCheck();
  // API mode: recorded history for the overview chart and the recent status changes.
  const hist = useHistory({ range: dashRange, from: "", to: "", m: "all" }, { enabled: API_MODE });

  if (view === "empty" || !machines.length)
    return (
      <EmptyState
        icon="server"
        title="No machines yet"
        actions={
          canManage ? (
            <Button variant="primary" icon="plus" onClick={nav.add}>
              Add machine
            </Button>
          ) : undefined
        }
      >
        {canManage ? "Add your first PisoWiFi to start building the overview." : "An admin can add machines to this workspace."}
      </EmptyState>
    );

  const c = machineCounts(machines);
  const cfg = API_MODE
    ? hist.data && historyChart(hist.data, machines, dashRange, "up", "Uptime per machine from recorded checks")
    : chartCfg(machines, machines.map((m) => m.id), dashRange, "up", "Uptime chart per machine");
  const unreach = unreachableMachines(machines);
  const uptime = API_MODE ? apiUptime(hist.data, machines) : measuredUptime(machines, dashRange);
  const recent = API_MODE ? (hist.data ? historyEvents(hist.data) : []) : allEvents(machines, extraEvents);
  const unchecked = API_MODE ? (hist.data?.machines.filter((m) => m.totals.checks === 0).length ?? 0) : machines.filter((m) => !m.hist).length;

  return (
    <>
      {unreach.length > 0 && (
        <Banner kind="bad" icon="x">
          <strong>
            {unreach.map((m) => m.name).join(", ")}
            {unreach.length > 1 ? " are" : " is"} offline.
          </strong>{" "}
          The last valid check got no answer.{" "}
          <RowLink brand onClick={() => nav.openDetail(unreach[0].id)}>
            View details
          </RowLink>
        </Banner>
      )}

      {/* Summary: two statuses only */}
      <div className="pw-grid pw-g3" style={{ gap: 16 }}>
        <KpiCard icon="server" label="Total machines" value={c.tot} sub={"Registered" + (c.none ? " · " + c.none + " without a check yet" : "")} />
        <KpiCard icon="check" tone="ok" label="Online" value={c.ok} sub="Last check reached the machine" />
        <KpiCard icon="x" tone="bad" label="Offline" value={c.bad} sub={c.bad ? "Needs attention" : "None right now"} />
      </div>

      <div className="pw-grid pw-g-main">
        <div className="pw-stack" style={{ gap: 24, minWidth: 0 }}>
          {/* Machine Uptime (original chart) */}
          <Card>
            <CardHead title="Machine Uptime" sub="Measured uptime for each PisoWiFi machine · Hover or tap the chart for details">
              <Segmented value={dashRange} items={RANGES} onChange={(v) => patch({ dashRange: v })} label="Range" />
            </CardHead>
            <div className="pw-grid pw-g3" style={{ gap: 16, marginBottom: 12 }}>
              <div>
                <div className="pw-label">Measured uptime</div>
                <div className="pw-kpi">{uptime.value}</div>
                <div className="pw-small pw-muted">{uptime.perMachine.length ? (dashRange === "24" ? "Last 24 hours" : "Last " + dashRange + " days") : "Not enough checks yet"}</div>
              </div>
              {uptime.perMachine.slice(0, 2).map(({ m, up }) => (
                <div key={m.id}>
                  <div className="pw-label">{m.name}</div>
                  <div className="pw-kpi">{up.toFixed(1)}%</div>
                </div>
              ))}
              {unchecked > 0 && (
                <div>
                  <div className="pw-label">{API_MODE ? "Not checked in range" : "New machines"}</div>
                  <div className="pw-kpi pw-muted">{API_MODE ? unchecked : "—"}</div>
                  <div className="pw-small pw-muted">{API_MODE ? "No valid check recorded" : "Not enough checks yet"}</div>
                </div>
              )}
            </div>
            {cfg ? (
              <>
                <LineChart id="dash" cfg={cfg} />
                <ChartLegend id="dash" series={cfg.series} />
              </>
            ) : API_MODE && !hist.data && hist.error ? (
              <EmptyState tone="bad" icon="alert" title="History could not be loaded" actions={<Button size="sm" icon="refresh" onClick={hist.reload}>Try again</Button>}>
                {hist.error.message} Machine statuses above are unaffected.
              </EmptyState>
            ) : API_MODE && !hist.data ? (
              <div aria-busy="true" aria-label="Loading uptime history">
                <Skeleton style={{ height: 180 }} />
              </div>
            ) : (
              <EmptyState tone="mute" icon="chart" title="No uptime history yet">
                The chart appears once checks have been recorded. Nothing is estimated.
              </EmptyState>
            )}
            {API_MODE && hist.data && hist.error && (
              <p className="pw-small pw-muted" role="status">
                Couldn’t refresh the chart ({hist.error.message}). Showing results from {ago(Date.parse(hist.data.generatedAt))}.
              </p>
            )}
          </Card>

          {/* Quick machines */}
          <Card>
            <div className="pw-card-head">
              <h2 className="pw-h2">Quick machines</h2>
              <Link href="/machines" className="rowlink" style={{ color: "var(--brand)" }}>
                View all
              </Link>
            </div>
            <div className="pw-grid g-auto" style={{ gap: 16 }}>
              {machines.slice(0, 4).map((m) => (
                <QuickMachineCard key={m.id} m={m} />
              ))}
            </div>
          </Card>
        </div>

        <div className="pw-stack" style={{ gap: 24, minWidth: 0 }}>
          <Card>
            <CardHead title={API_MODE ? "Recent status changes" : "Recent events"} />
            {API_MODE && !hist.data ? (
              <p className="pw-muted">{hist.error ? "Status changes could not be loaded." : "Loading…"}</p>
            ) : API_MODE && !recent.length ? (
              <p className="pw-muted">No machine changed between Online and Offline in this range.</p>
            ) : (
              <EventList events={recent} machines={machines} n={5} />
            )}
            <div style={{ marginTop: 12 }}>
              <Button size="sm" onClick={() => router.push("/history")}>
                Open history
              </Button>
            </div>
          </Card>
          <Card>
            <h2 className="pw-h2" style={{ marginBottom: 12 }}>
              Quick actions
            </h2>
            <div className="pw-stack" style={{ gap: 8 }}>
              {canManage && (
                <Button variant="primary" block icon="plus" onClick={nav.add}>
                  Add machine
                </Button>
              )}
              {/* API mode: the cloud monitoring worker checks every machine once a minute. */}
              {!API_MODE && (
                <Button
                  block
                  icon="refresh"
                  loading={check.busy}
                  loadingText="Checking…"
                  onClick={() => check.run(machines.map((m) => m.id), "Demo checks done. No requests were sent.")}
                >
                  Run check now (demo)
                </Button>
              )}
              {REMOTE_MODE !== "disabled" && (
                <Button block icon="shield" onClick={() => router.push("/remote")}>
                  Open Remote Administration
                </Button>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function QuickMachineCard({ m }: { m: Machine }) {
  const nav = useMachineNav();
  return (
    <div className="pw-card flat pw-stack" style={{ gap: 12 }}>
      <div className="pw-row pw-between" style={{ alignItems: "flex-start" }}>
        <div style={{ minWidth: 0 }}>
          <div className="pw-h3">{m.name}</div>
          <div className="pw-small pw-muted">{m.loc || "No location"}</div>
        </div>
        <ConnectivityBadge status={m.status} />
      </div>
      <div className="pw-mono pw-muted" style={{ overflowWrap: "anywhere" }}>
        {m.ip}
        {m.path}
      </div>
      <div className="pw-small pw-muted">
        Last checked {ago(m.checkedAt)} · last reachable {ago(m.okAt)}
      </div>
      <div className="pw-row pw-wrap" style={{ gap: 8 }}>
        <Button size="sm" icon="pulse" onClick={() => nav.openDetail(m.id)}>
          Details
        </Button>
        {REMOTE_MODE !== "disabled" && (
          <Button size="sm" icon="shield" onClick={() => nav.openRemote(m.id)}>
            Remote admin
          </Button>
        )}
      </div>
    </div>
  );
}

/** Overview figures from recorded checks: measured uptime overall and per checked machine. */
function apiUptime(data: HistoryResponse | null, machines: Machine[]) {
  const per = (data?.machines ?? []).flatMap((h) => {
    const m = machineById(machines, h.machineId);
    return m && h.totals.uptimePercent !== null ? [{ m, up: h.totals.uptimePercent }] : [];
  });
  const total = data ? historySummary(data).uptime : null;
  return { value: total === null ? "—" : total.toFixed(1) + "%", sub: "", perMachine: per };
}
