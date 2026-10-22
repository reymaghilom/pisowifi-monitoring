/* API machine service (B6): registered machines from the PisoWiFi API, mirrored into the store so the existing
   views keep reading one place. Statuses come only from verified API records;
   nothing here simulates a check or a state. */
import { apiErrorSchema, connectivityOf, machineListResponseSchema, machineSchema, type MachineDto } from "@pisowifi/shared";
import type { Machine, MachineInput } from "@/lib/types";
import type { MachineErrors } from "@/lib/validation";
import type { MachineService } from "@/lib/services/types";
import { useDemo } from "@/stores/demo-store";

const API = "/api/v1";
const UNREACHABLE = "Can't reach the server. Check your connection and try again.";

const ms = (iso: string | null) => {
  const value = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(value) ? value : null;
};

export function toMachine(d: MachineDto): Machine {
  const checkedAt = ms(d.state.lastCheckAt);
  return {
    id: d.id,
    name: d.name,
    loc: d.location ?? "",
    desc: d.description ?? "",
    sw: d.software,
    ver: d.softwareVersion ?? "",
    ztNet: d.ztNetworkId ?? "",
    ip: d.ztIp,
    path: d.adminPath,
    tags: d.tags,
    hist: false, // no sample history for real machines
    monitor: d.state.monitoringEnabled,
    // Two statuses only; "unknown" (and legacy stored states) mean no valid check yet.
    status: checkedAt === null ? null : connectivityOf(d.state.http),
    checkedAt,
    okAt: checkedAt === null ? null : ms(d.state.lastSuccessAt),
    did: d.id,
  };
}

/** The form's fields → API body. The ZeroTier member ID is backend-only and never sent from the UI. */
const toBody = (f: MachineInput) => ({
  name: f.name,
  location: f.loc,
  description: f.desc,
  software: f.sw,
  softwareVersion: f.ver,
  ztNetworkId: f.ztNet,
  ztIp: f.ip,
  adminPath: f.path,
  tags: f.tags,
});

/** API field → form field. */
const FIELD: Record<string, keyof MachineErrors> = { name: "name", software: "sw", ztIp: "ip", adminPath: "path", ztNetworkId: "ztNet" };

async function call(path: string, init: RequestInit = {}) {
  return fetch(API + path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
  }).catch(() => null);
}

/** API errors as form errors; anything not tied to a field (403, network, server) shows on the name field. */
async function formErrors(res: Response | null): Promise<MachineErrors> {
  if (!res) return { name: UNREACHABLE };
  const body = apiErrorSchema.safeParse(await res.json().catch(() => null));
  if (!body.success) return { name: UNREACHABLE };
  const out: MachineErrors = {};
  for (const [k, v] of Object.entries(body.data.error.fields ?? {})) {
    const f = FIELD[k];
    if (f && !out[f]) out[f] = v;
  }
  return Object.keys(out).length ? out : { name: body.data.error.message };
}

const store = () => useDemo.getState();

/** Registration policy (GET /machines/policy): the API validates every Add/Edit against it. */
export interface MachinePolicy {
  allowedRanges: string[];
  networkId: string | null;
  maxMachines: number;
  registered: number;
}

/** Null when it can't be loaded (the form still works; the API reports any policy error on the field). */
export async function fetchMachinePolicy(signal?: AbortSignal): Promise<MachinePolicy | null> {
  const res = await fetch(API + "/machines/policy", { credentials: "same-origin", cache: "no-store", headers: { accept: "application/json" }, signal }).catch(() => null);
  if (!res?.ok) return null;
  const j = (await res.json().catch(() => null)) as Partial<MachinePolicy> | null;
  return j && Array.isArray(j.allowedRanges) && typeof j.maxMachines === "number"
    ? { allowedRanges: j.allowedRanges.filter((s) => typeof s === "string"), networkId: typeof j.networkId === "string" ? j.networkId : null, maxMachines: j.maxMachines, registered: Number(j.registered) || 0 }
    : null;
}

/** Replace one machine in the store (or add it). */
function put(m: Machine) {
  const s = store();
  const exists = s.machines.some((x) => x.id === m.id);
  s.patch({ machines: exists ? s.machines.map((x) => (x.id === m.id ? m : x)) : [...s.machines, m], sel: s.sel ?? m.id });
}

export function createApiMachineService(): MachineService {
  return {
    async list() {
      // The initial page can show a skeleton; background refreshes keep the current verified state visible.
      const initialLoad = store().machinesLoading;
      try {
        const res = await call("/machines");
        if (!res?.ok) throw new Error(`could not load machines (${res?.status ?? "network"})`);
        const machines = machineListResponseSchema.parse(await res.json()).items.map(toMachine);
        const sel = store().sel;
        store().patch({ machines, sel: sel && machines.some((m) => m.id === sel) ? sel : (machines[0]?.id ?? null) });
        return machines;
      } finally {
        if (initialLoad) store().patch({ machinesLoading: false });
      }
    },
    async create(input) {
      const res = await call("/machines", { method: "POST", body: JSON.stringify(toBody(input)) });
      if (!res?.ok) return { ok: false, error: await formErrors(res) };
      const machine = toMachine(machineSchema.parse(await res.json()));
      put(machine);
      return { ok: true, machine };
    },
    async update(id, input) {
      const res = await call(`/machines/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(toBody(input)) });
      if (!res?.ok) return { ok: false, error: await formErrors(res) };
      const machine = toMachine(machineSchema.parse(await res.json()));
      put(machine);
      return { ok: true, machine };
    },
    async remove(id) {
      const res = await call(`/machines/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res || (!res.ok && res.status !== 404)) throw new Error(await formErrors(res).then((e) => e.name ?? "Delete failed"));
      store().deleteMachine(id);
    },
    async runCheck() {
      // Live checks arrive with monitoring (B8). Nothing runs; no status changes.
    },
    async toggleMonitoring(id) {
      const current = store().machines.find((m) => m.id === id);
      const res = await call(`/machines/${encodeURIComponent(id)}/monitoring`, { method: "PATCH", body: JSON.stringify({ enabled: !current?.monitor }) });
      if (!res?.ok) throw new Error(await formErrors(res).then((e) => e.name ?? "Could not change monitoring"));
      const machine = toMachine(machineSchema.parse(await res.json()));
      put(machine);
      return machine.monitor;
    },
    async simulateStatus() {
      // Demo-only control; statuses are never fabricated in API mode.
    },
  };
}
