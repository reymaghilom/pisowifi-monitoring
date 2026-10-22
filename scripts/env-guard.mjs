/* Local development guard (fail closed): `npm run dev` / `npm run dev:mock` must never use production.
   Refuses when apps/api/.env or the shell environment contains a production database host/project, a database
   URL that is not loopback, or enabled side effects (email, n8n alerts, Remote Admin tickets, the monitor).
   Prints only variable names, never values. */
import { existsSync, readFileSync } from "node:fs";

const PRODUCTION = /supabase\.(co|com)\b|pooler\.|apgktwrpsrwljjeyslwi|:6543\b/i;
const DB_KEYS = ["DATABASE_URL", "MIGRATION_DATABASE_URL"];
const SIDE_EFFECTS = ["SMTP_ENABLED", "N8N_ENABLED", "REMOTE_GATEWAY_ENABLED", "GATEWAY_ENABLED", "MONITOR_SCHEDULE_ENABLED"];

function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

const loopback = (url) => {
  try {
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

/** Problems found (variable names and reasons only). Shell values win over the file, like Node's --env-file. */
export function localOnlyProblems(envFile, shellEnv = process.env) {
  const merged = { ...parseEnvFile(envFile), ...Object.fromEntries(Object.entries(shellEnv).filter(([, v]) => v !== undefined)) };
  const problems = [];
  for (const [k, v] of Object.entries(merged)) if (typeof v === "string" && PRODUCTION.test(v)) problems.push(`${k}: points at production (Supabase)`);
  for (const k of DB_KEYS) if (merged[k] && !loopback(merged[k])) problems.push(`${k}: not a loopback database`);
  for (const k of SIDE_EFFECTS) if (String(merged[k] ?? "").toLowerCase() === "true") problems.push(`${k}=true: real side effects are not allowed in local development`);
  return [...new Set(problems)];
}

export function assertLocalOnly(envFile) {
  const problems = localOnlyProblems(envFile);
  if (!problems.length) return;
  console.error("[dev] REFUSED: local development must not use production or real side effects.");
  for (const p of problems) console.error(`[dev]   - ${p}`);
  console.error("[dev] Fix apps/api/.env (or unset the shell variable). Production settings live outside the repo on purpose.");
  process.exit(78);
}
