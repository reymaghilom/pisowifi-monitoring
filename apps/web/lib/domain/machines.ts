import type { Machine, MachineStatus } from "@/lib/types";

export type MachineSort = "name" | "status" | "seen" | "ip";
export type StatusFilter = "all" | MachineStatus;

export function machineById(machines: Machine[], id: string | null | undefined) {
  return machines.find((m) => m.id === id);
}

export function machineName(machines: Machine[], id: string) {
  return machineById(machines, id)?.name ?? "Removed machine";
}

/** My PisoWiFi search (name, IP, location, tags, software), status filter and sort. Does not mutate. */
export function filterMachines(machines: Machine[], query: string, status: StatusFilter, sort: MachineSort) {
  const q = query.trim().toLowerCase();
  const list = machines.filter((m) => {
    if (status !== "all" && m.status !== status) return false;
    if (!q) return true;
    return (m.name + " " + m.ip + " " + m.loc + " " + m.tags.join(" ") + " " + m.sw).toLowerCase().includes(q);
  });
  return list.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name, undefined, { numeric: true });
    if (sort === "status") return (a.status ?? "~").localeCompare(b.status ?? "~");
    if (sort === "seen") return (b.checkedAt || 0) - (a.checkedAt || 0);
    return a.ip.localeCompare(b.ip, undefined, { numeric: true });
  });
}

/** Dashboard KPI counts: Online, Offline, and machines without a valid check yet (no status). */
export function machineCounts(machines: Machine[]) {
  const c = { tot: machines.length, ok: 0, bad: 0, none: 0 };
  machines.forEach((m) => {
    if (m.status === "reachable") c.ok++;
    else if (m.status === "unreachable") c.bad++;
    else c.none++;
  });
  return c;
}

/** Machines that need the dashboard's red banner. */
export function unreachableMachines(machines: Machine[]) {
  return machines.filter((m) => m.status === "unreachable");
}

export function monitoringText(mon: { interval: string; timeout: string; thr: string }) {
  const i = +mon.interval;
  return "Every " + (i >= 60 ? i / 60 + " min" : i + " s") + " · timeout " + mon.timeout + " s · Offline on a verified failed check";
}
