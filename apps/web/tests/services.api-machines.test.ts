/* API data source, machines (B6): CRUD against the API, mirrored into the store; no simulated statuses. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApiMachineService, toMachine } from "@/lib/services/api/machines";
import { useDemo } from "@/stores/demo-store";
import type { MachineInput } from "@/lib/types";

const ID = "6f1c2a4e-8b1d-4c3e-9f2a-1b2c3d4e5f60";
const dto = (o: Record<string, unknown> = {}, state: Record<string, unknown> = {}) => ({
  id: ID,
  name: "PisoWiFi 01",
  location: null,
  description: null,
  software: "WiFi5Soft",
  softwareVersion: null,
  ztNetworkId: null,
  ztMemberId: null,
  ztIp: "192.168.194.82",
  adminPath: "/admin",
  tags: [],
  state: {
    http: "unknown",
    lastCheckAt: null,
    lastSuccessAt: null,
    zeroTier: "unknown",
    zeroTierLastSeenAt: null,
    internet: "unverified",
    monitor: "unknown",
    monitoringEnabled: true,
    ...state,
  },
  createdAt: "2026-10-12T01:00:00.000Z",
  updatedAt: "2026-10-12T01:00:00.000Z",
  ...o,
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const input = (o: Partial<MachineInput> = {}): MachineInput => ({
  name: "PisoWiFi 01",
  loc: "",
  desc: "",
  sw: "WiFi5Soft",
  ver: "",
  ztNet: "",
  ip: "192.168.194.82",
  path: "/admin",
  tags: [],
  ...o,
});

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  useDemo.setState({ machines: [], sel: null });
});
afterEach(() => vi.unstubAllGlobals());

describe("API machine service", () => {
  it("maps a zero-check API machine to a neutral result (no sample history, real id)", () => {
    expect(toMachine(dto({ location: "Main", tags: ["primary"] }) as never)).toEqual({
      id: ID,
      name: "PisoWiFi 01",
      loc: "Main",
      desc: "",
      sw: "WiFi5Soft",
      ver: "",
      ztNet: "",
      ip: "192.168.194.82",
      path: "/admin",
      tags: ["primary"],
      hist: false,
      monitor: true,
      status: null,
      checkedAt: null,
      okAt: null,
      did: ID,
    });
    expect(toMachine(dto({}, { http: "reachable", lastCheckAt: null }) as never).status).toBeNull();
  });

  it("list replaces the store's machines (no demo machines) and selects the first", async () => {
    useDemo.setState({ machines: [{ ...toMachine(dto({ id: "m1" }) as never) }], sel: "m1" });
    fetchMock.mockResolvedValueOnce(json(200, { items: [dto()] }));
    const machines = await createApiMachineService().list();
    expect(machines.map((m) => m.id)).toEqual([ID]);
    expect(useDemo.getState()).toMatchObject({ sel: ID, machines: [{ id: ID }] });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/machines", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("initial list clears the loading state; a failed background refresh preserves the verified status", async () => {
    let seen: boolean | undefined;
    useDemo.setState({ machinesLoading: true });
    fetchMock.mockImplementationOnce(async () => {
      seen = useDemo.getState().machinesLoading;
      return json(200, { items: [dto()] });
    });
    await createApiMachineService().list();
    expect(seen).toBe(true);
    expect(useDemo.getState().machinesLoading).toBe(false);
    useDemo.setState({ machines: [toMachine(dto({}, { http: "reachable", lastCheckAt: "2026-10-12T12:44:07.810Z" }) as never)] });
    fetchMock.mockResolvedValueOnce(json(500, { error: { code: "internal_error", message: "x" } }));
    await expect(createApiMachineService().list()).rejects.toThrow();
    expect(useDemo.getState().machinesLoading).toBe(false);
    expect(useDemo.getState().machines[0]).toMatchObject({ status: "reachable", checkedAt: Date.parse("2026-10-12T12:44:07.810Z") });
  });

  it("create sends the form fields (never a member ID) and adds the machine", async () => {
    fetchMock.mockResolvedValueOnce(json(201, dto({ location: "Main", tags: ["store"] })));
    const res = await createApiMachineService().create(input({ loc: "Main", tags: ["store"] }));
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect([url, init.method]).toEqual(["/api/v1/machines", "POST"]);
    expect(JSON.parse(init.body)).toEqual({
      name: "PisoWiFi 01",
      location: "Main",
      description: "",
      software: "WiFi5Soft",
      softwareVersion: "",
      ztNetworkId: "",
      ztIp: "192.168.194.82",
      adminPath: "/admin",
      tags: ["store"],
    });
    expect(JSON.parse(init.body)).not.toHaveProperty("ztMemberId");
    expect(useDemo.getState().machines.map((m) => m.loc)).toEqual(["Main"]);
  });

  it("maps duplicate and validation errors to the form's fields; other errors show on the name", async () => {
    const svc = createApiMachineService();
    fetchMock.mockResolvedValueOnce(json(409, { error: { code: "conflict", message: "x", fields: { ztIp: "This IP is already registered" } } }));
    expect(await svc.create(input())).toEqual({ ok: false, error: { ip: "This IP is already registered" } });
    fetchMock.mockResolvedValueOnce(
      json(400, {
        error: {
          code: "validation_failed",
          message: "x",
          fields: { adminPath: "Admin path must start with /", ztNetworkId: "Network ID is 16 hex characters" },
        },
      }),
    );
    expect(await svc.create(input())).toEqual({ ok: false, error: { path: "Admin path must start with /", ztNet: "Network ID is 16 hex characters" } });
    fetchMock.mockResolvedValueOnce(json(403, { error: { code: "forbidden", message: "Only admins can do this." } }));
    expect(await svc.update(ID, input())).toEqual({ ok: false, error: { name: "Only admins can do this." } });
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    expect((await svc.create(input())).ok).toBe(false);
  });

  it("toggles monitoring through the API and reflects the stored result", async () => {
    useDemo.setState({ machines: [toMachine(dto() as never)], sel: ID });
    fetchMock.mockResolvedValueOnce(json(200, dto({}, { monitoringEnabled: false, monitor: "paused" })));
    expect(await createApiMachineService().toggleMonitoring(ID)).toBe(false);
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({ enabled: false });
    expect(useDemo.getState().machines[0]!.monitor).toBe(false);
  });

  it("deletes through the API; a refused delete throws and keeps the machine", async () => {
    useDemo.setState({ machines: [toMachine(dto() as never)], sel: ID });
    fetchMock.mockResolvedValueOnce(json(403, { error: { code: "forbidden", message: "Only admins can do this." } }));
    await expect(createApiMachineService().remove(ID)).rejects.toThrow("Only admins can do this.");
    expect(useDemo.getState().machines).toHaveLength(1);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await createApiMachineService().remove(ID);
    expect(useDemo.getState().machines).toHaveLength(0);
  });

  it("never fabricates: run check and simulate state send nothing and change nothing", async () => {
    const before = toMachine(dto() as never);
    useDemo.setState({ machines: [before], sel: ID });
    const svc = createApiMachineService();
    await svc.runCheck([ID]);
    await svc.simulateStatus(ID, "reachable");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(useDemo.getState().machines[0]).toEqual(before);
  });
});

describe("connectivity wording and monitoring-failure handling", () => {
  const at = "2026-10-19T05:00:00.000Z";
  it("an internal monitoring failure never turns a machine Offline: the last confirmed status is kept", () => {
    expect(toMachine(dto({}, { http: "reachable", lastCheckAt: at, lastSuccessAt: at, monitor: "error" }) as never).status).toBe("reachable");
    expect(toMachine(dto({}, { http: "unreachable", lastCheckAt: at, lastSuccessAt: null, monitor: "error" }) as never).status).toBe("unreachable");
  });

  it("legacy or internal states are no status (no third category), never Offline", () => {
    for (const http of ["unknown", "stale", "error"]) {
      expect(toMachine(dto({}, { http, lastCheckAt: at }) as never).status).toBeNull();
    }
  });

  it("users see Online / Offline; the internal values stay reachable / unreachable", async () => {
    const { STATUS, STATUS_LABEL, EVLABEL } = await import("@/lib/constants");
    expect(STATUS_LABEL).toEqual({ reachable: "Online", unreachable: "Offline" });
    expect(STATUS.reachable).toEqual(["ok", "check", "Online"]);
    expect(STATUS.unreachable).toEqual(["bad", "x", "Offline"]);
    expect(EVLABEL).toMatchObject({ outage: "Offline", recovery: "Online" });
  });
});

describe("tags on edit (the Tags field was removed from the form)", () => {
  it("update sends the machine's existing tags back, so an edit never erases them", async () => {
    useDemo.setState({ machines: [toMachine(dto({ tags: ["store", "primary"] }) as never)], sel: ID });
    fetchMock.mockResolvedValueOnce(json(200, dto({ location: "Annex", tags: ["store", "primary"] })));
    const res = await createApiMachineService().update(ID, input({ loc: "Annex", tags: ["store", "primary"] }));
    expect(res.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain(ID);
    expect(JSON.parse(init.body).tags).toEqual(["store", "primary"]);
  });
});
