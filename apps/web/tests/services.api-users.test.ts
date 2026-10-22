import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiUsersService } from "@/lib/services/api/users";

const ID = "00000000-0000-4000-8000-000000000003";
const createdAt = "2026-10-18T08:00:00.000Z";
const account = { id: ID, email: "sibling@example.test", displayName: "Sibling", role: "viewer", status: "active", lastLoginAt: null, lockedUntil: null, deactivatedAt: null, createdAt };
const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

afterEach(() => vi.restoreAllMocks());

describe("typed Manage Users API client", () => {
  it("uses same-origin, no-store GETs for the list and authorized activity", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(200, { items: [account] }))
      .mockResolvedValueOnce(json(200, { items: [], nextBefore: null }));
    const svc = createApiUsersService();
    expect(await svc.list({ q: "Sibling", role: "viewer", status: "active" })).toEqual({ ok: true, data: [account] });
    expect(await svc.activity(ID, 42)).toEqual({ ok: true, data: { items: [], nextBefore: null } });
    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/users?q=Sibling&role=viewer&status=active", expect.objectContaining({ credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, `/api/v1/users/${ID}/activity?limit=25&before=42`, expect.objectContaining({ credentials: "same-origin", cache: "no-store" }));
  });

  it("returns a one-time provisioning link only to the caller and sends no password", async () => {
    const secret = "https://example.test/reset-password#token=private-once";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(201, { user: account, setPasswordUrl: secret, expiresAt: createdAt }));
    const result = await createApiUsersService().create({ displayName: "Sibling", email: "sibling@example.test", role: "viewer" });
    expect(result).toEqual({ ok: true, data: { user: account, link: { url: secret, expiresAt: createdAt } } });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/users", expect.objectContaining({
      method: "POST", credentials: "same-origin", cache: "no-store",
      body: JSON.stringify({ displayName: "Sibling", email: "sibling@example.test", role: "viewer" }),
    }));
    expect(sessionStorage.getItem("pw-demo")).not.toContain("private-once");
  });

  it("uses explicit role and status endpoints and reports permission refusal", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(200, { user: { ...account, role: "admin" }, sessionsRevoked: 2 }))
      .mockResolvedValueOnce(json(200, { user: { ...account, status: "deactivated", deactivatedAt: createdAt }, sessionsRevoked: 1 }))
      .mockResolvedValueOnce(json(403, { error: { code: "forbidden", message: "Forbidden" } }));
    const svc = createApiUsersService();
    expect((await svc.setRole(ID, "admin")).ok).toBe(true);
    expect((await svc.setActive(ID, false)).ok).toBe(true);
    expect(await svc.issueLink(ID)).toEqual({ ok: false, error: { status: 403, message: "You don't have permission to manage users.", fields: {} } });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/v1/users/${ID}/role`, `/api/v1/users/${ID}/status`, `/api/v1/users/${ID}/password-link`,
    ]);
    expect(fetchMock.mock.calls[0]![1]).toEqual(expect.objectContaining({ method: "PUT", body: '{"role":"admin"}' }));
    expect(fetchMock.mock.calls[1]![1]).toEqual(expect.objectContaining({ method: "PUT", body: '{"active":false}' }));
  });
});
