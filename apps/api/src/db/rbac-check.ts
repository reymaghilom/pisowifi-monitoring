/* Read-only RBAC deployment checks (deploy/rbac scripts run this from the RBAC release on the VM, as the API's
   service user with the runtime DATABASE_URL). Prints one JSON line of counts; never emails, hashes or tokens.
     node dist/db/rbac-check.js schema           exit 0 when migration 0005's objects exist, 3 when not
     node dist/db/rbac-check.js rollback-safety  exit 0 when a pre-RBAC release could not let any deactivated
                                                 account back in, 4 when one could (see neutralize-deactivated.sql)
   Exit 1: the check itself failed (treat as unsafe). */
import pg from "pg";
import { loadConfigOrExit } from "../lifecycle.js";
import { poolConfig, tlsFromConfig } from "./pg-config.js";
import { read0005State, readRollbackSafety, schemaReady } from "./rbac-state.js";

const mode = process.argv[2];
if (mode !== "schema" && mode !== "rollback-safety") {
  console.error("usage: rbac-check.js schema|rollback-safety");
  process.exit(64);
}
const config = loadConfigOrExit();
if (!config.DATABASE_URL) {
  console.error("DATABASE_URL is required");
  process.exit(78);
}
const client = new pg.Client(poolConfig(config.DATABASE_URL, { tls: tlsFromConfig(config), applicationName: "pisowifi-rbac-check", timeoutMs: 15_000, connectTimeoutMs: config.DATABASE_CONNECT_TIMEOUT_MS }));
try {
  await client.connect();
  if (mode === "schema") {
    const s = await read0005State(client);
    console.log(JSON.stringify({ check: "schema", migration0005: schemaReady(s), ...s }));
    process.exitCode = schemaReady(s) ? 0 : 3;
  } else {
    const s = await readRollbackSafety(client);
    console.log(JSON.stringify({ check: "rollback-safety", safe: s.unsafeDeactivated === 0, ...s }));
    process.exitCode = s.unsafeDeactivated === 0 ? 0 : 4;
  }
} catch (err) {
  console.error(`rbac-check ${mode} failed: ${(err as { code?: string }).code ?? ""} ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
