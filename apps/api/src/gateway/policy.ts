/* Destination policy for every address the system may contact on the ZeroTier network: monitoring checks, the
   worker's kernel egress allowlist (egress-sync) and remote-admin tickets. One rule set, so registration, the
   worker and the gateway never disagree. SSRF rules:
   - strict IPv4 literal only (no hostnames, so no DNS rebinding)
   - inside ZT_ALLOWED_CIDRS, which must themselves be private (RFC 1918 or CGNAT 100.64/10, like ZeroTier ranges)
   - never: "this network", loopback, link-local (cloud metadata), Azure wire server, Alibaba metadata, multicast,
     reserved, broadcast, or a range's own network/broadcast address
   - never an address in ZT_DENY_IPS (the monitoring host's own ZeroTier IP, admin PCs, servers)
   No imports: target.ts, remote/ticket.ts and the root-run egress-sync all build on this module. */
export const STRICT_IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const toInt = (ip: string) => ip.split(".").reduce((n, octet) => n * 256 + Number(octet), 0);

export interface Cidr {
  base: number;
  mask: number;
  text: string;
}

/** `minPrefix` keeps configured ranges reasonably narrow (default /8); the built-in lists use wider ones. */
export function parseCidr(text: string, minPrefix = 8): Cidr {
  const [ip, bits] = text.trim().split("/");
  const prefix = Number(bits);
  if (!ip || !STRICT_IPV4.test(ip) || !Number.isInteger(prefix) || prefix < minPrefix || prefix > 32) {
    throw new RangeError(`invalid CIDR "${text.trim()}" (IPv4, prefix /${minPrefix} to /32)`);
  }
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  // `>>> 0`: bitwise results are signed in JavaScript; keep every value unsigned so comparisons hold above 128.0.0.0.
  return { base: (toInt(ip) & mask) >>> 0, mask, text: text.trim() };
}

export const parseCidrList = (list: string | undefined): Cidr[] => (list ? list.split(",").filter((s) => s.trim()).map((s) => parseCidr(s)) : []);

const inCidr = (ip: number, c: Cidr) => (ip & c.mask) >>> 0 === c.base;

const BLOCKED = ["0.0.0.0/8", "127.0.0.0/8", "169.254.0.0/16", "168.63.129.16/32", "100.100.100.200/32", "224.0.0.0/4", "240.0.0.0/4"].map((c) => parseCidr(c, 0));
const PRIVATE = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"].map((c) => parseCidr(c, 0));
/** Private address space (RFC 1918 and CGNAT): the fallback registration range when no ZT_ALLOWED_CIDRS is set. */
export const PRIVATE_RANGES: readonly Cidr[] = PRIVATE;

/** True when the whole range is private address space (where ZeroTier managed routes live). */
export const isPrivateCidr = (c: Cidr) => PRIVATE.some((p) => c.mask >>> 0 >= p.mask >>> 0 && inCidr(c.base, p));

export type DestinationRefusal = "invalid_ip" | "blocked_range" | "outside_allowed" | "network_address" | "denied";

export interface DestinationRules {
  /** ZT_ALLOWED_CIDRS */
  allowed: readonly Cidr[];
  /** ZT_DENY_IPS (remote tickets: REMOTE_GATEWAY_DENY_IPS, the gateway's ZT_DENY_IPS) */
  denied: ReadonlySet<string>;
}

export const parseDenyList = (list: string | undefined): Set<string> => new Set((list ?? "").split(",").map((s) => s.trim()).filter(Boolean));

/** Why this address may not be contacted, or null when it is acceptable. */
export function destinationRefusal(ip: string, rules: DestinationRules): DestinationRefusal | null {
  if (!STRICT_IPV4.test(ip)) return "invalid_ip";
  const n = toInt(ip);
  if (BLOCKED.some((c) => inCidr(n, c)) || n === 0xffffffff) return "blocked_range";
  const range = rules.allowed.find((c) => inCidr(n, c));
  if (!range) return "outside_allowed";
  const hostBits = ~range.mask >>> 0;
  if (hostBits >= 3 && (n === range.base || n === (range.base | hostBits) >>> 0)) return "network_address";
  if (rules.denied.has(ip)) return "denied";
  return null;
}

/** Field message for a refused machine address (registration and edits). */
export const DESTINATION_MESSAGE: Record<DestinationRefusal, (allowed: string) => string> = {
  invalid_ip: () => "Enter a valid IPv4 address, e.g. 192.168.194.82",
  blocked_range: () => "This address is reserved and can never be monitored",
  outside_allowed: (allowed) => (allowed ? `Use an address in the PisoWiFi ZeroTier network (${allowed})` : "Monitoring has no ZeroTier network configured"),
  network_address: () => "This is the network's own network or broadcast address, not a device",
  denied: () => "This address belongs to monitoring or admin equipment and can't be registered as a machine",
};
