/* API process entry point. */
import { buildApp } from "./app.js";
import { createDb } from "./db/client.js";
import { createMailer } from "./mail/mailer.js";
import { createZeroTierClient } from "./gateway/zerotier.js";
import { createNotificationDispatcher } from "./notifications/dispatcher.js";
import { tlsFromConfig } from "./db/pg-config.js";
import { checkSchemaOnce } from "./db/rbac-state.js";
import { loadConfigOrExit, onShutdown } from "./lifecycle.js";

const config = loadConfigOrExit();
const db = createDb(config.DATABASE_URL, {
  tls: tlsFromConfig(config),
  max: config.DATABASE_POOL_MAX,
  connectTimeoutMs: config.DATABASE_CONNECT_TIMEOUT_MS,
  applicationName: "pisowifi-api",
  onError: (err) => app.log.error({ err }, "database pool error"),
});
const zerotier = config.GATEWAY_ENABLED ? createZeroTierClient(config) : null;
// Status-change notifications (n8n → Gmail): server to server only; the webhook secret stays in this process.
const notifier = createNotificationDispatcher({ config, db, log: (msg, meta, level = "warn") => app.log[level](meta ?? {}, msg) });
const app = await buildApp(config, { db, mailer: createMailer(config), zerotier, notifier });

// Fail closed on a database without migration 0005: this release reads users.disabled_at on every signed-in request,
// so it would answer 500 to everyone while /readyz still said ready. Exit 78 (EX_CONFIG; the unit sets
// RestartPreventExitStatus=78, so systemd doesn't retry). An unreachable database is not proof either way: start as
// before (/readyz reports it) and keep checking until there is an answer, so a database outage at boot can't leave
// the API permanently stopped.
const schemaMissing = () => {
  app.log.fatal("database schema is older than this release (migration 0005_user_management is not applied): refusing to serve");
  process.exit(78);
};
if (db) {
  const first = await checkSchemaOnce(db.pool);
  if (first === "missing") schemaMissing();
  if (first === "unreachable") {
    app.log.warn("database unreachable at start: schema check deferred");
    const timer = setInterval(() => {
      void checkSchemaOnce(db.pool).then((r) => {
        if (r === "missing") schemaMissing();
        if (r === "ready") {
          clearInterval(timer);
          app.log.info("database schema check passed (migration 0005 present)");
        }
      });
    }, 15_000);
    timer.unref();
  }
}

notifier.start();
// Open the first pool connection now, so the first sign-in does not wait for the TLS + SCRAM handshake.
if (db) void db.check();

if (!config.DATABASE_URL) app.log.warn("DATABASE_URL is not set: /readyz will report not_ready");
app.log.info(config.GATEWAY_ENABLED ? `ZeroTier gateway enabled (mode ${config.GATEWAY_MODE})` : "ZeroTier gateway disabled (GATEWAY_ENABLED is not true)");
if (!config.SMTP_ENABLED) app.log.info("email disabled (SMTP_ENABLED is not true): password reset by email is unavailable");
if (config.MONITOR_SCHEDULE_ENABLED) app.log.warn("MONITOR_SCHEDULE_ENABLED is ignored by the API; start the dedicated worker for scheduled checks");
app.log.info(notifier.enabled() ? "n8n status-change notifications enabled" : "n8n notifications disabled (N8N_ENABLED is not true)");

onShutdown(
  async () => {
    await notifier.stop();
    await app.close(); // stops accepting connections, drains requests, closes the database pool
    app.log.info("API stopped");
  },
  (msg) => app.log.info(msg),
);

try {
  await app.listen({ host: config.HOST, port: config.PORT });
} catch (err) {
  app.log.fatal({ err }, "failed to start API");
  process.exit(1);
}
