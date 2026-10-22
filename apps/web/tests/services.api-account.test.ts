/* API data source, account management (B4): profile, password, sessions, password reset. fetch is stubbed. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiServices } from "@/lib/services/api";
import { useDemo } from "@/stores/demo-store";

const user = { id: "6f1c2a4e-8b1d-4c3e-9f2a-1b2c3d4e5f60", email: "rey@example.com", displayName: "Rey", role: "admin" };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const empty = (status: number) => new Response(null, { status });
const sid = (n: number) => `6f1c2a4e-8b1d-4c3e-9f2a-1b2c3d4e5f6${n}`;
const session = (id: string, current: boolean) => ({
  id,
  label: current ? "Chrome on Windows" : "Safari on iOS",
  current,
  createdAt: "2026-10-10T01:00:00Z",
  lastSeenAt: new Date(Date.now() - 14 * 60_000).toISOString(),
});
const NEW_PW = "a brand new passphrase";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("API account services", () => {
  it("saveProfile sends displayName/email and updates the header profile; maps field errors", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { user: { ...user, displayName: "Rey M", email: "new@example.com" } }));
    expect(await createApiServices().settings.saveProfile({ name: "Rey M", email: "new@example.com" })).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/account/profile");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ displayName: "Rey M", email: "new@example.com" });
    expect(useDemo.getState().profile).toEqual({ name: "Rey M", email: "new@example.com" });

    fetchMock.mockResolvedValueOnce(json(409, { error: { code: "conflict", message: "x", fields: { email: "Another account already uses this email" } } }));
    expect(await createApiServices().settings.saveProfile({ name: "Rey", email: "partner@example.com" })).toEqual({
      ok: false,
      error: { name: undefined, email: "Another account already uses this email" },
    });
  });

  it("changePassword maps the API's field names to the form's and refreshes sessions", async () => {
    fetchMock.mockResolvedValueOnce(
      json(400, { error: { code: "validation_failed", message: "x", fields: { currentPassword: "Current password is incorrect" } } }),
    );
    expect(await createApiServices().settings.changePassword("bad", NEW_PW, NEW_PW)).toEqual({
      ok: false,
      error: { cur: "Current password is incorrect", nw: undefined, cf: undefined },
    });
    fetchMock.mockResolvedValueOnce(json(200, { revoked: 1 })).mockResolvedValueOnce(json(200, { items: [session(sid(0), true)] }));
    expect(await createApiServices().settings.changePassword("old password!", NEW_PW, NEW_PW)).toEqual({ ok: true });
    expect(useDemo.getState().sessions).toHaveLength(1);
  });

  it("lists sessions into the store with readable labels, and revokes one", async () => {
    fetchMock.mockResolvedValueOnce(json(200, { items: [session(sid(0), true), session(sid(1), false)] }));
    const rows = await createApiServices().settings.listSessions();
    expect(rows).toEqual([
      { id: sid(0), name: "Chrome on Windows", meta: "Active now · signed in Oct 10", cur: true },
      { id: sid(1), name: "Safari on iOS", meta: "Last active 14 min ago · signed in Oct 10", cur: false },
    ]);
    expect(useDemo.getState().sessions).toEqual(rows);

    fetchMock.mockResolvedValueOnce(empty(204)).mockResolvedValueOnce(json(200, { items: [session(sid(0), true)] }));
    await createApiServices().settings.signOutSession(sid(1));
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/account/sessions/${sid(1)}`, expect.objectContaining({ method: "DELETE" }));
    expect(useDemo.getState().sessions.map((s) => s.id)).toEqual([sid(0)]);

    fetchMock.mockResolvedValueOnce(json(200, { revoked: 0 })).mockResolvedValueOnce(json(200, { items: [session(sid(0), true)] }));
    await createApiServices().settings.signOutOtherSessions();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/account/sessions/revoke-others", expect.objectContaining({ method: "POST" }));
  });

  it("password reset request: 202 is ok; the API's message is shown otherwise (e.g. email not set up)", async () => {
    fetchMock.mockResolvedValueOnce(empty(202));
    expect(await createApiServices().auth.requestPasswordReset("rey@example.com")).toEqual({ ok: true });
    fetchMock.mockResolvedValueOnce(json(503, { error: { code: "unavailable", message: "Password reset by email is not set up yet." } }));
    expect(await createApiServices().auth.requestPasswordReset("rey@example.com")).toEqual({ ok: false, error: "Password reset by email is not set up yet." });
  });

  it("password reset confirm: sends token + password; maps invalid links; checks the confirmation locally", async () => {
    const auth = createApiServices().auth;
    const token = "t".repeat(43);
    fetchMock.mockResolvedValueOnce(empty(204));
    expect(await auth.confirmPasswordReset(token, NEW_PW, NEW_PW)).toEqual({ ok: true });
    expect(JSON.parse(fetchMock.mock.lastCall![1].body)).toEqual({ token, password: NEW_PW });

    fetchMock.mockResolvedValueOnce(json(400, { error: { code: "invalid_token", message: "This reset link is invalid or has expired. Request a new one." } }));
    expect(await auth.confirmPasswordReset(token, NEW_PW, NEW_PW)).toEqual({
      ok: false,
      error: { form: "This reset link is invalid or has expired. Request a new one." },
    });

    const calls = fetchMock.mock.calls.length;
    expect((await auth.confirmPasswordReset(token, NEW_PW, "different")).ok).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(calls); // no request for a mismatch
  });
});
