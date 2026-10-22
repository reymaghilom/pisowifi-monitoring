/* Demo Manage Users: an in-memory list (this tab only, never persisted) with the API's rules, so the demo behaves
   like the real thing: no self role change or deactivation, at least one active Administrator, unique emails.
   "Links" point at an .invalid demo address and set nothing. */
import { USER_MESSAGES, AUTH_MESSAGES, EMAIL_PATTERN, type AdminUserDto, type AuditEntryDto, type Role } from "@pisowifi/shared";
import type { UsersFailure, UsersResult, UsersService } from "@/lib/services/types";
import { useDemo } from "@/stores/demo-store";

/** The demo's signed-in account (there is no real account id in mock mode). */
export const DEMO_SELF_ID = "00000000-0000-4000-8000-00000000d0e0";

const wait = (ms = 250) => new Promise<void>((r) => setTimeout(r, ms));
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const fail = <T>(status: number, message: string, fields: Record<string, string> = {}): UsersResult<T> => ({ ok: false, error: { status, message, fields } satisfies UsersFailure });

export function createMockUsersService(): UsersService {
  let seq = 0;
  let audit = 0;
  const profile = useDemo.getState().profile;
  const users: AdminUserDto[] = [
    { id: DEMO_SELF_ID, email: profile.email, displayName: profile.name, role: "admin", status: "active", lastLoginAt: iso(60_000), lockedUntil: null, deactivatedAt: null, createdAt: iso(9 * 86_400_000) },
    { id: "00000000-0000-4000-8000-00000000d0e1", email: "partner@example.com", displayName: "Co-owner (demo)", role: "admin", status: "active", lastLoginAt: iso(2 * 86_400_000), lockedUntil: null, deactivatedAt: null, createdAt: iso(9 * 86_400_000) },
    { id: "00000000-0000-4000-8000-00000000d0e2", email: "family@example.com", displayName: "Family member (demo)", role: "viewer", status: "active", lastLoginAt: null, lockedUntil: null, deactivatedAt: null, createdAt: iso(86_400_000) },
  ];
  const log: AuditEntryDto[] = [];
  const record = (action: string, targetId: string, meta: Record<string, unknown> = {}) =>
    log.unshift({ id: ++audit, action, createdAt: new Date().toISOString(), actor: { id: DEMO_SELF_ID, displayName: useDemo.getState().profile.name }, target: { type: "user", id: targetId }, ip: null, meta });
  const find = (id: string) => users.find((u) => u.id === id);
  const activeAdmins = () => users.filter((u) => u.role === "admin" && u.status !== "deactivated").length;
  const demoLink = () => ({ url: `https://demo.invalid/reset-password#token=demo-${Date.now().toString(36)}`, expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
  const validate = (input: { displayName?: string; email?: string }, selfId?: string) => {
    const fields: Record<string, string> = {};
    if (input.displayName !== undefined && !input.displayName.trim()) fields.displayName = AUTH_MESSAGES.displayNameRequired;
    if (input.email !== undefined) {
      if (!EMAIL_PATTERN.test(input.email.trim())) fields.email = AUTH_MESSAGES.emailInvalid;
      else if (users.some((u) => u.id !== selfId && u.email.toLowerCase() === input.email!.trim().toLowerCase())) fields.email = AUTH_MESSAGES.emailTaken;
    }
    return fields;
  };

  return {
    async list(query = {}) {
      await wait();
      const q = query.q?.trim().toLowerCase();
      return {
        ok: true,
        data: users
          .filter((u) => !q || u.email.toLowerCase().includes(q) || u.displayName.toLowerCase().includes(q))
          .filter((u) => !query.role || u.role === query.role)
          .filter((u) => !query.status || u.status === query.status)
          .map((u) => ({ ...u })),
      };
    },
    async create(input) {
      await wait();
      const fields = validate(input);
      if (Object.keys(fields).length) return fail(Object.values(fields).includes(AUTH_MESSAGES.emailTaken) ? 409 : 400, "Check the highlighted fields.", fields);
      const user: AdminUserDto = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, email: input.email.trim(), displayName: input.displayName.trim(), role: input.role, status: "active", lastLoginAt: null, lockedUntil: null, deactivatedAt: null, createdAt: new Date().toISOString() };
      users.push(user);
      record("user.created", user.id, { role: user.role, via: "admin" });
      return { ok: true, data: { user: { ...user }, link: demoLink() } };
    },
    async update(id, input) {
      await wait();
      const u = find(id);
      if (!u) return fail(404, "This account doesn't exist anymore. Refresh the list.");
      const fields = validate(input, id);
      if (Object.keys(fields).length) return fail(Object.values(fields).includes(AUTH_MESSAGES.emailTaken) ? 409 : 400, "Check the highlighted fields.", fields);
      Object.assign(u, { ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}), ...(input.email !== undefined ? { email: input.email.trim() } : {}) });
      record("user.updated", id, { fields: Object.keys(input) });
      return { ok: true, data: { ...u } };
    },
    async setRole(id, role: Role) {
      await wait();
      const u = find(id);
      if (!u) return fail(404, "This account doesn't exist anymore. Refresh the list.");
      if (id === DEMO_SELF_ID) return fail(409, USER_MESSAGES.selfRole);
      if (u.role === "admin" && role !== "admin" && u.status !== "deactivated" && activeAdmins() <= 1) return fail(409, USER_MESSAGES.lastAdmin);
      const from = u.role;
      u.role = role;
      record("user.role_changed", id, { from, to: role, sessionsRevoked: 0 });
      return { ok: true, data: { user: { ...u }, sessionsRevoked: 0 } };
    },
    async setActive(id, active) {
      await wait();
      const u = find(id);
      if (!u) return fail(404, "This account doesn't exist anymore. Refresh the list.");
      if (id === DEMO_SELF_ID && !active) return fail(409, USER_MESSAGES.selfDeactivate);
      if (!active && u.role === "admin" && u.status !== "deactivated" && activeAdmins() <= 1) return fail(409, USER_MESSAGES.lastAdmin);
      u.status = active ? "active" : "deactivated";
      u.deactivatedAt = active ? null : new Date().toISOString();
      record(active ? "user.reactivated" : "user.deactivated", id);
      return { ok: true, data: { user: { ...u }, sessionsRevoked: 0 } };
    },
    async issueLink(id) {
      await wait();
      const u = find(id);
      if (!u) return fail(404, "This account doesn't exist anymore. Refresh the list.");
      if (id === DEMO_SELF_ID) return fail(409, USER_MESSAGES.selfLink);
      if (u.status === "deactivated") return fail(409, USER_MESSAGES.deactivatedLink);
      record("user.password_link_issued", id);
      return { ok: true, data: demoLink() };
    },
    async activity(id, before) {
      await wait();
      const items = log.filter((e) => e.target?.id === id && (!before || e.id < before)).slice(0, 25);
      return { ok: true, data: { items, nextBefore: null } };
    },
  };
}
