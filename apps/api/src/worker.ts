/* Dedicated cloud-side monitoring process. No HTTP listener or remote-admin ticket signer. */
import pino from "pino";
import { REDACT_PATHS } from "./app.js";
import { loadConfigOrExit, onShutdown } from "./lifecycle.js";
import { createDb } from "./db/client.js";
import { tlsFromConfig } from "./db/pg-config.js";
import { createZeroTierClient } from "./gateway/zerotier.js";
import { createGatewayChecker } from "./gateway/checker.js";
import { fetchTransport } from "./gateway/probe.js";
import { startScheduledChecks } from "./gateway/schedule.js";
import { startRetention } from "./monitoring/retention.js";
import { fileEgressGate, readKernelAllow } from "./gateway/egress.js";
import { createNotificationDispatcher } from "./notifications/dispatcher.js";

const config = loadConfigOrExit();
const log = pino({ name: "worker", level: config.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: "[redacted]" } });

// Fail closed rather than running a worker that can never verify a failed device check.
if (!config.MONITOR_SCHEDULE_ENABLED || !config.GATEWAY_ENABLED || !config.DATABASE_URL || !config.ZT_AUTHTOKEN_FILE || !config.ZT_NETWORK_ID || config.REMOTE_GATEWAY_ENABLED) {
  log.fatal("worker requires monitoring, gateway, database and ZeroTier configuration; remote ticket signing must be disabled");
  process.exit(78);
}

// The scheduler holds one transaction-scoped lock while checks use other pool connections.
const db = createDb(config.DATABASE_URL, {
  tls: tlsFromConfig(config),
  max: Math.max(2, config.DATABASE_POOL_MAX),
  connectTimeoutMs: config.DATABASE_CONNECT_TIMEOUT_MS,
  applicationName: "pisowifi-worker",
  onError: (err) => log.error({ err }, "database pool error"),
})!;
const zerotier = createZeroTierClient(config)!;
const notifier = createNotificationDispatcher({ config, db, log: (msg, meta, level = "warn") => log[level](meta ?? {}, msg) });
// With a kernel egress allowlist (egress-sync), only addresses the kernel already allows are checked.
const egress =
  config.GATEWAY_EGRESS_REQUEST_FILE && config.GATEWAY_EGRESS_APPLIED_FILE
    ? fileEgressGate({
        requestFile: config.GATEWAY_EGRESS_REQUEST_FILE,
        appliedFile: config.GATEWAY_EGRESS_APPLIED_FILE,
        maxEntries: config.MONITOR_MAX_MACHINES,
        // The kernel's effective allowlist is the truth; the applied file alone is never trusted.
        kernel: () => readKernelAllow(config.GATEWAY_EGRESS_UNIT),
        log: (msg, meta) => log.warn(meta ?? {}, msg),
      })
    : null;
const checker = createGatewayChecker({ config, db, transport: fetchTransport, zerotier, egress, onStatusChange: () => notifier.kick() });
const schedule = startScheduledChecks({ checker, db, log: (msg, meta) => log.warn(meta ?? {}, msg) });
// History pruning only with an explicit CHECK_RETENTION_DAYS; unset, nothing is deleted.
const retention = config.CHECK_RETENTION_DAYS
  ? startRetention({ db, retentionDays: config.CHECK_RETENTION_DAYS, log: (msg, meta) => log.info(meta ?? {}, msg) })
  : null;
log.info(config.CHECK_RETENTION_DAYS ? `check retention: ${config.CHECK_RETENTION_DAYS} days` : "check retention off (CHECK_RETENTION_DAYS not set)");
notifier.start();
log.info(notifier.enabled() ? "n8n status-change notifications enabled" : "n8n notifications disabled (N8N_ENABLED is not true)");
// The scheduler's timers are unref'd so they never hold the API or tests open. This process has no other handle
// (lazy pool, no listener), so keep the event loop alive until shutdown; otherwise Node exits cleanly at once.
const keepAlive = setInterval(() => {}, 2 ** 30);
log.info("monitoring worker started");

onShutdown(
  async () => {
    clearInterval(keepAlive);
    await schedule.stop();
    await retention?.stop();
    await notifier.stop();
    await db.close();
    log.info("worker stopped");
  },
  (msg) => log.info(msg),
);
