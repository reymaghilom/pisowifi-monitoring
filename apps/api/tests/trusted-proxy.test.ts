import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";

const ORIGIN = "https://web.example.test";
let app: FastifyInstance | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(trustProxy: boolean, loginRateLimit = 10) {
  app = await buildApp(loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    TRUST_PROXY: String(trustProxy),
    LOGIN_RATE_LIMIT: String(loginRateLimit),
  }));
  app.get("/test/ip", { config: { access: "public" } }, async (request) => ({ ip: request.ip }));
  return app;
}

describe("one trusted loopback Caddy hop", () => {
  it("ignores forwarded addresses while proxy trust is disabled", async () => {
    const server = await start(false);
    const response = await server.inject({
      method: "GET",
      url: "/test/ip",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "198.51.100.7" },
    });
    expect(response.json()).toEqual({ ip: "127.0.0.1" });
  });

  it("uses only the closest client address supplied by the loopback proxy", async () => {
    const server = await start(true);
    const response = await server.inject({
      method: "GET",
      url: "/test/ip",
      remoteAddress: "127.0.0.1",
      headers: { "x-forwarded-for": "203.0.113.66, 198.51.100.7" },
    });
    expect(response.json()).toEqual({ ip: "198.51.100.7" });
  });

  it("ignores forwarded headers from a non-loopback direct peer", async () => {
    const server = await start(true);
    const response = await server.inject({
      method: "GET",
      url: "/test/ip",
      remoteAddress: "203.0.113.9",
      headers: { "x-forwarded-for": "198.51.100.7" },
    });
    expect(response.json()).toEqual({ ip: "203.0.113.9" });
  });

  it("does not let earlier spoofed forwarding entries reset the login limit", async () => {
    const server = await start(true, 2);
    const attempt = (forwarded: string) => server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      remoteAddress: "127.0.0.1",
      headers: { origin: ORIGIN, "x-forwarded-for": forwarded },
      payload: {},
    });
    expect((await attempt("203.0.113.66, 198.51.100.7")).statusCode).toBe(400);
    expect((await attempt("203.0.113.67, 198.51.100.7")).statusCode).toBe(400);
    expect((await attempt("203.0.113.68, 198.51.100.7")).statusCode).toBe(429);
    expect((await attempt("203.0.113.68, 198.51.100.8")).statusCode).toBe(400);
  });
});
