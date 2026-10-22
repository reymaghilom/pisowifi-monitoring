-- Notification outbox for n8n -> Gmail status-change alerts. RLS + pisowifi_app policy as required by 0002.
CREATE TYPE "public"."delivery_status" AS ENUM('pending', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."notification_kind" AS ENUM('unreachable', 'reachable');--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" bigint NOT NULL,
	"machine_id" uuid NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"last_http_status" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "notification_deliveries_attempts_nonneg" CHECK ("notification_deliveries"."attempts" >= 0),
	CONSTRAINT "notification_deliveries_last_error_len" CHECK ("notification_deliveries"."last_error" is null or char_length("notification_deliveries"."last_error") <= 200),
	CONSTRAINT "notification_deliveries_sent_has_time" CHECK (("notification_deliveries"."status" = 'sent') = ("notification_deliveries"."sent_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_event_key" ON "notification_deliveries" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "notification_deliveries_due_idx" ON "notification_deliveries" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "notification_deliveries_machine_created_idx" ON "notification_deliveries" USING btree ("machine_id","created_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "notification_deliveries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "pisowifi_app_all" ON "notification_deliveries" AS PERMISSIVE FOR ALL TO pisowifi_app USING (true) WITH CHECK (true);
