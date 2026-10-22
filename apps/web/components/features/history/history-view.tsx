"use client";

import { API_MODE, EVLABEL } from "@/lib/constants";
import { ago, dTime, dur } from "@/lib/format";
import { chartCfg } from "@/lib/mock/history";
import {
  DEFAULT_HIST,
  allEvents,
  filterEvents,
  histWindow,
  historyIds,
  historyTotals,
  lastSuccessfulCheck,
  outagesInWindow,
  paginate,
  timeline,
} from "@/lib/domain/history";
import { machineById, machineName } from "@/lib/domain/machines";
import { useDemo } from "@/stores/demo-store";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Card, CardHead, KpiCard } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { ViewGate } from "@/components/demo/view-gate";
import { LineChart } from "@/components/charts/line-chart";
import { ChartLegend } from "@/components/charts/chart-legend";
import { StatusStrip } from "@/components/charts/status-strip";
import { ApiHistoryView } from "@/components/features/history/api-history-view";
import { HistoryFilters } from "@/components/features/history/history-filters";

export function HistoryView() {
  if (API_MODE) return <ApiHistoryView />;
  return <SampleHistoryView />;
}

function SampleHistoryView() {
  return <ViewGate kpi>{() => <HistoryBody />}</ViewGate>;
}

function HistoryBody() {
  const machines = useDemo((s) => s.machines);
  const extraEvents = useDemo((s) => s.extraEvents);
  const view = useDemo((s) => s.view);
  const H = useDemo((s) => s.hist);
  const reset = () => useDemo.getState().patch({ hist: DEFAULT_HIST });

  const win = histWindow(H);
  const ids = historyIds(machines, H.m);
  const one = H.m !== "all" ? machineById(machines, H.m) : null;
  const nohist = (one && !one.hist) || !ids.length || view === "empty";

  const filters = <HistoryFilters />;

  if (nohist)
    return (
      <>
        {filters}
        <EmptyState tone="mute" icon="history" title="No history yet" actions={<Button onClick={reset}>Reset filters</Button>}>
          {one && !one.hist ? one.name + " has no checks yet. History appears once monitoring runs." : "No sample history to show for this filter."}
        </EmptyState>
      </>
    );

  const cfgU = chartCfg(machines, ids, H.range, "up", "Sample uptime chart", win.from, win.to)!;
  const cfgR = chartCfg(machines, ids, H.range, "rt", "Sample response time chart", win.from, win.to)!;
  const tot = historyTotals(ids, H, win);
  const all = allEvents(machines, extraEvents);
  const evs = filterEvents(all, H, win);
  const outs = outagesInWindow(all, ids, win);
  const lastOk = lastSuccessfulCheck(machines, ids);
  const { pages, page: pg, slice } = paginate(evs, H.page);

  return (
    <>
      {filters}
      <div className="pw-grid pw-g4" style={{ gap: 16 }}>
        <KpiCard icon="check" tone="ok" label="Last successful check" value={ago(lastOk)} sub="Latest across selection · demo" />
        <KpiCard icon="clock" label="Average response" value={Math.round(tot.rt) + " ms"} sub="Sample" />
        <KpiCard icon="x" tone="bad" label="Total downtime" value={dur(tot.down)} sub={outs.length + " outage" + (outs.length === 1 ? "" : "s") + " in range"} />
        <KpiCard icon="pulse" label="Uptime" value={tot.up.toFixed(1) + "%"} sub="Sample" />
      </div>

      <div className="pw-grid pw-g-main">
        <div className="pw-stack" style={{ gap: 24, minWidth: 0 }}>
          <Card>
            <CardHead title="Timeline">
              <StatusBadge status="sample" />
            </CardHead>
            {ids.map((id) => (
              <TimelineRow key={id} id={id} name={machineName(machines, id)} a={win.a} b={win.b} />
            ))}
            <div className="pw-legend">
              <span>
                <i className="sq" style={{ background: "var(--success)" }} />
                Online
              </span>
              <span>
                <i className="sq" style={{ background: "var(--danger)" }} />
                Offline
              </span>
            </div>
          </Card>
          <Card>
            <CardHead title="Uptime">
              <StatusBadge status="sample" />
            </CardHead>
            <LineChart id="hu" cfg={cfgU} />
            <ChartLegend id="hu" series={cfgU.series} />
          </Card>
          <Card>
            <CardHead title="Average response time">
              <StatusBadge status="sample" />
            </CardHead>
            <LineChart id="hr" cfg={cfgR} />
            <ChartLegend id="hr" series={cfgR.series} />
          </Card>
        </div>
        <Card style={{ alignSelf: "start" }}>
          <CardHead title="Recent outages">
            <StatusBadge status="sample" />
          </CardHead>
          {outs.length ? (
            <ul className="pw-events">
              {outs.slice(0, 6).map((e, i) => (
                <li key={e.t + e.m + i}>
                  <span className="pw-ev-ic bad">
                    <Icon name="x" size={16} />
                  </span>
                  <div className="pw-grow">
                    <strong>{machineName(machines, e.m)}</strong>
                    <div className="pw-muted" style={{ fontSize: 13 }}>
                      {dTime(e.t)} · {dur(e.dur || 5)}
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
          Event log
        </h2>
        {evs.length ? (
          <>
            <div className="t-md">
              <div className="pw-tablewrap">
                <table className="pw-table">
                  <caption className="sr">Data table</caption>
                  <thead>
                    <tr>
                      <th scope="col">Event</th>
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
                {evs.length} events · page {pg + 1} of {pages}
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
          <EmptyState tone="mute" icon="search" title="No events match" actions={<Button onClick={reset}>Reset filters</Button>}>
            Try a wider date range or other filters.
          </EmptyState>
        )}
      </div>
    </>
  );
}

/** 48-bucket status strip for one machine across the window. */
function TimelineRow({ id, name, a, b }: { id: string; name: string; a: number; b: number }) {
  const { states, tips } = timeline(id, name, a, b);
  return (
    <div style={{ marginBottom: 10 }}>
      <div className="pw-small pw-muted" style={{ marginBottom: 4 }}>
        {name}
      </div>
      <StatusStrip states={states} tips={tips} />
    </div>
  );
}
