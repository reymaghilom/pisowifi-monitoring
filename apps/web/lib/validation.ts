/* Form validation for the UI. Field rules and messages come from @pisowifi/shared (also used by the API);
   this module adapts them to the form field names and adds checks that need local data (uniqueness). */
import {
  AUTH_MESSAGES,
  EMAIL_PATTERN,
  IPV4_PATTERN,
  MACHINE_MESSAGES,
  adminPathSchema,
  changePasswordSchema,
  fieldErrors,
  loginRequestSchema,
  machineNameSchema,
  newPasswordSchema,
  monitoringSettingsSchema,
  profileUpdateSchema,
  SUPPORTED_SOFTWARE,
  ztIpSchema,
  ztNetworkIdSchema,
} from "@pisowifi/shared";
import type { Machine, MachineInput } from "@/lib/types";

export const IP4 = IPV4_PATTERN;
export const EMAIL = EMAIL_PATTERN;

/** First message of a failed parse, or undefined. */
const firstError = (r: { success: boolean; error?: { issues: { message: string }[] } }) => (r.success ? undefined : r.error?.issues[0]?.message);

export type MachineErrors = Partial<Record<"name" | "sw" | "ip" | "path" | "ztNet", string>>;

/** Whether the API accepts this software type for new and edited machines (WiFi5Soft only). */
export const isSupportedSoftware = (sw: string) => (SUPPORTED_SOFTWARE as readonly string[]).includes(sw);

/** Add/Edit machine validation, ported from the prototype's validateForm. */
export function validateMachine(f: MachineInput, machines: Machine[], id: string | null): MachineErrors {
  const e: MachineErrors = {};
  // A stored legacy value (e.g. "Other") is reported, never silently replaced and never sent (the API would refuse it).
  if (!isSupportedSoftware(f.sw)) e.sw = MACHINE_MESSAGES.softwareUnsupported;
  const name = f.name.trim();
  const ip = f.ip.trim();
  const nameErr = firstError(machineNameSchema.safeParse(f.name));
  if (nameErr) e.name = nameErr;
  else if (machines.some((m) => m.id !== id && m.name.toLowerCase() === name.toLowerCase())) e.name = MACHINE_MESSAGES.nameTaken;
  const ipErr = firstError(ztIpSchema.safeParse(f.ip));
  if (ipErr) e.ip = ipErr;
  else if (machines.some((m) => m.id !== id && m.ip === ip)) e.ip = MACHINE_MESSAGES.ipTaken;
  const pathErr = firstError(adminPathSchema.safeParse(f.path));
  if (pathErr) e.path = pathErr;
  const netErr = f.ztNet ? firstError(ztNetworkIdSchema.safeParse(f.ztNet)) : undefined;
  if (netErr) e.ztNet = netErr;
  return e;
}

/** Password strength score 0–5. */
export function strength(p: string) {
  let s = 0;
  if (p.length >= 12) s++;
  if (p.length >= 16) s++;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
  if (/\d/.test(p)) s++;
  if (/[^A-Za-z0-9]/.test(p)) s++;
  return s;
}

export function validateLogin(email: string, password: string) {
  const r = loginRequestSchema.safeParse({ email, password });
  const f = r.success ? {} : fieldErrors(r.error);
  const e: { email?: string; pw?: string } = {};
  if (f.email) e.email = f.email;
  if (f.password) e.pw = f.password;
  return e;
}

export function validateResetEmail(email: string) {
  return EMAIL.test(email.trim()) ? undefined : AUTH_MESSAGES.emailInvalid;
}

/** New password + confirmation (reset form). */
export function validateNewPassword(pw: string, cf: string) {
  const e: { pw?: string; cf?: string } = {};
  const r = newPasswordSchema.safeParse(pw);
  if (!r.success) e.pw = r.error.issues[0]?.message;
  if (cf !== pw) e.cf = AUTH_MESSAGES.passwordMismatch;
  return e;
}

export function validateProfile(name: string, email: string) {
  const r = profileUpdateSchema.safeParse({ displayName: name, email });
  const f = r.success ? {} : fieldErrors(r.error);
  const e: { name?: string; email?: string } = {};
  if (f.displayName) e.name = f.displayName;
  if (f.email) e.email = f.email;
  return e;
}

export function validatePasswordChange(cur: string, nw: string, cf: string) {
  const r = changePasswordSchema.safeParse({ currentPassword: cur, newPassword: nw, confirmPassword: cf });
  const f = r.success ? {} : fieldErrors(r.error);
  const e: { cur?: string; nw?: string; cf?: string } = {};
  if (f.currentPassword) e.cur = f.currentPassword;
  if (f.newPassword) e.nw = f.newPassword;
  if (f.confirmPassword) e.cf = f.confirmPassword;
  return e;
}

export function validateMonitoring(timeout: string, thr: string) {
  // The interval is a fixed select in the UI; validate the two typed fields.
  const r = monitoringSettingsSchema.safeParse({ intervalSeconds: 60, timeoutSeconds: timeout, staleThreshold: thr });
  const f = r.success ? {} : fieldErrors(r.error);
  const e: { timeout?: string; thr?: string } = {};
  if (f.timeoutSeconds) e.timeout = f.timeoutSeconds;
  if (f.staleThreshold) e.thr = f.staleThreshold;
  return e;
}

export const hasErrors = (e: object) => Object.values(e).some(Boolean);
