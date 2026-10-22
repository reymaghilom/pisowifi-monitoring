import type { FastifyPluginAsync } from "fastify";
import type { HealthResponse, ReadyResponse } from "@pisowifi/shared";
import type { Db } from "../db/client.js";

export interface HealthOptions {
  db: Db | null;
  version: string;
}

const healthSchema = {
  response: {
    200: {
      type: "object",
      properties: { status: { type: "string" }, version: { type: "string" }, uptime: { type: "integer" } },
      required: ["status", "version", "uptime"],
    },
  },
} as const;

const readySchema = {
  response: {
    "2xx": { type: "object", properties: { status: { type: "string" }, db: { type: "string" } }, required: ["status", "db"] },
    "5xx": { type: "object", properties: { status: { type: "string" }, db: { type: "string" } }, required: ["status", "db"] },
  },
} as const;

/** Liveness (`/healthz`: the process is up) and readiness (`/readyz`: it can serve requests, i.e. the database answers). */
export const healthRoutes: FastifyPluginAsync<HealthOptions> = async (app, { db, version }) => {
  app.get("/healthz", { schema: healthSchema, config: { access: "public" } }, async (): Promise<HealthResponse> => ({ status: "ok", version, uptime: Math.round(process.uptime()) }));

  app.get("/readyz", { schema: readySchema, config: { access: "public" } }, async (_req, reply) => {
    const send = (code: number, body: ReadyResponse) => reply.code(code).send(body);
    if (!db) return send(503, { status: "not_ready", db: "not_configured" });
    return (await db.check()) ? send(200, { status: "ready", db: "up" }) : send(503, { status: "not_ready", db: "down" });
  });
};
