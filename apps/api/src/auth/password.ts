/* Password hashing: Argon2id with the OWASP-recommended baseline (19 MiB memory, 2 passes, 1 lane).
   Hashes are PHC strings ($argon2id$v=19$m=…,t=…,p=…$salt$hash), so the parameters can be raised later
   and old hashes still verify (see needsRehash). */
import { hash, verify, type Algorithm, type Options } from "@node-rs/argon2";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@pisowifi/shared";

export const ARGON2_OPTIONS: Options = {
  algorithm: 2 as Algorithm, // Argon2id (const enum, not importable under isolatedModules)
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

const PARAMS = `m=${ARGON2_OPTIONS.memoryCost},t=${ARGON2_OPTIONS.timeCost},p=${ARGON2_OPTIONS.parallelism}`;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new RangeError(`password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters`);
  }
  return hash(password, ARGON2_OPTIONS);
}

/** Never throws: a malformed stored hash counts as a mismatch. */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  if (password.length > PASSWORD_MAX_LENGTH) return false;
  try {
    return await verify(stored, password);
  } catch {
    return false;
  }
}

/** True when the stored hash is not Argon2id with the current parameters. */
export const needsRehash = (stored: string) => !stored.startsWith(`$argon2id$v=19$${PARAMS}$`);

let dummy: Promise<string> | undefined;

/** Spends the same time as a real check when the account doesn't exist, so response timing doesn't reveal it. */
export async function burnPasswordCheck(password: string): Promise<void> {
  dummy ??= hash("pisowifi-dummy-password-for-timing", ARGON2_OPTIONS);
  await verifyPassword(await dummy, password);
}
