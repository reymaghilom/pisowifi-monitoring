import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Machine } from "@/lib/types";
import { freezeTime } from "../helpers";

/* Removed UI: the demo "Preview state" select (My PisoWiFi and every page head) and the history CSV export.
   Env flags are read at import time, so each case re-imports with the env stubbed (demo mode stays on, as locally). */
async function load(source: "api" | "mock") {
  vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "true");
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", source);
  vi.stubEnv("NEXT_PUBLIC_REMOTE_MODE", "gateway");
  vi.resetModules();
  const { useDemo, makeMachine } = await import("@/stores/demo-store");
  const { MachinesView } = await import("@/components/features/machines/machines-view");
  const { HistoryView } = await import("@/components/features/history/history-view");
  await useDemo.persist.rehydrate();
  const machine: Machine = { ...makeMachine({ id: "6f1c2a4e-8b1d-4c3e-9f2a-1b2c3d4e5f60", name: "PisoWiFi 01", ip: "192.168.194.82" }), did: "x" };
  return { useDemo, machine, MachinesView, HistoryView };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

const noPreviewState = () => {
  expect(screen.queryByLabelText("Preview page state")).not.toBeInTheDocument();
  expect(screen.queryByText("Preview state")).not.toBeInTheDocument();
};

describe("My PisoWiFi without the Preview state select", () => {
  it("Administrator: machine cards and Add machine stay; the search/status/sort controls stay", async () => {
    const { useDemo, machine, MachinesView } = await load("api");
    useDemo.setState({ auth: true, role: "admin", machines: [machine], sel: machine.id, machinesLoading: false });
    render(<MachinesView />);
    noPreviewState();
    expect(screen.getAllByText("PisoWiFi 01").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "View details for PisoWiFi 01" }).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Add machine" })).toBeInTheDocument();
    // The functional filters are not preview controls and must remain.
    expect(screen.getAllByRole("combobox").length).toBeGreaterThan(0);
  });

  it("Limited User: machine cards stay, still no Add machine, no Preview state", async () => {
    const { useDemo, machine, MachinesView } = await load("api");
    useDemo.setState({ auth: true, role: "viewer", machines: [machine], sel: machine.id, machinesLoading: false });
    render(<MachinesView />);
    noPreviewState();
    expect(screen.getAllByRole("button", { name: "View details for PisoWiFi 01" }).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Add machine" })).not.toBeInTheDocument();
  });

  it("demo (mock) data source: no Preview state either", async () => {
    const { MachinesView } = await load("mock");
    render(<MachinesView />);
    noPreviewState();
    expect(screen.getByRole("button", { name: "Add machine" })).toBeInTheDocument();
  });
});

describe("Monitoring History without CSV export (demo data source)", () => {
  it("keeps the filters and events, has no CSV button or Preview state", async () => {
    freezeTime();
    const { HistoryView } = await load("mock");
    render(<HistoryView />);
    expect(await screen.findByLabelText("Date range")).toBeInTheDocument();
    expect(screen.getByLabelText("Status")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /csv/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/csv/i)).not.toBeInTheDocument();
    noPreviewState();
  });
});
