/* Email texts. Plain text, no tracking, no secrets other than the one-time reset link. */
import { PASSWORD_RESET_TTL_MINUTES } from "@pisowifi/shared";
import type { MailMessage } from "./mailer.js";

const SIGNATURE = "\n\nPisoWiFi Monitoring";
const NOT_YOU = "If this wasn't you, reset your password right away and sign out all other sessions in Settings → Sessions.";

export const passwordResetEmail = (to: string, name: string, link: string): MailMessage => ({
  to,
  subject: "Reset your PisoWiFi Monitoring password",
  text:
    `Hi ${name},\n\nSomeone asked to reset the password for this account. To choose a new password, open this link ` +
    `within ${PASSWORD_RESET_TTL_MINUTES} minutes (it works once):\n\n${link}\n\n` +
    `If you didn't ask for this, ignore this email: your password stays the same.` +
    SIGNATURE,
});

export const passwordChangedEmail = (to: string, name: string): MailMessage => ({
  to,
  subject: "Your PisoWiFi Monitoring password was changed",
  text: `Hi ${name},\n\nThe password for this account was just changed and other sessions were signed out.\n\n${NOT_YOU}` + SIGNATURE,
});

export const emailChangedEmail = (to: string, name: string, newEmail: string): MailMessage => ({
  to,
  subject: "Your PisoWiFi Monitoring email was changed",
  text: `Hi ${name},\n\nThe sign-in email for this account was changed to ${newEmail}. This address will no longer receive account emails.\n\n${NOT_YOU}` + SIGNATURE,
});

export const testEmail = (to: string): MailMessage => ({
  to,
  subject: "PisoWiFi Monitoring: SMTP test",
  text: "This is a test message. SMTP delivery works." + SIGNATURE,
});
