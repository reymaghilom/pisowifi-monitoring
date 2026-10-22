/* Monitoring History, Dashboard and Machine Details in API mode: recorded data only, honest empty/error states. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { Machine } from "@/lib/types";
import { nav } from "../setup";
import { M1, M2, historyFixture } from "../history-fixture";

async function load() {
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "api");
  vi.resetModules();
  const { useDemo, makeMachine } = await import("@/stores/demo-store");
  const { HistoryView } = await import("@/components/features/history/history-view");
  const { MachineDetailView } = await import("@/components/features/machine-detail/machine-detail-view");
  const { DashboardView } = await import("@/components/features/dashboard/dashboard-view");
  await useDemo.persist.rehydrate();
  const now = Date.now();
  const machines: Machine[] = [
    { ...makeMachine({ id: M1, name: "PISOWIFI 1", ip: "192.168.194.127" }), status: "reachable", checkedAt: now - 30_000, okAt: now - 30_000, hist: false, did: M1 },
    { ...makeMachine({ id: M2, name: "PISOWIFI 2", ip: "192.168.194.82" }), status: null, checkedAt: null, okAt: null, hist: false, did: M2 },
  ];
  useDemo.setState({ auth: true, role: "viewer", machines, sel: M1, machinesLoading: false });
  return { useDemo, HistoryView, MachineDetailView, DashboardView };
}

const respond = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Monitoring History (API mode)", () => {
  it("shows measured totals, the three-state timeline and status changes from the API", async () => {
    const fetch = respond(200, historyFixture());
    vi.stubGlobal("fetch", fetch);
    const { HistoryView } = await load();
    render(<HistoryView />);
    expect(await screen.findByText("80.0%")).toBeInTheDocument();
    expect(screen.getByText("4 of 5 checks reached the machine")).toBeInTheDocument();
    expect(screen.getByText("250 ms")).toBeInTheDocument();
    expect(screen.getByText("Not checked")).toBeInTheDocument();
    expect(screen.getByText(/PISOWIFI 2 · no checks in this range/)).toBeInTheDocument();
    expect(screen.getAllByText("Back online after 60 min offline").length).toBeGreaterThan(0);
    expect(screen.queryByText(/sample/i)).toBeNull();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /csv/i })).toBeNull();
    expect(screen.queryByText(/csv/i)).toBeNull();
    const url = String((fetch.mock.calls[0] as unknown[])[0]);
    expect(url).toMatch(/^\/api\/v1\/history\?from=.+&to=.+&buckets=14$/);
  });

  it("shows the server error and a retry, without inventing data", async () => {
    vi.stubGlobal("fetch", respond(500, { error: { code: "internal_error", message: "x" } }));
    const { HistoryView } = await load();
    render(<HistoryView />);
    expect(await screen.findByText("History could not be loaded")).toBeInTheDocument();
    expect(screen.getByText(/error 500/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(screen.queryByText("80.0%")).toBeNull();
  });

  it("says when the selection has no checks instead of drawing a status", async () => {
    const data = historyFixture();
    vi.stubGlobal("fetch", respond(200, { ...data, machines: [data.machines[1]], events: [], outages: [] }));
    const { HistoryView, useDemo } = await load();
    useDemo.setState({ hist: { ...useDemo.getState().hist, m: M2 } });
    render(<HistoryView />);
    expect(await screen.findByText("No checks in this range")).toBeInTheDocument();
    expect(screen.getByText(/PISOWIFI 2 has no recorded checks/)).toBeInTheDocument();
  });
});

describe("Machine Details (API mode)", () => {
  it("lists the latest recorded checks with timestamps and offers no demo check", async () => {
    vi.stubGlobal("fetch", respond(200, historyFixture()));
    const { MachineDetailView } = await load();
    nav.params = { id: M1 };
    render(<MachineDetailView />);
    const table = await screen.findByRole("table", { name: "Most recent checks for PISOWIFI 1" });
    expect(within(table).getByText("HTTP 200 · 210 ms")).toBeInTheDocument();
    expect(within(table).getByText("No answer")).toBeInTheDocument();
    expect(screen.getByText("Uptime 24 h")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Run check now/ })).toBeNull();
    expect(screen.queryByText(/Simulate state/)).toBeNull();
  });

  it("a machine without checks shows no uptime or status", async () => {
    const data = historyFixture();
    vi.stubGlobal("fetch", respond(200, { ...data, machines: [data.machines[1]], events: [], outages: [] }));
    const { MachineDetailView } = await load();
    nav.params = { id: M2 };
    render(<MachineDetailView />);
    expect(await screen.findByText("No checks in the last 24 hours")).toBeInTheDocument();
    expect(screen.getByText("No checks recorded in the last 24 hours.")).toBeInTheDocument();
  });
});

/* UI wording: Online / Offline only (internal values stay reachable / unreachable), new headings and the legend. */
const OLD_WORDS = /\b(Reachable|Unreachable|Became)\b|Monitoring overview|Monitoring summary/;

describe("UI wording (API mode)", () => {
  for (const role of ["admin", "viewer"] as const) {
    it(`Dashboard (${role}): Machine Uptime heading and subtitle, Online/Offline only`, async () => {
      vi.stubGlobal("fetch", respond(200, historyFixture()));
      const { DashboardView, useDemo } = await load();
      useDemo.setState({ role });
      render(<DashboardView />);
      await waitFor(() => expect(screen.getByRole("img", { name: "Uptime per machine from recorded checks" })).toBeInTheDocument());
      expect(screen.getByRole("heading", { name: "Machine Uptime" })).toBeInTheDocument();
      expect(screen.getByText("Measured uptime for each PisoWiFi machine · Hover or tap the chart for details")).toBeInTheDocument();
      expect(screen.getAllByText("Online").length).toBeGreaterThan(0);
      expect(screen.getAllByText("Offline").length).toBeGreaterThan(0);
      expect(document.body).not.toHaveTextContent(OLD_WORDS);
    });

    it(`Machine Details (${role}): Machine Status Overview, Status Legend wording`, async () => {
      vi.stubGlobal("fetch", respond(200, historyFixture()));
      const { MachineDetailView, useDemo } = await load();
      useDemo.setState({ role });
      nav.params = { id: M1 };
      render(<MachineDetailView />);
      expect(await screen.findByRole("heading", { name: "Machine Status Overview" })).toBeInTheDocument();
      expect(screen.getByText("Last 24 hours · Based on recorded connectivity checks")).toBeInTheDocument();
      const legend = screen.getByRole("heading", { name: "Status Legend" }).closest(".pw-card") as HTMLElement;
      expect(within(legend).getByText("Online").closest(".pw-badge")).toHaveClass("ok");
      expect(within(legend).getByText("Offline").closest(".pw-badge")).toHaveClass("bad");
      expect(within(legend).getByText("The machine was successfully reached during the latest valid connectivity check.")).toBeInTheDocument();
      expect(within(legend).getByText("The latest valid connectivity check confirmed the machine was unreachable.")).toBeInTheDocument();
      expect(
        within(legend).getByText("If a monitoring check fails internally, the last confirmed status remains unchanged until another valid check completes."),
      ).toBeInTheDocument();
      // Only two machine statuses in the legend.
      expect(legend.querySelectorAll(".pw-badge")).toHaveLength(2);
      await screen.findByRole("table", { name: "Most recent checks for PISOWIFI 1" });
      expect(document.body).not.toHaveTextContent(OLD_WORDS);
    });
  }

  it("Monitoring History presents stored status changes as Online/Offline events (stored text untouched)", async () => {
    vi.stubGlobal("fetch", respond(200, historyFixture()));
    const { HistoryView } = await load();
    render(<HistoryView />);
    expect((await screen.findAllByText("Back online after 60 min offline")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Went offline").length).toBeGreaterThan(0);
    expect(screen.getByRole("combobox", { name: "Status" })).toHaveTextContent(/Online.*Offline/);
    expect(document.body).not.toHaveTextContent(OLD_WORDS);
  });
});

describe("Dashboard (API mode)", () => {
  it("draws the overview from recorded checks and lists real status changes", async () => {
    vi.stubGlobal("fetch", respond(200, historyFixture()));
    const { DashboardView } = await load();
    render(<DashboardView />);
    await waitFor(() => expect(screen.getByRole("img", { name: "Uptime per machine from recorded checks" })).toBeInTheDocument());
    expect(screen.getByText("Recent status changes")).toBeInTheDocument();
    expect(screen.getByText("Not checked in range")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Run check now/ })).toBeNull();
  });
});
