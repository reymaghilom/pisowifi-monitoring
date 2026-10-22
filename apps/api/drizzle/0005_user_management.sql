-- RBAC-1 user management: account deactivation (disabled_at/by) and a guarantee of at least one active admin.
ALTER TABLE "users" ADD COLUMN "disabled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "disabled_by" uuid;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_disabled_by_users_id_fk" FOREIGN KEY ("disabled_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_disabled_by_needs_disabled_at" CHECK ("users"."disabled_by" is null or "users"."disabled_at" is not null);
--> statement-breakpoint
-- At least one active admin while any account exists. Runs after every statement that changes a role, deactivates or
-- deletes users (API, CLI or SQL). It first takes the same transaction-scoped advisory lock as the API
-- (7240001 = "pisowifi users: active admin guard"), so two concurrent demotions/deactivations serialize and the second
-- sees the first's committed change (READ COMMITTED takes a new snapshot per statement) instead of both passing.
-- That only holds in READ COMMITTED: under REPEATABLE READ the second transaction keeps its old snapshot and both
-- demotions commit (zero admins; reproduced on PostgreSQL 17), so role/deactivation changes are refused in any other
-- isolation level. The API and psql/the Supabase SQL editor use the READ COMMITTED default.
CREATE FUNCTION "public"."users_keep_active_admin"() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'role and deactivation changes require READ COMMITTED isolation' USING ERRCODE = 'invalid_transaction_state';
  END IF;
  PERFORM pg_advisory_xact_lock(7240001);
  IF EXISTS (SELECT 1 FROM public.users) AND NOT EXISTS (SELECT 1 FROM public.users WHERE role = 'admin' AND disabled_at IS NULL) THEN
    RAISE EXCEPTION 'at least one active admin is required' USING ERRCODE = 'check_violation', CONSTRAINT = 'users_active_admin_required';
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "users_keep_active_admin" AFTER UPDATE OF "role", "disabled_at" OR DELETE ON "public"."users" FOR EACH STATEMENT EXECUTE FUNCTION "public"."users_keep_active_admin"();
