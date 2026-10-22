/* Outgoing email over any SMTP provider (configurable, B4). Plain-text messages only (no HTML to inject into).
   Disabled unless SMTP_ENABLED=true: createMailer() returns null and features that need email say so.
   Transport security: implicit TLS (SMTP_SECURE) or mandatory STARTTLS, TLS 1.2+, certificate verified. */
import nodemailer from "nodemailer";
import type { Config } from "../config/env.js";

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export function createMailer(config: Config): Mailer | null {
  if (!config.SMTP_ENABLED || !config.SMTP_HOST || !config.SMTP_FROM) return null;
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_SECURE,
    requireTLS: !config.SMTP_SECURE,
    auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS } : undefined,
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  const from = config.SMTP_FROM;
  return {
    async send({ to, subject, text }) {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}
