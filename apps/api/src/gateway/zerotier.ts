/* Gateway node health from the local ZeroTier service API (read-only: GET /status and GET /network/:id).
   Only used when ZT_AUTHTOKEN_FILE is set; the token is read once, sent only to the loopback service and never
   logged or returned. Without it the gateway state is "unknown" (configured, not verifiable). */
import { readFileSync } from "node:fs";
import type { GatewayState } from "@pisowifi/shared";
import type { Config } from "../config/env.js";

export interface ZeroTierClient {
  nodeState(): Promise<GatewayState>;
}

export function createZeroTierClient(config: Config, fetchImpl: typeof fetch = fetch): ZeroTierClient | null {
  if (!config.ZT_AUTHTOKEN_FILE) return null;
  const token = readFileSync(config.ZT_AUTHTOKEN_FILE, "utf8").trim();
  const base = new URL(config.ZT_LOCAL_API_URL);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("ZT_LOCAL_API_URL must point to this machine");
  const get = async (path: string) => {
    const res = await fetchImpl(new URL(path, base), { headers: { "X-ZT1-Auth": token }, redirect: "error", signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`zerotier ${path}: ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  };
  return {
    async nodeState() {
      try {
        const status = await get("/status");
        if (status.online !== true) return "offline";
        if (config.ZT_NETWORK_ID) {
          const net = await get(`/network/${config.ZT_NETWORK_ID.toLowerCase()}`);
          return net.status === "OK" ? "online" : "offline";
        }
        return "online";
      } catch {
        return "offline";
      }
    },
  };
}
