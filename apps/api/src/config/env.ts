/* Environment configuration, validated once at startup (API, worker, migration scripts).
   Errors name the variable and the rule, never the rejected value, so secrets don't end up in logs. */
import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { isPrivateCidr, parseCidrList } from "../gateway/policy.js";

/** Treat empty strings (e.g. `DATABASE_URL=` in a .env file) as "not set". */
const optional = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === "" ? undefined : v), schema.optional());

const bool = z.enum(["true", "false"]).transform((v) => v === "true");

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** TLS settings live in DATABASE_SSL / DATABASE_SSL_CA only. node-postgres lets URL parameters override them silently. */
const URL_TLS_PARAMS = ["sslmode", "ssl", "sslrootcert", "sslcert", "sslkey", "sslaccept", "uselibpqcompat"];

const postgresUrl = z
  .string()
  .regex(/^postgres(ql)?:\/\/\S+$/, "must be a postgres:// or postgresql:// connection URL")
  .refine((u) => {
    try {
      const params = new URL(u).searchParams;
      return !URL_TLS_PARAMS.some((p) => params.has(p));
    } catch {
      return false;
    }
  }, "must not contain sslmode or other TLS parameters (set DATABASE_SSL and DATABASE_SSL_CA instead)");

export function urlHost(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export const isLoopbackUrl = (u: string) => LOOPBACK_HOSTS.has(urlHost(u) ?? "");

/** A one-line secret file (e.g. a systemd credential): one trailing newline is ignored. Undefined when unreadable. */
function readSecretFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").replace(/\r?\n$/, "");
  } catch {
    return undefined;
  }
}

/** An origin only (scheme, host, optional port), normalized to `URL.origin` (no trailing slash). */
const originOnly = z
  .url({ protocol: /^https?$/ })
  .refine((u) => {
    const x = new URL(u);
    return !x.username && !x.password && x.pathname === "/" && !x.search && !x.hash;
  }, "must be an origin only (https://host[:port])")
  .transform((u) => new URL(u).origin);

/** Exact http(s) origin as written (an optional trailing "/" is allowed): no wildcard, path, query or credentials. */
function isExactOrigin(raw: string): boolean {
  if (raw.includes("*")) return false;
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && raw.replace(/\/$/, "").toLowerCase() === u.origin;
  } catch {
    return false;
  }
}

/** Comma-separated exact origins, normalized to `URL.origin`. */
const originList = z
  .string()
  .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean))
  .refine((list) => list.every(isExactOrigin), "must be exact origins (http[s]://host[:port]) separated by commas; wildcards are not allowed")
  .transform((list) => [...new Set(list.map((o) => new URL(o).origin))]);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Bind address. 127.0.0.1 keeps the API private behind the reverse proxy on the VPS. */
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    /** Runtime connection (API and worker): least-privilege role `pisowifi_app`.
     *  On Supabase: transaction pooler, port 6543, user `pisowifi_app.<project-ref>`. */
    DATABASE_URL: optional(postgresUrl),
    /** Migrations and role provisioning: the schema owner (on Supabase: `postgres`, session pooler, port 5432).
     *  Falls back to DATABASE_URL (local development). Never used by the API or worker processes. */
    MIGRATION_DATABASE_URL: optional(postgresUrl),
    /** "verify": TLS with the server certificate checked against DATABASE_SSL_CA. "off": no TLS (loopback hosts only).
     *  Default: "verify" in production, "off" otherwise. There is deliberately no unverified-TLS mode. */
    DATABASE_SSL: optional(z.enum(["verify", "off"])),
    /** Path to the PEM CA certificate (Supabase: Database settings → SSL certificate). */
    DATABASE_SSL_CA: optional(z.string().min(1)),
    /** Connections per process. Supabase plans cap connections; the API and worker each get their own pool. */
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),
    /** Connect timeout per pool connection. A Supabase pooler connection can take 5-10 s over a slow link. */
    DATABASE_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
    /** Worker: raw checks older than this many days are deleted hourly (events and outages are kept). Off unless set:
     *  nothing is ever deleted without an explicit value (proposed: 90). */
    CHECK_RETENTION_DAYS: optional(z.coerce.number().int().min(7).max(3650)),
    /** Trust exactly one loopback Caddy hop for client IPs. Requires HOST=127.0.0.1. */
    TRUST_PROXY: bool.default(false),
    /** Public origin of the web app. State-changing requests must carry this Origin (CSRF check). */
    APP_ORIGIN: originOnly.default("http://localhost:3000"),
    /** Other exact origins the same web app is opened at (e.g. its LAN address for a phone in development). They pass
     *  the CSRF check like APP_ORIGIN; links in emails still use APP_ORIGIN. Comma-separated, no wildcards. */
    APP_EXTRA_ORIGINS: z.preprocess((v) => (v === undefined ? "" : v), originList),
    /** Session cookie flags: Secure + `__Host-` prefix. Default: on in production. Only turn off for plain-http local development. */
    SESSION_COOKIE_SECURE: optional(bool),
    /** Failed sign-ins per IP per 15 minutes before the login endpoint answers 429. */
    LOGIN_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(10),
    /** Outgoing email (password reset, security notices). Nothing is sent unless SMTP_ENABLED=true (explicit approval). */
    SMTP_ENABLED: bool.default(false),
    SMTP_HOST: optional(z.string().min(1)),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
    /** true: implicit TLS (port 465). false: STARTTLS, which is then required (never plain text). Default: port === 465. */
    SMTP_SECURE: optional(bool),
    SMTP_USER: optional(z.string().min(1)),
    SMTP_PASS: optional(z.string().min(1)),
    /** Sender, e.g. `PisoWiFi Monitoring <no-reply@example.com>`. */
    SMTP_FROM: optional(z.string().min(3).max(254)),
    /** ZeroTier gateway (Phase Z1). Off unless true: no gateway request is ever made while disabled. */
    GATEWAY_ENABLED: bool.default(false),
    /** "direct": this API host is the ZeroTier member and reaches machines itself. */
    GATEWAY_MODE: z.enum(["direct"]).default("direct"),
    /** The PisoWiFi ZeroTier network range(s) machines may be registered and reached in, e.g. `192.168.194.0/24`.
     *  Private ranges only. Required when the gateway is enabled; the API also uses it to validate registrations. */
    ZT_ALLOWED_CIDRS: optional(z.string().regex(/^\s*\d{1,3}(\.\d{1,3}){3}\/\d{1,2}\s*(,\s*\d{1,3}(\.\d{1,3}){3}\/\d{1,2}\s*)*$/, "must be IPv4 CIDRs separated by commas")),
    /** ZeroTier IPs that are never a machine: the monitoring host's own ZeroTier IP, admin PCs, servers. Refused at
     *  registration, never checked, never added to the worker's egress allowlist. Comma-separated IPv4. */
    ZT_DENY_IPS: optional(z.string().regex(/^\s*\d{1,3}(\.\d{1,3}){3}\s*(,\s*\d{1,3}(\.\d{1,3}){3}\s*)*$/, "must be IPv4 addresses separated by commas")),
    /** Upper bound on registered machines (bounds the worker's load and its egress allowlist). */
    MONITOR_MAX_MACHINES: z.coerce.number().int().min(1).max(1000).default(100),
    /** D2 activation boundary. When set, the worker may request and probe only these exact machine IPs. */
    MONITOR_APPROVED_IPS: optional(z.string().min(1)),
    /** Worker with a kernel egress allowlist (egress-sync): it writes the addresses it wants to check to the request
     *  file and only checks addresses listed in the applied file (written by the root egress-sync once the kernel
     *  allows them). Both or neither. */
    GATEWAY_EGRESS_REQUEST_FILE: optional(z.string().min(1)),
    GATEWAY_EGRESS_APPLIED_FILE: optional(z.string().min(1)),
    /** The worker's own systemd unit: its effective IPAddressAllow is read back every round (systemctl show). */
    GATEWAY_EGRESS_UNIT: z.string().regex(/^[a-zA-Z0-9@._-]+\.service$/, "must be a systemd service name").default("pisowifi-worker.service"),
    /** Port of the WiFi5Soft admin interface on every machine (server-side setting, never from requests). */
    GATEWAY_TARGET_PORT: z.coerce.number().int().min(1).max(65535).default(80),
    /** Health check timeout per machine. */
    GATEWAY_TIMEOUT_MS: z.coerce.number().int().min(500).max(30_000).default(5000),
    /** Machines checked at the same time. */
    GATEWAY_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(16).default(4),
    /** Optional: local ZeroTier service API, to report whether the gateway node is online (read-only). */
    ZT_LOCAL_API_URL: z.url({ protocol: /^http$/ }).default("http://127.0.0.1:9993"),
    /** Path to the ZeroTier service auth token (e.g. /var/lib/zerotier-one/authtoken.secret). Read once; never logged. */
    ZT_AUTHTOKEN_FILE: optional(z.string().min(1)),
    /** ZeroTier network the gateway must be joined to (16 hex), checked with the local API. */
    ZT_NETWORK_ID: optional(z.string().regex(/^[0-9a-f]{16}$/i, "must be 16 hex characters")),
    /** Scheduled admin-HTTP checks (interval from monitoring_settings) in this process. Needs GATEWAY_ENABLED and a
     *  host that is an authorized, online ZeroTier member. Run it in one process only. */
    MONITOR_SCHEDULE_ENABLED: bool.default(false),
    /** Status-change notifications to an n8n webhook (n8n sends the Gmail message). Off unless true. */
    N8N_ENABLED: bool.default(false),
    /** n8n Webhook node production URL. https, except a loopback URL for local testing. Secret: keep out of git. */
    N8N_WEBHOOK_URL: optional(z.url({ protocol: /^https?$/ })),
    /** Shared secret: sent as "Authorization: Bearer <secret>" and used for the HMAC signature. At least 32 chars. */
    N8N_WEBHOOK_SECRET: optional(z.string().min(32, "must be at least 32 characters").max(512)),
    /** Alternative to N8N_WEBHOOK_SECRET: a file holding only the secret (production: a systemd credential, so the
     *  secret is never in any environment). Printable ASCII without spaces, 32-512 characters. Not both. */
    N8N_WEBHOOK_SECRET_FILE: optional(z.string().min(1)),
    /** Per-request timeout and the number of attempts before a notification is marked failed. */
    N8N_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30_000).default(10_000),
    N8N_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(12),
    /** Remote administration through the ZeroTier gateway (Azure): the API signs entry tickets. Off unless true. */
    REMOTE_GATEWAY_ENABLED: bool.default(false),
    /** The gateway's public origin, exactly its GATEWAY_PUBLIC_ORIGIN (also the ticket audience). https, except loopback. */
    REMOTE_GATEWAY_ORIGIN: optional(originOnly),
    /** Ed25519 private key (PEM, PKCS#8) that signs tickets. Keep it outside the repository; never logged.
     *  The gateway VM only has the matching public key. */
    REMOTE_TICKET_PRIVATE_KEY_FILE: optional(z.string().min(1)),
    /** Ticket lifetime in seconds (the gateway accepts at most 120). */
    REMOTE_TICKET_TTL_S: z.coerce.number().int().min(10).max(120).default(60),
    /** ZeroTier IPs no ticket may name: exactly the gateway's ZT_DENY_IPS (its own ZeroTier IP, admin PCs, servers).
     *  Comma-separated IPv4. Tickets also need ZT_ALLOWED_CIDRS (the same ranges as the gateway's). */
    REMOTE_GATEWAY_DENY_IPS: optional(z.string().regex(/^\s*\d{1,3}(\.\d{1,3}){3}\s*(,\s*\d{1,3}(\.\d{1,3}){3}\s*)*$/, "must be IPv4 addresses separated by commas")),
    /** Exact machines the gateway may open, as `<machine-uuid>@<ipv4>` pairs (the gateway's ALLOWED_MACHINES). When set,
     *  a ticket is signed only for a listed machine whose current record IP is its listed IP; MONITOR_APPROVED_IPS,
     *  when set, also applies. Unset: every machine passing the destination rules (development). */
    REMOTE_GATEWAY_MACHINES: optional(
      z.string().regex(/^\s*[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}@\d{1,3}(\.\d{1,3}){3}\s*(,\s*[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}@\d{1,3}(\.\d{1,3}){3}\s*)*$/, "must be <machine-uuid>@<ipv4> pairs (lowercase uuid) separated by commas"),
    ),
  })
  .superRefine((env, ctx) => {
    if (env.N8N_WEBHOOK_SECRET && env.N8N_WEBHOOK_SECRET_FILE) {
      ctx.addIssue({ code: "custom", path: ["N8N_WEBHOOK_SECRET_FILE"], message: "set N8N_WEBHOOK_SECRET or N8N_WEBHOOK_SECRET_FILE, not both" });
    }
    if (env.N8N_WEBHOOK_SECRET_FILE) {
      const secret = readSecretFile(env.N8N_WEBHOOK_SECRET_FILE);
      if (secret === undefined) ctx.addIssue({ code: "custom", path: ["N8N_WEBHOOK_SECRET_FILE"], message: "file not found or not readable" });
      else if (!/^[\x21-\x7e]{32,512}$/.test(secret)) {
        ctx.addIssue({ code: "custom", path: ["N8N_WEBHOOK_SECRET_FILE"], message: "must hold one line of 32-512 printable characters without spaces" });
      }
    }
  })
  .transform((env) => ({
    ...env,
    N8N_WEBHOOK_SECRET: env.N8N_WEBHOOK_SECRET_FILE ? readSecretFile(env.N8N_WEBHOOK_SECRET_FILE) : env.N8N_WEBHOOK_SECRET,
    DATABASE_SSL: env.DATABASE_SSL ?? (env.NODE_ENV === "production" ? "verify" : "off"),
    SESSION_COOKIE_SECURE: env.SESSION_COOKIE_SECURE ?? env.NODE_ENV === "production",
    SMTP_SECURE: env.SMTP_SECURE ?? env.SMTP_PORT === 465,
  }))
  .superRefine((env, ctx) => {
    if ((env.NODE_ENV === "production" || env.TRUST_PROXY) && env.HOST !== "127.0.0.1") {
      ctx.addIssue({ code: "custom", path: ["HOST"], message: "must be 127.0.0.1 in production or when TRUST_PROXY is true" });
    }
    if (env.NODE_ENV === "production" && !env.APP_ORIGIN.startsWith("https://")) {
      ctx.addIssue({ code: "custom", path: ["APP_ORIGIN"], message: "must use https in production" });
    }
    if (env.NODE_ENV === "production" && env.APP_EXTRA_ORIGINS.some((origin) => !origin.startsWith("https://"))) {
      ctx.addIssue({ code: "custom", path: ["APP_EXTRA_ORIGINS"], message: "must use https in production" });
    }
    if (env.NODE_ENV === "production" && !env.DATABASE_URL) {
      ctx.addIssue({ code: "custom", path: ["DATABASE_URL"], message: "is required in production" });
    }
    if (env.NODE_ENV === "production" && !env.SESSION_COOKIE_SECURE) {
      ctx.addIssue({ code: "custom", path: ["SESSION_COOKIE_SECURE"], message: "must be true in production" });
    }
    if (env.SMTP_ENABLED) {
      for (const key of ["SMTP_HOST", "SMTP_FROM"] as const) {
        if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "is required when SMTP_ENABLED is true" });
      }
      if (!env.SMTP_USER !== !env.SMTP_PASS) ctx.addIssue({ code: "custom", path: ["SMTP_PASS"], message: "SMTP_USER and SMTP_PASS must be set together" });
    }
    if (env.GATEWAY_ENABLED && !env.ZT_ALLOWED_CIDRS) {
      ctx.addIssue({ code: "custom", path: ["ZT_ALLOWED_CIDRS"], message: "is required when GATEWAY_ENABLED is true" });
    }
    if (env.ZT_ALLOWED_CIDRS) {
      try {
        if (!parseCidrList(env.ZT_ALLOWED_CIDRS).every(isPrivateCidr)) {
          ctx.addIssue({ code: "custom", path: ["ZT_ALLOWED_CIDRS"], message: "must be private ranges (10/8, 172.16/12, 192.168/16, 100.64/10)" });
        }
      } catch (err) {
        ctx.addIssue({ code: "custom", path: ["ZT_ALLOWED_CIDRS"], message: err instanceof Error ? err.message : "invalid" });
      }
    }
    if (!env.GATEWAY_EGRESS_REQUEST_FILE !== !env.GATEWAY_EGRESS_APPLIED_FILE) {
      ctx.addIssue({ code: "custom", path: ["GATEWAY_EGRESS_APPLIED_FILE"], message: "GATEWAY_EGRESS_REQUEST_FILE and GATEWAY_EGRESS_APPLIED_FILE must be set together" });
    }
    if (env.MONITOR_SCHEDULE_ENABLED && !env.GATEWAY_ENABLED) {
      ctx.addIssue({ code: "custom", path: ["MONITOR_SCHEDULE_ENABLED"], message: "needs GATEWAY_ENABLED=true" });
    }
    if (env.N8N_ENABLED) {
      for (const key of ["N8N_WEBHOOK_URL", "N8N_WEBHOOK_SECRET"] as const) {
        if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "is required when N8N_ENABLED is true" });
      }
    }
    if (env.N8N_WEBHOOK_URL) {
      const u = new URL(env.N8N_WEBHOOK_URL);
      if (u.username || u.password) ctx.addIssue({ code: "custom", path: ["N8N_WEBHOOK_URL"], message: "must not contain credentials" });
      if (u.protocol !== "https:" && !isLoopbackUrl(env.N8N_WEBHOOK_URL)) {
        ctx.addIssue({ code: "custom", path: ["N8N_WEBHOOK_URL"], message: "must use https (plain http only for a loopback URL)" });
      }
    }
    if (env.REMOTE_GATEWAY_ENABLED) {
      for (const key of ["REMOTE_GATEWAY_ORIGIN", "REMOTE_TICKET_PRIVATE_KEY_FILE", "ZT_ALLOWED_CIDRS"] as const) {
        if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "is required when REMOTE_GATEWAY_ENABLED is true" });
      }
    }
    if (env.REMOTE_GATEWAY_MACHINES) {
      const pairs = env.REMOTE_GATEWAY_MACHINES.split(",").map((s) => s.trim().split("@") as [string, string]);
      if (new Set(pairs.map(([id]) => id)).size !== pairs.length || new Set(pairs.map(([, ip]) => ip)).size !== pairs.length) {
        ctx.addIssue({ code: "custom", path: ["REMOTE_GATEWAY_MACHINES"], message: "lists a machine or an IP twice" });
      }
    }
    if (env.REMOTE_GATEWAY_ORIGIN && !env.REMOTE_GATEWAY_ORIGIN.startsWith("https:") && !isLoopbackUrl(env.REMOTE_GATEWAY_ORIGIN)) {
      ctx.addIssue({ code: "custom", path: ["REMOTE_GATEWAY_ORIGIN"], message: "must use https (plain http only for a loopback origin)" });
    }
    // The key's type is checked when the API starts (src/remote/ticket.ts); only its presence is checked here.
    if (env.REMOTE_TICKET_PRIVATE_KEY_FILE && !existsSync(env.REMOTE_TICKET_PRIVATE_KEY_FILE)) {
      ctx.addIssue({ code: "custom", path: ["REMOTE_TICKET_PRIVATE_KEY_FILE"], message: "file not found" });
    }
    if (env.ZT_AUTHTOKEN_FILE && !existsSync(env.ZT_AUTHTOKEN_FILE)) {
      ctx.addIssue({ code: "custom", path: ["ZT_AUTHTOKEN_FILE"], message: "file not found" });
    }
    if (env.DATABASE_SSL === "verify") {
      if (!env.DATABASE_SSL_CA) ctx.addIssue({ code: "custom", path: ["DATABASE_SSL_CA"], message: 'is required when DATABASE_SSL is "verify"' });
      else if (!existsSync(env.DATABASE_SSL_CA)) ctx.addIssue({ code: "custom", path: ["DATABASE_SSL_CA"], message: "file not found" });
    } else {
      // Plain-text connections only to this machine (local Docker / local PostgreSQL).
      for (const key of ["DATABASE_URL", "MIGRATION_DATABASE_URL"] as const) {
        const url = env[key];
        if (url && !isLoopbackUrl(url)) {
          ctx.addIssue({ code: "custom", path: [key], message: 'points to a remote host: set DATABASE_SSL="verify" and DATABASE_SSL_CA' });
        }
      }
    }
  });

export type Config = z.infer<typeof envSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Parses and validates the environment. Throws ConfigError with a readable list of problems. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const result = envSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError("Invalid environment configuration:\n" + problems.join("\n"));
  }
  return result.data;
}
