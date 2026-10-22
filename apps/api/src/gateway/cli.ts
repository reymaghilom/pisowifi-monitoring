/* Real admin HTTP checks from the gateway host's shell (Phase PC2), with exactly the rules the API uses: registered
   WiFi5Soft machines only, targets inside ZT_ALLOWED_CIDRS, one bounded GET of the admin path, redirects never
   followed. Results are recorded like a check from the app (see ./checker.ts), so the Machines page shows them.

     npm run gateway:check -w apps/api                 every registered WiFi5Soft machine
     npm run gateway:check -w apps/api -- --dry-run    list targets and refusals, contact nothing

   Exit code 0 when every machine answered over HTTP, 2 when some did not, 78 when the gateway is not configured. */
import { parseArgs } from "node:util";
import { asc, eq, sql } from "drizzle-orm";
import { loadConfigOrExit } from "../lifecycle.js";
import { createDb } from "../db/client.js";
import { tlsFromConfig } from "../db/pg-config.js";
import { machines } from "../db/schema/index.js";
import { createGatewayChecker } from "./checker.js";
import { fetchTransport } from "./probe.js";
import { parseCidrList, resolveTarget } from "./target.js";
import { createZeroTierClient } from "./zerotier.js";
import { createNotificationDispatcher } from "../notifications/dispatcher.js";

const { values: args } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });

const config = loadConfigOrExit();
if (!config.GATEWAY_ENABLED) {
  console.error("The gateway is disabled. Set GATEWAY_ENABLED=true and ZT_ALLOWED_CIDRS in apps/api/.env (see apps/api/README.md).");
  process.exit(78);
}
const db = createDb(config.DATABASE_URL, { tls: tlsFromConfig(config), max: 2, applicationName: "pisowifi-gateway-check", timeoutMs: 15_000 });
if (!db) {
  console.error("DATABASE_URL is not set: registered machines cannot be read.");
  process.exit(78);
}

const notifier = createNotificationDispatcher({ config, db, log: (msg, meta, level = "warn") => console[level](msg, meta ?? "") });
const checker = createGatewayChecker({ config, db, transport: fetchTransport, zerotier: createZeroTierClient(config) });
const names = new Map(
  (await db.orm.select({ id: machines.id, name: machines.name, ztIp: machines.ztIp, adminPath: machines.adminPath }).from(machines).where(eq(machines.software, "WiFi5Soft")).orderBy(asc(sql`lower(${machines.name})`))).map(
    (m) => [m.id, m] as const,
  ),
);

try {
  console.log(`Gateway node: ${await checker.nodeState()}${config.ZT_AUTHTOKEN_FILE ? "" : " (ZT_AUTHTOKEN_FILE not set: node not verifiable)"}`);
  console.log(`Allowed ranges: ${config.ZT_ALLOWED_CIDRS}; port ${config.GATEWAY_TARGET_PORT}; timeout ${config.GATEWAY_TIMEOUT_MS} ms`);
  if (names.size === 0) console.log("No registered WiFi5Soft machines.");

  if (args["dry-run"]) {
    const allowed = parseCidrList(config.ZT_ALLOWED_CIDRS);
    for (const m of names.values()) {
      const r = resolveTarget(m, { allowed, port: config.GATEWAY_TARGET_PORT });
      console.log(`  ${m.name.padEnd(24)} ${r.ok ? `would check ${r.target.origin}${r.target.adminPath}` : `refused (${r.reason})`}`);
    }
  } else {
    const results = await checker.checkAll();
    for (const c of results) {
      const m = names.get(c.machineId);
      const detail = c.refusal && c.adminHttp === "unknown" ? `not checked (${c.refusal})` : `HTTP ${c.httpStatus ?? "-"}${c.latencyMs !== null ? `, ${c.latencyMs} ms` : ""}${c.error ? `, ${c.error}` : ""}`;
      console.log(`  ${(m?.name ?? c.machineId).padEnd(24)} ${(m?.ztIp ?? "").padEnd(16)} admin HTTP ${c.adminHttp.padEnd(11)} ${detail}`);
    }
    console.log("Customer internet: unverified (an admin HTTP answer does not prove customers are online).");
    // Status changes found by this run are notified before exiting (when N8N_ENABLED).
    if (notifier.enabled()) {
      const d = await notifier.deliverDue();
      if (d.sent + d.retrying + d.failed) console.log(`Notifications: ${d.sent} sent, ${d.retrying} to retry, ${d.failed} failed.`);
    }
    if (results.some((c) => c.adminHttp !== "reachable")) process.exitCode = 2;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await db.close();
}
