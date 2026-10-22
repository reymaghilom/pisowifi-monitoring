import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDemo } from "@/stores/demo-store";
import { setSessionStatus, useSession, verifySession } from "@/lib/session";

const user = { name: "Rey", email: "rey@example.com", role: "viewer" as const };

beforeEach(() => {
  setSessionStatus("pending");
  useDemo.getState().signOut();
});

describe("API session verification", () => {
  it("restores a valid cookie in a fresh tab without saved client auth", async () => {
    expect(useDemo.getState().auth).toBe(false);
    await verifySession(async () => user);
    expect(useSession.getState().status).toBe("authenticated");
    expect(useDemo.getState()).toMatchObject({ auth: true, role: "viewer", profile: { name: "Rey", email: "rey@example.com" } });
  });

  it("does not trust stale saved auth while the check is pending, then clears an expired session", async () => {
    useDemo.getState().signIn(true);
    let finish!: (value: null) => void;
    const checking = verifySession(() => new Promise((resolve) => { finish = resolve; }));
    expect(useSession.getState().status).toBe("pending");
    finish(null);
    await checking;
    expect(useSession.getState().status).toBe("unauthenticated");
    expect(useDemo.getState().auth).toBe(false);
  });

  it("keeps a network failure out of authenticated state and permits retry", async () => {
    useDemo.getState().signIn(true);
    await verifySession(async () => { throw new TypeError("offline"); });
    expect(useSession.getState().status).toBe("error");
    expect(useDemo.getState().auth).toBe(false);
    await verifySession(async () => user);
    expect(useSession.getState().status).toBe("authenticated");
  });

  it("ignores a late response after a newer sign-out", async () => {
    let finish!: (value: typeof user) => void;
    const checking = verifySession(() => new Promise((resolve) => { finish = resolve; }));
    setSessionStatus("unauthenticated");
    finish(user);
    await checking;
    expect(useSession.getState().status).toBe("unauthenticated");
    expect(useDemo.getState().auth).toBe(false);
  });
});
