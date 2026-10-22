/* Remote administration through the ZeroTier gateway (NEXT_PUBLIC_REMOTE_MODE=gateway). The API decides who gets a
   ticket (remote:open session permission, Origin check); this only asks for one and hands it to a browser tab.

   The ticket is a bearer credential for about a minute: it is never logged, toasted, stored or sent anywhere but
   the tab that opens the gateway. It sits in the URL fragment, which browsers never send to a server or in a
   Referer. */
import { apiErrorSchema, remoteTicketResponseSchema, type RemoteTicketResponse } from "@pisowifi/shared";
import { REMOTE_MODE } from "@/lib/constants";

const API = "/api/v1";
const GATEWAY_ORIGIN = process.env.NEXT_PUBLIC_GATEWAY_ORIGIN;

/** Browser-side guard for the destination; the server also controls ticket issuance. */
export function isConfiguredGatewayEntryUrl(entryUrl: string, configuredOrigin = GATEWAY_ORIGIN): boolean {
  if (!configuredOrigin || !remoteTicketResponseSchema.shape.entryUrl.safeParse(entryUrl).success) return false;
  try {
    const origin = new URL(configuredOrigin);
    const entry = new URL(entryUrl);
    return origin.protocol === "https:" && configuredOrigin === origin.origin && entry.protocol === "https:" && entry.origin === origin.origin;
  } catch {
    return false;
  }
}

export type TicketFailure = "unauthenticated" | "forbidden" | "not_found" | "invalid_machine" | "unavailable" | "rate_limited" | "unreachable" | "bad_response";

export type TicketResult = ({ ok: true } & RemoteTicketResponse) | { ok: false; reason: TicketFailure; message: string };

const DEFAULT_MESSAGE: Record<TicketFailure, string> = {
  unauthenticated: "Your session has ended. Sign in again, then retry.",
  forbidden: "Your account can’t open remote administration. Ask an Administrator for access.",
  not_found: "This machine isn’t registered anymore. Refresh the list and try again.",
  invalid_machine: "This machine’s ZeroTier IP or admin path can’t be opened through the gateway. Check it in My PisoWiFi.",
  unavailable: "Remote administration through the gateway isn’t enabled on the server yet.",
  rate_limited: "Too many attempts. Wait a minute, then try again.",
  unreachable: "Can't reach the server. Check your connection and try again.",
  bad_response: "The server sent an unexpected answer. Nothing was opened.",
};

const BY_STATUS: Record<number, TicketFailure> = {
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  422: "invalid_machine",
  429: "rate_limited",
  503: "unavailable",
};

/** apps/api/src/auth/plugin.ts, Origin check. */
const CROSS_ORIGIN_MESSAGE = "Cross-origin request blocked.";
const WRONG_ORIGIN = "The server refused this page’s address. Open PisoWiFi Monitoring at its configured address, then try again.";

const fail = (reason: TicketFailure, message = DEFAULT_MESSAGE[reason]): TicketResult => ({ ok: false, reason, message });

/** `POST /remote/machines/:id/ticket`. Never throws. */
export async function requestRemoteTicket(machineId: string): Promise<TicketResult> {
  if (REMOTE_MODE !== "gateway") return fail("unavailable");
  const res = await fetch(`${API}/remote/machines/${encodeURIComponent(machineId)}/ticket`, {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json" },
  }).catch(() => null);
  if (!res) return fail("unreachable");
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const ticket = remoteTicketResponseSchema.safeParse(body);
    return ticket.success && isConfiguredGatewayEntryUrl(ticket.data.entryUrl) ? { ok: true, ...ticket.data } : fail("bad_response");
  }
  const reason = BY_STATUS[res.status] ?? "unreachable";
  const err = apiErrorSchema.safeParse(body);
  // The API's CSRF check (also a 403): the app was opened at an address other than its configured APP_ORIGIN.
  if (reason === "forbidden" && err.success && err.data.error.message === CROSS_ORIGIN_MESSAGE) return fail(reason, WRONG_ORIGIN);
  // Our wording for session, role and deleted-machine failures; the API's where it is specific (422, 429, 503).
  return reason === "unauthenticated" || reason === "forbidden" || reason === "not_found" || !err.success ? fail(reason) : fail(reason, err.data.error.message);
}

/** A tab opened synchronously in the click handler (before any await, so popup blockers allow it), detached from
 *  this page, waiting for the gateway URL. null: the browser blocked it. */
export type PendingTab = { go(entryUrl: string): boolean; close(): void } | null;

export function openPendingTab(): PendingTab {
  if (REMOTE_MODE !== "gateway") return null;
  // Not "noopener": with it window.open returns null and the tab could never be navigated. The opener link is cut
  // right away instead, so the gateway page can't reach back into this one (reverse tabnabbing).
  let opened: Window | null = null;
  try {
    opened = window.open("about:blank", "_blank");
  } catch {
    opened = null;
  }
  if (!opened) return null;
  const tab = opened;
  try {
    tab.opener = null;
    tab.document.title = "Opening admin page…";
    tab.document.body.textContent = "Opening the secure gateway…";
  } catch {
    // Some browsers don't expose the blank document; navigation still works.
  }
  return {
    /** false: the user closed the tab while waiting. replace(): the blank page doesn't stay in its history. */
    go(entryUrl) {
      if (tab.closed) return false;
      tab.location.replace(entryUrl);
      return true;
    },
    close: () => {
      try {
        tab.close();
      } catch {
        // Already closed by the user.
      }
    },
  };
}

/** Same-tab fallback, only ever from a click. Indirection so tests can observe it (jsdom can't navigate). */
export const leavePage = { to: (entryUrl: string) => window.location.assign(entryUrl) };
