import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";

vi.mock("@/hooks/use-hydrated", () => ({ useHydrated: () => true }));
vi.mock("@/components/shell/sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/shell/header", () => ({ Header: () => null }));
vi.mock("@/components/shell/mobile-drawer", () => ({ MobileDrawer: () => null }));
vi.mock("@/components/features/machines/machine-dialogs", () => ({ MachineDialogs: () => null }));

afterEach(() => vi.unstubAllEnvs());

describe("stored status refresh", () => {
  it("reloads machines periodically for a signed-in API session and stops after unmount", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "api");
    vi.resetModules();
    const { useDemo } = await import("@/stores/demo-store");
    const { getServices } = await import("@/lib/services");
    const { verifySession } = await import("@/lib/session");
    const { AppShell, MACHINE_REFRESH_MS } = await import("@/components/shell/app-shell");
    await useDemo.persist.rehydrate();
    const svc = getServices();
    vi.spyOn(svc.auth, "currentUser").mockResolvedValue({ name: "Admin", email: "admin@example.test", role: "admin" });
    const list = vi.spyOn(svc.machines, "list").mockResolvedValue([]);
    await verifySession(() => svc.auth.currentUser());
    vi.useFakeTimers();
    const view = render(<AppShell><p>Dashboard</p></AppShell>);
    await act(async () => { await Promise.resolve(); });
    expect(list).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(MACHINE_REFRESH_MS); });
    expect(list).toHaveBeenCalledTimes(2);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(MACHINE_REFRESH_MS * 2); });
    expect(list).toHaveBeenCalledTimes(2);
  });
});
