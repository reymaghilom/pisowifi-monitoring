import { describe, expect, it } from "vitest";
import { MIN } from "@/lib/format";
import { makeMachine, useDemo } from "@/stores/demo-store";

describe("demo store", () => {
  it("seeds two demo machines: 01 Online, 02 Offline", () => {
    const [a, b] = useDemo.getState().machines;
    expect([a.name, a.status, a.ver, a.hist]).toEqual(["PisoWiFi 01", "reachable", "v3.5.84", true]);
    expect([b.name, b.status]).toEqual(["PisoWiFi 02", "unreachable"]);
  });

  it("status presets set last checked / last reachable; new machines have no status until a valid check", () => {
    const now = Date.now();
    const m = makeMachine({ id: "x", name: "X", ip: "1.1.1.1" }, "unreachable");
    expect(Math.round((now - m.checkedAt!) / MIN)).toBe(2);
    expect(Math.round((now - m.okAt!) / MIN)).toBe(25);
    expect(makeMachine({ id: "y", name: "Y", ip: "1.1.1.2" })).toMatchObject({ status: null, checkedAt: null, okAt: null, path: "/admin", sw: "WiFi5Soft" });
  });

  it("only a change of status is an event (no repeats while it stays the same)", () => {
    const events = () => useDemo.getState().extraEvents.filter((e) => e.type !== "check");
    useDemo.getState().setMachineStatus("m1", "reachable", "Online");
    expect(events()).toHaveLength(0);
    useDemo.getState().setMachineStatus("m1", "unreachable", "Offline");
    useDemo.getState().setMachineStatus("m1", "unreachable", "Offline");
    useDemo.getState().setMachineStatus("m1", "reachable", "Online");
    expect(events().map((e) => e.type)).toEqual(["outage", "recovery"]);
  });

  it("deleting the machine shown elsewhere resets those views", () => {
    useDemo.setState({ remote: { m: "m1" }, hist: { ...useDemo.getState().hist, m: "m1" } });
    useDemo.getState().deleteMachine("m1");
    expect(useDemo.getState()).toMatchObject({ sel: "m2", remote: { m: "m2" }, hist: { m: "all" } });
  });

  it("legend toggles are per chart and series", () => {
    useDemo.getState().toggleHide("dashm1");
    expect(useDemo.getState().hide).toEqual({ dashm1: true });
    useDemo.getState().toggleHide("dashm1");
    expect(useDemo.getState().hide).toEqual({ dashm1: false });
  });

  it("persists session data but not transient UI state", () => {
    useDemo.getState().patch({ view: "loading", drawer: true, profile: { name: "Rey", email: "r@x.io" } });
    const saved = JSON.parse(sessionStorage.getItem("pw-demo")!).state;
    expect(saved.profile.name).toBe("Rey");
    expect(saved).not.toHaveProperty("view");
    expect(saved).not.toHaveProperty("drawer");
    expect(saved).not.toHaveProperty("theme");
  });
});
