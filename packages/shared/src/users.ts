/* Manage Users (Administrators only). Request schemas are strict: unknown fields are rejected, so a request can
   never set a role, status, password or id it isn't meant to (no mass assignment). Passwords are never sent:
   new accounts and resets get a one-time set-password link that the person opens themselves. */
import { z } from "zod";
import { isoDateTimeSchema } from "./api.js";
import { AUTH_MESSAGES, emailSchema, roleSchema } from "./auth.js";

/** One-time set-password links (new accounts and admin resets) expire after this long and work once. */
export const SET_PASSWORD_LINK_TTL_MINUTES = 60;

export const USER_STATUSES = ["active", "deactivated", "locked"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const adminUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  status: z.enum(USER_STATUSES),
  lastLoginAt: isoDateTimeSchema.nullable(),
  lockedUntil: isoDateTimeSchema.nullable(),
  deactivatedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type AdminUserDto = z.infer<typeof adminUserSchema>;
export const usersResponseSchema = z.object({ items: z.array(adminUserSchema) });
/** `GET /users/:id`, `PATCH /users/:id`. */
export const userResponseSchema = z.object({ user: adminUserSchema });
/** `PUT /users/:id/role` and `/status`: the account after the change and how many of its sessions were ended. */
export const userChangeResponseSchema = z.object({ user: adminUserSchema, sessionsRevoked: z.number().int().nonnegative() });

export const usersQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    role: roleSchema.optional(),
    status: z.enum(USER_STATUSES).optional(),
  })
  .strict();

const displayNameSchema = z.string().trim().min(1, AUTH_MESSAGES.displayNameRequired).max(80);

export const userCreateSchema = z.object({ displayName: displayNameSchema, email: emailSchema, role: roleSchema.default("viewer") }).strict();
export type UserCreate = z.input<typeof userCreateSchema>;

export const userUpdateSchema = z
  .object({ displayName: displayNameSchema.optional(), email: emailSchema.optional() })
  .strict()
  .refine((v) => v.displayName !== undefined || v.email !== undefined, { message: "Nothing to update" });
export type UserUpdate = z.input<typeof userUpdateSchema>;

export const userRoleUpdateSchema = z.object({ role: roleSchema }).strict();
export const userStatusUpdateSchema = z.object({ active: z.boolean() }).strict();

/** Shown to the Administrator once; never stored or logged by the server. */
export const setPasswordLinkSchema = z.object({ setPasswordUrl: z.url(), expiresAt: isoDateTimeSchema });
export const userCreatedResponseSchema = z.object({ user: adminUserSchema }).extend(setPasswordLinkSchema.shape);

export const auditEntrySchema = z.object({
  id: z.number().int(),
  action: z.string(),
  createdAt: isoDateTimeSchema,
  actor: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  target: z.object({ type: z.string(), id: z.string() }).nullable(),
  ip: z.string().nullable(),
  meta: z.record(z.string(), z.unknown()),
});
export type AuditEntryDto = z.infer<typeof auditEntrySchema>;
export const auditPageSchema = z.object({ items: z.array(auditEntrySchema), nextBefore: z.number().int().nullable() });

export const auditQuerySchema = z
  .object({
    before: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    action: z.string().trim().regex(/^[a-z_.]{1,60}$/).optional(),
  })
  .strict();

export const USER_MESSAGES = {
  lastAdmin: "At least one active Administrator is required. Make another account an Administrator first.",
  selfRole: "You can't change your own role. Ask another Administrator.",
  selfDeactivate: "You can't deactivate your own account.",
  selfLink: "Use Settings → Security to change your own password.",
  deactivatedLink: "Reactivate this account before issuing a set-password link.",
  emailByAdmin: "Ask an Administrator to change your sign-in email.",
} as const;
