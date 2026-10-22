import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { redirect } from "next/navigation";
import { nav } from "../setup";

/* Env is read at import time, so each case re-imports what it renders. */
async function load(source: "api" | "mock", role: "admin" | "viewer" = "admin") {
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", source);
  vi.stubEnv("NEXT_PUBLIC_REMOTE_MODE", "gateway");
  vi.resetModules();
  const { useDemo } = await import("@/stores/demo-store");
  await useDemo.persist.rehydrate();
  useDemo.setState({ auth: true, role, profile: { name: role === "admin" ? "Rey Maghilom" : "Sibling", email: role === "admin" ? "rey@example.test" : "sib@example.test" } });
  return { useDemo };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("profile role labels", () => {
  for (const [role, label, name] of [
    ["admin", "Administrator", "Rey Maghilom"],
    ["viewer", "Member", "Sibling"],
  ] as const) {
    it(`${label}: the trigger and the account menu (shown on mobile too) use the signed-in user's own role`, async () => {
      await load("api", role);
      const { Header } = await import("@/components/shell/header");
      render(<Header />);
      const trigger = screen.getByRole("button", { name: "Account menu" });
      expect(trigger).toHaveTextContent(name);
      expect(trigger).toHaveTextContent(label);
      expect(document.body).not.toHaveTextContent(/Owner|Limited User/);
      await userEvent.setup().click(trigger);
      const menu = await screen.findByRole("menu");
      expect(menu).toHaveTextContent(name);
      expect(menu).toHaveTextContent(label + " · ");
    });
  }
});

describe("navigation", () => {
  it("has no Reports & Analytics entry and keeps Notifications & Automations", async () => {
    await load("api");
    const { NAV, routeKeyFor } = await import("@/lib/constants");
    expect(NAV.map((n) => n.label)).not.toContain("Reports & Analytics");
    expect(NAV.some((n) => n.href === "/reports")).toBe(false);
    const auto = NAV.find((n) => n.key === "auto")!;
    expect(auto).toMatchObject({ label: "Notifications & Automations", title: "Notifications & Automations", subtitle: "Manage connectivity alerts and monitor notification delivery." });
    expect(NAV.find((n) => n.key === "remote")!.subtitle).toBe("Securely manage your PisoWiFi machines through the Remote Admin Gateway.");
    // An old /reports link still gets a valid header (Dashboard) while the page redirects.
    expect(NAV.find((n) => n.key === routeKeyFor("/reports"))).toBeDefined();
  });

  it("/reports redirects to the Dashboard", async () => {
    const { default: ReportsPage } = await import("@/app/(app)/reports/page");
    ReportsPage();
    expect(redirect).toHaveBeenCalledWith("/dashboard");
  });
});

describe("Notifications & Automations", () => {
  it("API mode shows no sample executions or placeholder delivery records", async () => {
    await load("api");
    nav.pathname = "/automations";
    const { AutomationsView } = await import("@/components/features/automations/automations-view");
    render(<AutomationsView />);
    expect(await screen.findByText("Alert controls and delivery history are not available here yet")).toBeInTheDocument();
    expect(document.body).toHaveTextContent("one email is sent when a machine goes Offline and one when it is back Online");
    expect(document.body).not.toHaveTextContent(/Sample rows|days ago|webhook not configured|succeeded|Reachable|Unreachable/);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("sample Gmail previews use Offline / back Online with the machine and Asia/Manila time", async () => {
    await load("mock");
    const { msgPreview } = await import("@/lib/constants");
    const at = Date.parse("2026-10-12T12:44:07Z");
    const outage = msgPreview("outage", "PISOWIFI 2", "192.168.194.82", at);
    const recovery = msgPreview("recovery", "PISOWIFI 2", "192.168.194.82", at);
    expect(outage).toContain("Subject: PisoWiFi alert: PISOWIFI 2 is Offline");
    expect(outage).toContain("\n\nPISOWIFI 2 is Offline.\n");
    expect(recovery).toContain("Subject: PisoWiFi: PISOWIFI 2 is back Online");
    expect(recovery).toContain("\n\nPISOWIFI 2 is back Online.\n");
    for (const text of [outage, recovery]) {
      expect(text).toContain("Detected: October 12, 2026, 8:44 PM (Asia/Manila, UTC+8)");
      expect(text).toContain("(Sample message. Not sent.)");
      expect(text).not.toMatch(/Reachable|Unreachable/);
    }
  });
});

describe("Machine Details legend", () => {
  it("uses the approved Status Legend copy", async () => {
    await load("mock");
    nav.params = { id: "m1" };
    const { MachineDetailView } = await import("@/components/features/machine-detail/machine-detail-view");
    render(<MachineDetailView />);
    const legend = (await screen.findByRole("heading", { name: "Status Legend" })).closest(".pw-card") as HTMLElement;
    expect(within(legend).getByText("Online")).toBeInTheDocument();
    expect(within(legend).getByText("Offline")).toBeInTheDocument();
    expect(legend).toHaveTextContent("The machine was successfully reached during the latest valid connectivity check.");
    expect(legend).toHaveTextContent("The latest valid connectivity check confirmed the machine was unreachable.");
    expect(legend).toHaveTextContent("If a monitoring check fails internally, the last confirmed status remains unchanged until another valid check completes.");
  });
});
