"use client";

/* Monitoring history in API mode: recorded checks, status changes and outages only. Slots without a valid check
   are "Not checked" (neutral); nothing is sampled, estimated or filled in. */
import { EVLABEL } from "@/lib/constants";
import { ago, dTime, dur } from "@/lib/format";
import { DEFAULT_HIST, paginate } from "@/lib/domain/history";
import { checkedMachines, historyChart, historyEvents, historyStrip, historySummary } from "@/lib/domain/api-history";
import { machineName } from "@/lib/domain/machines";
import { useDemo } from "@/stores/demo-store";
import { useHistory, type HistoryState } from "@/hooks/use-history";
import { Icon } from "@/components/ui/icon";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card, CardHead, KpiCard } from "@/components/ui/card";
import { EmptyState, PageSkeleton } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { ViewGate } from "@/components/demo/view-gate";
import { LineChart } from "@/components/charts/line-chart";
import { ChartLegend } from "@/components/charts/chart-legend";
import { StatusStrip } from "@/components/charts/status-strip";
import { HistoryFilters } from "@/components/features/history/history-filters";

export function ApiHistoryView() {
  const H = useDemo((s) => s.hist);
  const hist = useHistory(H);
  return (
    <ViewGate kpi>
      {() => <ApiHistoryBody hist={hist} />}
    </ViewGate>
  );
}

function ApiHistoryBody({ hist }: { hist: HistoryState }) {
  const machines = useDemo((s) => s.machines);
  const H = useDemo((s) => s.hist);
  const reset = () => useDemo.getState().patch({ hist: DEFAULT_HIST });
  const { data, error } = hist;
  const filters = <HistoryFilters />;

  if (!machines.length)
    return (
      <EmptyState tone="mute" icon="history" title="No machines yet">
        History appears once a machine is registered and monitored.
      </EmptyState>
    );
  if (!data && error)
    return (
      <>
        {filters}
        <EmptyState
          tone="bad"
          icon="alert"
          title="History could not be loaded"
          actions={
            <Button icon="refresh" onClick={hist.reload}>
              Try again
            </Button>
          }
        >
          {error.message} No statuses were changed.
        </EmptyState>
      </>
    );
  if (!data)
    return (
      <>
        {filters}
        <PageSkeleton kpi />
      </>
    );

  const sum = historySummary(data);
  const checked = checkedMachines(data);
  const events = historyEvents(data).filter((e) => H.status === "all" || e.st === H.status);
  const { pages, page: pg, slice } = paginate(events, H.page);
  const cfgU = historyChart(data, machines, H.range, "up", "Uptime per machine from recorded checks");
  const cfgR = historyChart(data, machines, H.range, "rt", "Average response time per machine from recorded checks");
  const stale = error ? (
    <Banner kind="warn" icon="alert">
      Couldn’t refresh history: {error.message} Showing results loaded {ago(Date.parse(data.generatedAt))}.
    </Banner>
  ) : null;
  const updated = (
    <span className="pw-small pw-muted" aria-live="polite">
      Updated {ago(Date.parse(data.generatedAt))} · refreshes every minute
    </span>
  );

  if (!checked.length)
    return (
      <>
        {filters}
        {stale}
        <EmptyState tone="mute" icon="history" title="No checks in this range" actions={<Button onClick={reset}>Reset filters</Button>}>
          {H.m !== "all" ? machineName(machines, H.m) + " has" : "The selected machines have"} no recorded checks in this range. History appears once monitoring records results.
        </EmptyState>
      </>
    );

  return (
    <>
      {filters}
      {stale}
      <div className="pw-grid pw-g4" style={{ gap: 16 }}>
        <KpiCard icon="check" tone="ok" label="Last successful check" value={sum.lastSuccessAt ? ago(sum.lastSuccessAt) : "Never"} sub="Latest across selection" />
        <KpiCard icon="clock" label="Average response" value={sum.avgResponseMs === null ? "—" : sum.avgResponseMs + " ms"} sub="Checks that reached the machine" />
        <KpiCard icon="x" tone="bad" label="Total downtime" value={dur(Math.round(sum.downMinutes))} sub={sum.outages + " outage" + (sum.outages === 1 ? "" : "s") + " in range"} />
        <KpiCard icon="pulse" label="Uptime" value={sum.uptime === null ? "—" : sum.uptime.toFixed(1) + "%"} sub={sum.ok + " of " + sum.checks + " checks reached the machine"} />
      </div>

      <div className="pw-grid pw-g-main">
        <div className="pw-stack" style={{ gap: 24, minWidth: 0 }}>
          <Card>
            <CardHead title="Timeline">{updated}</CardHead>
            {data.machines.map((m) => {
              const name = machineName(machines, m.machineId);
              const strip = historyStrip(data, m, name);
              return (
                <div key={m.machineId} style={{ marginBottom: 10 }}>
                  <div className="pw-small pw-muted" style={{ marginBottom: 4 }}>
                    {name}
                    {m.totals.checks === 0 && " · no checks in this range"}
                  </div>
                  <StatusStrip states={strip.states} tips={strip.tips} label={name + " status timeline"} />
                </div>
              );
            })}
            <div className="pw-legend">
              <span>
                <i className="sq" style={{ background: "var(--success)" }} />
                Online
              </span>
              <span>
                <i className="sq" style={{ background: "var(--danger)" }} />
                Offline
              </span>
              <span>
                <i className="sq" style={{ background: "var(--neutral-soft)" }} />
                Not checked
              </span>
            </div>
          </Card>
          <Card>
            <CardHead title="Uptime" />
            {cfgU ? (
              <>
                <LineChart id="hu" cfg={cfgU} />
                <ChartLegend id="hu" series={cfgU.series} />
              </>
            ) : (
              <p className="pw-muted">No valid checks in this range.</p>
            )}
          </Card>
          <Card>
            <CardHead title="Average response time" />
            {cfgR ? (
              <>
                <LineChart id="hr" cfg={cfgR} />
                <ChartLegend id="hr" series={cfgR.series} />
              </>
            ) : (
              <p className="pw-muted">No check reached a machine in this range.</p>
            )}
          </Card>
        </div>
        <Card style={{ alignSelf: "start" }}>
          <CardHead title="Recent outages" />
          {data.outages.length ? (
            <ul className="pw-events">
              {data.outages.slice(0, 6).map((o) => (
                <li key={o.machineId + o.startedAt}>
                  <span className="pw-ev-ic bad">
                    <Icon name="x" size={16} />
                  </span>
                  <div className="pw-grow">
                    <strong>{machineName(machines, o.machineId)}</strong>
                    <div className="pw-muted" style={{ fontSize: 13 }}>
                      {dTime(Date.parse(o.startedAt))} · {o.endedAt ? dur(Math.max(1, Math.round(o.durationMinutes))) : "ongoing, " + dur(Math.max(1, Math.round(o.durationMinutes))) + " so far"}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="pw-muted">No outages in this range.</p>
          )}
        </Card>
      </div>

      <div>
        <h2 className="pw-h2" style={{ marginBottom: 12 }}>
          Status changes
        </h2>
        {events.length ? (
          <>
            <div className="t-md">
              <div className="pw-tablewrap">
                <table className="pw-table">
                  <caption className="sr">Status changes</caption>
                  <thead>
                    <tr>
                      <th scope="col">Status</th>
                      <th scope="col">Machine</th>
                      <th scope="col">Details</th>
                      <th scope="col">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slice.map((e, i) => (
                      <tr key={e.t + e.m + i}>
                        <td className="nw">
                          <StatusBadge status={e.st} label={EVLABEL[e.type]} />
                        </td>
                        <td className="nw" style={{ fontWeight: 600 }}>
                          {machineName(machines, e.m)}
                        </td>
                        <td className="pw-muted">{e.msg}</td>
                        <td className="nw">{dTime(e.t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div className="c-md cardlist">
              {slice.map((e, i) => (
                <div key={e.t + e.m + i} className="pw-card flat pw-stack" style={{ gap: 6 }}>
                  <div className="pw-row pw-between pw-wrap">
                    <StatusBadge status={e.st} label={EVLABEL[e.type]} />
                    <span className="pw-small pw-muted">{dTime(e.t)}</span>
                  </div>
                  <div style={{ fontWeight: 600 }}>{machineName(machines, e.m)}</div>
                  <div className="pw-muted" style={{ fontSize: 13 }}>
                    {e.msg}
                  </div>
                </div>
              ))}
            </div>
            <div className="pager">
              <span className="pw-small pw-muted" aria-live="polite">
                {events.length} status change{events.length === 1 ? "" : "s"} · page {pg + 1} of {pages}
              </span>
              <div className="pw-row">
                <Button size="sm" disabled={pg === 0} onClick={() => useDemo.getState().patch({ hist: { ...H, page: Math.max(0, pg - 1) } })}>
                  Previous
                </Button>
                <Button size="sm" disabled={pg >= pages - 1} onClick={() => useDemo.getState().patch({ hist: { ...H, page: pg + 1 } })}>
                  Next
                </Button>
              </div>
            </div>
          </>
        ) : (
          <EmptyState tone="mute" icon="check" title="No status changes" actions={H.status !== "all" ? <Button onClick={reset}>Reset filters</Button> : undefined}>
            {H.status === "all" ? "No machine changed between Online and Offline in this range." : "No status changes match this filter."}
          </EmptyState>
        )}
      </div>
    </>
  );
}
