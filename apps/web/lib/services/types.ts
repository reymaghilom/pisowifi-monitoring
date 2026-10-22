/* Service contracts the UI depends on. Implementations: lib/services/mock (everything simulated) and
   lib/services/api (real sign-in against the API, the rest still mock until their backend milestones).
   Every implementation must pass tests/services.contract.test.ts.

   Commands (anything that changes data) are async so a network implementation can drop in.
   Read models (history/report aggregations) are synchronous today because the sample engine runs in
   the browser; with a backend they move behind a data-fetching hook (see README, "Swapping in a backend"). */
import type { RuleKey } from "@/lib/constants";
import type { MachineErrors } from "@/lib/validation";
import type { Machine, MachineInput, MachineStatus } from "@/lib/types";
import type { NotifPrefs, SessionRow } from "@/stores/demo-store";
import type { AdminUserDto, AuditEntryDto, Role, UserStatus } from "@pisowifi/shared";

export type Ok = { ok: true };
export type Fail<E> = { ok: false; error: E };

/** `id`: the account id in API mode; absent in the demo. */
export type SignedInUser = { id?: string; name: string; email: string; role: "admin" | "viewer" };

export interface AuthService {
  /** Email + password sign-in (no second factor). On success the user is signed in. */
  signIn(input: { email: string; password: string; remember: boolean }): Promise<Ok | Fail<string>>;
  /** The signed-in user, or null when there is no live session. */
  currentUser(): Promise<SignedInUser | null>;
  signOut(): Promise<void>;
  requestPasswordReset(email: string): Promise<Ok | Fail<string>>;
  /** Sets a new password from a reset link's token. `form` is a message for the whole form (e.g. expired link). */
  confirmPasswordReset(token: string, pw: string, cf: string): Promise<Ok | Fail<{ pw?: string; cf?: string; form?: string }>>;
}

export interface MachineService {
  /** Loads the registered machines into the store (API mode) and returns them. Mock: the demo machines. */
  list(): Promise<Machine[]>;
  create(input: MachineInput): Promise<{ ok: true; machine: Machine } | Fail<MachineErrors>>;
  update(id: string, input: MachineInput): Promise<{ ok: true; machine: Machine } | Fail<MachineErrors>>;
  remove(id: string): Promise<void>;
  /** Mock: simulated admin HTTP check (no request is sent). API: not available until monitoring (B8); changes nothing. */
  runCheck(ids: string[]): Promise<void>;
  /** Pauses or resumes monitoring; resolves to the new state. */
  toggleMonitoring(id: string): Promise<boolean>;
  /** Demo only: force a machine into a state. API: no-op (statuses are never fabricated). */
  /** Demo only. null = no valid check yet. */
  simulateStatus(id: string, status: MachineStatus | null): Promise<void>;
}

export interface SettingsService {
  saveProfile(p: { name: string; email: string }): Promise<Ok | Fail<{ name?: string; email?: string }>>;
  changePassword(cur: string, nw: string, cf: string): Promise<Ok | Fail<{ cur?: string; nw?: string; cf?: string }>>;
  /** The signed-in user's active sessions (also mirrored into the store for the Sessions list). */
  listSessions(): Promise<SessionRow[]>;
  signOutSession(id: string): Promise<void>;
  signOutOtherSessions(): Promise<void>;
  saveMonitoring(m: { interval: string; timeout: string; thr: string }): Promise<Ok | Fail<{ timeout?: string; thr?: string }>>;
  setNotification(key: keyof NotifPrefs, on: boolean): Promise<void>;
}

export interface AutomationService {
  setRule(rule: RuleKey, on: boolean): Promise<void>;
}

/** A refused or failed Manage Users request: HTTP status (0 = network), a message that is always safe to show,
 *  and per-field messages for forms. */
export type UsersFailure = { status: number; message: string; fields: Record<string, string> };
export type UsersResult<T> = { ok: true; data: T } | { ok: false; error: UsersFailure };
/** A one-time set-password link. Shown to the Administrator once; never stored, logged or cached by the app. */
export type SetPasswordLink = { url: string; expiresAt: string };

/** Manage Users (Administrators; the API enforces users:manage and audit:view). */
export interface UsersService {
  list(query?: { q?: string; role?: Role; status?: UserStatus }): Promise<UsersResult<AdminUserDto[]>>;
  create(input: { displayName: string; email: string; role: Role }): Promise<UsersResult<{ user: AdminUserDto; link: SetPasswordLink }>>;
  update(id: string, input: { displayName?: string; email?: string }): Promise<UsersResult<AdminUserDto>>;
  setRole(id: string, role: Role): Promise<UsersResult<{ user: AdminUserDto; sessionsRevoked: number }>>;
  setActive(id: string, active: boolean): Promise<UsersResult<{ user: AdminUserDto; sessionsRevoked: number }>>;
  issueLink(id: string): Promise<UsersResult<SetPasswordLink>>;
  activity(id: string, before?: number): Promise<UsersResult<{ items: AuditEntryDto[]; nextBefore: number | null }>>;
}

export interface Services {
  auth: AuthService;
  users: UsersService;
  machines: MachineService;
  settings: SettingsService;
  automations: AutomationService;
}
