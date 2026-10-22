/* Entry tickets for the ZeroTier gateway (separate repository: pisowifi-zerotier-gateway, src/ticket.ts).
   The format and limits below must stay identical to the gateway's verifier:

   Format: base64url(JSON claims) "." base64url(Ed25519 signature over the first segment's ASCII bytes).
   Claims: { v: 1, aud, jti, iat, exp, sub, mid, ip, path }
     aud   the gateway's public origin              jti  unique id, 16-64 base64url chars (single use)
     iat   issued at, Unix seconds                  exp  expiry, Unix seconds (at most 120 s after iat)
     sub   user id in PisoWiFi Monitoring           mid  machine UUID (lowercase)
     ip    the machine's stored ZeroTier IP          path admin path to open, e.g. "/admin"

   The private key is read once from REMOTE_TICKET_PRIVATE_KEY_FILE and lives only in this process: it is never
   logged, returned or written anywhere. Only `jti` may be recorded (audit); the ticket itself never is. */
import { createPrivateKey, randomBytes, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { GATEWAY_ENTRY_PATH, IPV4_PATTERN } from "@pisowifi/shared";
import { ConfigError } from "../config/env.js";

export interface TicketClaims {
  v: 1;
  aud: string;
  jti: string;
  iat: number;
  exp: number;
  sub: string;
  mid: string;
  ip: string;
  path: string;
}

/** Gateway limits (src/ticket.ts there). */
export const MAX_TICKET_LIFETIME_S = 120;
const MAX_ADMIN_PATH = 200;
const MAX_SUB = 128;

/** Reads and checks the signing key. Errors name the variable, never the file's contents. */
export function loadTicketKey(file: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(readFileSync(file, "utf8"));
  } catch {
    throw new ConfigError("REMOTE_TICKET_PRIVATE_KEY_FILE: not a readable PEM private key");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new ConfigError("REMOTE_TICKET_PRIVATE_KEY_FILE: must be an Ed25519 private key");
  return key;
}

export function signTicket(claims: TicketClaims, privateKey: KeyObject): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(null, Buffer.from(payload, "ascii"), privateKey).toString("base64url")}`;
}

// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\\\u0000-\u001f\u007f]/;

/** Same rule as the gateway's safePath: stays on the device, no traversal, no control characters or spaces. */
export function isSafeAdminPath(raw: string): boolean {
  if (raw.length > MAX_ADMIN_PATH || !raw.startsWith("/") || raw.startsWith("//") || UNSAFE_CHARS.test(raw) || raw.includes(" ")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.split("?")[0]!);
  } catch {
    return false;
  }
  if (UNSAFE_CHARS.test(decoded) || decoded.startsWith("//") || decoded.split("/").some((seg) => seg === "." || seg === "..")) return false;
  try {
    return new URL(raw, "http://192.0.2.1").origin === "http://192.0.2.1";
  } catch {
    return false;
  }
}

/** Stored ZeroTier IP as the gateway's allowlist writes it: a bare IPv4 address (Postgres may add "/32"). */
export function bareIp(ztIp: string): string | null {
  const ip = ztIp.trim().replace(/\/32$/, "");
  return IPV4_PATTERN.test(ip) ? ip : null;
}

/* Destination rules, identical to the gateway's (src/target.ts and src/ticket.ts there, MACHINE_POLICY=signed): a
   ticket names its target, so the API refuses to sign one the gateway would refuse, and the gateway checks again.
   The same rules gate monitoring checks and the worker's egress allowlist (../gateway/policy.ts). */
export { destinationRefusal, parseDenyList, type DestinationRefusal, type DestinationRules } from "../gateway/policy.js";

export interface IssuedTicket {
  entryUrl: string;
  expiresAt: Date;
  jti: string;
}

export function issueTicket(
  input: { origin: string; userId: string; machineId: string; ip: string; path: string; ttlS: number; nowMs?: number },
  privateKey: KeyObject,
): IssuedTicket {
  const ttl = Math.min(MAX_TICKET_LIFETIME_S, Math.max(1, Math.floor(input.ttlS)));
  const iat = Math.floor((input.nowMs ?? Date.now()) / 1000);
  const claims: TicketClaims = {
    v: 1,
    aud: input.origin,
    // 18 random bytes → 24 base64url characters (the gateway accepts 16-64).
    jti: randomBytes(18).toString("base64url"),
    iat,
    exp: iat + ttl,
    sub: input.userId.slice(0, MAX_SUB),
    mid: input.machineId.toLowerCase(),
    ip: input.ip,
    path: input.path,
  };
  const token = signTicket(claims, privateKey);
  return { entryUrl: `${input.origin}${GATEWAY_ENTRY_PATH}#t=${token}`, expiresAt: new Date(claims.exp * 1000), jti: claims.jti };
}
