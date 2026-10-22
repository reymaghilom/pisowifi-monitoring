/* Common API contracts: error envelope, list/pagination, health. */
import { z } from "zod";

/** Machine-readable error codes used by the API. */
export const ERROR_CODES = [
  "bad_request",
  "validation_failed",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "rate_limited",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Every error response: `{ error: { code, message, fields? } }`. `fields` maps an input field to its message. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;

export function apiError(code: ErrorCode | (string & {}), message: string, fields?: Record<string, string>): ApiError {
  return { error: fields ? { code, message, fields } : { code, message } };
}

/** Cursor pagination query: `?cursor=…&limit=…` (limit 1–100, default 50). */
export const cursorQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type CursorQuery = z.infer<typeof cursorQuerySchema>;

/** List responses: `{ items, nextCursor }` (`nextCursor` is null on the last page). */
export const listResponseSchema = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });
export type ListResponse<T> = { items: T[]; nextCursor: string | null };

/** ISO-8601 timestamp with offset, as sent over the wire. */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

export const healthResponseSchema = z.object({ status: z.literal("ok"), version: z.string(), uptime: z.number().int().nonnegative() });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const readyResponseSchema = z.object({
  status: z.enum(["ready", "not_ready"]),
  db: z.enum(["up", "down", "not_configured"]),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;

/** First message per top-level field, e.g. `{ name: "Machine name is required" }`. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? String(issue.path[0]) : "_";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}
