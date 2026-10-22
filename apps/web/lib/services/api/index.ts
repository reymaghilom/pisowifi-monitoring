/* API services: real sign-in and account management against the PisoWiFi API (B3, B4). The session lives in
   an HttpOnly cookie that scripts can't read; requests are same-origin (/api/v1 is proxied by next.config.ts),
   so the browser sends it and the API's Origin check passes. Machines (B6) come from the API too; monitoring
   preferences, notifications and automations are still the mock until their backend milestones. */
import {
  apiErrorSchema,
  revokedSessionsResponseSchema,
  sessionUserResponseSchema,
  sessionsResponseSchema,
  type SessionDto,
  type UserDto,
} from "@pisowifi/shared";
import { ago, dShort } from "@/lib/format";
import type { Services, SignedInUser } from "@/lib/services/types";
import { createMockServices } from "@/lib/services/mock";
import { createApiMachineService } from "@/lib/services/api/machines";
import { createApiUsersService } from "@/lib/services/api/users";
import { useDemo, type SessionRow } from "@/stores/demo-store";
import { setSessionStatus } from "@/lib/session";

const API = "/api/v1";
const UNREACHABLE = "Can't reach the server. Check your connection and try again.";

const toSignedIn = (u: UserDto): SignedInUser => ({ id: u.id, name: u.displayName, email: u.email, role: u.role });

const toRow = (s: SessionDto): SessionRow => ({
  id: s.id,
  name: s.label,
  meta: `${s.current ? "Active now" : `Last active ${ago(Date.parse(s.lastSeenAt))}`} · signed in ${dShort(Date.parse(s.createdAt))}`,
  cur: s.current,
});

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(API + path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
}

/** Parsed API error: message plus per-field messages (always safe to show). */
async function apiFailure(res: Response): Promise<{ message: string; fields: Record<string, string> }> {
  const body = apiErrorSchema.safeParse(await res.json().catch(() => null));
  if (!body.success) return { message: UNREACHABLE, fields: {} };
  return { message: body.data.error.message, fields: body.data.error.fields ?? {} };
}

async function errorMessage(res: Response): Promise<string> {
  const { message, fields } = await apiFailure(res);
  return Object.values(fields)[0] ?? message;
}

/** Network errors become a response-like failure so every caller handles one shape. */
const send = (path: string, init?: RequestInit) => call(path, init).catch(() => null);

/** Mirrors the signed-in user into the shell state (header name/email, route guard). */
function remember(user: SignedInUser, rememberMe?: boolean) {
  const s = useDemo.getState();
  s.patch({ profile: { name: user.name, email: user.email }, role: user.role, uid: user.id ?? null });
  if (!s.auth || rememberMe !== undefined) s.signIn(rememberMe ?? s.remember);
}

export function createApiServices(): Services {
  const mock = createMockServices();

  const listSessions = async (): Promise<SessionRow[]> => {
    const res = await send("/account/sessions");
    if (!res?.ok) return useDemo.getState().sessions;
    const rows = sessionsResponseSchema.parse(await res.json()).items.map(toRow);
    useDemo.getState().patch({ sessions: rows });
    return rows;
  };

  return {
    ...mock,
    machines: createApiMachineService(),
    users: createApiUsersService(),
    auth: {
      async signIn({ email, password, remember: rememberMe }) {
        const res = await send("/auth/login", { method: "POST", body: JSON.stringify({ email, password, remember: rememberMe }) });
        if (!res) return { ok: false, error: UNREACHABLE };
        if (!res.ok) return { ok: false, error: await errorMessage(res) };
        const body = sessionUserResponseSchema.safeParse(await res.json().catch(() => null));
        if (!body.success) return { ok: false, error: UNREACHABLE };
        remember(toSignedIn(body.data.user), rememberMe);
        setSessionStatus("authenticated");
        return { ok: true };
      },
      /** null only when the API says the session is gone (401); network errors throw so callers keep the user signed in. */
      async currentUser() {
        const res = await call("/auth/me");
        if (res.status === 401) return null;
        if (!res.ok) throw new Error(`session check failed (${res.status})`);
        return toSignedIn(sessionUserResponseSchema.parse(await res.json()).user);
      },
      /** Always signs out locally; if the request fails the server session still expires on its own. */
      async signOut() {
        await send("/auth/logout", { method: "POST" });
        useDemo.getState().signOut();
        setSessionStatus("unauthenticated");
      },
      async requestPasswordReset(email) {
        const res = await send("/auth/password-reset", { method: "POST", body: JSON.stringify({ email }) });
        if (!res) return { ok: false, error: UNREACHABLE };
        return res.ok ? { ok: true } : { ok: false, error: await errorMessage(res) };
      },
      async confirmPasswordReset(token, pw, cf) {
        if (pw !== cf) return mock.auth.confirmPasswordReset(token, pw, cf);
        const res = await send("/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token, password: pw }) });
        if (!res) return { ok: false, error: { form: UNREACHABLE } };
        if (res.ok) return { ok: true };
        const { message, fields } = await apiFailure(res);
        return { ok: false, error: fields.password ? { pw: fields.password } : { form: message } };
      },
    },

    settings: {
      ...mock.settings,
      async saveProfile(p) {
        const res = await send("/account/profile", { method: "PATCH", body: JSON.stringify({ displayName: p.name, email: p.email }) });
        if (!res) return { ok: false, error: { email: UNREACHABLE } };
        if (!res.ok) {
          const { message, fields } = await apiFailure(res);
          const error = { name: fields.displayName, email: fields.email };
          return { ok: false, error: error.name || error.email ? error : { email: message } };
        }
        remember(toSignedIn(sessionUserResponseSchema.parse(await res.json()).user));
        return { ok: true };
      },
      async changePassword(cur, nw, cf) {
        const res = await send("/account/password", { method: "POST", body: JSON.stringify({ currentPassword: cur, newPassword: nw, confirmPassword: cf }) });
        if (!res) return { ok: false, error: { cur: UNREACHABLE } };
        if (!res.ok) {
          const { message, fields } = await apiFailure(res);
          const error = { cur: fields.currentPassword, nw: fields.newPassword, cf: fields.confirmPassword };
          return { ok: false, error: error.cur || error.nw || error.cf ? error : { cur: message } };
        }
        revokedSessionsResponseSchema.parse(await res.json());
        await listSessions();
        return { ok: true };
      },
      listSessions,
      async signOutSession(id) {
        await send(`/account/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
        await listSessions();
      },
      async signOutOtherSessions() {
        await send("/account/sessions/revoke-others", { method: "POST" });
        await listSessions();
      },
    },
  };
}
