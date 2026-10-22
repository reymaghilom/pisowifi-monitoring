/* Delivers queued status-change notifications to the n8n webhook (server to server; the secret never leaves the
   API). Rows are claimed one at a time with FOR UPDATE SKIP LOCKED, under a lease longer than the request timeout
   (leaseSeconds), so several API instances, the gateway:check CLI or a restart never send one row twice at the same
   time; a crashed attempt is taken over once its lease expires. Every claim adds 1 to `attempts`, which fences the
   result: an attempt whose lease was taken over cannot overwrite the newer claim's outcome.

   Request: POST N8N_WEBHOOK_URL, JSON body = the stored payload, headers
     Authorization: Bearer <N8N_WEBHOOK_SECRET>       (n8n Webhook node "Header Auth")
     X-PisoWiFi-Event-Id: <uuid>                      (same on every retry: dedupe key)
     X-PisoWiFi-Timestamp: <unix seconds>
     X-PisoWiFi-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + body)>  (optional extra check)
   Redirects are never followed. 2xx = delivered. Anything else is retried with exponential backoff
   (30 s, 1 min, 2 min … capped at 1 h) until N8N_MAX_ATTEMPTS, then marked failed. Errors are stored as a short
   reason only (never the URL, headers or secret). */
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Config } from "../config/env.js";
import type { Db } from "../db/client.js";

const LEASE_MIN_S = 60;
const LEASE_MARGIN_S = 30;
const BATCH = 10;
const BACKOFF_BASE_S = 30;
const BACKOFF_MAX_S = 3600;

export type LogLevel = "warn" | "error";
export type WebhookFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal; redirect: "manual" }) => Promise<Response>;

export interface DeliveryResult {
  sent: number;
  retrying: number;
  failed: number;
}

/** Seconds to wait before the next attempt, after `attempts` failed attempts. */
export const backoffSeconds = (attempts: number) => Math.min(BACKOFF_BASE_S * 2 ** Math.max(0, attempts - 1), BACKOFF_MAX_S);

/** How long one claimed row stays locked: the request timeout plus a margin for the database round trips. */
export const leaseSeconds = (timeoutMs: number) => Math.max(LEASE_MIN_S, Math.ceil(timeoutMs / 1000) + LEASE_MARGIN_S);

/** Operator hint for responses that retrying alone will not fix (no URL or secret in it). */
export function failureHint(status: number | null): string | undefined {
  if (status === 401 || status === 403) return "n8n rejected the webhook credentials: N8N_WEBHOOK_SECRET must match the n8n Header Auth credential (Authorization: Bearer <secret>)";
  if (status === 404) return "n8n webhook not found: is the workflow active and N8N_WEBHOOK_URL the production (not /webhook-test/) URL?";
  return undefined;
}

export function signBody(secret: string, timestamp: number, body: string) {
  return "sha256=" + createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

const rowsOf = <T>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));

export function createNotificationDispatcher(opts: {
  config: Config;
  db: Db | null;
  fetchImpl?: WebhookFetch;
  log?: (msg: string, meta?: Record<string, unknown>, level?: LogLevel) => void;
}) {
  const { config, db } = opts;
  const fetchImpl: WebhookFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const log = opts.log ?? (() => {});
  const enabled = () => Boolean(config.N8N_ENABLED && config.N8N_WEBHOOK_URL && config.N8N_WEBHOOK_SECRET && db);
  const lease = leaseSeconds(config.N8N_TIMEOUT_MS);
  let stopping = false;

  /** Claims the next due row (or one whose lease expired), or null. */
  async function claimNext() {
    const res = await db!.orm.execute(sql`
      update notification_deliveries d
         set status = 'sending', attempts = d.attempts + 1, locked_until = now() + make_interval(secs => ${lease})
       where d.id = (
         select id from notification_deliveries
          where (status = 'pending' and next_attempt_at <= now())
             or (status = 'sending' and locked_until < now())
          order by created_at
          limit 1
          for update skip locked)
      returning d.id, d.payload, d.attempts, d.event_id, d.machine_id`);
    return rowsOf<{ id: string; payload: unknown; attempts: number; event_id: string | number; machine_id: string }>(res)[0] ?? null;
  }

  /** One POST. Returns null on success, otherwise a short reason and the HTTP status if there was one. */
  async function post(id: string, payload: unknown): Promise<{ error: string; status: number | null } | null> {
    const body = JSON.stringify(payload);
    const ts = Math.floor(Date.now() / 1000);
    try {
      const res = await fetchImpl(config.N8N_WEBHOOK_URL!, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "PisoWiFi-Monitoring",
          authorization: `Bearer ${config.N8N_WEBHOOK_SECRET}`,
          "x-pisowifi-event-id": id,
          "x-pisowifi-timestamp": String(ts),
          "x-pisowifi-signature": signBody(config.N8N_WEBHOOK_SECRET!, ts, body),
        },
        body,
        signal: AbortSignal.timeout(config.N8N_TIMEOUT_MS),
        redirect: "manual",
      });
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) return null;
      return { error: res.status >= 300 && res.status < 400 ? `redirect ${res.status} not followed` : `HTTP ${res.status}`, status: res.status };
    } catch (err) {
      const name = (err as { name?: string })?.name;
      return { error: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network error", status: null };
    }
  }

  /** Sends up to `limit` due notifications, one claim at a time. Safe to call often and from several processes at once.
      Stops claiming once stop() has begun; the request already in flight finishes and is recorded. */
  async function deliverDue(limit = BATCH): Promise<DeliveryResult> {
    const result: DeliveryResult = { sent: 0, retrying: 0, failed: 0 };
    if (!enabled()) return result;
    for (let i = 0; i < limit && !stopping; i++) {
      const row = await claimNext();
      if (!row) break;
      const meta = { deliveryId: row.id, eventId: String(row.event_id), machineId: row.machine_id, attempts: row.attempts };
      const outcome = await post(row.id, row.payload);
      // Fenced by `attempts`: if this claim's lease expired and another dispatcher re-claimed the row, its result wins.
      const fence = sql`id = ${row.id} and status = 'sending' and attempts = ${row.attempts}`;
      if (!outcome) {
        const done = await db!.orm.execute(sql`update notification_deliveries set status = 'sent', sent_at = now(), locked_until = null, last_error = null, last_http_status = null where ${fence} returning id`);
        if (rowsOf(done).length) result.sent++;
        else log("notification delivered, but its claim had been taken over by a newer attempt; result not recorded", meta);
        continue;
      }
      const final = row.attempts >= config.N8N_MAX_ATTEMPTS;
      const done = await db!.orm.execute(sql`
        update notification_deliveries
           set status = ${final ? "failed" : "pending"}, locked_until = null, last_error = ${outcome.error}, last_http_status = ${outcome.status},
               next_attempt_at = now() + make_interval(secs => ${backoffSeconds(row.attempts)})
         where ${fence}
        returning id`);
      if (!rowsOf(done).length) {
        log("notification delivery failed, but its claim had been taken over by a newer attempt; result not recorded", { ...meta, error: outcome.error });
        continue;
      }
      if (final) result.failed++;
      else result.retrying++;
      const hint = failureHint(outcome.status);
      const failMeta = { ...meta, maxAttempts: config.N8N_MAX_ATTEMPTS, error: outcome.error, httpStatus: outcome.status, ...(hint ? { hint } : {}) };
      if (final) log("notification delivery failed permanently: retries exhausted, no email will be sent for this change", failMeta, "error");
      else log("notification delivery failed; will retry", { ...failMeta, retryInSeconds: backoffSeconds(row.attempts) }, hint && outcome.status !== 404 ? "error" : "warn");
    }
    return result;
  }

  let running: Promise<unknown> | null = null;
  let again = false;
  /** Starts a delivery round now (e.g. right after a status change); coalesces overlapping calls. */
  function kick() {
    if (!enabled() || stopping) return;
    if (running) {
      again = true;
      return;
    }
    running = (async () => {
      do {
        again = false;
        await deliverDue().catch((err) => log("notification delivery round failed", { error: err instanceof Error ? err.name : "error" }));
      } while (again && !stopping);
    })().finally(() => {
      running = null;
    });
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  /** Periodic retries (and pick-up after restarts). */
  function start(intervalMs = 30_000) {
    if (!enabled() || timer || stopping) return;
    timer = setInterval(kick, intervalMs);
    timer.unref?.();
    kick();
  }
  /** Graceful shutdown: no new claims; waits only for the request in flight (at most N8N_TIMEOUT_MS) to be recorded. */
  async function stop() {
    stopping = true;
    if (timer) clearInterval(timer);
    timer = null;
    await running;
  }

  return { enabled, deliverDue, kick, start, stop };
}

export type NotificationDispatcher = ReturnType<typeof createNotificationDispatcher>;
