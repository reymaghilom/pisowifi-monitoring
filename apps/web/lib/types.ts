/* Connectivity and software type come from @pisowifi/shared, so the web app and the API use one definition.
   Users see two connectivity statuses only: Online and Offline (internally "reachable" / "unreachable"). A machine without a valid check has no
   status (null), never a guessed one. */
import type { Connectivity, SoftwareType } from "@pisowifi/shared";
export type { SoftwareType };

/** The two user-facing connectivity statuses. */
export type MachineStatus = Connectivity;

/** Monitoring history events users see: status changes and (demo) checks. */
export type EventType = "outage" | "recovery" | "check";

/** Status vocabulary from the design system (components/index.d.ts). Every state is a word + icon + colour. */
export type StatusKey =
  | "reachable"
  | "unreachable"
  | "soon"
  | "notconn"
  | "demo"
  | "sample"
  | "proto"
  | "enabled"
  | "paused"
  | "failed"
  | "nodata";

export interface Machine {
  id: string;
  name: string;
  loc: string;
  desc: string;
  sw: SoftwareType;
  ver: string;
  /** Optional ZeroTier network ID (16 hex characters). There is intentionally no member ID. */
  ztNet: string;
  ip: string;
  path: string;
  tags: string[];
  /** Whether sample history exists for this machine. */
  hist: boolean;
  monitor: boolean;
  /** Result of the last valid check; null until one exists. Monitoring-side failures never change it. */
  status: MachineStatus | null;
  /** Time of the last valid check. */
  checkedAt: number | null;
  /** Last time a check found the machine Online. */
  okAt: number | null;
  did: string;
}

/** Fields edited by the Add/Edit machine form. */
export interface MachineInput {
  name: string;
  loc: string;
  desc: string;
  sw: SoftwareType;
  ver: string;
  ztNet: string;
  ip: string;
  path: string;
  tags: string[];
}

export interface MonitoringEvent {
  t: number;
  m: string;
  type: EventType;
  st: MachineStatus;
  msg: string;
  /** Outage duration in minutes. */
  dur?: number;
}

export interface HistoryPoint {
  a: number;
  b: number;
  label: string;
  up: number;
  rt: number;
  down: number;
  mins: number;
  outs?: number;
}

export type Range = "24" | "7" | "14" | "30";
export type HistRange = Range | "custom";
export type ViewState = "normal" | "loading" | "empty" | "error";
export type ThemePref = "light" | "dark" | "system";

export type ChartSeriesClass = "l1" | "l2" | "b1" | "b2";

export interface ChartSeries {
  id: string;
  name: string;
  cls: ChartSeriesClass;
  /** null: no data for that slot (drawn as a gap, never as a value) */
  v: (number | null)[];
}

export interface LineChartConfig {
  labels: string[];
  series: ChartSeries[];
  min: number;
  max: number;
  unit: string;
  ticks?: number;
  alt: string;
}

export interface BarGroup {
  label: string;
  v: Record<string, number>;
}

export interface BarChartConfig {
  groups: BarGroup[];
  series: { id: string; name: string; cls: "b1" | "b2" }[];
  max: number;
  unit?: string;
  alt: string;
}
