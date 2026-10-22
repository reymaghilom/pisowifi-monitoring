/* Fastify application factory. Builds the app without listening, so tests use app.inject(). */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { apiError } from "@pisowifi/shared";
import type { Config } from "./config/env.js";
import type { Db } from "./db/client.js";
import { healthRoutes } from "./routes/health.js";
import { authRoutes, checkOrigin, registerAuthGuards } from "./auth/plugin.js";
import { passwordResetRoutes } from "./auth/password-reset.js";
import { accountRoutes } from "./account/routes.js";
import { machineRoutes } from "./machines/routes.js";
import { historyRoutes } from "./monitoring/history.js";
import { gatewayRoutes } from "./gateway/routes.js";
import { remoteRoutes } from "./remote/routes.js";
import { userRoutes } from "./users/routes.js";
import type { GatewayTransport } from "./gateway/probe.js";
import type { ZeroTierClient } from "./gateway/zerotier.js";
import type { NotificationDispatcher } from "./notifications/dispatcher.js";
import type { Mailer } from "./mail/mailer.js";

export const API_PREFIX = "/api/v1";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

/** Values that must never reach the logs. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.newPassword",
  "*.currentPassword",
  "*.token",
  "*.secret",
  "*.SMTP_PASS",
  // Gateway entry URLs carry a signed ticket.
  "*.entryUrl",
];

export interface AppDeps {
  db?: Db | null;
  /** Outgoing email; null when SMTP is not enabled (password reset then answers 503). */
  mailer?: Mailer | null;
  /** Gateway network access (tests inject a fake); defaults to fetch without following redirects. */
  gatewayTransport?: GatewayTransport;
  /** Local ZeroTier service client for gateway node health; null when not configured. */
  zerotier?: ZeroTierClient | null;
  /** Status-change notifications (n8n); checks kick it after a recorded change. */
  notifier?: NotificationDispatcher | null;
}

export async function buildApp(config: Config, deps: AppDeps = {}): Promise<FastifyInstance> {
  const db = deps.db ?? null;
  const mailer = deps.mailer ?? null;
  const app = Fastify({
    logger: config.NODE_ENV === "test" ? false : { level: config.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: "[redacted]" } },
    // Caddy reaches this loopback-only API directly. Trust its single hop, never
    // an arbitrary chain supplied in X-Forwarded-For by a client.
    trustProxy: config.TRUST_PROXY ? (address: string, hop: number) => hop === 0 && address === "127.0.0.1" : false,
    bodyLimit: 1024 * 1024,
    // Always generate request ids; never trust a client-supplied one.
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  app.addHook("onSend", async (req, reply) => {
    reply.header("x-request-id", req.id);
  });

  // Security headers. The API only serves JSON, so the strictest CSP applies.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    crossOriginResourcePolicy: { policy: "same-origin" },
  });

  await app.register(cookie);
  // Per-route limits only (sign-in, password change and reset); errors use the API envelope.
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: (req) => ({
      statusCode: 429,
      code: "rate_limited",
      message: req.url.endsWith("/auth/login") ? "Too many sign-in attempts. Try again in 15 minutes." : "Too many attempts. Try again in 15 minutes.",
    }),
  });
  app.addHook("onRequest", checkOrigin([config.APP_ORIGIN, ...config.APP_EXTRA_ORIGINS]));
  registerAuthGuards(app, config, db);

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send(apiError("not_found", "Route not found"));
  });

  app.setErrorHandler((err: FastifyError, req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "request failed");
    const expose = status < 500 || config.NODE_ENV !== "production";
    reply
      .code(status)
      .send(apiError(status >= 500 ? "internal_error" : (err.code ?? "bad_request").toLowerCase(), expose ? err.message : "Internal server error"));
  });

  await app.register(healthRoutes, { prefix: API_PREFIX, db, version });
  await app.register(authRoutes, { prefix: API_PREFIX, config, db });
  await app.register(passwordResetRoutes, { prefix: API_PREFIX, config, db, mailer });
  await app.register(accountRoutes, { prefix: API_PREFIX, db, mailer });
  await app.register(machineRoutes, { prefix: API_PREFIX, db, config });
  await app.register(historyRoutes, { prefix: API_PREFIX, db });
  await app.register(gatewayRoutes, { prefix: API_PREFIX, config, db, transport: deps.gatewayTransport, zerotier: deps.zerotier, onStatusChange: () => deps.notifier?.kick() });
  await app.register(remoteRoutes, { prefix: API_PREFIX, config, db });
  await app.register(userRoutes, { prefix: API_PREFIX, config, db });

  app.addHook("onClose", async () => {
    await db?.close();
  });

  return app;
}
