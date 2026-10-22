"use client";

import { useRouter } from "next/navigation";
import { API_MODE } from "@/lib/constants";
import { dur } from "@/lib/format";
import { chartCfg } from "@/lib/mock/history";
import { machineName } from "@/lib/domain/machines";
import { nextSort, outageGroups, periodDays, periodSummary, reliabilityRows, summaryText, type ReportSort } from "@/lib/domain/reports";
import { useDemo } from "@/stores/demo-store";
import { copyText } from "@/stores/toast-store";
import { Icon, type IconName } from "@/components/ui/icon";
import { DemoBanner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import { Card, CardHead, StatIcon } from "@/components/ui/card";
import { Segmented } from "@/components/ui/controls";
import { KeyValueList } from "@/components/ui/data-display";
import { EmptyState } from "@/components/ui/states";
import { StatusBadge } from "@/components/ui/status-badge";
import { ViewGate } from "@/components/demo/view-gate";
import { LineChart } from "@/components/charts/line-chart";
import { BarChart } from "@/components/charts/bar-chart";
import { ChartLegend } from "@/components/charts/chart-legend";

export function ReportsView() {
  if (API_MODE) return <ViewGate machines={false}>{() => <EmptyState tone="mute" icon="chart" title="Reports are coming soon">The API does not provide report data yet. No sample values are shown for registered machines.</EmptyState>}</ViewGate>;
  return <SampleReportsView />;
}

function SampleReportsView() {
  const empty = useDemo((s) => s.view === "empty" || !s.machines.some((m) => m.hist));
  const copySummary = () => {
    const { machines, rep } = useDemo.getState();
    copyText(summaryText(machines, rep.period), "Summary copied");
  };
  return (
    <ViewGate
      actions={
        empty ? undefined : (
          <Button icon="download" onClick={copySummary}>
            Copy summary
          </Button>
        )
      }
    >
      {() => <ReportsBody />}
    </ViewGate>
  );
}

/** Planned metric: dashed card, Coming Soon, "—" (never a number), Not Connected Yet. */
function FutureMetric({ icon, title, desc }: { icon: IconName; title: string; desc: string }) {
  return (
    <div className="pw-card flat pw-stack" style={{ gap: 10, borderStyle: "dashed", borderColor: "var(--border-strong)" }}>
      <div className="pw-row pw-between">
        <StatIcon icon={icon} tone="mute" />
        <StatusBadge status="soon" />
      </div>
      <div className="pw-h3">{title}</div>
      <div className="pw-kpi pw-muted" aria-label="No value">
        —
      </div>
      <div className="pw-small pw-muted">{desc}</div>
      <StatusBadge status="notconn" />
    </div>
  );
}

function ReportsBody() {
  const router = useRouter();
  const machines = useDemo((s) => s.machines);
  const view = useDemo((s) => s.view);
  const R = useDemo((s) => s.rep);
  const patch = useDemo((s) => s.patch);
  const days = periodDays(R.period);
  const ids = machines.filter((m) => m.hist).map((m) => m.id);

  if (view === "empty" || !ids.length)
    return (
      <EmptyState tone="mute" icon="chart" title="Not enough data for reports" actions={<Button onClick={() => router.push("/machines")}>Go to My PisoWiFi</Button>}>
        Reports need machines with check history.
      </EmptyState>
    );

  const rows = reliabilityRows(machines, R.period, R.sort, R.dir);
  const sortBy = (k: ReportSort) => patch({ rep: { ...R, ...nextSort(R, k) } });
  const th = (k: ReportSort, label: string) => {
    const on = R.sort === k;
    return (
      <th scope="col" aria-sort={on ? (R.dir > 0 ? "ascending" : "descending") : "none"}>
        <button type="button" className="th-btn" onClick={() => sortBy(k)}>
          {label}
          {on ? (R.dir > 0 ? " ▲" : " ▼") : ""}
        </button>
      </th>
    );
  };

  const cfgU = chartCfg(machines, ids, days, "up", "Sample uptime trend")!;
  const cfgR = chartCfg(machines, ids, days, "rt", "Sample response time trend")!;

  const { groups, max: mx } = outageGroups(ids, R.period);
  const bser = ids.map((id) => ({ id, name: machineName(machines, id), cls: (id === "m1" ? "b1" : "b2") as "b1" | "b2" }));

  const w7 = periodSummary(machines, ids, "7"),
    m30 = periodSummary(machines, ids, "30");

  return (
    <>
      <DemoBanner title="Sample data.">Reliability charts use invented numbers. Future metrics are placeholders and show no values.</DemoBanner>
      <div className="pw-row pw-between pw-wrap">
        <Segmented
          value={R.period}
          items={[
            ["weekly", "Weekly"],
            ["monthly", "Monthly"],
          ]}
          onChange={(v) => patch({ rep: { ...R, period: v } })}
          label="Report period"
        />
        <span className="pw-small pw-muted">Showing {R.period === "weekly" ? "last 7 days" : "last 30 days"}</span>
      </div>

      <div className="pw-grid pw-g2">
        <Card>
          <CardHead title="Device reliability">
            <StatusBadge status="sample" />
          </CardHead>
          <div className="pw-tablewrap" style={{ boxShadow: "none" }}>
            <table className="pw-table">
              <caption className="sr">Data table</caption>
              <thead>
                <tr>
                  {th("name", "Machine")}
                  {th("up", "Uptime")}
                  {th("outs", "Outages")}
                  {th("rt", "Avg response")}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.m.id}>
                    <td style={{ fontWeight: 600 }}>{r.m.name}</td>
                    {r.none ? (
                      <td colSpan={3}>
                        <StatusBadge status="nodata" />
                      </td>
                    ) : (
                      <>
                        <td>{r.up.toFixed(1)}%</td>
                        <td>{r.outs}</td>
                        <td className="pw-mono">{Math.round(r.rt)} ms</td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="pw-small pw-muted" style={{ marginTop: 12 }}>
            Click a column heading to sort. Machines without checks are listed last.
          </p>
        </Card>
        <Card>
          <CardHead title="Outage frequency">
            <StatusBadge status="sample" />
          </CardHead>
          <BarChart id="rb" cfg={{ groups, series: bser, max: mx, unit: "outages", alt: "Sample outage frequency" }} />
          <ChartLegend id="rb" series={bser} />
        </Card>
        <Card>
          <CardHead title="Uptime trend">
            <StatusBadge status="sample" />
          </CardHead>
          <LineChart id="ru" cfg={cfgU} />
          <ChartLegend id="ru" series={cfgU.series} />
        </Card>
        <Card>
          <CardHead title="Response time trend">
            <StatusBadge status="sample" />
          </CardHead>
          <LineChart id="rr" cfg={cfgR} />
          <ChartLegend id="rr" series={cfgR.series} />
        </Card>
      </div>

      <div className="pw-grid pw-g2">
        <Card>
          <h2 className="pw-h2" style={{ marginBottom: 12 }}>
            Weekly summary
          </h2>
          <KeyValueList
            rows={[
              ["Period", "Last 7 days (sample)"],
              ["Average uptime", w7.up.toFixed(1) + "%"],
              ["Outages", w7.o],
              ["Longest outage", dur(w7.lg)],
              ["Most reliable", w7.best],
            ]}
          />
        </Card>
        <Card>
          <h2 className="pw-h2" style={{ marginBottom: 12 }}>
            Monthly summary
          </h2>
          <KeyValueList
            rows={[
              ["Period", "Last 30 days (sample)"],
              ["Average uptime", m30.up.toFixed(1) + "%"],
              ["Outages", m30.o],
              ["Longest outage", dur(m30.lg)],
              ["Most reliable", m30.best],
            ]}
          />
        </Card>
      </div>

      <div>
        <h2 className="pw-h2">Future metrics</h2>
        <p className="pw-muted" style={{ margin: "4px 0 16px" }}>
          These need integrations that do not exist yet. No live or sample values are shown.
        </p>
        <div className="pw-grid pw-g4" style={{ gap: 16 }}>
          <FutureMetric icon="coins" title="Sales" desc="Coin and voucher sales" />
          <FutureMetric icon="coins" title="Revenue" desc="Earnings per machine" />
          <FutureMetric icon="cpu" title="CPU usage" desc="Per-machine load" />
          <FutureMetric icon="thermo" title="CPU temperature" desc="Heat monitoring" />
          <FutureMetric icon="ram" title="RAM usage" desc="Memory pressure" />
          <FutureMetric icon="disk" title="Storage" desc="Disk space" />
          <FutureMetric icon="users" title="Connected users" desc="Active clients" />
          <div className="pw-card flat pw-stack" style={{ gap: 8, justifyContent: "center" }}>
            <span className="pw-badge mute" style={{ alignSelf: "flex-start" }}>
              <Icon name="info" size={14} />
              Integration Not Available
            </span>
            <div className="pw-small pw-muted">Needs data from WiFi5Soft, which this project has not integrated.</div>
          </div>
        </div>
      </div>
    </>
  );
}
