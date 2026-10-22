CREATE TYPE "public"."check_error_kind" AS ENUM('timeout', 'refused', 'dns', 'tls', 'http', 'monitor');--> statement-breakpoint
CREATE TYPE "public"."check_trigger" AS ENUM('schedule', 'manual');--> statement-breakpoint
CREATE TYPE "public"."event_type" AS ENUM('outage', 'recovery', 'stale', 'error', 'system', 'check');--> statement-breakpoint
CREATE TYPE "public"."http_status" AS ENUM('reachable', 'stale', 'unreachable', 'unknown', 'error');--> statement-breakpoint
CREATE TYPE "public"."internet_state" AS ENUM('unverified');--> statement-breakpoint
CREATE TYPE "public"."monitor_health" AS ENUM('ok', 'paused', 'error', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."software_type" AS ENUM('WiFi5Soft', 'Other');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('admin', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."zerotier_state" AS ENUM('recent', 'stale', 'unknown');--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"ip" "inet",
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_log_action_nonempty" CHECK (char_length("audit_log"."action") between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE "password_reset_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"requested_ip" "inet",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "password_reset_tokens_hash_len" CHECK (octet_length("password_reset_tokens"."token_hash") = 32),
	CONSTRAINT "password_reset_tokens_expiry" CHECK ("password_reset_tokens"."expires_at" > "password_reset_tokens"."created_at")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" "bytea" NOT NULL,
	"remember" boolean DEFAULT false NOT NULL,
	"mfa_pending" boolean DEFAULT false NOT NULL,
	"ip" "inet",
	"user_agent" text,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_token_hash_len" CHECK (octet_length("sessions"."token_hash") = 32),
	CONSTRAINT "sessions_expiry_after_creation" CHECK ("sessions"."expires_at" > "sessions"."created_at"),
	CONSTRAINT "sessions_user_agent_len" CHECK ("sessions"."user_agent" is null or char_length("sessions"."user_agent") <= 512)
);
--> statement-breakpoint
CREATE TABLE "totp_backup_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "totp_backup_codes_hash_len" CHECK (octet_length("totp_backup_codes"."code_hash") = 32)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" "user_role" DEFAULT 'viewer' NOT NULL,
	"totp_secret_enc" "bytea",
	"totp_enabled_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_format" CHECK ("users"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and char_length("users"."email") <= 254),
	CONSTRAINT "users_display_name_len" CHECK (char_length(btrim("users"."display_name")) between 1 and 80),
	CONSTRAINT "users_password_hash_nonempty" CHECK (char_length("users"."password_hash") > 0),
	CONSTRAINT "users_failed_logins_nonneg" CHECK ("users"."failed_login_count" >= 0),
	CONSTRAINT "users_totp_needs_secret" CHECK ("users"."totp_enabled_at" is null or "users"."totp_secret_enc" is not null)
);
--> statement-breakpoint
CREATE TABLE "machine_state" (
	"machine_id" uuid PRIMARY KEY NOT NULL,
	"http_status" "http_status" DEFAULT 'unknown' NOT NULL,
	"last_check_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"zt_state" "zerotier_state" DEFAULT 'unknown' NOT NULL,
	"zt_last_seen_at" timestamp with time zone,
	"internet_state" "internet_state" DEFAULT 'unverified' NOT NULL,
	"internet_checked_at" timestamp with time zone,
	"monitor_health" "monitor_health" DEFAULT 'unknown' NOT NULL,
	"monitor_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_state_failures_nonneg" CHECK ("machine_state"."consecutive_failures" >= 0),
	CONSTRAINT "machine_state_success_not_after_check" CHECK ("machine_state"."last_success_at" is null or ("machine_state"."last_check_at" is not null and "machine_state"."last_success_at" <= "machine_state"."last_check_at")),
	CONSTRAINT "machine_state_monitor_error_len" CHECK ("machine_state"."monitor_error" is null or char_length("machine_state"."monitor_error") <= 500)
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"location" text,
	"description" text,
	"software" "software_type" DEFAULT 'WiFi5Soft' NOT NULL,
	"software_version" text,
	"zt_network_id" text,
	"zt_member_id" text,
	"zt_ip" "inet" NOT NULL,
	"admin_path" text DEFAULT '/admin' NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"monitoring_enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machines_name_valid" CHECK (char_length("machines"."name") between 1 and 64 and "machines"."name" = btrim("machines"."name")),
	CONSTRAINT "machines_location_len" CHECK ("machines"."location" is null or char_length("machines"."location") <= 120),
	CONSTRAINT "machines_description_len" CHECK ("machines"."description" is null or char_length("machines"."description") <= 2000),
	CONSTRAINT "machines_version_len" CHECK ("machines"."software_version" is null or char_length("machines"."software_version") <= 40),
	CONSTRAINT "machines_zt_network_id_format" CHECK ("machines"."zt_network_id" is null or "machines"."zt_network_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "machines_zt_member_id_format" CHECK ("machines"."zt_member_id" is null or "machines"."zt_member_id" ~ '^[0-9a-f]{10}$'),
	CONSTRAINT "machines_zt_member_needs_network" CHECK ("machines"."zt_member_id" is null or "machines"."zt_network_id" is not null),
	CONSTRAINT "machines_zt_ip_ipv4_host" CHECK (family("machines"."zt_ip") = 4 and masklen("machines"."zt_ip") = 32),
	CONSTRAINT "machines_admin_path_format" CHECK (left("machines"."admin_path", 1) = '/' and char_length("machines"."admin_path") <= 200),
	CONSTRAINT "machines_tags_limit" CHECK (cardinality("machines"."tags") <= 8)
);
--> statement-breakpoint
CREATE TABLE "check_rollups_hourly" (
	"machine_id" uuid NOT NULL,
	"bucket_start" timestamp with time zone NOT NULL,
	"checks" integer DEFAULT 0 NOT NULL,
	"ok_count" integer DEFAULT 0 NOT NULL,
	"avg_response_ms" integer,
	"down_seconds" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "check_rollups_hourly_pkey" PRIMARY KEY("machine_id","bucket_start"),
	CONSTRAINT "rollups_counts_valid" CHECK ("check_rollups_hourly"."checks" >= 0 and "check_rollups_hourly"."ok_count" between 0 and "check_rollups_hourly"."checks"),
	CONSTRAINT "rollups_down_seconds_range" CHECK ("check_rollups_hourly"."down_seconds" between 0 and 3600),
	CONSTRAINT "rollups_avg_nonneg" CHECK ("check_rollups_hourly"."avg_response_ms" is null or "check_rollups_hourly"."avg_response_ms" >= 0),
	CONSTRAINT "rollups_bucket_on_hour" CHECK (extract(epoch from "check_rollups_hourly"."bucket_start")::bigint % 3600 = 0)
);
--> statement-breakpoint
CREATE TABLE "checks" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checks_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"machine_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"duration_ms" integer,
	"ok" boolean NOT NULL,
	"http_code" smallint,
	"error_kind" "check_error_kind",
	"trigger" "check_trigger" DEFAULT 'schedule' NOT NULL,
	CONSTRAINT "checks_duration_nonneg" CHECK ("checks"."duration_ms" is null or "checks"."duration_ms" >= 0),
	CONSTRAINT "checks_http_code_range" CHECK ("checks"."http_code" is null or "checks"."http_code" between 100 and 599),
	CONSTRAINT "checks_ok_xor_error" CHECK (("checks"."ok" and "checks"."error_kind" is null) or (not "checks"."ok" and "checks"."error_kind" is not null))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"machine_id" uuid,
	"type" "event_type" NOT NULL,
	"status" "http_status",
	"message" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "events_message_len" CHECK (char_length("events"."message") between 1 and 500),
	CONSTRAINT "events_machine_unless_system" CHECK ("events"."type" = 'system' or "events"."machine_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "outages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "outages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"machine_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "outages_end_after_start" CHECK ("outages"."ended_at" is null or "outages"."ended_at" > "outages"."started_at")
);
--> statement-breakpoint
CREATE TABLE "monitoring_settings" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"timeout_seconds" integer DEFAULT 5 NOT NULL,
	"stale_threshold" integer DEFAULT 3 NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "monitoring_settings_singleton" CHECK ("monitoring_settings"."id" = 1),
	CONSTRAINT "monitoring_settings_interval" CHECK ("monitoring_settings"."interval_seconds" in (30, 60, 300, 900)),
	CONSTRAINT "monitoring_settings_timeout" CHECK ("monitoring_settings"."timeout_seconds" between 1 and 30),
	CONSTRAINT "monitoring_settings_threshold" CHECK ("monitoring_settings"."stale_threshold" between 1 and 10)
);
--> statement-breakpoint
CREATE TABLE "notification_prefs" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"offline" boolean DEFAULT true NOT NULL,
	"recovery" boolean DEFAULT true NOT NULL,
	"email" boolean DEFAULT false NOT NULL,
	"telegram" boolean DEFAULT false NOT NULL,
	"quiet_hours" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "totp_backup_codes" ADD CONSTRAINT "totp_backup_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_state" ADD CONSTRAINT "machine_state_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_rollups_hourly" ADD CONSTRAINT "check_rollups_hourly_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outages" ADD CONSTRAINT "outages_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "monitoring_settings" ADD CONSTRAINT "monitoring_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_prefs" ADD CONSTRAINT "notification_prefs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_at_idx" ON "audit_log" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "audit_log_user_created_idx" ON "audit_log" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "password_reset_tokens_token_hash_key" ON "password_reset_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "password_reset_tokens_user_idx" ON "password_reset_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "sessions_user_active_idx" ON "sessions" USING btree ("user_id") WHERE "sessions"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "totp_backup_codes_user_code_key" ON "totp_backup_codes" USING btree ("user_id","code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_lower_key" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "machine_state_http_status_idx" ON "machine_state" USING btree ("http_status");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_name_lower_key" ON "machines" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "machines_zt_ip_key" ON "machines" USING btree ("zt_ip");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_zt_member_key" ON "machines" USING btree ("zt_network_id","zt_member_id") WHERE "machines"."zt_member_id" is not null;--> statement-breakpoint
CREATE INDEX "check_rollups_hourly_bucket_idx" ON "check_rollups_hourly" USING btree ("bucket_start");--> statement-breakpoint
CREATE INDEX "checks_machine_started_idx" ON "checks" USING btree ("machine_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "checks_started_brin" ON "checks" USING brin ("started_at");--> statement-breakpoint
CREATE INDEX "events_occurred_idx" ON "events" USING btree ("occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_machine_occurred_idx" ON "events" USING btree ("machine_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "events_type_occurred_idx" ON "events" USING btree ("type","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "outages_machine_started_idx" ON "outages" USING btree ("machine_id","started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "outages_one_open_per_machine" ON "outages" USING btree ("machine_id") WHERE "outages"."ended_at" is null;