"use client";

/* Machine Details in API mode: the last 24 hours of recorded checks for one machine. */
import { ago, dTime, dur } from "@/lib/format";
import { historyChart, historyEvents, historyStrip } from "@/lib/domain/api-history";
import { useDemo } from "@/stores/demo-store";
import { useHistory } from "@/hooks/use-history";
import { Button, RowLink } from "@/components/ui/button";
import { Card, CardHead } from "@/components/ui/card";
import { EventList } from "@/components/ui/data-display";
import { EmptyState, Skeleton } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { LineChart } from "@/components/charts/line-chart";
import { StatusStrip } from "@/components/charts/status-strip";

export function ApiMachineHistory({ machineId, name, onOpenHistory }: { machineId: string; name: string; onOpenHistory: () => void }) {
  const machines = useDemo((s) => s.machines);
  const hist = useHistory({ range: "24", from: "", to: "", m: machineId });
  const h = hist.data?.machines.find((x) => x.machineId === machineId);

  const body = () => {
    if (!hist.data && hist.error)
      return (
        <EmptyState
          tone="bad"
          icon="alert"
          title="History could not be loaded"
          actions={
            <Button size="sm" icon="refresh" onClick={hist.reload}>
              Try again
            </Button>
          }
        >
          {hist.error.message} The status above is unaffected.
        </EmptyState>
      );
    if (!hist.data || !h)
      return (
        <div aria-busy="true" aria-label="Loading monitoring history" className="pw-stack" style={{ gap: 12 }}>
          <Skeleton style={{ height: 32 }} />
          <Skeleton style={{ height: 160 }} />
        </div>
      );
    if (!h.totals.checks)
      return (
        <EmptyState tone="mute" icon="chart" title="No checks in the last 24 hours">
          {name} has no recorded check in this period, so no status or uptime is shown. Nothing is estimated.
        </EmptyState>
      );
    const strip = historyStrip(hist.data, h, name);
    const cfg = historyChart(hist.data, machines, "24", "rt", "Average response time for " + name + ", last 24 hours");
    return (
      <>
        <div className="pw-grid pw-g3" style={{ gap: 16, marginBottom: 12 }}>
          <div>
            <div className="pw-label">Uptime 24 h</div>
            <div className="pw-kpi">{h.totals.uptimePercent === null ? "—" : h.totals.uptimePercent.toFixed(1) + "%"}</div>
            <div className="pw-small pw-muted">
              {h.totals.okChecks} of {h.totals.checks} checks reached it
            </div>
          </div>
          <div>
            <div className="pw-label">Avg response</div>
            <div className="pw-kpi">{h.totals.avgResponseMs === null ? "—" : h.totals.avgResponseMs + " ms"}</div>
          </div>
          <div>
            <div className="pw-label">Outages</div>
            <div className="pw-kpi">{h.totals.outages}</div>
            <div className="pw-small pw-muted">{h.totals.outages ? dur(Math.round(h.totals.downMinutes)) + " offline" : "None in 24 hours"}</div>
          </div>
        </div>
        <StatusStrip states={strip.states} tips={strip.tips} label={name + " status timeline, last 24 hours"} />
        {cfg && (
          <div style={{ marginTop: 12 }}>
            <LineChart id="det" cfg={cfg} />
          </div>
        )}
        {hist.error && (
          <p className="pw-small pw-muted" role="status">
            Couldn’t refresh ({hist.error.message}). Showing results from {ago(Date.parse(hist.data.generatedAt))}.
          </p>
        )}
      </>
    );
  };

  const events = hist.data ? historyEvents(hist.data) : [];
  return (
    <div className="pw-stack" style={{ gap: 24, minWidth: 0 }}>
      <Card>
        <CardHead title="Machine Status Overview" sub="Last 24 hours · Based on recorded connectivity checks" />
        {body()}
      </Card>
      <Card>
        <div className="pw-card-head">
          <h2 className="pw-h2">Recent checks</h2>
          <RowLink brand onClick={onOpenHistory}>
            Open history
          </RowLink>
        </div>
        {!h ? (
          <p className="pw-muted">{hist.error ? "Checks could not be loaded." : "Loading…"}</p>
        ) : h.recentChecks.length ? (
          <div className="pw-tablewrap">
            <table className="pw-table">
              <caption className="sr">Most recent checks for {name}</caption>
              <thead>
                <tr>
                  <th scope="col">Checked</th>
                  <th scope="col">Result</th>
                  <th scope="col">Response</th>
                </tr>
              </thead>
              <tbody>
                {h.recentChecks.slice(0, 10).map((c) => (
                  <tr key={c.startedAt}>
                    <td className="nw" title={dTime(Date.parse(c.startedAt))}>
                      {ago(Date.parse(c.startedAt))}
                    </td>
                    <td className="nw">
                      <StatusBadge status={c.ok ? "reachable" : "unreachable"} />
                    </td>
                    <td className="nw pw-muted">{c.ok ? (c.httpCode ? "HTTP " + c.httpCode + " · " : "") + (c.durationMs ?? "—") + " ms" : "No answer"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="pw-muted">No checks recorded in the last 24 hours.</p>
        )}
      </Card>
      <Card>
        <CardHead title="Status changes" sub="Last 24 hours" />
        {hist.data ? (
          events.length ? (
            <EventList events={events} machines={machines} n={5} />
          ) : (
            <p className="pw-muted">No change between Online and Offline in the last 24 hours.</p>
          )
        ) : (
          <p className="pw-muted">{hist.error ? "Status changes could not be loaded." : "Loading…"}</p>
        )}
      </Card>
    </div>
  );
}
