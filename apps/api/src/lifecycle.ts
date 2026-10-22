/* Shared process lifecycle for the API and the worker: config errors and graceful shutdown. */
import { ConfigError, loadConfig, type Config } from "./config/env.js";

/** Loads config or exits with a readable message (exit code 78 = configuration error). */
export function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(78);
    }
    throw err;
  }
}

/** Runs `stop` once on SIGINT/SIGTERM, then exits; forces exit if it takes longer than `graceMs`. */
export function onShutdown(stop: (signal: string) => Promise<void>, log: (msg: string) => void, graceMs = 10_000) {
  let stopping = false;
  const handler = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} received, shutting down`);
    const force = setTimeout(() => {
      log("shutdown timed out, forcing exit");
      process.exit(1);
    }, graceMs);
    force.unref();
    stop(signal).then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}
