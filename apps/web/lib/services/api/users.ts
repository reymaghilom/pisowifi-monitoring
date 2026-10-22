/* Manage Users against the API (RBAC-1: /users, /users/:id/activity). The API decides everything: it enforces
   users:manage / audit:view, the last-active-Administrator rule, no self role change or deactivation, and
   validates every field. This module only sends requests and parses the answers with the shared contracts.

   One-time set-password links: returned to the caller and nothing else. Never logged, toasted, put in the store
   or browser storage, or sent anywhere; requests use cache: "no-store" (and the API answers no-store). */
import {
  apiErrorSchema,
  auditPageSchema,
  setPasswordLinkSchema,
  userChangeResponseSchema,
  userCreatedResponseSchema,
  userResponseSchema,
  usersResponseSchema,
} from "@pisowifi/shared";
import type { UsersFailure, UsersResult, UsersService } from "@/lib/services/types";

const API = "/api/v1";
const UNREACHABLE = "Can't reach the server. Check your connection and try again.";
const UNEXPECTED = "The server sent an unexpected answer. Nothing was changed on this page; refresh to check.";
const BY_STATUS: Record<number, string> = {
  401: "Your session has ended. Sign in again, then retry.",
  403: "You don't have permission to manage users.",
  404: "This account doesn't exist anymore. Refresh the list.",
  429: "Too many changes in a short time. Wait a few minutes, then try again.",
};

type Parser<T> = { safeParse(v: unknown): { success: true; data: T } | { success: false } };

async function request<T>(path: string, parser: Parser<T>, init: RequestInit = {}): Promise<UsersResult<T>> {
  const res = await fetch(API + path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    referrerPolicy: "no-referrer",
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
  }).catch(() => null);
  if (!res) return { ok: false, error: { status: 0, message: UNREACHABLE, fields: {} } };
  const body: unknown = await res.json().catch(() => null);
  if (res.ok) {
    const parsed = parser.safeParse(body);
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: { status: res.status, message: UNEXPECTED, fields: {} } };
  }
  return { ok: false, error: failure(res.status, body) };
}

function failure(status: number, body: unknown): UsersFailure {
  const err = apiErrorSchema.safeParse(body);
  // Our wording for session/permission/not-found/rate limits; the API's where it is specific (400, 409).
  const message = BY_STATUS[status] ?? (err.success ? err.data.error.message : UNREACHABLE);
  return { status, message, fields: err.success ? (err.data.error.fields ?? {}) : {} };
}

const json = (method: string, body?: unknown): RequestInit => ({ method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const id = (v: string) => encodeURIComponent(v);
const link = (l: { setPasswordUrl: string; expiresAt: string }) => ({ url: l.setPasswordUrl, expiresAt: l.expiresAt });

export function createApiUsersService(): UsersService {
  return {
    async list(query = {}) {
      const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== "") as [string, string][]).toString();
      const res = await request(`/users${qs ? "?" + qs : ""}`, usersResponseSchema);
      return res.ok ? { ok: true, data: res.data.items } : res;
    },
    async create(input) {
      const res = await request("/users", userCreatedResponseSchema, json("POST", input));
      return res.ok ? { ok: true, data: { user: res.data.user, link: link(res.data) } } : res;
    },
    async update(userId, input) {
      const res = await request(`/users/${id(userId)}`, userResponseSchema, json("PATCH", input));
      return res.ok ? { ok: true, data: res.data.user } : res;
    },
    setRole: (userId, role) => request(`/users/${id(userId)}/role`, userChangeResponseSchema, json("PUT", { role })),
    setActive: (userId, active) => request(`/users/${id(userId)}/status`, userChangeResponseSchema, json("PUT", { active })),
    async issueLink(userId) {
      const res = await request(`/users/${id(userId)}/password-link`, setPasswordLinkSchema, json("POST"));
      return res.ok ? { ok: true, data: link(res.data) } : res;
    },
    activity: (userId, before) => request(`/users/${id(userId)}/activity?limit=25${before ? `&before=${before}` : ""}`, auditPageSchema),
  };
}
