/* Optional ZeroTier Central membership check (egress-sync only): the addresses assigned to AUTHORIZED members of the
   PisoWiFi network. Read-only (GET .../network/:id/member); never authorizes, deauthorizes or edits a member. The
   API token is read from a root-only file and sent only to the Central API origin; it is never logged. */
import { readFileSync } from "node:fs";
import { STRICT_IPV4 } from "./policy.js";

interface Member {
  config?: { authorized?: boolean; ipAssignments?: unknown };
}

export async function authorizedMemberIps(opts: { apiUrl: string; networkId: string; tokenFile: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<Set<string>> {
  const token = readFileSync(opts.tokenFile, "utf8").trim();
  if (!token) throw new Error("ZeroTier Central token file is empty");
  const url = new URL(`/api/v1/network/${opts.networkId.toLowerCase()}/member`, opts.apiUrl);
  const res = await (opts.fetchImpl ?? fetch)(url, {
    headers: { authorization: `token ${token}`, accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
  });
  if (!res.ok) throw new Error(`ZeroTier Central answered ${res.status}`);
  const members = (await res.json()) as unknown;
  if (!Array.isArray(members)) throw new Error("unexpected ZeroTier Central response");
  const ips = new Set<string>();
  for (const m of members as Member[]) {
    if (m?.config?.authorized !== true || !Array.isArray(m.config.ipAssignments)) continue;
    for (const ip of m.config.ipAssignments) if (typeof ip === "string" && STRICT_IPV4.test(ip)) ips.add(ip);
  }
  return ips;
}
