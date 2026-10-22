/* Remote administration through the ZeroTier gateway (Azure). The API signs a short-lived, single-use Ed25519
   entry ticket; the browser opens the gateway's entry URL with the ticket in the URL fragment (never sent to a
   server or a Referer). The signing key stays with the API; the gateway only has the public key. */
import { z } from "zod";
import { isoDateTimeSchema } from "./api.js";

/** Path of the gateway's entry page; the ticket follows as `#t=<ticket>`. */
export const GATEWAY_ENTRY_PATH = "/__pisowifi/enter";

/** `<origin>/__pisowifi/enter#t=<base64url payload>.<base64url Ed25519 signature>`: nothing else. */
const ENTRY_URL = new RegExp(`^https?://[A-Za-z0-9.-]+(:\\d{1,5})?${GATEWAY_ENTRY_PATH}#t=[A-Za-z0-9_-]{16,1600}\\.[A-Za-z0-9_-]{86}$`);

/** `POST /remote/machines/:id/ticket` (Admin). `entryUrl` works once, until `expiresAt`. */
export const remoteTicketResponseSchema = z.object({
  entryUrl: z.url({ protocol: /^https?$/ }).regex(ENTRY_URL, "must be the gateway entry URL with a ticket fragment"),
  expiresAt: isoDateTimeSchema,
});
export type RemoteTicketResponse = z.infer<typeof remoteTicketResponseSchema>;
