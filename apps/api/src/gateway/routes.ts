/* ZeroTier gateway routes (Phases Z1, PC2). The API host is a ZeroTier member and checks registered WiFi5Soft
   machines' admin interfaces: an always-running data source for monitoring, which a browser alone can't be.
   Remote administration itself is direct: the user's own device joins ZeroTier and opens the machine's admin page
   (no proxy here).

   Admin (app session + Admin role):
     GET    /gateway/status                     gateway node state (no addresses or tokens)
     POST   /gateway/machines/:id/check         live check of one registered WiFi5Soft machine (recorded, see ./checker.ts)
     POST   /gateway/check                      live check of every registered WiFi5Soft machine, bounded concurrency

   Results are read back through GET /machines (any signed-in user): machine_state holds the admin HTTP signal.
   Targets come only from registered machine records and server configuration (see ./target.ts). */
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { apiError } from "@pisowifi/shared";
import type { Config } from "../config/env.js";
import type { Db } from "../db/client.js";
import { createGatewayChecker, publicCheck } from "./checker.js";
import { fetchTransport, type GatewayTransport } from "./probe.js";
import type { ZeroTierClient } from "./zerotier.js";

export interface GatewayOptions {
  config: Config;
  db: Db | null;
  transport?: GatewayTransport;
  zerotier?: ZeroTierClient | null;
  /** Called after a check recorded a status change (delivers its notification right away). */
  onStatusChange?: () => void;
}

const idParam = z.object({ id: z.uuid() });

export const gatewayRoutes: FastifyPluginAsync<GatewayOptions> = async (app, opts) => {
  const { config, db } = opts;
  const transport = opts.transport ?? fetchTransport;
  const zerotier = opts.zerotier ?? null;
  const checker = createGatewayChecker({ config, db, transport, zerotier, onStatusChange: opts.onStatusChange });
  const { nodeState, check, loadMachine } = checker;

  /* ---------------- Admin API (app session + Admin) ---------------- */
  await app.register(async (admin) => {
    admin.addHook("onSend", async (_req, reply) => {
      reply.header("cache-control", "no-store");
    });

    admin.get("/gateway/status", { config: { access: "gateway:check" } }, async () => ({ enabled: config.GATEWAY_ENABLED, mode: config.GATEWAY_MODE, gateway: await nodeState(), checkedAt: new Date().toISOString() }));

    // Each check is one bounded GET per machine; the limits keep repeated clicks from hammering the devices.
    admin.post("/gateway/machines/:id/check", { config: { access: "gateway:check", rateLimit: { max: 30, timeWindow: 60_000 } } }, async (req, reply) => {
      const params = idParam.safeParse(req.params);
      const m = params.success ? await loadMachine(params.data.id) : null;
      if (!m) return reply.code(404).send(apiError("not_found", "Machine not found"));
      return publicCheck(await check(m));
    });

    admin.post("/gateway/check", { config: { access: "gateway:check", rateLimit: { max: 6, timeWindow: 60_000 } } }, async () => {
      return { items: (await checker.checkAll()).map(publicCheck) };
    });
  });
};
