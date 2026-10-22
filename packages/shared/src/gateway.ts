/* ZeroTier gateway contracts (Phases Z1, PC2). The API host is a ZeroTier member that checks registered machines'
   admin interfaces (monitoring data). Remote admin itself is direct: the user's device joins ZeroTier and opens the
   machine's admin page; the API never proxies it.
   Three separate signals, never merged: the gateway itself, the machine's admin HTTP interface, and customer
   internet access (not verified by the gateway). */
import { z } from "zod";
import { isoDateTimeSchema } from "./api.js";
import { checkErrorKindSchema, internetStateSchema, machineStatusSchema } from "./machine.js";

/** The gateway node: off by configuration, joined and online, not online, or not verifiable (no local ZeroTier API). */
export const GATEWAY_STATES = ["disabled", "online", "offline", "unknown"] as const;
export const gatewayStateSchema = z.enum(GATEWAY_STATES);
export type GatewayState = z.infer<typeof gatewayStateSchema>;

/** `GET /gateway/status` (Admin). No addresses, ranges or tokens are exposed. */
export const gatewayStatusSchema = z.object({
  enabled: z.boolean(),
  mode: z.enum(["direct"]),
  gateway: gatewayStateSchema,
  checkedAt: isoDateTimeSchema,
});
export type GatewayStatus = z.infer<typeof gatewayStatusSchema>;

/** `POST /gateway/machines/:id/check` and `POST /gateway/check` (Admin). Live result; not stored (monitoring is B8). */
export const gatewayCheckSchema = z.object({
  machineId: z.uuid(),
  gateway: gatewayStateSchema,
  adminHttp: machineStatusSchema,
  /** HTTP status the admin interface answered with (any answer means it is reachable; login still required). */
  httpStatus: z.number().int().min(100).max(599).nullable(),
  latencyMs: z.number().int().nonnegative().nullable(),
  error: checkErrorKindSchema.nullable(),
  /** Customer internet access is a different question; the gateway never claims it. */
  internet: internetStateSchema,
  checkedAt: isoDateTimeSchema,
});
export type GatewayCheck = z.infer<typeof gatewayCheckSchema>;
export const gatewayCheckListSchema = z.object({ items: z.array(gatewayCheckSchema) });

/** Why a check did not produce "reachable", in the order the steps are checked. Only admin_unreachable is a result
 *  about the machine; the others are monitoring-side and record nothing. */
export const GATEWAY_ERROR_CODES = ["gateway_disabled", "target_not_allowed", "egress_pending", "gateway_offline", "gateway_unverified", "admin_unreachable"] as const;
export type GatewayErrorCode = (typeof GATEWAY_ERROR_CODES)[number];
