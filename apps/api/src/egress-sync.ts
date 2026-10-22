/* egress-sync entry point (root, systemd oneshot; see deploy/systemd/). Reads only its own environment; no database,
   no network except the optional ZeroTier Central API. Exit 0 = kernel allowlist confirmed, 1 = not confirmed. */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { z } from "zod";
import { runEgressSync, type Run } from "./gateway/egress-sync.js";
import { isPrivateCidr, parseCidrList, parseDenyList } from "./gateway/policy.js";
import { normalizeAllowEntry } from "./gateway/egress-plan.js";
import { authorizedMemberIps } from "./gateway/zt-central.js";

const CIDR_V4 = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;
const CIDR_V6 = /^[0-9a-fA-F:]+(\/\d{1,3})?$/;

const env = z
  .object({
    EGRESS_REQUEST_FILE: z.string().min(1).default("/run/pisowifi-worker/egress-request.json"),
    EGRESS_APPLIED_FILE: z.string().min(1).default("/run/pisowifi-egress/applied.json"),
    EGRESS_UNIT: z.string().default("pisowifi-worker.service"),
    /** Always allowed: loopback and the database pooler, e.g. "127.0.0.0/8 ::1/128 13.237.241.81 13.238.183.126 3.106.102.114". */
    EGRESS_BASE_ALLOW: z.string().min(1),
    ZT_ALLOWED_CIDRS: z.string().min(1),
    ZT_DENY_IPS: z.string().optional(),
    MONITOR_MAX_MACHINES: z.coerce.number().int().min(1).max(1000).default(100),
    EGRESS_APPROVED_IPS: z.string().min(1).optional(),
    ZT_NETWORK_ID: z.string().regex(/^[0-9a-f]{16}$/i).optional(),
    /** Optional: read-only ZeroTier Central API token (root-only file). With it, only authorized members are allowed. */
    ZT_CENTRAL_TOKEN_FILE: z.string().min(1).optional(),
    ZT_CENTRAL_API_URL: z.url({ protocol: /^https$/ }).default("https://api.zerotier.com"),
  })
  .superRefine((e, ctx) => {
    if (e.ZT_CENTRAL_TOKEN_FILE && !e.ZT_NETWORK_ID) ctx.addIssue({ code: "custom", path: ["ZT_NETWORK_ID"], message: "is required with ZT_CENTRAL_TOKEN_FILE" });
    if (e.ZT_CENTRAL_TOKEN_FILE && !existsSync(e.ZT_CENTRAL_TOKEN_FILE)) ctx.addIssue({ code: "custom", path: ["ZT_CENTRAL_TOKEN_FILE"], message: "file not found" });
  })
  .safeParse(process.env);
if (!env.success) {
  console.error("egress-sync: invalid configuration:", env.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  process.exit(78);
}
const e = env.data;
const base = e.EGRESS_BASE_ALLOW.split(/[\s,]+/).filter(Boolean);
if (!base.every((b) => CIDR_V4.test(b) || CIDR_V6.test(b))) {
  console.error("egress-sync: EGRESS_BASE_ALLOW must list IP addresses or CIDRs");
  process.exit(78);
}
const allowed = parseCidrList(e.ZT_ALLOWED_CIDRS);
if (!allowed.every(isPrivateCidr)) {
  console.error("egress-sync: ZT_ALLOWED_CIDRS must be private ranges");
  process.exit(78);
}

const run: Run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 15_000 }, (err, stdout, stderr) => resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr })));

const result = await runEgressSync({
  requestFile: e.EGRESS_REQUEST_FILE,
  appliedFile: e.EGRESS_APPLIED_FILE,
  unit: e.EGRESS_UNIT,
  base: base.map(normalizeAllowEntry),
  rules: { allowed, denied: parseDenyList(e.ZT_DENY_IPS) },
  maxEntries: e.MONITOR_MAX_MACHINES,
  approved: e.EGRESS_APPROVED_IPS ? parseDenyList(e.EGRESS_APPROVED_IPS) : null,
  members: e.ZT_CENTRAL_TOKEN_FILE ? () => authorizedMemberIps({ apiUrl: e.ZT_CENTRAL_API_URL, networkId: e.ZT_NETWORK_ID!, tokenFile: e.ZT_CENTRAL_TOKEN_FILE! }) : null,
  run,
  log: (msg, meta) => console.log(JSON.stringify({ msg, ...meta })),
});
console.log(JSON.stringify({ msg: "egress-sync done", verified: result.verified, changed: result.changed, devices: result.plan.devices.length, rejected: result.plan.rejected.length }));
process.exit(result.verified ? 0 : 1);
