-- Supabase hardening and least-privilege runtime role (milestone S1). Additive: B2 migrations are unchanged.
-- Safe on any PostgreSQL: Supabase-only roles (anon, authenticated) are handled only if they exist.
--
-- Roles:
--   * migration role (the role running this file; on Supabase `postgres`): owns the tables. Table owners bypass
--     RLS, so migrations and maintenance keep working.
--   * pisowifi_app: runtime role for the API and worker. Created NOLOGIN here (no secret in git); login and
--     password are enabled by `npm run db:provision-app-role` (SCRAM verifier, plaintext never sent).
--   * anon / authenticated (Supabase Data API): no access at all.
-- Every table has RLS enabled. Only pisowifi_app has policies; any other non-owner role sees nothing.
-- Authorization (Admin/Viewer) is enforced per request by the API, so the app role's policies allow all rows.
-- New tables in later migrations must: ENABLE ROW LEVEL SECURITY + add a pisowifi_app policy
-- (tests/migrations.test.ts fails otherwise).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pisowifi_app') THEN
    CREATE ROLE pisowifi_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;
--> statement-breakpoint
-- Session defaults apply on every connection, including through the transaction pooler (no SET needed).
ALTER ROLE pisowifi_app SET statement_timeout = '15s';
--> statement-breakpoint
ALTER ROLE pisowifi_app SET lock_timeout = '5s';
--> statement-breakpoint
ALTER ROLE pisowifi_app SET idle_in_transaction_session_timeout = '30s';
--> statement-breakpoint

-- Privileges: data access only (no DDL, no TRUNCATE, no access to the drizzle migrations schema).
GRANT USAGE ON SCHEMA public TO pisowifi_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO pisowifi_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO pisowifi_app;
--> statement-breakpoint
-- The audit trail is append-only for the application.
REVOKE UPDATE, DELETE ON TABLE "audit_log" FROM pisowifi_app;
--> statement-breakpoint
-- The workspace settings row is never inserted or deleted by the application.
REVOKE INSERT, DELETE ON TABLE "monitoring_settings" FROM pisowifi_app;
--> statement-breakpoint
-- Future tables created by the migration role get the same table privileges (RLS + policy still required).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pisowifi_app;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO pisowifi_app;
--> statement-breakpoint

-- Row-level security on every table.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "password_reset_tokens" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "totp_backup_codes" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "machines" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "machine_state" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "checks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "outages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "check_rollups_hourly" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "monitoring_settings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification_prefs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint

-- Policies: only the runtime role, all rows (authorization is per request in the API).
CREATE POLICY "pisowifi_app_all" ON "users" AS PERMISSIVE FOR ALL TO pisowifi_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_all" ON "sessions" AS PERMISSIVE FOR ALL TO pisowifi_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_all" ON "password_reset_tokens" AS PERMISSIVE FOR ALL TO pisowifi_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_all" ON "totp_backup_codes" AS PERMISSIVE FOR ALL TO pisowifi_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_read" ON "audit_log" AS PERMISSIVE FOR SELECT TO pisowifi_app USING (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_append" ON "audit_log" AS PERMISSIVE FOR INSERT TO pisowifi_app WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_all" ON "machines" AS PERMISSIVE FOR ALL TO pisowifi_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_all" ON "machine_state" AS PERMISSIVE FOR ALL TO pisowifi_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_all" ON "checks" AS PERMISSIVE FOR ALL TO pisowifi_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_all" ON "events" AS PERMISSIVE FOR ALL TO pisowifi_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_all" ON "outages" AS PERMISSIVE FOR ALL TO pisowifi_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_all" ON "check_rollups_hourly" AS PERMISSIVE FOR ALL TO pisowifi_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_read" ON "monitoring_settings" AS PERMISSIVE FOR SELECT TO pisowifi_app USING (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_update" ON "monitoring_settings" AS PERMISSIVE FOR UPDATE TO pisowifi_app USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "pisowifi_app_all" ON "notification_prefs" AS PERMISSIVE FOR ALL TO pisowifi_app USING (true) WITH CHECK (true);
--> statement-breakpoint

-- Supabase Data API roles: no access to our tables, sequences or functions, now or for future objects.
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
    END IF;
  END LOOP;
END
$$;
