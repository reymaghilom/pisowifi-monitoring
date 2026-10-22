import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/* Gateway mode (NEXT_PUBLIC_REMOTE_MODE=gateway). Env is read at import time, so each case re-imports the view. */
const TICKET = "A".repeat(48) + "." + "B".repeat(86);
const ENTRY = "https://gw.example.test/__pisowifi/enter#t=" + TICKET;
const TICKET_PATH = "/api/v1/remote/machines/m1/ticket";

type Reply = { status: number; body?: unknown } | "network";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const apiError = (code: string, message: string) => ({ error: { code, message } });
const ok = (expiresInMs = 60_000) => ({ status: 200, body: { entryUrl: ENTRY, expiresAt: new Date(Date.now() + expiresInMs).toISOString() } });

/** A stand-in for the blank tab window.open returns. */
function fakeTab(closed = false) {
  return {
    opener: {} as unknown,
    closed,
    document: { title: "", body: { textContent: "" } },
    location: { replace: vi.fn() },
    close: vi.fn(),
  };
}

async function load({ mode = "gateway", source = "api", role = "admin", tab = fakeTab() as ReturnType<typeof fakeTab> | null, reply = ok() as Reply | Promise<Reply> } : { mode?: string | null; source?: string; role?: string; tab?: ReturnType<typeof fakeTab> | null; reply?: Reply | Promise<Reply> } = {}) {
  vi.stubEnv("NEXT_PUBLIC_DATA_SOURCE", source);
  vi.stubEnv("NEXT_PUBLIC_REMOTE_MODE", mode ?? undefined);
  vi.stubEnv("NEXT_PUBLIC_GATEWAY_ORIGIN", "https://gw.example.test");
  vi.stubEnv("NEXT_PUBLIC_ZT_NETWORK_ID", "");
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
  vi.resetModules();
  localStorage.clear();
  const { useDemo, makeMachine } = await import("@/stores/demo-store");
  const { useRemoteSetup } = await import("@/stores/remote-setup-store");
  const { RemoteView } = await import("@/components/features/remote/remote-view");
  const { Toaster } = await import("@/components/ui/toaster");
  const { leavePage } = await import("@/lib/services/api/remote");
  await useDemo.persist.rehydrate();
  await useRemoteSetup.persist.rehydrate();
  const m1 = makeMachine({ id: "m1", name: "PisoWiFi 01", ip: "192.168.194.82" }, "reachable");
  const m2 = makeMachine({ id: "m2", name: "PisoWiFi 02", ip: "192.168.194.127" }, "unreachable");
  useDemo.setState({ auth: true, machines: [m1, m2], sel: "m1", remote: { m: "m1" }, machinesLoading: false, role: role as "admin" | "viewer" });

  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== TICKET_PATH) throw new TypeError("unexpected request");
    const r = await reply;
    if (r === "network") throw new TypeError("Failed to fetch");
    return json(r.status, r.body ?? null);
  });
  const ticketCalls = () => fetchSpy.mock.calls.filter(([u]) => String(u) === TICKET_PATH);
  const openSpy = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
  const leaveSpy = vi.spyOn(leavePage, "to").mockImplementation(() => {});
  const logs = (["log", "info", "warn", "error", "debug"] as const).map((k) => vi.spyOn(console, k));
  render(
    <>
      <RemoteView />
      <Toaster />
    </>,
  );
  /** The ticket must never reach the page text, a toast or the console. */
  const expectTicketNotLeaked = () => {
    expect(document.body.textContent).not.toContain(TICKET);
    for (const spy of logs) for (const args of spy.mock.calls) expect(JSON.stringify(args)).not.toContain(TICKET);
  };
  return { useDemo, fetchSpy, ticketCalls, openSpy, leaveSpy, tab, expectTicketNotLeaked, user: userEvent.setup() };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Remote Administration through the gateway", () => {
  it("skips the ZeroTier wizard, keeps the gateway access and has no 'How remote access works' section", async () => {
    const { ticketCalls } = await load();
    const heading = await screen.findByText("Secure Remote Access");
    const note = heading.closest(".pw-banner")!;
    expect(note).toHaveTextContent(
      "Access your PisoWiFi machines securely through the Remote Admin Gateway. No additional VPN setup is required on your device. Each access request generates a single-use link that expires within one minute and opens the selected machine's administration interface in a new tab.",
    );
    expect(within(note as HTMLElement).getByText("Authentication on the PisoWiFi machine may still be required.")).toBeInTheDocument();
    expect(note).not.toHaveTextContent(/WiFi5Soft/);
    expect(screen.getByRole("heading", { name: "Ready for Remote Access" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open admin page" })).toBeEnabled();
    expect(screen.queryByText("How remote access works")).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Connection path" })).not.toBeInTheDocument();
    for (const gone of ["Secure gateway", "Private ZeroTier network", /Only signed-in users with Remote Admin access get a link/]) {
      expect(screen.queryByText(gone)).not.toBeInTheDocument();
    }
    expect(screen.getByText("Not needed")).toBeInTheDocument();
    expect(screen.queryByText("Remote access setup")).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Windows PC" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Direct access through your own ZeroTier connection/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review setup steps" })).not.toBeInTheDocument();
    expect(ticketCalls()).toHaveLength(0);
  });

  it("names the selected machine in the ready state and shows Online wording only for a confirmed Online result", async () => {
    const { useDemo, user, ticketCalls } = await load();
    const ready = (await screen.findByRole("heading", { name: "Ready for Remote Access" })).closest(".pw-card")!;
    expect(ready).toHaveTextContent(
      "Open PisoWiFi 01's administration interface securely in a new tab through the Remote Admin Gateway. No additional VPN setup is required on this device.",
    );
    expect(ready).toHaveTextContent("Machine login credentials may be required.");
    expect(ready).not.toHaveTextContent(/WiFi5Soft/);
    const online =
      "The machine is Online based on the latest successful connectivity check from the monitoring server. Remote access through the secure gateway is expected to be available. This does not confirm customer internet connectivity.";
    expect(screen.getByRole("heading", { name: "Connectivity Status" })).toBeInTheDocument();
    expect(document.body).toHaveTextContent(online);

    // Offline machine: factual Offline text, never the Online promise.
    await user.click(screen.getByRole("button", { name: /PisoWiFi 02/ }));
    expect(await screen.findByText(/Open PisoWiFi 02's administration interface/)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(online);
    expect(document.body).toHaveTextContent(/The machine is Offline: the latest valid connectivity check/);

    // No valid check yet: neither Online nor Offline wording.
    useDemo.setState((s) => ({ machines: s.machines.map((m) => (m.id === "m2" ? { ...m, status: null, checkedAt: null } : m)) }));
    expect(await screen.findByText("No valid connectivity check has completed for this machine yet, so no status is shown.")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(online);
    expect(ticketCalls()).toHaveLength(0);
  });

  it("opens a blank tab during the click, detaches it, then sends it to the entry URL", async () => {
    let release!: (r: Reply) => void;
    const { ticketCalls, openSpy, tab, user, expectTicketNotLeaked } = await load({ reply: new Promise<Reply>((r) => (release = r)) });
    await user.click(await screen.findByRole("button", { name: "Open admin page" }));

    // The tab exists before the ticket does, and can't reach back into this page.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
    expect(tab!.opener).toBeNull();
    expect(tab!.location.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Opening…" })).toBeDisabled();

    const [, init] = ticketCalls()[0];
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
    expect(init?.body).toBeUndefined();

    release(ok());
    expect(await screen.findByText(/Opened in a new tab/)).toBeInTheDocument();
    expect(tab!.location.replace).toHaveBeenCalledWith(ENTRY);
    expect(tab!.close).not.toHaveBeenCalled();
    expect(ticketCalls()).toHaveLength(1);
    expectTicketNotLeaked();
  });

  it("asks for a ticket for the selected machine", async () => {
    const { fetchSpy, user } = await load();
    await user.click(await screen.findByRole("button", { name: /PisoWiFi 02/ }));
    fetchSpy.mockImplementation(async () => json(200, ok().body));
    await user.click(screen.getByRole("button", { name: "Open admin page" }));
    expect(fetchSpy).toHaveBeenCalledWith("/api/v1/remote/machines/m2/ticket", expect.anything());
  });

  it.each([
    [401, apiError("unauthenticated", "Sign in"), "Your session has ended. Sign in again, then retry."],
    [403, apiError("forbidden", "Permission required"), "Your account can’t open remote administration. Ask an Administrator for access."],
    [403, apiError("forbidden", "Cross-origin request blocked."), /refused this page’s address/],
  ])("authorization failure %i closes the blank tab and explains", async (status, body, message) => {
    const { tab, user, expectTicketNotLeaked } = await load({ reply: { status, body } });
    await user.click(await screen.findByRole("button", { name: "Open admin page" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(tab!.close).toHaveBeenCalledTimes(1);
    expect(tab!.location.replace).not.toHaveBeenCalled();
    expectTicketNotLeaked();
  });

  it.each([
    ["503 disabled", { status: 503, body: apiError("unavailable", "Remote administration through the gateway is not enabled.") }, "Remote administration through the gateway is not enabled."],
    ["422 bad record", { status: 422, body: apiError("invalid_machine", "This machine’s ZeroTier IP or admin path can’t be opened through the gateway.") }, /can’t be opened through the gateway/],
    ["422 outside the gateway's network", { status: 422, body: apiError("invalid_machine", "This machine’s ZeroTier IP is outside the network the gateway may open. Check it in My PisoWiFi.") }, /outside the network the gateway may open/],
    ["422 not a PisoWiFi machine", { status: 422, body: apiError("invalid_machine", "This address belongs to a device that isn’t a PisoWiFi machine, so the gateway won’t open it. Check its IP in My PisoWiFi.") }, /isn’t a PisoWiFi machine/],
    ["404 machine deleted", { status: 404, body: apiError("not_found", "Machine not found") }, "This machine isn’t registered anymore. Refresh the list and try again."],
    ["429", { status: 429, body: apiError("rate_limited", "Too many requests") }, "Too many requests"],
    ["500 without a body", { status: 500 }, "Can't reach the server. Check your connection and try again."],
    ["network error", "network" as const, "Can't reach the server. Check your connection and try again."],
    ["malformed ticket", { status: 200, body: { entryUrl: "https://evil.example/somewhere", expiresAt: new Date().toISOString() } }, "The server sent an unexpected answer. Nothing was opened."],
    ["other HTTPS origin", { status: 200, body: { entryUrl: ENTRY.replace("gw.example.test", "evil.example.test"), expiresAt: new Date().toISOString() } }, "The server sent an unexpected answer. Nothing was opened."],
  ])("%s: closes the blank tab, shows the error and offers a retry", async (_, reply, message) => {
    const { tab, user, ticketCalls } = await load({ reply: reply as Reply });
    await user.click(await screen.findByRole("button", { name: "Open admin page" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Couldn’t open the admin page.");
    expect(tab!.close).toHaveBeenCalledTimes(1);
    expect(tab!.location.replace).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(ticketCalls()).toHaveLength(2));
  });

  it("popup blocked: offers the one-time link as a user-initiated new tab or same-tab navigation", async () => {
    const { ticketCalls, leaveSpy, user } = await load({ tab: null });
    await user.click(await screen.findByRole("button", { name: "Open admin page" }));
    expect(await screen.findByText("Your browser blocked the new tab.")).toBeInTheDocument();
    expect(ticketCalls()).toHaveLength(1);

    const link = screen.getByRole("link", { name: "Open in new tab" });
    expect(link).toHaveAttribute("href", ENTRY);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).toHaveAttribute("referrerpolicy", "no-referrer");

    await user.click(screen.getByRole("button", { name: "Open in this tab" }));
    expect(leaveSpy).toHaveBeenCalledWith(ENTRY);
    // Used once: the link is gone from the page.
    expect(screen.queryByRole("link", { name: "Open in new tab" })).not.toBeInTheDocument();
  });

  it("popup blocked: the fallback link disappears when its ticket expires", async () => {
    const { user } = await load({ tab: null, reply: ok(1500) });
    await user.click(await screen.findByRole("button", { name: "Open admin page" }));
    expect(await screen.findByRole("link", { name: "Open in new tab" })).toBeInTheDocument();
    expect(await screen.findByText(/That link expired unused/, undefined, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open in new tab" })).not.toBeInTheDocument();
  });

  it("tab closed by the user while waiting: falls back to the link instead of losing the ticket", async () => {
    const tab = fakeTab(true);
    await load({ tab }).then(({ user }) => screen.findByRole("button", { name: "Open admin page" }).then((b) => user.click(b)));
    expect(await screen.findByText("Your browser blocked the new tab.")).toBeInTheDocument();
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it("switching machine drops a pending fallback link", async () => {
    const { user } = await load({ tab: null });
    await user.click(await screen.findByRole("button", { name: "Open admin page" }));
    expect(await screen.findByRole("link", { name: "Open in new tab" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /PisoWiFi 02/ }));
    expect(screen.queryByRole("link", { name: "Open in new tab" })).not.toBeInTheDocument();
  });

  it("Limited Users can request tickets for both approved machines (and see no informational section)", async () => {
    const { ticketCalls, fetchSpy, user } = await load({ role: "viewer" });
    await user.click(await screen.findByRole("button", { name: "Open admin page" }));
    expect(screen.queryByText("How remote access works")).not.toBeInTheDocument();
    expect(ticketCalls()).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /PisoWiFi 02/ }));
    await user.click(await screen.findByRole("button", { name: "Open admin page" }));
    expect(fetchSpy).toHaveBeenCalledWith("/api/v1/remote/machines/m2/ticket", expect.anything());
  });

  it("mock data source: simulated, nothing opened or requested", async () => {
    const { ticketCalls, openSpy, user } = await load({ source: "mock" });
    await user.click(await screen.findByRole("button", { name: "Open admin page" }));
    expect(await screen.findByText(/Simulated: a one-time gateway link for PisoWiFi 01/)).toBeInTheDocument();
    expect(ticketCalls()).toHaveLength(0);
    expect(openSpy).not.toHaveBeenCalled();
  });
});

describe("Remote Administration, explicit direct mode", () => {
  it("keeps the ZeroTier wizard and the direct link", async () => {
    const mode = "direct";
    const { ticketCalls, openSpy, user } = await load({ mode });
    expect(await screen.findByText("Direct access through your own ZeroTier connection.")).toBeInTheDocument();
    expect(screen.getByText("Remote access setup")).toBeInTheDocument();
    expect(screen.queryByText("Secure gateway")).not.toBeInTheDocument();
    expect(screen.queryByText("How remote access works")).not.toBeInTheDocument();
    // The Secure Remote Access text describes gateway mode only.
    expect(screen.queryByText("Secure Remote Access")).not.toBeInTheDocument();
    for (const name of ["ZeroTier One is installed", /I've joined the network/, /I’m authorized/]) await user.click(screen.getByRole("button", { name }));
    await user.click(screen.getByRole("button", { name: "Open PisoWiFi 01 admin page" }));
    expect(openSpy).toHaveBeenCalledWith("http://192.168.194.82/admin", "_blank", "noopener,noreferrer");
    expect(ticketCalls()).toHaveLength(0);
  });
});

describe("Remote Administration, disabled mode", () => {
  it.each(["disabled", "", "invalid", "Gateway", null])("NEXT_PUBLIC_REMOTE_MODE=%j fails closed", async (mode) => {
    const { ticketCalls, openSpy, leaveSpy } = await load({ mode });
    expect(await screen.findByRole("heading", { name: "Remote Administration unavailable" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /admin page|remote access/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Remote access setup")).not.toBeInTheDocument();
    expect(screen.queryByText("Secure gateway")).not.toBeInTheDocument();
    expect(ticketCalls()).toHaveLength(0);
    expect(openSpy).not.toHaveBeenCalled();
    expect(leaveSpy).not.toHaveBeenCalled();
    const { requestRemoteTicket, openPendingTab } = await import("@/lib/services/api/remote");
    expect(await requestRemoteTicket("m1")).toMatchObject({ ok: false, reason: "unavailable" });
    expect(openPendingTab()).toBeNull();
    expect(ticketCalls()).toHaveLength(0);
    expect(openSpy).not.toHaveBeenCalled();
  });
});
