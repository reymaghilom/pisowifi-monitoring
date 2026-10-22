/* Account management from the server's shell. There is no public registration endpoint: this is the only way
   to create accounts or set passwords. Passwords are typed at a hidden prompt (or piped with --password-stdin),
   hashed locally with Argon2id and never printed or passed on the command line.

     npm run user:create -w apps/api -- --email you@example.com --name "Your Name" --role admin
     npm run user:set-password -w apps/api -- --email you@example.com     (also unlocks and signs out everywhere)
     npm run user:list -w apps/api

   Uses DATABASE_URL (the runtime role is allowed to manage users). */
import { parseArgs } from "node:util";
import { eq, sql } from "drizzle-orm";
import { ROLES, ROLE_LABELS, emailSchema, newPasswordSchema, profileUpdateSchema, roleSchema } from "@pisowifi/shared";
import { loadConfigOrExit } from "../lifecycle.js";
import { createDb } from "../db/client.js";
import { tlsFromConfig } from "../db/pg-config.js";
import { auditLog, users } from "../db/schema/index.js";
import { hashPassword } from "./password.js";
import { revokeAllSessions } from "./sessions.js";

const USAGE = `Usage:
  user:create        --email <email> --name <display name> [--role ${ROLES.join("|")}] [--password-stdin]
  user:set-password  --email <email> [--password-stdin]
  user:list`;

class UsageError extends Error {}

/** Reads a line without echoing it. */
function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new UsageError("No interactive terminal: pipe the password with --password-stdin instead.");
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let buf = "";
    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\r" || c === "\n") return finish(), resolve(buf);
        if (c === "\u0003") return finish(), reject(new UsageError("Cancelled."));
        buf = c === "\u007f" || c === "\b" ? buf.slice(0, -1) : buf + c;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function readStdin(): Promise<string> {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, "");
}

async function askPassword(fromStdin: boolean): Promise<string> {
  const password = fromStdin ? await readStdin() : await promptHidden("New password (min 12 characters): ");
  const valid = newPasswordSchema.safeParse(password);
  if (!valid.success) throw new UsageError(valid.error.issues[0]!.message);
  if (!fromStdin && (await promptHidden("Repeat password: ")) !== password) throw new UsageError("Passwords do not match.");
  return password;
}

const [command, ...rest] = process.argv.slice(2);
const { values: args } = parseArgs({
  args: rest,
  options: { email: { type: "string" }, name: { type: "string" }, role: { type: "string" }, "password-stdin": { type: "boolean" } },
  strict: true,
});

const config = loadConfigOrExit();
const db = createDb(config.DATABASE_URL, { tls: tlsFromConfig(config), max: 1, applicationName: "pisowifi-accounts", timeoutMs: 15_000 });
if (!db) {
  console.error("DATABASE_URL is required.");
  process.exit(78);
}
const orm = db.orm;

async function findUser(email: string) {
  const [u] = await orm
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(sql`lower(${users.email})`, email.toLowerCase()))
    .limit(1);
  return u;
}

async function main() {
  switch (command) {
    case "create": {
      const profile = profileUpdateSchema.safeParse({ email: args.email ?? "", displayName: args.name ?? "" });
      if (!profile.success) throw new UsageError(profile.error.issues.map((i) => `--${i.path[0] === "displayName" ? "name" : String(i.path[0])}: ${i.message}`).join("\n"));
      const role = roleSchema.safeParse(args.role ?? "viewer");
      if (!role.success) throw new UsageError(`--role must be one of: ${ROLES.join(", ")}`);
      if (await findUser(profile.data.email)) throw new UsageError("An account with this email already exists. Use user:set-password to change its password.");
      const passwordHash = await hashPassword(await askPassword(!!args["password-stdin"]));
      const [created] = await orm
        .insert(users)
        .values({ email: profile.data.email, displayName: profile.data.displayName, role: role.data, passwordHash })
        .returning({ id: users.id });
      await orm.insert(auditLog).values({ action: "user.created", targetType: "user", targetId: created!.id, meta: { via: "cli", role: role.data } });
      console.log(`Created ${role.data} account ${profile.data.email}.`);
      return;
    }
    case "set-password": {
      const email = emailSchema.safeParse(args.email ?? "");
      if (!email.success) throw new UsageError(`--email: ${email.error.issues[0]!.message}`);
      const user = await findUser(email.data);
      if (!user) throw new UsageError("No account with this email.");
      const passwordHash = await hashPassword(await askPassword(!!args["password-stdin"]));
      await orm.update(users).set({ passwordHash, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, user.id));
      const revoked = await revokeAllSessions(orm, user.id);
      await orm.insert(auditLog).values({ action: "user.password_set", targetType: "user", targetId: user.id, meta: { via: "cli", sessionsRevoked: revoked } });
      console.log(`Password updated for ${user.email}; account unlocked; ${revoked} session(s) signed out.`);
      return;
    }
    case "list": {
      const rows = await orm
        .select({ email: users.email, name: users.displayName, role: users.role, lastLoginAt: users.lastLoginAt, lockedUntil: users.lockedUntil, disabledAt: users.disabledAt })
        .from(users)
        .orderBy(users.createdAt);
      if (!rows.length) return console.log("No accounts yet. Create one with user:create.");
      for (const r of rows) {
        const locked = r.lockedUntil && r.lockedUntil.getTime() > Date.now() ? `  LOCKED until ${r.lockedUntil.toISOString()}` : "";
        const off = r.disabledAt ? `  DEACTIVATED ${r.disabledAt.toISOString()}` : "";
        console.log(`${ROLE_LABELS[r.role].padEnd(13)}  ${r.email}  (${r.name})  last sign-in: ${r.lastLoginAt?.toISOString() ?? "never"}${locked}${off}`);
      }
      return;
    }
    default:
      throw new UsageError(USAGE);
  }
}

try {
  await main();
} catch (err) {
  console.error(err instanceof UsageError ? err.message : `Failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = err instanceof UsageError ? 64 : 1;
} finally {
  await db.close();
}
