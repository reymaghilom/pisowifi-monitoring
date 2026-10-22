"use client";

/* Demo state: a 1:1 port of the prototype's single `S` object.
   Session memory only (sessionStorage), like the prototype.
   UI state lives here; data writes go through lib/services (the mock services call the
   data actions below). Derived queries live in lib/domain. */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { MIN } from "@/lib/format";
import { API_MODE, STATUS_PRESETS, type RuleKey } from "@/lib/constants";
import type { HistFilters } from "@/lib/domain/history";
import { DEFAULT_HIST } from "@/lib/domain/history";
import type {
  Machine,
  MachineInput,
  MachineStatus,
  MonitoringEvent,
  Range,
  ThemePref,
  ViewState,
} from "@/lib/types";

export type Modal =
  | { type: "form"; id: string | null }
  | { type: "delete"; id: string }
  | { type: "success"; id: string; msg: string; again: boolean };

export type SettingsSection =
  | "profile"
  | "security"
  | "sessions"
  | "theme"
  | "monitoring"
  | "zerotier"
  | "notifications"
  | "automation";

export interface SessionRow {
  id: string;
  name: string;
  meta: string;
  cur?: boolean;
}

export interface NotifPrefs {
  email: boolean;
  offline: boolean;
  recovery: boolean;
  quiet: boolean;
}


function withStatus(m: Machine, st: MachineStatus | null, now = Date.now()): Machine {
  if (!st) return { ...m, status: null, checkedAt: null, okAt: null };
  const p = STATUS_PRESETS[st];
  return { ...m, status: st, checkedAt: now - p.checked * MIN, okAt: now - p.ok * MIN };
}

export function makeMachine(o: Partial<Machine> & Pick<Machine, "id" | "name" | "ip">, status: MachineStatus | null = null): Machine {
  const base: Machine = {
    loc: "",
    desc: "",
    tags: [],
    ztNet: "",
    hist: false,
    monitor: true,
    ver: "",
    sw: "WiFi5Soft",
    path: "/admin",
    did: "demo-" + o.id,
    status,
    checkedAt: null,
    okAt: null,
    ...o,
  };
  return withStatus(base, status);
}

function seedMachines(): Machine[] {
  return [
    makeMachine(
      { id: "m1", name: "PisoWiFi 01", loc: "Location not set (demo)", sw: "WiFi5Soft", ver: "v3.5.84", ip: "192.168.194.82", path: "/admin", tags: ["demo", "primary"], hist: true, did: "demo-m1-0001" },
      "reachable",
    ),
    makeMachine(
      { id: "m2", name: "PisoWiFi 02", loc: "Location not set (demo)", sw: "WiFi5Soft", ver: "", ip: "192.168.194.127", path: "/admin", tags: ["demo"], hist: true, did: "demo-m2-0002" },
      "unreachable",
    ),
  ];
}

interface DemoState {
  /* auth (mock) */
  auth: boolean;
  remember: boolean;
  /** Signed-in user's role. Mock: always admin. API: from the server; only hides controls (the API enforces). */
  role: "admin" | "viewer";
  /** Signed-in user's account id (API mode; null in the demo). Lets Manage Users recognise "you" by id, not email. */
  uid: string | null;

  /* shell */
  theme: ThemePref;
  collapsed: boolean;
  drawer: boolean;
  view: ViewState;
  busy: boolean;
  modal: Modal | null;

  /* data */
  machines: Machine[];
  /** API mode: true until the first machine list arrives (pages show their skeleton, not the empty state). */
  machinesLoading: boolean;
  sel: string | null;
  seq: number;
  extraEvents: MonitoringEvent[];

  /* page filters */
  mq: string;
  mstatus: "all" | MachineStatus;
  msort: "name" | "status" | "seen" | "ip";
  dashRange: Range;
  hide: Record<string, boolean>;
  hist: HistFilters;
  rep: { period: "weekly" | "monthly"; sort: "name" | "up" | "outs" | "rt"; dir: 1 | -1 };
  remote: { m: string | null };
  auto: { hf: "all" | "failed" | "skipped"; rule: RuleKey; rules: Record<RuleKey, boolean> };

  /* settings */
  profile: { name: string; email: string };
  mon: { interval: string; timeout: string; thr: string };
  notif: NotifPrefs;
  sessions: SessionRow[];

  /* actions */
  patch: (p: Partial<DemoState>) => void;
  signIn: (remember: boolean) => void;
  signOut: () => void;
  setTheme: (t: ThemePref) => void;
  setView: (v: ViewState) => void;
  openModal: (m: Modal | null) => void;
  toggleHide: (key: string) => void;
  addMachine: (f: MachineInput) => string;
  updateMachine: (id: string, f: MachineInput) => void;
  deleteMachine: (id: string) => void;
  selectMachine: (id: string) => void;
  setMachineStatus: (id: string, st: MachineStatus | null, label: string) => void;
  toggleMonitor: (id: string) => boolean;
  /** Records a finished (simulated) check: refreshes last seen / last OK and logs an event. */
  recordCheck: (ids: string[]) => void;
  addEvent: (e: Omit<MonitoringEvent, "t">) => void;
}

const storage = createJSONStorage(() =>
  typeof window === "undefined"
    ? { getItem: () => null, setItem: () => {}, removeItem: () => {} }
    : window.sessionStorage,
);

export const useDemo = create<DemoState>()(
  persist(
    (set, get) => ({
      auth: false,
      remember: true,
      role: "admin",
      uid: null,
      theme: "system",
      collapsed: false,
      drawer: false,
      view: "normal",
      busy: false,
      modal: null,

      // API mode: machines come from the API (AppShell loads them); no demo machines, ever.
      machines: API_MODE ? [] : seedMachines(),
      machinesLoading: API_MODE,
      sel: API_MODE ? null : "m1",
      seq: 2,
      extraEvents: [],

      mq: "",
      mstatus: "all",
      msort: "name",
      dashRange: "14",
      hide: {},
      hist: DEFAULT_HIST,
      rep: { period: "weekly", sort: "up", dir: -1 },
      remote: { m: "m1" },
      auto: { hf: "all", rule: "outage", rules: { outage: true, recovery: true } },

      profile: { name: "Operator", email: "operator@example.com" },
      mon: { interval: "60", timeout: "5", thr: "3" },
      notif: { email: false, offline: true, recovery: true, quiet: false },
      sessions: [
        { id: "s1", name: "This browser", meta: "Sample · active now", cur: true },
        { id: "s2", name: "Phone", meta: "Sample · 2 days ago" },
        { id: "s3", name: "Laptop", meta: "Sample · 6 days ago" },
      ],

      patch: (p) => set(p),
      signIn: (remember) => set({ auth: true, remember }),
      signOut: () => set({ auth: false, drawer: false, modal: null, view: "normal" }),
      setTheme: (theme) => set({ theme }),
      setView: (view) => set({ view }),
      openModal: (modal) => set({ modal }),
      toggleHide: (key) => set((s) => ({ hide: { ...s.hide, [key]: !s.hide[key] } })),

      addMachine: (f) => {
        const seq = get().seq + 1;
        const id = "m" + seq;
        const m = makeMachine({ id, ...f, did: "demo-" + id });
        set((s) => ({ seq, machines: [...s.machines, m] }));
        return id;
      },
      updateMachine: (id, f) =>
        set((s) => ({ machines: s.machines.map((m) => (m.id === id ? { ...m, ...f } : m)) })),
      deleteMachine: (id) =>
        set((s) => {
          const machines = s.machines.filter((m) => m.id !== id);
          const sel = s.sel === id ? (machines[0]?.id ?? null) : s.sel;
          return {
            machines,
            sel,
            remote: s.remote.m === id ? { ...s.remote, m: sel } : s.remote,
            hist: s.hist.m === id ? { ...s.hist, m: "all" } : s.hist,
          };
        }),
      selectMachine: (id) => set({ sel: id }),
      setMachineStatus: (id, st, label) => {
        const before = get().machines.find((m) => m.id === id)?.status ?? null;
        set((s) => ({ machines: s.machines.map((m) => (m.id === id ? withStatus(m, st) : m)) }));
        // Only a change of status is an event, like the future alerts (no repeat while it stays the same).
        if (st && st !== before) get().addEvent({ m: id, type: st === "unreachable" ? "outage" : "recovery", st, msg: "Demo: became " + label });
      },
      toggleMonitor: (id) => {
        const m = get().machines.find((x) => x.id === id);
        if (!m) return false;
        const monitor = !m.monitor;
        set((s) => ({ machines: s.machines.map((x) => (x.id === id ? { ...x, monitor } : x)) }));
        return monitor;
      },
      recordCheck: (ids) => {
        const now = Date.now();
        set((s) => ({
          machines: s.machines.map((m) => {
            if (!ids.includes(m.id)) return m;
            // A demo check repeats the current result; with no result yet there is nothing valid to record.
            if (!m.status) return m;
            return { ...m, checkedAt: now, okAt: m.status === "reachable" ? now : m.okAt };
          }),
        }));
        ids.forEach((id) => {
          const m = get().machines.find((x) => x.id === id);
          if (m?.status) get().addEvent({ m: id, type: "check", st: m.status, msg: "Demo check completed (simulated). No request was sent." });
        });
      },
      addEvent: (e) => set((s) => ({ extraEvents: [...s.extraEvents, { ...e, t: Date.now() }] })),
    }),
    {
      name: "pw-demo",
      storage,
      // Rehydrated explicitly after mount (StoreSync) so server and first client render match.
      skipHydration: true,
      // API mode: machine data saved by an earlier mock session in this tab must never come back as real data.
      merge: (persisted, current) => {
        const p = { ...(persisted as Partial<DemoState>) };
        if (API_MODE) for (const k of ["machines", "sel", "seq", "extraEvents", "machinesLoading"] as const) delete p[k];
        return { ...current, ...p };
      },
      partialize: (s) => ({
        auth: s.auth,
        remember: s.remember,
        role: s.role,
        uid: s.uid,
        collapsed: s.collapsed,
        ...(API_MODE ? {} : { machines: s.machines, sel: s.sel, seq: s.seq }),
        extraEvents: s.extraEvents,
        profile: s.profile,
        mon: s.mon,
        notif: s.notif,
        sessions: s.sessions,
        auto: s.auto,
      }),
    },
  ),
);

export type { HistFilters };
export { DEFAULT_HIST };
