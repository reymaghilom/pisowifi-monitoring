import { afterEach, describe, expect, it } from "vitest";
import { apiErrorSchema, healthResponseSchema, readyResponseSchema } from "@pisowifi/shared";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { disposableServerUrl } from "./support/real-db.js";

/** A disposable server only (refuses production, Supabase/pooler and non-loopback hosts). */
const serverUrl = disposableServerUrl();

const config = loadConfig({ NODE_ENV: "test" });
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("GET /api/v1/healthz", () => {
  it("reports liveness with version and uptime", async () => {
    app = await buildApp(config);
    const res = await app.inject({ method: "GET", url: "/api/v1/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok", version: "0.1.0", uptime: expect.any(Number) });
    expect(healthResponseSchema.safeParse(res.json()).success).toBe(true);
  });

  it("sends security headers and a generated request id", async () => {
    app = await buildApp(config);
    const res = await app.inject({ method: "GET", url: "/api/v1/healthz", headers: { "x-request-id": "attacker-chosen" } });
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("GET /api/v1/readyz", () => {
  it("is not ready when no database is configured", async () => {
    app = await buildApp(config, { db: null });
    const res = await app.inject({ method: "GET", url: "/api/v1/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "not_ready", db: "not_configured" });
  });

  it("is not ready when the database is unreachable", async () => {
    app = await buildApp(config, { db: createDb("postgresql://u:p@127.0.0.1:1/none", { timeoutMs: 500 }) });
    const res = await app.inject({ method: "GET", url: "/api/v1/readyz" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: "not_ready", db: "down" });
    expect(readyResponseSchema.safeParse(res.json()).success).toBe(true);
  });

  it.skipIf(!serverUrl)("is ready when PostgreSQL answers (CI)", async () => {
    app = await buildApp(config, { db: createDb(serverUrl) });
    const res = await app.inject({ method: "GET", url: "/api/v1/readyz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ready", db: "up" });
  });
});

describe("errors", () => {
  it("unknown routes return a JSON 404", async () => {
    app = await buildApp(config);
    const res = await app.inject({ method: "GET", url: "/api/v1/nope" });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "Route not found" } });
    expect(apiErrorSchema.safeParse(res.json()).success).toBe(true);
  });

  it("hides internal error details in production", async () => {
    app = await buildApp(loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://web.example.test", DATABASE_URL: "postgresql://u:p@127.0.0.1:1/x", DATABASE_SSL: "off", LOG_LEVEL: "silent" }));
    app.get("/boom", { config: { access: "public" } }, async () => {
      throw new Error("connection string postgres://secret@db leaked");
    });
    const res = await app.inject({ method: "GET", url: "/boom" });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: "internal_error", message: "Internal server error" } });
    expect(res.body).not.toContain("secret");
  });

  it("rejects oversized bodies", async () => {
    app = await buildApp(config);
    app.post("/echo", { config: { access: "public" } }, async () => ({ ok: true }));
    const res = await app.inject({ method: "POST", url: "/echo", headers: { origin: "http://localhost:3000" }, payload: { x: "a".repeat(1024 * 1024 + 1) } });
    expect(res.statusCode).toBe(413);
  });
});
