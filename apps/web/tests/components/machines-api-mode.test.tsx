import { afterEach, describe, expect, it, vi } from "vitest";
import { render, renderHook, screen } from "@testing-library/react";
import type { Machine } from "@/lib/types";
import { nav, router } from "../setup";

/* API_MODE is read once at import time, so each case re-imports the store and views with the env stubbed. */
async function load(source: "api" | "mock", remoteMode = "direct") {
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", source);
  vi.stubEnv("NEXT_PUBLIC_REMOTE_MODE", remoteMode);
  vi.resetModules();
  const { useDemo, makeMachine } = await import("@/stores/demo-store");
  const { MachinesView } = await import("@/components/features/machines/machines-view");
  const { MachineDetailView } = await import("@/components/features/machine-detail/machine-detail-view");
  const { DashboardView } = await import("@/components/features/dashboard/dashboard-view");
  await useDemo.persist.rehydrate();
  const machine: Machine = { ...makeMachine({ id: "6f1c2a4e-8b1d-4c3e-9f2a-1b2c3d4e5f60", name: "PisoWiFi 01", ip: "192.168.194.82" }), did: "x" };
  return { useDemo, machine, MachinesView, MachineDetailView, DashboardView };
}

afterEach(() => vi.unstubAllEnvs());

const writeControls = () => [
  ...screen.queryAllByRole("button", { name: /^(Add machine|Edit|Delete|Edit machine|Delete machine|Pause monitoring|Resume monitoring)$/ }),
  ...screen.queryAllByRole("button", { name: /^(Edit|Delete) PisoWiFi 01$/ }),
];

describe("machine controls by role (API mode)", () => {
  it("viewers see the machines but no Add/Edit/Delete/Pause controls", async () => {
    const { useDemo, machine, MachinesView, DashboardView } = await load("api");
    useDemo.setState({ auth: true, role: "viewer", machines: [machine], sel: machine.id, machinesLoading: false });
    const { unmount } = render(<MachinesView />);
    expect(screen.getAllByText("PisoWiFi 01").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "View details for PisoWiFi 01" }).length).toBeGreaterThan(0);
    expect(writeControls()).toEqual([]);
    unmount();
    render(<DashboardView />);
    expect(writeControls()).toEqual([]);
  });

  it("viewers get the detail page without write controls", async () => {
    const { useDemo, machine, MachineDetailView } = await load("api");
    useDemo.setState({ auth: true, role: "viewer", machines: [machine], sel: machine.id, machinesLoading: false });
    nav.params = { id: machine.id };
    render(<MachineDetailView />);
    expect(screen.getByRole("button", { name: "Open Remote Administration" })).toBeInTheDocument();
    expect(writeControls()).toEqual([]);
  });

  it("an empty workspace tells viewers an admin adds machines (no Add button)", async () => {
    const { useDemo, MachinesView } = await load("api");
    useDemo.setState({ auth: true, role: "viewer", machines: [], sel: null, machinesLoading: false });
    render(<MachinesView />);
    expect(screen.getByText("An admin can add machines to this workspace.")).toBeInTheDocument();
    expect(writeControls()).toEqual([]);
  });

  it("admins keep every control", async () => {
    const { useDemo, machine, MachinesView } = await load("api");
    useDemo.setState({ auth: true, role: "admin", machines: [machine], sel: machine.id, machinesLoading: false });
    render(<MachinesView />);
    expect(screen.getAllByRole("button", { name: "Add machine" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Edit PisoWiFi 01" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Delete PisoWiFi 01" }).length).toBeGreaterThan(0);
  });
});

describe("machine list loading (API mode)", () => {
  it("starts in the loading state, showing the skeleton instead of the empty state", async () => {
    const { useDemo, MachinesView } = await load("api");
    expect(useDemo.getState()).toMatchObject({ machines: [], machinesLoading: true });
    useDemo.setState({ auth: true });
    render(<MachinesView />);
    expect(screen.getByLabelText("Loading")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("No machines yet")).not.toBeInTheDocument();
  });

  it("shows the real empty state once the list has loaded", async () => {
    const { useDemo, MachinesView } = await load("api");
    useDemo.setState({ auth: true, role: "admin", machinesLoading: false });
    render(<MachinesView />);
    expect(screen.getByText("No machines yet")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
  });
});

describe("mock mode is unchanged", () => {
  it("never waits for a machine list, shows demo machines and every control, even if role says viewer", async () => {
    const { useDemo, MachinesView } = await load("mock");
    expect(useDemo.getState().machinesLoading).toBe(false);
    useDemo.setState({ auth: true, role: "viewer" });
    render(<MachinesView />);
    expect(screen.getAllByText("PisoWiFi 01").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: "Edit PisoWiFi 01" }).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText("Loading")).not.toBeInTheDocument();
  });
});

describe("disabled Remote Administration entry points", () => {
  it("hides remote actions on machine, dashboard, and navigation surfaces", async () => {
    const { useDemo, machine, MachinesView, MachineDetailView, DashboardView } = await load("api", "disabled");
    useDemo.setState({ auth: true, role: "admin", machines: [machine], sel: machine.id, machinesLoading: false });
    const { NavLinks } = await import("@/components/shell/nav-links");
    const list = render(<MachinesView />);
    expect(screen.queryByRole("button", { name: /remote admin/i })).not.toBeInTheDocument();
    list.unmount();
    nav.params = { id: machine.id };
    const detail = render(<MachineDetailView />);
    expect(screen.queryByRole("button", { name: /remote admin/i })).not.toBeInTheDocument();
    detail.unmount();
    const dashboard = render(<DashboardView />);
    expect(screen.queryByRole("button", { name: /remote admin/i })).not.toBeInTheDocument();
    dashboard.unmount();
    render(<NavLinks />);
    expect(screen.queryByRole("link", { name: "Remote Administration" })).not.toBeInTheDocument();
    const { useMachineNav } = await import("@/components/features/machines/machine-bits");
    renderHook(() => useMachineNav()).result.current.openRemote(machine.id);
    expect(router.push).not.toHaveBeenCalled();
  });
});
