/* Sends one test email to check the SMTP settings. Refuses to run unless SMTP_ENABLED=true.
     npm run mail:test -w apps/api -- --to you@example.com */
import { parseArgs } from "node:util";
import { emailSchema } from "@pisowifi/shared";
import { loadConfigOrExit } from "../lifecycle.js";
import { createMailer } from "./mailer.js";
import { testEmail } from "./templates.js";

const { values } = parseArgs({ options: { to: { type: "string" } }, strict: true });
const to = emailSchema.safeParse(values.to ?? "");
if (!to.success) {
  console.error("Usage: mail:test --to <email>");
  process.exit(64);
}
const config = loadConfigOrExit();
const mailer = createMailer(config);
if (!mailer) {
  console.error("Email is disabled. Set SMTP_HOST, SMTP_FROM (and SMTP_USER/SMTP_PASS) and SMTP_ENABLED=true first.");
  process.exit(78);
}
try {
  await mailer.send(testEmail(to.data));
  console.log(`Test email sent to ${to.data} via ${config.SMTP_HOST}:${config.SMTP_PORT} (${config.SMTP_SECURE ? "TLS" : "STARTTLS"}).`);
} catch (err) {
  console.error("Sending failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
