/* Behaviour every Services implementation must have. Run against the mock today; point a backend
   implementation (plus a resettable test fixture) at runServiceContract() when it exists. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Services } from "@/lib/services/types";
import { createMockServices, MOCK_LATENCY } from "@/lib/services/mock";
import { getServices, setServicesForTesting } from "@/lib/services";
import { useDemo } from "@/stores/demo-store";
import type { MachineInput } from "@/lib/types";

const input = (o: Partial<MachineInput> = {}): MachineInput => ({
  name: "PisoWiFi 03",
  loc: "Annex",
  desc: "",
  sw: "WiFi5Soft",
  ver: "",
  ztNet: "",
  ip: "192.168.194.90",
  path: "/admin",
  tags: ["store"],
  ...o,
});

/** Resolves a promise that waits on (fake) timers. */
async function settle<T>(p: Promise<T>) {
  await vi.runAllTimersAsync();
  return p;
}

function runServiceContract(name: string, make: () => Services) {
  describe(name, () => {
    let s: Services;
    beforeEach(() => {
      vi.useFakeTimers();
      s = make();
    });

    describe("auth", () => {
      it("rejects a wrong password with a readable error", async () => {
        const res = await settle(s.auth.signIn({ email: "a@b.co", password: "wrong", remember: true }));
        expect(res).toEqual({ ok: false, error: expect.stringContaining("Invalid email or password") });
        expect(useDemo.getState().auth).toBe(false);
      });

      it("signs in with email + password only (no second step), reports the user, signs out", async () => {
        expect(await s.auth.currentUser()).toBeNull();
        expect(await settle(s.auth.signIn({ email: "a@b.co", password: "demo", remember: false }))).toEqual({ ok: true });
        expect(useDemo.getState()).toMatchObject({ auth: true, remember: false });
        expect(await s.auth.currentUser()).toMatchObject({ email: expect.any(String), name: expect.any(String) });
        await s.auth.signOut();
        expect(useDemo.getState().auth).toBe(false);
        expect(await s.auth.currentUser()).toBeNull();
      });

      it("confirms a password reset with the shared password rules", async () => {
        expect(await s.auth.confirmPasswordReset("token", "short", "short")).toEqual({ ok: false, error: { pw: "Use at least 12 characters" } });
        expect(await s.auth.confirmPasswordReset("token", "a brand new passphrase", "x")).toEqual({ ok: false, error: { cf: "Passwords do not match" } });
        expect(await s.auth.confirmPasswordReset("token", "a brand new passphrase", "a brand new passphrase")).toEqual({ ok: true });
      });

      it("takes the prototype's 900 ms to sign in", async () => {
        let done = false;
        void s.auth.signIn({ email: "a@b.co", password: "demo", remember: true }).then(() => (done = true));
        await vi.advanceTimersByTimeAsync(MOCK_LATENCY.signIn - 1);
        expect(done).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(done).toBe(true);
      });

      it("validates the password-reset email", async () => {
        expect(await s.auth.requestPasswordReset("x")).toEqual({ ok: false, error: "Enter a valid email address" });
        expect(await s.auth.requestPasswordReset("you@example.com")).toEqual({ ok: true });
      });
    });

    describe("machines", () => {
      it("creates a machine with no status until a valid check, no history and no ZeroTier member ID", async () => {
        const res = await s.machines.create(input());
        if (!res.ok) throw new Error("expected ok");
        expect(res.machine).toMatchObject({ name: "PisoWiFi 03", status: null, hist: false, checkedAt: null, okAt: null });
        expect(res.machine).not.toHaveProperty("ztMember");
        expect(useDemo.getState().machines.map((m) => m.id)).toContain(res.machine.id);
      });

      it("refuses invalid or duplicate machines and leaves data unchanged", async () => {
        const before = useDemo.getState().machines.length;
        const res = await s.machines.create(input({ name: "PisoWiFi 01", ip: "192.168.194.82" }));
        expect(res).toEqual({ ok: false, error: { name: "Another machine already uses this name", ip: "This IP is already registered" } });
        expect(useDemo.getState().machines).toHaveLength(before);
      });

      it("updates in place (keeping status) and validates against other machines", async () => {
        const res = await s.machines.update("m2", input({ name: "PisoWiFi 02", ip: "192.168.194.127", loc: "Upstairs" }));
        expect(res.ok && res.machine).toMatchObject({ id: "m2", loc: "Upstairs", status: "unreachable" });
        const dup = await s.machines.update("m2", input({ name: "PisoWiFi 01" }));
        expect(dup.ok).toBe(false);
      });

      it("removes a machine and moves the selection", async () => {
        useDemo.getState().selectMachine("m1");
        await s.machines.remove("m1");
        expect(useDemo.getState().machines.map((m) => m.id)).toEqual(["m2"]);
        expect(useDemo.getState().sel).toBe("m2");
      });

      it("runs a check after the delay, logging an event (no request is sent)", async () => {
        const events = useDemo.getState().extraEvents.length;
        await settle(s.machines.runCheck(["m1", "m2"]));
        const ev = useDemo.getState().extraEvents;
        expect(ev).toHaveLength(events + 2);
        expect(ev.at(-1)!.msg).toBe("Demo check completed (simulated). No request was sent.");
      });

      it("toggles monitoring and simulates states", async () => {
        expect(await s.machines.toggleMonitoring("m1")).toBe(false);
        expect(await s.machines.toggleMonitoring("m1")).toBe(true);
        await s.machines.simulateStatus("m1", "unreachable");
        expect(useDemo.getState().machines[0]).toMatchObject({ status: "unreachable" });
        expect(useDemo.getState().extraEvents.at(-1)).toMatchObject({ type: "outage", st: "unreachable", msg: "Demo: became Offline" });
      });
    });

    describe("settings and automations", () => {
      it("saves profile and monitoring preferences only when valid", async () => {
        expect((await s.settings.saveProfile({ name: "", email: "x" })).ok).toBe(false);
        expect(await s.settings.saveProfile({ name: "Rey", email: "rey@example.com" })).toEqual({ ok: true });
        expect(useDemo.getState().profile).toEqual({ name: "Rey", email: "rey@example.com" });
        expect((await s.settings.saveMonitoring({ interval: "60", timeout: "99", thr: "3" })).ok).toBe(false);
        expect(await s.settings.saveMonitoring({ interval: "300", timeout: "10", thr: "5" })).toEqual({ ok: true });
        expect(useDemo.getState().mon).toEqual({ interval: "300", timeout: "10", thr: "5" });
      });

      it("password change validates and never stores the password", async () => {
        expect((await s.settings.changePassword("a", "short", "short")).ok).toBe(false);
        expect(await s.settings.changePassword("old-password", "new-password-123", "new-password-123")).toEqual({ ok: true });
        expect(JSON.stringify(useDemo.getState())).not.toContain("new-password-123");
      });

      it("sessions, notifications and rules", async () => {
        expect((await s.settings.listSessions()).map((x) => x.id)).toEqual(["s1", "s2", "s3"]);
        await s.settings.signOutSession("s2");
        expect(useDemo.getState().sessions.map((x) => x.id)).toEqual(["s1", "s3"]);
        await s.settings.signOutOtherSessions();
        expect(useDemo.getState().sessions.map((x) => x.id)).toEqual(["s1"]);
        await s.settings.setNotification("quiet", true);
        expect(useDemo.getState().notif.quiet).toBe(true);
        await s.automations.setRule("recovery", false);
        expect(useDemo.getState().auto.rules.recovery).toBe(false);
      });
    });
  });
}

runServiceContract("mock services", createMockServices);

describe("getServices", () => {
  it("returns one shared instance and can be replaced in tests", () => {
    expect(getServices()).toBe(getServices());
    const fake = createMockServices();
    setServicesForTesting(fake);
    expect(getServices()).toBe(fake);
  });
});
