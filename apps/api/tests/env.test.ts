import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config/env.js";

describe("loadConfig", () => {
  it("applies safe defaults", () => {
    expect(loadConfig({})).toEqual({
      NODE_ENV: "development",
      HOST: "127.0.0.1",
      PORT: 4000,
      LOG_LEVEL: "info",
      DATABASE_URL: undefined,
      MIGRATION_DATABASE_URL: undefined,
      DATABASE_SSL: "off",
      DATABASE_SSL_CA: undefined,
      DATABASE_POOL_MAX: 5,
      DATABASE_CONNECT_TIMEOUT_MS: 20_000,
      CHECK_RETENTION_DAYS: undefined,
      ZT_DENY_IPS: undefined,
      MONITOR_MAX_MACHINES: 100,
      GATEWAY_EGRESS_REQUEST_FILE: undefined,
      GATEWAY_EGRESS_APPLIED_FILE: undefined,
      GATEWAY_EGRESS_UNIT: "pisowifi-worker.service",
      TRUST_PROXY: false,
      APP_ORIGIN: "http://localhost:3000",
      APP_EXTRA_ORIGINS: [],
      SESSION_COOKIE_SECURE: false,
      LOGIN_RATE_LIMIT: 10,
      SMTP_ENABLED: false,
      SMTP_HOST: undefined,
      SMTP_PORT: 587,
      SMTP_SECURE: false,
      SMTP_USER: undefined,
      SMTP_PASS: undefined,
      SMTP_FROM: undefined,
      GATEWAY_ENABLED: false,
      GATEWAY_MODE: "direct",
      ZT_ALLOWED_CIDRS: undefined,
      GATEWAY_TARGET_PORT: 80,
      GATEWAY_TIMEOUT_MS: 5000,
      GATEWAY_MAX_CONCURRENCY: 4,
      ZT_LOCAL_API_URL: "http://127.0.0.1:9993",
      ZT_AUTHTOKEN_FILE: undefined,
      ZT_NETWORK_ID: undefined,
      MONITOR_SCHEDULE_ENABLED: false,
      N8N_ENABLED: false,
      N8N_WEBHOOK_URL: undefined,
      N8N_WEBHOOK_SECRET: undefined,
      N8N_TIMEOUT_MS: 10000,
      N8N_MAX_ATTEMPTS: 12,
      REMOTE_GATEWAY_ENABLED: false,
      REMOTE_GATEWAY_ORIGIN: undefined,
      REMOTE_TICKET_PRIVATE_KEY_FILE: undefined,
      REMOTE_TICKET_TTL_S: 60,
    });
  });

  it("remote gateway: off by default; enabling needs an https origin (origin only) and an existing key file; TTL within the gateway's limit", () => {
    const dir = mkdtempSync(join(tmpdir(), "pw-env-remote-"));
    const keyFile = join(dir, "ticket-private.pem");
    writeFileSync(keyFile, "placeholder (type checked at API start)");
    const ok = { REMOTE_GATEWAY_ENABLED: "true", REMOTE_GATEWAY_ORIGIN: "https://gw.example.com/", REMOTE_TICKET_PRIVATE_KEY_FILE: keyFile, ZT_ALLOWED_CIDRS: "192.168.194.0/24" };
    expect(loadConfig(ok)).toMatchObject({ REMOTE_GATEWAY_ENABLED: true, REMOTE_GATEWAY_ORIGIN: "https://gw.example.com", REMOTE_TICKET_TTL_S: 60 });
    expect(() => loadConfig({ REMOTE_GATEWAY_ENABLED: "true" })).toThrow(/REMOTE_GATEWAY_ORIGIN: is required[\s\S]*REMOTE_TICKET_PRIVATE_KEY_FILE: is required[\s\S]*ZT_ALLOWED_CIDRS: is required/);
    expect(() => loadConfig({ ...ok, REMOTE_TICKET_PRIVATE_KEY_FILE: join(dir, "missing.pem") })).toThrow(/REMOTE_TICKET_PRIVATE_KEY_FILE: file not found/);
    expect(() => loadConfig({ ...ok, REMOTE_GATEWAY_ORIGIN: "http://gw.example.com" })).toThrow(/REMOTE_GATEWAY_ORIGIN: must use https/);
    expect(loadConfig({ ...ok, REMOTE_GATEWAY_ORIGIN: "http://127.0.0.1:8443" }).REMOTE_GATEWAY_ORIGIN).toBe("http://127.0.0.1:8443");
    for (const bad of ["https://gw.example.com/admin", "https://gw.example.com/?x=1", "https://u:p@gw.example.com", "ftp://gw.example.com"]) {
      expect(() => loadConfig({ ...ok, REMOTE_GATEWAY_ORIGIN: bad }), bad).toThrow(/REMOTE_GATEWAY_ORIGIN/);
    }
    for (const ttl of ["9", "121", "abc"]) expect(() => loadConfig({ ...ok, REMOTE_TICKET_TTL_S: ttl }), ttl).toThrow(/REMOTE_TICKET_TTL_S/);
    expect(loadConfig({ ...ok, REMOTE_TICKET_TTL_S: "120" }).REMOTE_TICKET_TTL_S).toBe(120);
  });

  it("n8n webhook secret from a file (systemd credential): one trailing newline ignored, not both, content checked, never echoed", () => {
    const dir = mkdtempSync(join(tmpdir(), "pw-env-n8n-"));
    const secret = "Abc_-123".repeat(5) + "xyz"; // 43 printable characters, like base64url of 32 bytes
    const file = join(dir, "n8n-webhook-secret");
    writeFileSync(file, secret + "\n");
    const on = { N8N_ENABLED: "true", N8N_WEBHOOK_URL: "http://127.0.0.1:5678/webhook/pisowifi-status" };
    const cfg = loadConfig({ ...on, N8N_WEBHOOK_SECRET_FILE: file });
    expect(cfg.N8N_WEBHOOK_SECRET).toBe(secret);
    expect(cfg.N8N_ENABLED).toBe(true);
    writeFileSync(file, secret + "\r\n");
    expect(loadConfig({ ...on, N8N_WEBHOOK_SECRET_FILE: file }).N8N_WEBHOOK_SECRET).toBe(secret);
    expect(loadConfig({ ...on, N8N_WEBHOOK_SECRET: secret }).N8N_WEBHOOK_SECRET).toBe(secret);

    expect(() => loadConfig({ ...on, N8N_WEBHOOK_SECRET: secret, N8N_WEBHOOK_SECRET_FILE: file })).toThrow(/N8N_WEBHOOK_SECRET_FILE: set N8N_WEBHOOK_SECRET or N8N_WEBHOOK_SECRET_FILE, not both/);
    expect(() => loadConfig({ ...on, N8N_WEBHOOK_SECRET_FILE: join(dir, "missing") })).toThrow(/N8N_WEBHOOK_SECRET_FILE: file not found or not readable/);
    expect(() => loadConfig(on)).toThrow(/N8N_WEBHOOK_SECRET: is required when N8N_ENABLED is true/);
    for (const bad of ["short-secret", secret + " tail", secret + "\nsecond-line", "", "\n", "x".repeat(513)]) {
      writeFileSync(file, bad);
      let message = "";
      try {
        loadConfig({ ...on, N8N_WEBHOOK_SECRET_FILE: file });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/N8N_WEBHOOK_SECRET_FILE: must hold one line of 32-512 printable characters without spaces/);
      expect(message).not.toContain(secret);
      expect(message).not.toContain("short-secret");
    }
  });

  it("SMTP: off unless enabled; enabling needs host and sender; port 465 means implicit TLS", () => {
    expect(() => loadConfig({ SMTP_ENABLED: "true" })).toThrow(/SMTP_HOST: is required when SMTP_ENABLED is true[\s\S]*SMTP_FROM/);
    expect(() => loadConfig({ SMTP_ENABLED: "true", SMTP_HOST: "smtp.example.com", SMTP_FROM: "a@example.com", SMTP_USER: "u" })).toThrow(/SMTP_PASS/);
    const c = loadConfig({ SMTP_ENABLED: "true", SMTP_HOST: "smtp.example.com", SMTP_PORT: "465", SMTP_FROM: "PisoWiFi <a@example.com>" });
    expect(c).toMatchObject({ SMTP_ENABLED: true, SMTP_SECURE: true });
    expect(() => loadConfig({ SMTP_PASS: "hunter2-secret", SMTP_USER: "u", SMTP_ENABLED: "maybe" })).toThrow(/SMTP_ENABLED/);
    try {
      loadConfig({ SMTP_PASS: "hunter2-secret", SMTP_ENABLED: "true" });
    } catch (e) {
      expect(String(e)).not.toContain("hunter2-secret");
    }
  });

  it("session cookies are Secure by default in production and can't be turned off there", () => {
    const prod = { NODE_ENV: "production", DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/x", DATABASE_SSL: "off", APP_ORIGIN: "https://web.example.test" };
    expect(loadConfig(prod).SESSION_COOKIE_SECURE).toBe(true);
    expect(() => loadConfig({ ...prod, SESSION_COOKIE_SECURE: "false" })).toThrow(/SESSION_COOKIE_SECURE: must be true in production/);
    expect(loadConfig({ APP_ORIGIN: "https://app.example.com/" }).APP_ORIGIN).toBe("https://app.example.com");
    for (const origin of ["http://web.example.test", "http://127.0.0.1:13000"]) {
      expect(() => loadConfig({ ...prod, APP_ORIGIN: origin })).toThrow(/APP_ORIGIN: must use https in production/);
    }
    expect(() => loadConfig({ ...prod, APP_EXTRA_ORIGINS: "http://other.example.test" })).toThrow(/APP_EXTRA_ORIGINS: must use https in production/);
    expect(loadConfig({ ...prod, APP_EXTRA_ORIGINS: "https://other.example.test" }).APP_EXTRA_ORIGINS).toEqual(["https://other.example.test"]);
  });

  it("requires an exact web origin and a loopback API bind for trusted proxy mode", () => {
    for (const origin of ["https://web.example.test/path", "https://user:pass@web.example.test", "https://web.example.test?x=1"]) {
      expect(() => loadConfig({ APP_ORIGIN: origin })).toThrow(/APP_ORIGIN/);
    }
    expect(loadConfig({ TRUST_PROXY: "true", HOST: "127.0.0.1" }).TRUST_PROXY).toBe(true);
    for (const host of ["0.0.0.0", "::1", "192.0.2.10"]) {
      expect(() => loadConfig({ TRUST_PROXY: "true", HOST: host })).toThrow(/HOST: must be 127.0.0.1 in production or when TRUST_PROXY is true/);
    }
    expect(() => loadConfig({ NODE_ENV: "production", HOST: "0.0.0.0", APP_ORIGIN: "https://web.example.test", DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/x", DATABASE_SSL: "off" })).toThrow(/HOST: must be 127.0.0.1/);
  });

  it("APP_EXTRA_ORIGINS: exact origins only, normalized and de-duplicated", () => {
    expect(loadConfig({ APP_EXTRA_ORIGINS: "" }).APP_EXTRA_ORIGINS).toEqual([]);
    expect(loadConfig({ APP_EXTRA_ORIGINS: " http://192.168.100.226:3000 , https://App.Example.com/,http://192.168.100.226:3000" }).APP_EXTRA_ORIGINS).toEqual([
      "http://192.168.100.226:3000",
      "https://app.example.com",
    ]);
  });

  it.each([
    "*",
    "http://*",
    "http://*.example.com",
    "http://192.168.100.*:3000",
    "192.168.100.226:3000",
    "192.168.100.226",
    "http://192.168.100.226:3000/login",
    "http://192.168.100.226:3000?x=1",
    "http://user:pw@192.168.100.226:3000",
    "ftp://192.168.100.226",
    "javascript:alert(1)",
    "null",
    "http://localhost:3000,not an origin",
  ])("APP_EXTRA_ORIGINS rejects %s", (value) => {
    expect(() => loadConfig({ APP_EXTRA_ORIGINS: value })).toThrow(/APP_EXTRA_ORIGINS: must be exact origins/);
  });

  it("parses typed values", () => {
    const c = loadConfig({ PORT: "8080", TRUST_PROXY: "true", DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/x", LOG_LEVEL: "debug" });
    expect(c).toMatchObject({ PORT: 8080, TRUST_PROXY: true, DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/x", LOG_LEVEL: "debug" });
  });

  it("treats empty strings as unset", () => {
    expect(loadConfig({ DATABASE_URL: "" }).DATABASE_URL).toBeUndefined();
  });

  it.each([
    [{ PORT: "abc" }, "PORT"],
    [{ PORT: "70000" }, "PORT"],
    [{ DATABASE_URL: "mysql://u:p@h/db" }, "DATABASE_URL"],
    [{ TRUST_PROXY: "yes" }, "TRUST_PROXY"],
    [{ APP_ORIGIN: "javascript:alert(1)" }, "APP_ORIGIN"],
    [{ NODE_ENV: "production" }, "DATABASE_URL: is required in production"],
    [{ DATABASE_POOL_MAX: "0" }, "DATABASE_POOL_MAX"],
    [{ DATABASE_CONNECT_TIMEOUT_MS: "100" }, "DATABASE_CONNECT_TIMEOUT_MS"],
    [{ DATABASE_SSL: "require" }, "DATABASE_SSL"],
  ])("rejects %o", (env, msg) => {
    expect(() => loadConfig(env)).toThrow(ConfigError);
    expect(() => loadConfig(env)).toThrow(msg);
  });

  it("never echoes the rejected value (secrets stay out of logs)", () => {
    const secret = "postgres-without-scheme-SuperSecretPassword";
    try {
      loadConfig({ DATABASE_URL: secret });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain("SuperSecretPassword");
    }
  });

  describe("database TLS", () => {
    const remote = "postgresql://pisowifi_app.ref:pw@aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres";
    const caDir = mkdtempSync(join(tmpdir(), "pw-env-"));
    const ca = join(caDir, "prod-ca.crt");
    writeFileSync(ca, ["-----BEGIN CERTIFICATE-----", "X", "-----END CERTIFICATE-----", ""].join("\n"));

    it("defaults to verify in production and off in development", () => {
      expect(loadConfig({ NODE_ENV: "production", APP_ORIGIN: "https://web.example.test", DATABASE_URL: remote, DATABASE_SSL_CA: ca }).DATABASE_SSL).toBe("verify");
      expect(loadConfig({ DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/x" }).DATABASE_SSL).toBe("off");
    });

    it("never connects to a remote host without TLS (runtime or migration URL)", () => {
      expect(() => loadConfig({ DATABASE_URL: remote })).toThrow(/DATABASE_URL: points to a remote host/);
      expect(() => loadConfig({ MIGRATION_DATABASE_URL: remote.replace(":6543", ":5432") })).toThrow(/MIGRATION_DATABASE_URL: points to a remote host/);
      for (const local of ["localhost", "127.0.0.1", "[::1]"]) {
        expect(loadConfig({ DATABASE_URL: `postgresql://u:p@${local}:5432/x` }).DATABASE_URL).toContain(local);
      }
    });

    it("verify requires an existing CA file", () => {
      expect(() => loadConfig({ DATABASE_URL: remote, DATABASE_SSL: "verify" })).toThrow(/DATABASE_SSL_CA: is required/);
      expect(() => loadConfig({ DATABASE_URL: remote, DATABASE_SSL: "verify", DATABASE_SSL_CA: join(caDir, "missing.crt") })).toThrow(/file not found/);
      expect(loadConfig({ DATABASE_URL: remote, DATABASE_SSL: "verify", DATABASE_SSL_CA: ca })).toMatchObject({ DATABASE_SSL: "verify", DATABASE_SSL_CA: ca });
    });

    it("rejects TLS parameters inside URLs (node-postgres would let them override the CA check)", () => {
      expect(() => loadConfig({ DATABASE_URL: remote + "?sslmode=require", DATABASE_SSL: "verify", DATABASE_SSL_CA: ca })).toThrow(/must not contain sslmode/);
      expect(() => loadConfig({ DATABASE_URL: "postgresql://u:p@127.0.0.1/x?sslrootcert=/tmp/x" })).toThrow(/must not contain sslmode/);
    });
  });
});
