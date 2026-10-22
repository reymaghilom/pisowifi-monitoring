/* Admin HTTP reachability through the gateway: one GET to the machine's admin path, no redirects followed, strict
   timeout, at most PROBE_MAX_BYTES read. Connectivity has two answers only: any HTTP answer (any status, even 5xx)
   means the machine is reachable (the device login is still required). Only recognized target failures
   are unreachable; unexpected or monitoring-side failures are inconclusive. Never throws. */
import type { CheckErrorKind, MachineStatus } from "@pisowifi/shared";
import type { GatewayTarget } from "./target.js";

export type GatewayTransport = (url: string, init: { method: string; headers: Record<string, string>; body?: Buffer; signal: AbortSignal }) => Promise<Response>;

/** Real network access. Redirects are never followed; the caller decides what a Location may point to. */
export const fetchTransport: GatewayTransport = (url, init) =>
  fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal, redirect: "manual" });

const PROBE_MAX_BYTES = 64 * 1024;

export interface ProbeResult {
  adminHttp: MachineStatus;
  httpStatus: number | null;
  latencyMs: number | null;
  error: CheckErrorKind | null;
}

function errorKind(err: unknown): CheckErrorKind {
  const e = err as { name?: string; cause?: { code?: string; name?: string } };
  if (e?.name === "TimeoutError" || e?.name === "AbortError" || e?.cause?.name === "TimeoutError") return "timeout";
  const code = e?.cause?.code ?? "";
  if (code === "ECONNREFUSED" || code === "ECONNRESET") return "refused";
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") return "timeout";
  return "monitor";
}

export async function probeAdmin(target: GatewayTarget, transport: GatewayTransport, timeoutMs: number): Promise<ProbeResult> {
  const started = performance.now();
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const res = await transport(target.origin + target.adminPath, { method: "GET", headers: { accept: "text/html,*/*", "accept-encoding": "identity" }, signal });
    if (!Number.isInteger(res?.status) || res.status < 100 || res.status > 599) {
      return { adminHttp: "unknown", httpStatus: null, latencyMs: null, error: "monitor" };
    }
    // Once headers arrive, connectivity is verified even if the response body fails to stream.
    try {
      const reader = res.body?.getReader();
      let read = 0;
      while (reader && read < PROBE_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        read += value.byteLength;
      }
      await reader?.cancel().catch(() => {});
    } catch { /* Headers already proved the device answered. */ }
    const latencyMs = Math.round(performance.now() - started);
    return { adminHttp: "reachable", httpStatus: res.status, latencyMs, error: null };
  } catch (err) {
    const error = errorKind(err);
    return { adminHttp: error === "monitor" ? "unknown" : "unreachable", httpStatus: null, latencyMs: null, error };
  }
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
