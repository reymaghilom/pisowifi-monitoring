import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";
import { parseDevAllowedHosts } from "./lib/dev-hosts";

/** Where the PisoWiFi API listens (server-side only). The browser calls same-origin /api/v1/*, which Next proxies
 *  here, so the HttpOnly session cookie stays first-party and the API's Origin check sees the web origin. */
const API_ORIGIN = process.env.API_ORIGIN ?? "http://127.0.0.1:4000";

const baseConfig: NextConfig = {
  // Test harnesses build into their own folder (e.g. the API-mode end-to-end run) so `.next` is never overwritten.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async rewrites() {
    return [{ source: "/api/v1/:path*", destination: `${API_ORIGIN}/api/v1/:path*` }];
  },
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

/** `next dev` only: DEV_ALLOWED_HOSTS (e.g. this PC's LAN IP) may load dev resources besides localhost. The API's
 *  Origin check needs the same address in its APP_EXTRA_ORIGINS. Builds and `next start` never read it. */
export default function nextConfig(phase: string): NextConfig {
  if (phase !== PHASE_DEVELOPMENT_SERVER) return baseConfig;
  const hosts = parseDevAllowedHosts(process.env.DEV_ALLOWED_HOSTS);
  return hosts.length ? { ...baseConfig, allowedDevOrigins: hosts } : baseConfig;
}
