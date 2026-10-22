/* SCRAM-SHA-256 password verifier (RFC 5802 / RFC 7677), in PostgreSQL's pg_authid format.
   Lets us set a role password without ever sending the plaintext to the server (where statement logs could
   capture it): `ALTER ROLE … PASSWORD 'SCRAM-SHA-256$…'` stores the verifier as-is. */
import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

export const SCRAM_ITERATIONS = 4096;

/** Printable ASCII only: avoids SASLprep differences between clients. Generate with `openssl rand -base64 32`. */
export const ROLE_PASSWORD_PATTERN = /^[\x21-\x7e]{24,128}$/;

export function scramSha256Verifier(password: string, salt: Buffer = randomBytes(16), iterations = SCRAM_ITERATIONS): string {
  if (!ROLE_PASSWORD_PATTERN.test(password)) throw new Error("Password must be 24–128 printable ASCII characters (no spaces).");
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}
