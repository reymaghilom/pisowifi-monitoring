/* Gateway targets: the only way an address reaches the network code. A target is built from a registered machine
   record (ztIp + adminPath) and server configuration (port); nothing comes from the request. The address must pass
   the shared destination policy (./policy.ts: private ZT_ALLOWED_CIDRS, special ranges, network/broadcast
   addresses, ZT_DENY_IPS). Fixed scheme (http) and port; paths are re-checked against the target origin. */
import { destinationRefusal, type Cidr, type DestinationRefusal } from "./policy.js";

export { parseCidr, parseCidrList, type Cidr } from "./policy.js";

export type TargetRefusal = DestinationRefusal;

export interface GatewayTarget {
  ip: string;
  port: number;
  /** `http://ip[:port]` */
  origin: string;
  /** Path of the machine's admin interface, e.g. `/admin`. */
  adminPath: string;
}

export function resolveTarget(
  machine: { ztIp: string; adminPath: string },
  opts: { allowed: readonly Cidr[]; port: number; denied?: ReadonlySet<string> },
): { ok: true; target: GatewayTarget } | { ok: false; reason: TargetRefusal } {
  const ip = machine.ztIp.trim().replace(/\/32$/, "");
  const reason = destinationRefusal(ip, { allowed: opts.allowed, denied: opts.denied ?? new Set() });
  if (reason) return { ok: false, reason };
  const origin = `http://${ip}${opts.port === 80 ? "" : `:${opts.port}`}`;
  const adminPath = machine.adminPath.startsWith("/") ? machine.adminPath : `/${machine.adminPath}`;
  return { ok: true, target: { ip, port: opts.port, origin, adminPath } };
}

/** Resolves a path (with query) against the target and proves the result stays on it. Null if it would leave. */
export function targetUrl(target: GatewayTarget, pathAndQuery: string): URL | null {
  // Control characters and backslashes are refused outright (header injection, path confusion).
  // eslint-disable-next-line no-control-regex
  if (!pathAndQuery.startsWith("/") || pathAndQuery.startsWith("//") || /[\\\u0000-\u001f]/.test(pathAndQuery)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathAndQuery.split("?")[0]!);
  } catch {
    return null;
  }
  // eslint-disable-next-line no-control-regex
  if (decoded.split("/").some((seg) => seg === ".." || seg === ".") || /[\\\u0000-\u001f]/.test(decoded)) return null;
  let url: URL;
  try {
    url = new URL(pathAndQuery, target.origin);
  } catch {
    return null;
  }
  return url.origin === target.origin && url.username === "" && url.password === "" ? url : null;
}
