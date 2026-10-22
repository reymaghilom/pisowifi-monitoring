/* API data source (B3): sign-in, session check and sign-out go to the real API; fetch is stubbed here. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiServices } from "@/lib/services/api";
import { useDemo } from "@/stores/demo-store";

const user = { id: "6f1c2a4e-8b1d-4c3e-9f2a-1b2c3d4e5f60", email: "rey@example.com", displayName: "Rey", role: "admin" };
const json = (status: number, body: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("API auth service", () => {
  it("signs in same-origin with JSON and mirrors the user into the shell", async () => {
    fetchMock.mockResolvedValue(json(200, { user }));
    expect(await createApiServices().auth.signIn({ email: "rey@example.com", password: "correct horse battery", remember: false })).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("/api/v1/auth/login");
    expect(init).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" } });
    expect(JSON.parse(init.body)).toEqual({ email: "rey@example.com", password: "correct horse battery", remember: false });
    expect(useDemo.getState()).toMatchObject({ auth: true, remember: false, profile: { name: "Rey", email: "rey@example.com" } });
  });

  it("shows the API's message on failure and stays signed out", async () => {
    fetchMock.mockResolvedValue(json(401, { error: { code: "unauthorized", message: "Invalid email or password." } }));
    expect(await createApiServices().auth.signIn({ email: "a@b.co", password: "x", remember: true })).toEqual({
      ok: false,
      error: "Invalid email or password.",
    });
    fetchMock.mockResolvedValue(json(429, { error: { code: "rate_limited", message: "Too many sign-in attempts. Try again in 15 minutes." } }));
    expect(await createApiServices().auth.signIn({ email: "a@b.co", password: "x", remember: true })).toEqual({
      ok: false,
      error: expect.stringContaining("Too many"),
    });
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    expect((await createApiServices().auth.signIn({ email: "a@b.co", password: "x", remember: true })).ok).toBe(false);
    expect(useDemo.getState().auth).toBe(false);
  });

  it("currentUser: user on 200, null on 401, throws on other failures", async () => {
    const auth = createApiServices().auth;
    fetchMock.mockResolvedValue(json(200, { user }));
    expect(await auth.currentUser()).toEqual({ id: user.id, name: "Rey", email: "rey@example.com", role: "admin" });
    fetchMock.mockResolvedValue(json(401, { error: { code: "unauthorized", message: "Sign in to continue." } }));
    expect(await auth.currentUser()).toBeNull();
    fetchMock.mockResolvedValue(json(502, undefined));
    await expect(auth.currentUser()).rejects.toThrow();
  });

  it("signOut calls the API and clears local state even if the request fails", async () => {
    useDemo.getState().signIn(true);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await createApiServices().auth.signOut();
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/auth/logout", expect.objectContaining({ method: "POST" }));
    expect(useDemo.getState().auth).toBe(false);
  });
});
