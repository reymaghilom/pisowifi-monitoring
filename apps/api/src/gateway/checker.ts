/* Admin HTTP checks through the gateway (Phase PC2), shared by the API routes and the gateway:check CLI.

   Only registered WiFi5Soft machines are checked: the target comes from the machine record (ztIp + adminPath) and
   server configuration, never from a request (see ./target.ts). Each check is one bounded GET (./probe.ts).

   Only valid results are recorded, and there are two: reachable (the machine answered over HTTP) and unreachable (no
   answer while this monitoring host's own ZeroTier node is confirmed online). A valid result adds one `checks` row
   (trigger manual or schedule) and updates the admin HTTP signal in machine_state (status, last check, last success,
   consecutive failures). Monitoring-side failures are never blamed on the machine and write nothing, so the last
   valid result stays: gateway disabled or offline, target refused, or no answer while the gateway node's own state
   can't be confirmed (no local ZeroTier API configured). Customer internet stays "unverified".

   Status changes: when a valid result changes the stored status from reachable (Reachable) to unreachable (Unreachable) or back, the same
   transaction (machine_state row locked) adds an `events` row (outage | recovery), opens or closes the `outages`
   row and, when N8N_ENABLED, queues one notification (../notifications). A first result (from unknown) or an
   unchanged status is not a change: nothing is queued, so alerts never repeat while the status stays the same. */
import { and, eq, sql } from "drizzle-orm";
import type { GatewayCheck, GatewayErrorCode, GatewayState } from "@pisowifi/shared";
import type { Config } from "../config/env.js";
import type { Db } from "../db/client.js";
import { randomUUID } from "node:crypto";
import { checks, events, machineState, machines, notificationDeliveries, outages } from "../db/schema/index.js";
import { buildPayload } from "../notifications/payload.js";
import { notificationRecipients } from "../notifications/recipients.js";
import { requireOrm } from "../auth/helpers.js";
import { mapLimit, probeAdmin, type GatewayTransport, type ProbeResult } from "./probe.js";
import { parseCidrList, resolveTarget, targetUrl, type GatewayTarget } from "./target.js";
import { parseDenyList } from "./policy.js";
import type { EgressGate } from "./egress.js";
import type { ZeroTierClient } from "./zerotier.js";

const NODE_STATE_TTL_MS = 10_000;

export interface MachineTarget {
  id: string;
  ztIp: string;
  adminPath: string;
}

export type CheckOutcome = GatewayCheck & { refusal?: GatewayErrorCode; target?: GatewayTarget };

export const publicCheck = ({ refusal: _r, target: _t, ...c }: CheckOutcome): GatewayCheck => c;

const targetColumns = { id: machines.id, ztIp: machines.ztIp, adminPath: machines.adminPath };
const isWiFi5Soft = eq(machines.software, "WiFi5Soft");

export interface CheckerOptions {
  config: Config;
  db: Db | null;
  transport: GatewayTransport;
  zerotier: ZeroTierClient | null;
  /** Called after a status change was committed (e.g. to deliver its notification right away). */
  onStatusChange?: () => void;
  /** Worker with a kernel egress allowlist: only addresses the kernel allows are checked (./egress.ts). */
  egress?: EgressGate | null;
}

export type CheckTrigger = "manual" | "schedule";
type ValidProbe = ProbeResult & { adminHttp: "reachable" | "unreachable" };
const isValidProbe = (probe: ProbeResult): probe is ValidProbe => probe.adminHttp === "reachable" || probe.adminHttp === "unreachable";

export function createGatewayChecker(opts: CheckerOptions) {
  const { config, db, transport, zerotier } = opts;
  const onStatusChange = opts.onStatusChange ?? (() => {});
  const allowed = parseCidrList(config.ZT_ALLOWED_CIDRS);
  const denied = parseDenyList(config.ZT_DENY_IPS);
  const approved = config.MONITOR_APPROVED_IPS ? parseDenyList(config.MONITOR_APPROVED_IPS) : null;
  const egress = opts.egress ?? null;
  const rules = { allowed, port: config.GATEWAY_TARGET_PORT, denied };
  const orm = () => requireOrm(db);

  let nodeCache: { state: GatewayState; at: number } | null = null;
  async function nodeState(force = false): Promise<GatewayState> {
    if (!config.GATEWAY_ENABLED) return "disabled";
    if (!zerotier) return "unknown";
    if (!force && nodeCache && Date.now() - nodeCache.at < NODE_STATE_TTL_MS) return nodeCache.state;
    nodeCache = { state: await zerotier.nodeState(), at: Date.now() };
    return nodeCache.state;
  }

  /** Records a valid result. Returns true when it changed the status between Reachable and Unreachable. */
  async function record(machineId: string, probe: ValidProbe, startedAt: Date, trigger: CheckTrigger): Promise<boolean> {
    const ok = probe.adminHttp === "reachable";
    const now = new Date();
    return orm().transaction(async (tx) => {
      // Lock the state row so concurrent checks of one machine see each other's result (no double transition).
      const [m] = await tx.select({ name: machines.name, ip: machines.ztIp }).from(machines).where(eq(machines.id, machineId)).limit(1);
      if (!m) return false;
      const [prev] = await tx.select({ http: machineState.httpStatus }).from(machineState).where(eq(machineState.machineId, machineId)).for("update");
      const from = prev?.http ?? "unknown";
      const to = probe.adminHttp;
      const [c] = await tx
        .insert(checks)
        .values({ machineId, startedAt, durationMs: probe.latencyMs, ok, httpCode: probe.httpStatus, errorKind: ok ? null : (probe.error ?? "monitor"), trigger })
        .returning({ id: checks.id });
      const state = { httpStatus: to, lastCheckAt: now, ...(ok ? { lastSuccessAt: now } : {}) };
      await tx
        .insert(machineState)
        .values({ machineId, ...state, consecutiveFailures: ok ? 0 : 1 })
        .onConflictDoUpdate({ target: machineState.machineId, set: { ...state, consecutiveFailures: ok ? 0 : sql`${machineState.consecutiveFailures} + 1` } });

      const changed = (from === "reachable" && to === "unreachable") || (from === "unreachable" && to === "reachable");
      if (!changed) return false;
      const down = to === "unreachable";
      const [ev] = await tx
        .insert(events)
        .values({ machineId, type: down ? "outage" : "recovery", status: to, message: down ? "Became Unreachable" : "Became Reachable", meta: { from, to, checkId: c!.id }, occurredAt: now })
        .returning({ id: events.id });
      // Recovery closes the open outage; its start (the committed Offline change) is the only source of downtime.
      let outageStartedAt: Date | null = null;
      if (down) await tx.insert(outages).values({ machineId, startedAt: now }).onConflictDoNothing();
      else {
        const [closed] = await tx
          .update(outages)
          .set({ endedAt: now })
          .where(and(eq(outages.machineId, machineId), sql`${outages.endedAt} is null`))
          .returning({ startedAt: outages.startedAt });
        outageStartedAt = closed?.startedAt ?? null;
      }
      if (config.N8N_ENABLED) {
        const kind = down ? "unreachable" : "reachable";
        // Recipients are fixed now, with the change; nobody to notify (all accounts disabled/opted out) = no delivery.
        const recipients = await notificationRecipients(tx as never, kind);
        if (recipients.length) {
          const id = randomUUID();
          const payload = buildPayload({ eventId: id, kind, machine: { id: machineId, name: m.name, ip: m.ip.replace(/\/32$/, "") }, detectedAt: now, recipients, outageStartedAt });
          await tx.insert(notificationDeliveries).values({ id, eventId: ev!.id, machineId, kind, payload });
        }
      }
      return true;
    });
  }

  /** Live check of one machine. Three separate answers: gateway, admin HTTP, internet (never verified here). */
  async function check(m: MachineTarget, trigger: CheckTrigger = "manual", egressAllowed?: ReadonlySet<string>): Promise<CheckOutcome> {
    const base = { machineId: m.id, internet: "unverified" as const, httpStatus: null, latencyMs: null };
    const at = () => new Date().toISOString();
    const gateway = await nodeState();
    if (gateway === "disabled") return { ...base, gateway, adminHttp: "unknown", error: null, checkedAt: at(), refusal: "gateway_disabled" };
    const resolved = resolveTarget(m, rules);
    // The admin path must also resolve onto the target itself (no "//host", traversal or control characters).
    if (!resolved.ok || !targetUrl(resolved.target, resolved.target.adminPath)) {
      return { ...base, gateway, adminHttp: "unknown", error: "monitor", checkedAt: at(), refusal: "target_not_allowed" };
    }
    if (approved && !approved.has(resolved.target.ip)) {
      return { ...base, gateway, adminHttp: "unknown", error: "monitor", checkedAt: at(), refusal: "target_not_allowed" };
    }
    // Not (yet) confirmed in the applied file AND the effective kernel allowlist: monitoring-side refusal, nothing recorded.
    if (egress && !(egressAllowed ?? (await egress.applied())).has(resolved.target.ip)) {
      return { ...base, gateway, adminHttp: "unknown", error: "monitor", checkedAt: at(), refusal: "egress_pending" };
    }
    if (gateway === "offline") return { ...base, gateway, adminHttp: "unknown", error: "monitor", checkedAt: at(), refusal: "gateway_offline" };
    const startedAt = new Date();
    const probe = await probeAdmin(resolved.target, transport, config.GATEWAY_TIMEOUT_MS);
    if (!isValidProbe(probe)) {
      return { ...base, gateway, ...probe, checkedAt: at(), refusal: "gateway_unverified" };
    }
    // Confirm node health again after a failed probe; a cached pre-check may outlive a network outage.
    if (probe.adminHttp === "unreachable" && (gateway !== "online" || await nodeState(true) !== "online")) {
      return { ...base, gateway: nodeCache?.state ?? gateway, adminHttp: "unknown", error: "monitor", checkedAt: at(), refusal: "gateway_unverified" };
    }
    // A kernel-blocked connect times out exactly like a silent device. Only a failure while the effective allowlist
    // (read again now) still covers the address is about the machine; otherwise nothing is recorded.
    if (probe.adminHttp === "unreachable" && egress && !(await egress.confirm(resolved.target.ip))) {
      return { ...base, gateway, adminHttp: "unknown", error: "monitor", checkedAt: at(), refusal: "egress_pending" };
    }
    if (await record(m.id, probe, startedAt, trigger)) onStatusChange();
    const refusal = probe.adminHttp === "unreachable" ? "admin_unreachable" : undefined;
    return { ...base, gateway, ...probe, checkedAt: at(), refusal, target: resolved.target };
  }

  /** A registered WiFi5Soft machine, or null. */
  async function loadMachine(id: string): Promise<MachineTarget | null> {
    const [m] = await orm().select(targetColumns).from(machines).where(and(eq(machines.id, id), isWiFi5Soft)).limit(1);
    return m ?? null;
  }

  /** Every registered WiFi5Soft machine, checked with at most GATEWAY_MAX_CONCURRENCY in flight. */
  async function checkAll(opts: { trigger?: CheckTrigger; skipPaused?: boolean } = {}): Promise<CheckOutcome[]> {
    const where = opts.skipPaused ? and(isWiFi5Soft, eq(machines.monitoringEnabled, true)) : isWiFi5Soft;
    const rows = await orm().select(targetColumns).from(machines).where(where).orderBy(sql`lower(${machines.name})`).limit(config.MONITOR_MAX_MACHINES);
    let egressAllowed: ReadonlySet<string> | undefined;
    if (egress) {
      // Ask for exactly the policy-valid addresses of the machines in this round (new ones are added, deleted or
      // paused ones drop out), then check only those the kernel already allows.
      const wanted = rows.flatMap((m) => {
        const r = resolveTarget(m, rules);
        return r.ok && (!approved || approved.has(r.target.ip)) ? [r.target.ip] : [];
      });
      await egress.request(wanted);
      egressAllowed = await egress.applied();
    }
    return mapLimit(rows, config.GATEWAY_MAX_CONCURRENCY, (m) => check(m, opts.trigger ?? "manual", egressAllowed));
  }

  return { nodeState, check, checkAll, loadMachine };
}

export type GatewayChecker = ReturnType<typeof createGatewayChecker>;
