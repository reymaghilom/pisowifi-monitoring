/* Authentication and account contracts (request/response shapes only; no auth logic).
   Single workspace with two roles (approved decision). Email + password sign-in; there is no second factor. */
import { z } from "zod";
import { isoDateTimeSchema } from "./api.js";

export const ROLES = ["admin", "viewer"] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/** What people see. The stored value stays "viewer" (rollback-safe); it is shown as Member. */
export const ROLE_LABELS: Record<Role, string> = { admin: "Administrator", viewer: "Member" };

/* ---------- permissions (RBAC) ----------
   The single source of truth for both the API (enforced, deny-by-default) and the web app (which only hides
   controls). Every API route declares one of these, "session" (any signed-in active user) or "public". */
export const PERMISSIONS = [
  "dashboard:view",
  "machines:view",
  "history:view",
  "remote:open",
  "account:self",
  "account:email",
  "notifications:receive",
  "machines:manage",
  "gateway:check",
  "users:manage",
  "settings:manage",
  "notifications:manage",
  "audit:view",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  admin: new Set(PERMISSIONS),
  // Member (stored as viewer): monitoring, history, Remote Admin for the approved machines, own account (not its sign-in email).
  viewer: new Set<Permission>(["dashboard:view", "machines:view", "history:view", "remote:open", "account:self", "notifications:receive"]),
};

/** Deny-by-default: unknown roles and missing users have no permissions. */
export function can(role: Role | null | undefined, permission: Permission): boolean {
  return !!role && (ROLE_PERMISSIONS[role]?.has(permission) ?? false);
}

export function permissionsFor(role: Role): Permission[] {
  return PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role].has(p));
}

export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound protects the password hasher from oversized input. */
export const PASSWORD_MAX_LENGTH = 256;

/** Same loose shape check the UI uses (the server never reveals whether an account exists). */
export const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export const AUTH_MESSAGES = {
  emailRequired: "Enter your email",
  passwordRequired: "Enter your password",
  emailInvalid: "Enter a valid email address",
  displayNameRequired: "Display name is required",
  currentPasswordRequired: "Enter your current password",
  passwordTooShort: "Use at least 12 characters",
  passwordTooLong: `Use at most ${PASSWORD_MAX_LENGTH} characters`,
  passwordUnchanged: "Choose a different password",
  passwordMismatch: "Passwords do not match",
  /** Generic sign-in failure: never says which part was wrong. */
  invalidCredentials: "Invalid email or password.",
  currentPasswordIncorrect: "Current password is incorrect",
  emailTaken: "Another account already uses this email",
  resetLinkInvalid: "This reset link is invalid or has expired. Request a new one.",
  resetUnavailable: "Password reset by email is not set up yet. Ask an admin to reset your password.",
} as const;

export const emailSchema = z.string().trim().max(254).regex(EMAIL_PATTERN, AUTH_MESSAGES.emailInvalid);

/* ---------- sign-in ---------- */

export const loginRequestSchema = z.object({
  /** Not format-checked: a malformed address simply fails like any unknown account. */
  email: z.string().trim().min(1, AUTH_MESSAGES.emailRequired).max(254),
  password: z.string().min(1, AUTH_MESSAGES.passwordRequired).max(PASSWORD_MAX_LENGTH),
  remember: z.boolean().default(true),
});
export type LoginRequest = z.input<typeof loginRequestSchema>;

export const userSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
});
export type UserDto = z.infer<typeof userSchema>;

/** `POST /auth/login` and `GET /auth/me`: the signed-in user. */
export const sessionUserResponseSchema = z.object({ user: userSchema });
export type SessionUserResponse = z.infer<typeof sessionUserResponseSchema>;

/* ---------- password reset (configurable SMTP, B4) ---------- */

/** Reset links expire after this long and work once. */
export const PASSWORD_RESET_TTL_MINUTES = 30;

export const passwordResetRequestSchema = z.object({ email: emailSchema });
export const newPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, AUTH_MESSAGES.passwordTooShort)
  .max(PASSWORD_MAX_LENGTH, AUTH_MESSAGES.passwordTooLong);
export const passwordResetConfirmSchema = z.object({ token: z.string().min(16).max(512), password: newPasswordSchema });

/* ---------- account (Settings) ---------- */

export const profileUpdateSchema = z.object({
  displayName: z.string().trim().min(1, AUTH_MESSAGES.displayNameRequired).max(80),
  email: emailSchema,
});
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

/** Change password. Rules run in the UI's order so each field shows the same message as today. */
export const changePasswordSchema = z
  .object({ currentPassword: z.string(), newPassword: z.string(), confirmPassword: z.string() })
  .superRefine((v, ctx) => {
    if (!v.currentPassword) ctx.addIssue({ code: "custom", path: ["currentPassword"], message: AUTH_MESSAGES.currentPasswordRequired });
    if (v.newPassword.length < PASSWORD_MIN_LENGTH) ctx.addIssue({ code: "custom", path: ["newPassword"], message: AUTH_MESSAGES.passwordTooShort });
    else if (v.newPassword.length > PASSWORD_MAX_LENGTH) ctx.addIssue({ code: "custom", path: ["newPassword"], message: AUTH_MESSAGES.passwordTooLong });
    else if (v.newPassword === v.currentPassword) ctx.addIssue({ code: "custom", path: ["newPassword"], message: AUTH_MESSAGES.passwordUnchanged });
    if (v.confirmPassword !== v.newPassword) ctx.addIssue({ code: "custom", path: ["confirmPassword"], message: AUTH_MESSAGES.passwordMismatch });
  });
export type ChangePasswordRequest = z.infer<typeof changePasswordSchema>;

/** Active session as listed in Settings → Sessions (`GET /account/sessions`). */
export const sessionSchema = z.object({
  id: z.uuid(),
  /** Derived from the browser's user agent, e.g. "Chrome on Windows". */
  label: z.string(),
  current: z.boolean(),
  createdAt: isoDateTimeSchema,
  lastSeenAt: isoDateTimeSchema,
});
export type SessionDto = z.infer<typeof sessionSchema>;
export const sessionsResponseSchema = z.object({ items: z.array(sessionSchema) });
export type SessionsResponse = z.infer<typeof sessionsResponseSchema>;

/** `POST /account/password` and `POST /account/sessions/revoke-others`: how many other sessions were signed out. */
export const revokedSessionsResponseSchema = z.object({ revoked: z.number().int().nonnegative() });
