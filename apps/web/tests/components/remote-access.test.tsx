import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/* API_MODE is read once at import time, so each case re-imports the stores and view with the env stubbed. */
async function load(source: "api" | "mock", ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)") {
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", source);
  vi.stubEnv("NEXT_PUBLIC_REMOTE_MODE", "direct");
  vi.stubEnv("NEXT_PUBLIC_ZT_NETWORK_ID", "");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(ua);
  vi.resetModules();
  localStorage.clear();
  const { useDemo, makeMachine } = await import("@/stores/demo-store");
  const { useRemoteSetup } = await import("@/stores/remote-setup-store");
  const { RemoteView } = await import("@/components/features/remote/remote-view");
  const { Toaster } = await import("@/components/ui/toaster");
  await useDemo.persist.rehydrate();
  await useRemoteSetup.persist.rehydrate();
  const m82 = makeMachine({ id: "m1", name: "PisoWiFi 01", ip: "192.168.194.82" }, "reachable");
  const m127 = makeMachine({ id: "m2", name: "PisoWiFi 02", ip: "192.168.194.127" }, "unreachable");
  useDemo.setState({ auth: true, machines: [m82, m127], sel: "m1", remote: { m: "m1" }, machinesLoading: false });
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
  render(
    <>
      <RemoteView />
      <Toaster />
    </>,
  );
  return { useDemo, useRemoteSetup, fetchSpy, openSpy, user: userEvent.setup() };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Remote Access Setup Wizard (mock)", () => {
  it("Windows: user-confirmed steps, pending authorization, failed test, retry, then ready; nothing is contacted", async () => {
    const { useRemoteSetup, fetchSpy, openSpy, user } = await load("mock");
    expect(await screen.findByRole("tab", { name: "Windows PC", selected: true })).toBeInTheDocument();
    // The informational "How remote access works" section is gone; the setup wizard itself stays.
    expect(screen.queryByText("How remote access works")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Connection path" })).not.toBeInTheDocument();
    expect(screen.queryByText(/can’t see whether ZeroTier is installed/)).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Official download page" })).toHaveAttribute("href", "https://www.zerotier.com/download/");

    await user.click(screen.getByRole("button", { name: "ZeroTier One is installed" }));
    expect(screen.getByText(/Ask your administrator for the 16-character Network ID/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /I've joined the network/ }));

    expect(screen.getByText("Pending authorization")).toBeInTheDocument();
    const copy = screen.getByRole("button", { name: "Copy authorization request" });
    expect(copy).toBeDisabled();
    await user.type(screen.getByLabelText(/Your ZeroTier address/), "zz");
    expect(screen.getByText("10 characters, 0–9 and a–f")).toBeInTheDocument();
    await user.clear(screen.getByLabelText(/Your ZeroTier address/));
    await user.type(screen.getByLabelText(/Your ZeroTier address/), "a1b2c3d4e5");
    expect(copy).toBeEnabled();
    await user.click(screen.getByRole("button", { name: /I’m authorized/ }));

    await user.click(screen.getByRole("button", { name: "Open PisoWiFi 01 admin page" }));
    expect(await screen.findByText(/Simulated: http:\/\/192\.168\.194\.82\/admin would open/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "No, it didn’t load" }));
    expect(screen.getByRole("heading", { name: "Connection failed" })).toBeInTheDocument();
    expect(screen.getByText(/admin page answered the last check/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));
    await user.click(screen.getByRole("button", { name: "Yes, it loaded" }));
    expect(screen.getByRole("heading", { name: "Ready for Remote Access" })).toBeInTheDocument();
    expect(useRemoteSetup.getState().done.windows).toEqual(["install", "join", "authorize", "test"]);
    expect(JSON.parse(localStorage.getItem("pw-remote-setup")!).state.done.windows).toHaveLength(4);

    expect(openSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("Android: adds the VPN step and VPN troubleshooting; undoing a step undoes the later ones", async () => {
    const { useRemoteSetup, user } = await load("mock", "Mozilla/5.0 (Linux; Android 14; Pixel 8)");
    expect(await screen.findByRole("tab", { name: "Android phone", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "ZeroTier One on Google Play" })).toHaveAttribute("href", expect.stringContaining("com.zerotier.one"));
    for (const name of ["ZeroTier One is installed", /I've joined the network/, /I’m authorized/]) await user.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("heading", { name: "Turn on the network and allow the VPN" })).toBeInTheDocument();
    expect(screen.getByText(/Android: the VPN permission didn’t appear/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "The network is on and the VPN is allowed" }));
    expect(useRemoteSetup.getState().done.android).toEqual(["install", "join", "authorize", "vpn"]);
    await user.click(screen.getByRole("button", { name: "Mark “Join the private network” as not done" }));
    expect(useRemoteSetup.getState().done.android).toEqual(["install"]);
  });
});

describe("Remote Administration (API mode)", () => {
  it("opens the machine's own admin URL in a new tab, never through the app", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", "api");
    const { useRemoteSetup, useDemo, openSpy, user } = await load("api");
    useDemo.setState({ role: "admin" });
    useRemoteSetup.setState({ platform: "windows", done: { windows: ["install", "join", "authorize", "test"], android: [] } });
    const card = await screen.findByRole("heading", { name: "Ready for Remote Access" });
    expect(card).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open admin page" }));
    expect(openSpy).toHaveBeenCalledWith("http://192.168.194.82/admin", "_blank", "noopener,noreferrer");
    await user.click(screen.getByRole("button", { name: /PisoWiFi 02/ }));
    await user.click(screen.getByRole("button", { name: "Open admin page" }));
    expect(openSpy).toHaveBeenLastCalledWith("http://192.168.194.127/admin", "_blank", "noopener,noreferrer");
    await user.click(screen.getByRole("button", { name: "No, it didn’t load" }));
    expect(within(screen.getByRole("heading", { name: "Connection failed" }).closest(".pw-card")!).getByText(/Offline/)).toBeInTheDocument();
  });

  it("Limited Users can open Remote Administration for both approved machines", async () => {
    const { useDemo, useRemoteSetup, openSpy, user } = await load("api");
    useDemo.setState({ role: "viewer" });
    useRemoteSetup.setState({ platform: "windows", done: { windows: ["install", "join", "authorize", "test"], android: [] } });
    await user.click(await screen.findByRole("button", { name: "Open admin page" }));
    expect(openSpy).toHaveBeenCalledWith("http://192.168.194.82/admin", "_blank", "noopener,noreferrer");
    await user.click(screen.getByRole("button", { name: /PisoWiFi 02/ }));
    await user.click(screen.getByRole("button", { name: "Open admin page" }));
    expect(openSpy).toHaveBeenLastCalledWith("http://192.168.194.127/admin", "_blank", "noopener,noreferrer");
  });
});
