#!/usr/bin/env node
/* Local development: API (Fastify, :4000) and WEB (Next.js, :3000) in one terminal with labelled output.

     npm run dev                 API + WEB, web app on the API data source (real sign-in, machines, account)
     npm run dev:mock            API + WEB, web app on the mock data source (demo data, password "demo")
     NEXT_PUBLIC_DATA_SOURCE=mock npm run dev   same as dev:mock (a value already in your shell always wins)

   - Ports are checked first. If something already listens on 4000 or 3000 (for example servers you started
     yourself), this reports the conflict and exits; it never stops another process.
     Other ports: DEV_API_PORT=4100 DEV_WEB_PORT=3100 npm run dev (wires PORT, APP_ORIGIN and API_ORIGIN for you).
   - Ctrl+C stops only the two processes started here (concurrently forwards the signal to its own children).
   - Environment files are not modified: the API reads apps/api/.env, the web app apps/web/.env*. Only values
     this script needs are passed, and only when they are not already set. */
import { readFileSync } from "node:fs";
import net from "node:net";
import concurrently from "concurrently";
import { assertLocalOnly } from "./env-guard.mjs";

// First, before anything starts: never run local development against production (see scripts/env-guard.mjs).
assertLocalOnly(new URL("../apps/api/.env", import.meta.url));

const DEFAULT_API_PORT = 4000;
const DEFAULT_WEB_PORT = 3000;

const apiPort = Number(process.env.DEV_API_PORT ?? DEFAULT_API_PORT);
const webPort = Number(process.env.DEV_WEB_PORT ?? DEFAULT_WEB_PORT);
const dataSource = process.env.NEXT_PUBLIC_DATA_SOURCE ?? (process.argv.includes("--mock") ? "mock" : "api");

for (const [name, port] of [["DEV_API_PORT", apiPort], ["DEV_WEB_PORT", webPort]]) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[dev] ${name} must be a port number (1–65535).`);
    process.exit(64);
  }
}
if (!["api", "mock"].includes(dataSource)) {
  console.error(`[dev] NEXT_PUBLIC_DATA_SOURCE must be "api" or "mock" (got "${dataSource}").`);
  process.exit(64);
}

/** True when something accepts connections on the port (IPv4 or IPv6 loopback). Read-only: connects, then closes. */
function listening(port) {
  const probe = (host) =>
    new Promise((resolve) => {
      const socket = net.connect({ host, port });
      const done = (result) => {
        socket.destroy();
        resolve(result);
      };
      socket.setTimeout(700, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  return Promise.all([probe("127.0.0.1"), probe("::1")]).then((r) => r.some(Boolean));
}

/** Next.js allows one dev server per project (any port). Its lock file names the running one; null if none is alive. */
function runningNextDev() {
  try {
    const lock = JSON.parse(readFileSync(new URL("../apps/web/.next/dev/lock", import.meta.url), "utf8"));
    process.kill(lock.pid, 0); // existence check only: signal 0 does not affect the process
    return lock;
  } catch {
    return null; // no lock, unreadable, or a stale lock from a server that already exited
  }
}

const busy = [];
if (await listening(apiPort)) busy.push(`API port ${apiPort}`);
if (await listening(webPort)) busy.push(`WEB port ${webPort}`);
if (busy.length) {
  console.error(`[dev] Not starting: ${busy.join(" and ")} ${busy.length > 1 ? "are" : "is"} already in use (another server is running there).`);
  console.error("[dev] Nothing was stopped. Close that server yourself, or use other ports, e.g.:");
  console.error("[dev]   DEV_API_PORT=4100 DEV_WEB_PORT=3100 npm run dev");
  process.exit(1);
}
const nextDev = runningNextDev();
if (nextDev) {
  console.error(`[dev] Not starting: a Next.js dev server for this project is already running (pid ${nextDev.pid}, ${nextDev.appUrl ?? "port " + nextDev.port}).`);
  console.error("[dev] Next.js allows only one per project, even on another port. Nothing was stopped; close it yourself first.");
  process.exit(1);
}

// Only what differs from the defaults is passed down, so values in apps/api/.env and apps/web/.env* stay in charge.
const apiEnv = {};
const webEnv = { NEXT_PUBLIC_DATA_SOURCE: dataSource };
if (apiPort !== DEFAULT_API_PORT) {
  apiEnv.PORT = String(apiPort);
  webEnv.API_ORIGIN ??= process.env.API_ORIGIN ?? `http://127.0.0.1:${apiPort}`;
}
if (webPort !== DEFAULT_WEB_PORT) apiEnv.APP_ORIGIN = process.env.APP_ORIGIN ?? `http://localhost:${webPort}`;

console.log(`[dev] API → http://127.0.0.1:${apiPort}   WEB → http://localhost:${webPort}   data source: ${dataSource}   (Ctrl+C stops both)`);

const { result } = concurrently(
  [
    { name: "API", command: "npm run dev -w apps/api", env: apiEnv, prefixColor: "cyan" },
    { name: "WEB", command: `npm run dev -w apps/web${webPort !== DEFAULT_WEB_PORT ? ` -- -p ${webPort}` : ""}`, env: webEnv, prefixColor: "magenta" },
  ],
  {
    prefix: "name",
    padPrefix: true,
    // If one server fails to start or crashes, stop the other instead of leaving half a stack running.
    killOthersOn: ["failure"],
    killTimeout: 5000,
  },
);

result.then(
  () => process.exit(0),
  (events) => {
    const failed = Array.isArray(events) ? events.filter((e) => e.exitCode !== 0 && e.exitCode !== "SIGINT") : [];
    process.exit(failed.length ? 1 : 0);
  },
);
