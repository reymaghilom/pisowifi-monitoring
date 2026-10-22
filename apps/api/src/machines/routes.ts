/* Machine management (B6): registered WiFi5Soft machines and their stored state.

   GET    /machines                    list (q, status, sort)          any signed-in user
   GET    /machines/:id                one machine                     any signed-in user
   POST   /machines                    create                          Admin
   PUT    /machines/:id                replace the editable fields     Admin
   PATCH  /machines/:id/monitoring     pause / resume monitoring       Admin
   DELETE /machines/:id                delete (state and history go)   Admin

   State is reported exactly as stored in machine_state. Nothing here contacts a machine or ZeroTier, so a new
   machine is "unknown" on every signal until the monitor (B8) writes real results. Every write is audited. */
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import { and, asc, eq, ilike, ne, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import {
  MACHINE_MESSAGES,
  apiError,
  fieldErrors,
  machineInputSchema,
  machineListQuerySchema,
  machineMonitoringSchema,
  type MachineDto,
  type MachineInputData,
} from "@pisowifi/shared";
import type { Db } from "../db/client.js";
import type { Config } from "../config/env.js";
import { machineState, machines, outages } from "../db/schema/index.js";
import { audit, isUniqueViolation, requireOrm } from "../auth/helpers.js";
import { DESTINATION_MESSAGE, PRIVATE_RANGES, destinationRefusal, parseCidrList, parseDenyList } from "../gateway/policy.js";
import { isSafeAdminPath } from "../remote/ticket.js";

export interface MachineRoutesOptions {
  db: Db | null;
  /** Destination policy for registrations (ZT_ALLOWED_CIDRS, ZT_DENY_IPS, ZT_NETWORK_ID, MONITOR_MAX_MACHINES). */
  config?: Pick<Config, "ZT_ALLOWED_CIDRS" | "ZT_DENY_IPS" | "ZT_NETWORK_ID" | "MONITOR_MAX_MACHINES" | "MONITOR_APPROVED_IPS">;
}

const idParam = z.object({ id: z.uuid() });

/** API field names → shared contract names, so `fields` matches the request body. */
const DUPLICATE: Record<string, { field: string; message: string }> = {
  machines_name_lower_key: { field: "name", message: MACHINE_MESSAGES.nameTaken },
  machines_zt_ip_key: { field: "ztIp", message: MACHINE_MESSAGES.ipTaken },
  machines_zt_member_key: { field: "ztMemberId", message: "This ZeroTier member is already registered" },
};

type Row = typeof machines.$inferSelect & { state: typeof machineState.$inferSelect | null };

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function toMachineDto(m: Row): MachineDto {
  const s = m.state;
  return {
    id: m.id,
    name: m.name,
    location: m.location,
    description: m.description,
    software: m.software,
    softwareVersion: m.softwareVersion,
    ztNetworkId: m.ztNetworkId,
    ztMemberId: m.ztMemberId,
    ztIp: m.ztIp,
    adminPath: m.adminPath,
    tags: m.tags,
    state: {
      http: s?.httpStatus ?? "unknown",
      lastCheckAt: iso(s?.lastCheckAt),
      lastSuccessAt: iso(s?.lastSuccessAt),
      zeroTier: s?.ztState ?? "unknown",
      zeroTierLastSeenAt: iso(s?.ztLastSeenAt),
      internet: s?.internetState ?? "unverified",
      monitor: s?.monitorHealth ?? (m.monitoringEnabled ? "unknown" : "paused"),
      monitoringEnabled: m.monitoringEnabled,
    },
    createdAt: m.createdAt.toISOString(),
    updatedAt: m.updatedAt.toISOString(),
  };
}

/** Columns written from a validated body. ztMemberId is backend-only: kept unless the body sets it, and
 *  cleared when the network ID is removed (a member address needs its network). */
function columns(input: MachineInputData, existingMemberId: string | null = null) {
  const ztNetworkId = input.ztNetworkId ?? null;
  const ztMemberId = ztNetworkId ? (input.ztMemberId !== undefined ? input.ztMemberId : existingMemberId) : null;
  return {
    name: input.name,
    location: input.location ?? null,
    description: input.description ?? null,
    software: input.software,
    softwareVersion: input.softwareVersion ?? null,
    ztNetworkId,
    ztMemberId,
    ztIp: input.ztIp,
    adminPath: input.adminPath,
    tags: input.tags,
    monitoringEnabled: input.monitoringEnabled,
  };
}

const notFound = (reply: FastifyReply) => reply.code(404).send(apiError("not_found", "Machine not found"));
const conflict = (reply: FastifyReply, d: { field: string; message: string }) => reply.code(409).send(apiError("conflict", d.message, { [d.field]: d.message }));
const invalid = (reply: FastifyReply, error: z.ZodError) => reply.code(400).send(apiError("validation_failed", "Check the highlighted fields.", fieldErrors(error)));

export const machineRoutes: FastifyPluginAsync<MachineRoutesOptions> = async (app, { db, config }) => {
  app.addHook("onSend", async (_req, reply) => {
    reply.header("cache-control", "no-store");
  });

  const orm = () => requireOrm(db);

  // Registration uses the monitor's own destination policy, so every registered machine is one the worker may check.
  // Without ZT_ALLOWED_CIDRS (e.g. local development) any private address is accepted; special ranges never are.
  const configured = parseCidrList(config?.ZT_ALLOWED_CIDRS);
  const rules = { allowed: configured.length ? configured : PRIVATE_RANGES, denied: parseDenyList(config?.ZT_DENY_IPS) };
  const rangeText = config?.ZT_ALLOWED_CIDRS?.split(",").map((s) => s.trim()).join(", ") || "a private range: 10.x, 172.16–31.x, 192.168.x or 100.64–127.x";
  const networkId = config?.ZT_NETWORK_ID?.toLowerCase() ?? null;
  const maxMachines = config?.MONITOR_MAX_MACHINES ?? 100;
  // D3 keeps the D2 two-device authorization boundary at the API write edge.
  // Omission preserves the later dynamic-management implementation until its activation is approved.
  const approved = config?.MONITOR_APPROVED_IPS ? parseDenyList(config.MONITOR_APPROVED_IPS) : null;

  function policyErrors(input: MachineInputData): Record<string, string> | null {
    const out: Record<string, string> = {};
    const refusal = destinationRefusal(input.ztIp.trim().replace(/\/32$/, ""), rules);
    if (refusal) out.ztIp = DESTINATION_MESSAGE[refusal](rangeText);
    else if (approved && !approved.has(input.ztIp.trim().replace(/\/32$/, ""))) out.ztIp = "Monitoring for this device is not authorized yet";
    if (networkId && input.ztNetworkId && input.ztNetworkId !== networkId) out.ztNetworkId = `Use the PisoWiFi ZeroTier network ID (${networkId})`;
    if (!isSafeAdminPath(input.adminPath)) out.adminPath = "Use a plain path such as /admin";
    return Object.keys(out).length ? out : null;
  }
  const policyFailed = (reply: FastifyReply, fields: Record<string, string>) => reply.code(400).send(apiError("validation_failed", "Check the highlighted fields.", fields));

  app.get("/machines/policy", { config: { access: "machines:view" } }, async () => {
    const [count] = await orm().select({ n: sql<number>`count(*)::int`.mapWith(Number) }).from(machines);
    return { allowedRanges: configured.map((c) => c.text), networkId, maxMachines, registered: count?.n ?? 0 };
  });

  async function load(id: string): Promise<Row | null> {
    const [row] = await orm()
      .select({ m: machines, s: machineState })
      .from(machines)
      .leftJoin(machineState, eq(machineState.machineId, machines.id))
      .where(eq(machines.id, id))
      .limit(1);
    return row ? { ...row.m, state: row.s } : null;
  }

  /** Name (ignoring case) or IP already used by another machine. */
  async function duplicateOf(input: MachineInputData, exceptId?: string) {
    const others = exceptId ? ne(machines.id, exceptId) : undefined;
    const [byName] = await orm()
      .select({ id: machines.id })
      .from(machines)
      .where(and(eq(sql`lower(${machines.name})`, input.name.toLowerCase()), others))
      .limit(1);
    if (byName) return DUPLICATE.machines_name_lower_key!;
    const [byIp] = await orm()
      .select({ id: machines.id })
      .from(machines)
      .where(and(eq(machines.ztIp, input.ztIp), others))
      .limit(1);
    return byIp ? DUPLICATE.machines_zt_ip_key! : null;
  }

  /** Maps a unique-index violation (e.g. a concurrent insert) to the same 409 the pre-check gives. */
  function duplicateFromError(err: unknown) {
    if (!isUniqueViolation(err)) return null;
    const e = err as { constraint?: string; cause?: { constraint?: string }; message?: string };
    const name = e.constraint ?? e.cause?.constraint ?? Object.keys(DUPLICATE).find((k) => String(e.message ?? "").includes(k) || String(e.cause ?? "").includes(k));
    return (name && DUPLICATE[name]) || { field: "name", message: "This machine is already registered" };
  }

  app.get("/machines", { config: { access: "machines:view" } }, async (req, reply) => {
    const query = machineListQuerySchema.safeParse(req.query ?? {});
    if (!query.success) return invalid(reply, query.error);
    const { q, status, sort } = query.data;
    const filters: (SQL | undefined)[] = [];
    if (q) {
      const like = `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
      filters.push(or(ilike(machines.name, like), ilike(machines.location, like), sql`host(${machines.ztIp}) like ${like}`, sql`exists (select 1 from unnest(${machines.tags}) as tag where tag ilike ${like})`));
    }
    if (status !== "all") filters.push(eq(sql`coalesce(${machineState.httpStatus}, 'unknown')`, status));
    const order = {
      name: [asc(sql`lower(${machines.name})`)],
      ip: [asc(machines.ztIp)],
      status: [asc(sql`coalesce(${machineState.httpStatus}, 'unknown')`), asc(sql`lower(${machines.name})`)],
      seen: [sql`${machineState.lastCheckAt} desc nulls last`, asc(sql`lower(${machines.name})`)],
    }[sort];
    const rows = await orm()
      .select({ m: machines, s: machineState })
      .from(machines)
      .leftJoin(machineState, eq(machineState.machineId, machines.id))
      .where(and(...filters))
      .orderBy(...order);
    return { items: rows.map((r) => toMachineDto({ ...r.m, state: r.s })) };
  });

  app.get("/machines/:id", { config: { access: "machines:view" } }, async (req, reply) => {
    const params = idParam.safeParse(req.params);
    const row = params.success ? await load(params.data.id) : null;
    return row ? toMachineDto(row) : notFound(reply);
  });

  app.post("/machines", { config: { access: "machines:manage" } }, async (req, reply) => {
    const parsed = machineInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const input = parsed.data;
    const policy = policyErrors(input);
    if (policy) return policyFailed(reply, policy);
    const dup = await duplicateOf(input);
    if (dup) return conflict(reply, dup);
    const [count] = await orm().select({ n: sql<number>`count(*)::int`.mapWith(Number) }).from(machines);
    if ((count?.n ?? 0) >= maxMachines) {
      return conflict(reply, { field: "name", message: `The machine limit (${maxMachines}) is reached. Delete a machine first.` });
    }
    let id: string;
    try {
      id = await orm().transaction(async (tx) => {
        const [created] = await tx
          .insert(machines)
          .values({ ...columns(input, input.ztMemberId ?? null), createdBy: req.user!.id })
          .returning({ id: machines.id });
        // Honest initial state: nothing has been checked yet.
        await tx.insert(machineState).values({ machineId: created!.id, monitorHealth: input.monitoringEnabled ? "unknown" : "paused" });
        return created!.id;
      });
    } catch (err) {
      const d = duplicateFromError(err);
      if (d) return conflict(reply, d);
      throw err;
    }
    await audit(orm(), req, "machine.created", req.user!.id, { name: input.name, ztIp: input.ztIp }, { type: "machine", id });
    return reply.code(201).send(toMachineDto((await load(id))!));
  });

  app.put("/machines/:id", { config: { access: "machines:manage" } }, async (req, reply) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const existing = await load(params.data.id);
    if (!existing) return notFound(reply);
    const parsed = machineInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalid(reply, parsed.error);
    const input = parsed.data;
    const policy = policyErrors(input);
    if (policy) return policyFailed(reply, policy);
    const dup = await duplicateOf(input, existing.id);
    if (dup) return conflict(reply, dup);

    const next = columns(input, existing.ztMemberId);
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((k) => JSON.stringify(next[k]) !== JSON.stringify(existing[k]));
    // A different address is a different device as far as results go: the old status no longer applies.
    const newAddress = String(existing.ztIp).replace(/\/32$/, "") !== input.ztIp.trim().replace(/\/32$/, "");
    try {
      await orm().transaction(async (tx) => {
        await tx.update(machines).set(next).where(eq(machines.id, existing.id));
        if (changed.includes("monitoringEnabled")) await tx.update(machineState).set({ monitorHealth: input.monitoringEnabled ? "unknown" : "paused" }).where(eq(machineState.machineId, existing.id));
        if (newAddress) {
          // Back to "Not checked yet" until a valid check of the new address; an open outage ends without a
          // recovery event (no result says the machine recovered).
          await tx.update(machineState).set({ httpStatus: "unknown", lastCheckAt: null, consecutiveFailures: 0 }).where(eq(machineState.machineId, existing.id));
          await tx.update(outages).set({ endedAt: sql`now()` }).where(and(eq(outages.machineId, existing.id), sql`${outages.endedAt} is null`));
        }
      });
    } catch (err) {
      const d = duplicateFromError(err);
      if (d) return conflict(reply, d);
      throw err;
    }
    await audit(orm(), req, "machine.updated", req.user!.id, { name: input.name, changed }, { type: "machine", id: existing.id });
    return toMachineDto((await load(existing.id))!);
  });

  app.patch("/machines/:id/monitoring", { config: { access: "machines:manage" } }, async (req, reply) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const body = machineMonitoringSchema.safeParse(req.body ?? {});
    if (!body.success) return invalid(reply, body.error);
    const { enabled } = body.data;
    if (enabled && approved) {
      const existing = await load(params.data.id);
      if (!existing) return notFound(reply);
      if (!approved.has(String(existing.ztIp).replace(/\/32$/, ""))) {
        return policyFailed(reply, { ztIp: "Monitoring for this device is not authorized yet" });
      }
    }
    const updated = await orm().transaction(async (tx) => {
      const [m] = await tx.update(machines).set({ monitoringEnabled: enabled }).where(eq(machines.id, params.data.id)).returning({ id: machines.id, name: machines.name });
      if (!m) return null;
      // Pausing is a fact we know; resuming means "not checked yet" until the monitor runs.
      await tx
        .insert(machineState)
        .values({ machineId: m.id, monitorHealth: enabled ? "unknown" : "paused" })
        .onConflictDoUpdate({ target: machineState.machineId, set: { monitorHealth: enabled ? "unknown" : "paused" } });
      return m;
    });
    if (!updated) return notFound(reply);
    await audit(orm(), req, enabled ? "machine.monitoring_resumed" : "machine.monitoring_paused", req.user!.id, { name: updated.name }, { type: "machine", id: updated.id });
    return toMachineDto((await load(updated.id))!);
  });

  app.delete("/machines/:id", { config: { access: "machines:manage" } }, async (req, reply) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) return notFound(reply);
    const [deleted] = await orm().delete(machines).where(eq(machines.id, params.data.id)).returning({ id: machines.id, name: machines.name, ztIp: machines.ztIp });
    if (!deleted) return notFound(reply);
    await audit(orm(), req, "machine.deleted", req.user!.id, { name: deleted.name, ztIp: deleted.ztIp }, { type: "machine", id: deleted.id });
    return reply.code(204).send();
  });
};

