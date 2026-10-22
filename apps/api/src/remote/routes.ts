/* Remote administration through the ZeroTier gateway (Azure VM, separate repository). The API never carries admin
   traffic; it only signs a short-lived, single-use entry ticket for one registered machine.

   Permission remote:open (Administrators and Members; Origin-checked because it is a POST). Opening a machine's
   admin page grants nothing else in this app; what the person can do on the device is up to its own WiFi5Soft login:
     POST   /remote/machines/:id/ticket          { entryUrl, expiresAt }

   Off unless REMOTE_GATEWAY_ENABLED=true (503 then). Ticket contents come only from the session and the machine
   record; the request supplies nothing but the machine id. The ticket names its target (machine id + ZeroTier IP), so
   with the gateway's MACHINE_POLICY=signed a newly registered machine opens without a gateway change: the IP must pass
   the gateway's own destination rules first (ZT_ALLOWED_CIDRS, blocked ranges, REMOTE_GATEWAY_DENY_IPS), else 422.
   In production the machine must also be exactly authorized: listed in REMOTE_GATEWAY_MACHINES at its current record
   IP, and that IP in MONITOR_APPROVED_IPS (when set); otherwise 422 "not_approved", audited, nothing signed.
   The response is never cached, the ticket is never logged or stored, and each issue is audited with its `jti` only;
   refusals of a registered machine are audited with the rule that failed. */
import type { FastifyPluginAsync } from "fastify";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, type RemoteTicketResponse } from "@pisowifi/shared";
import type { Config } from "../config/env.js";
import type { Db } from "../db/client.js";
import { machines } from "../db/schema/index.js";
import { audit, requireOrm } from "../auth/helpers.js";
import { parseCidrList } from "../gateway/target.js";
import { bareIp, destinationRefusal, isSafeAdminPath, issueTicket, loadTicketKey, parseDenyList, type DestinationRefusal } from "./ticket.js";

export interface RemoteRoutesOptions {
  config: Config;
  db: Db | null;
}

const idParam = z.object({ id: z.uuid() });

/** What an admin is told; specific enough to fix the record, nothing about the gateway's configuration. */
const REFUSED: Record<DestinationRefusal | "invalid_path" | "not_approved", string> = {
  not_approved: "This machine isn’t approved for remote administration through the gateway, or its ZeroTier IP changed since it was approved.",
  invalid_ip: "This machine’s ZeroTier IP isn’t a plain IPv4 address, so it can’t be opened through the gateway. Check it in My PisoWiFi.",
  outside_allowed: "This machine’s ZeroTier IP is outside the network the gateway may open. Check it in My PisoWiFi.",
  blocked_range: "This machine’s ZeroTier IP is a reserved address and can’t be opened through the gateway. Check it in My PisoWiFi.",
  network_address: "This machine’s ZeroTier IP is a reserved address and can’t be opened through the gateway. Check it in My PisoWiFi.",
  denied: "This address belongs to a device that isn’t a PisoWiFi machine, so the gateway won’t open it. Check its IP in My PisoWiFi.",
  invalid_path: "This machine’s admin path can’t be opened through the gateway. Check it in My PisoWiFi.",
};

export const remoteRoutes: FastifyPluginAsync<RemoteRoutesOptions> = async (app, { config, db }) => {
  // Read once at startup: a missing or wrong key stops the API before it serves anything.
  const key = config.REMOTE_GATEWAY_ENABLED ? loadTicketKey(config.REMOTE_TICKET_PRIVATE_KEY_FILE!) : null;
  const origin = config.REMOTE_GATEWAY_ORIGIN;
  const rules = { allowed: parseCidrList(config.ZT_ALLOWED_CIDRS), denied: parseDenyList(config.REMOTE_GATEWAY_DENY_IPS) };
  // Exact authorization (production): pinned machine id → IP pairs, and the monitoring boundary's exact IPs.
  const pinned = config.REMOTE_GATEWAY_MACHINES
    ? new Map(config.REMOTE_GATEWAY_MACHINES.split(",").map((s) => s.trim().split("@") as [string, string]))
    : null;
  const approvedIps = config.MONITOR_APPROVED_IPS ? parseDenyList(config.MONITOR_APPROVED_IPS) : null;
  const authorized = (id: string, ip: string) => (!pinned || pinned.get(id.toLowerCase()) === ip) && (!approvedIps || approvedIps.has(ip));

  await app.register(async (admin) => {
    admin.addHook("onSend", async (_req, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("pragma", "no-cache");
    });

    admin.post("/remote/machines/:id/ticket", { config: { access: "remote:open", rateLimit: { max: 20, timeWindow: 60_000 } } }, async (req, reply) => {
      if (!key || !origin) return reply.code(503).send(apiError("unavailable", "Remote administration through the gateway is not enabled."));
      const params = idParam.safeParse(req.params);
      if (!params.success) return reply.code(404).send(apiError("not_found", "Machine not found"));
      const orm = requireOrm(db);
      // The gateway serves WiFi5Soft admin pages only.
      const [m] = await orm
        .select({ id: machines.id, name: machines.name, ztIp: machines.ztIp, adminPath: machines.adminPath })
        .from(machines)
        .where(and(eq(machines.id, params.data.id), eq(machines.software, "WiFi5Soft")))
        .limit(1);
      if (!m) return reply.code(404).send(apiError("not_found", "Machine not found"));
      const ip = bareIp(m.ztIp);
      const refusal = !ip
        ? "invalid_ip"
        : (destinationRefusal(ip, rules) ?? (authorized(m.id, ip) ? null : "not_approved") ?? (isSafeAdminPath(m.adminPath) ? null : "invalid_path"));
      if (!ip || refusal) {
        await audit(orm, req, "remote.ticket_refused", req.user!.id, { name: m.name, reason: refusal ?? "invalid_ip" }, { type: "machine", id: m.id });
        return reply.code(422).send(apiError("invalid_machine", REFUSED[refusal ?? "invalid_ip"]));
      }

      const ticket = issueTicket({ origin, userId: req.user!.id, machineId: m.id, ip, path: m.adminPath, ttlS: config.REMOTE_TICKET_TTL_S }, key);
      await audit(orm, req, "remote.ticket_issued", req.user!.id, { name: m.name, ztIp: ip, jti: ticket.jti, expiresAt: ticket.expiresAt.toISOString(), role: req.user!.role }, { type: "machine", id: m.id });
      return { entryUrl: ticket.entryUrl, expiresAt: ticket.expiresAt.toISOString() } satisfies RemoteTicketResponse;
    });
  });
};
