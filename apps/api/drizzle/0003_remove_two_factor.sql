-- Remove two-factor authentication (milestone B3 decision: email + password only, no 2FA now or planned).
-- Drops the unused TOTP columns, the backup-code table and the "second factor pending" session flag.
-- No CASCADE: an unexpected dependency fails the migration instead of being dropped silently.
DROP TABLE "totp_backup_codes";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_totp_needs_secret";--> statement-breakpoint
ALTER TABLE "sessions" DROP COLUMN "mfa_pending";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "totp_secret_enc";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "totp_enabled_at";
