/* DEV_ALLOWED_HOSTS: extra hosts the Next.js dev server serves its dev resources (/_next/*, HMR) to, e.g. the PC's
   LAN address so a phone on the same Wi-Fi can use `next dev`. Development only; production builds ignore it.
   Exact host names or IPv4 addresses only: no wildcards, schemes, ports or paths. Read by next.config.ts. */

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** Comma-separated hosts → lowercase, de-duplicated list. Throws (naming the variable) on anything else. */
export function parseDevAllowedHosts(raw: string | undefined): string[] {
  const hosts = (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const bad = hosts.filter((h) => !(IPV4.test(h) || (HOSTNAME.test(h) && !/^[\d.]+$/.test(h))));
  if (bad.length) throw new Error(`DEV_ALLOWED_HOSTS: must be exact host names or IPv4 addresses separated by commas (no wildcards, schemes or ports); got ${bad.length} invalid value(s)`);
  return [...new Set(hosts)];
}
