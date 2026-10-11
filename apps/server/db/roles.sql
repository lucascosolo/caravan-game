-- Runtime database role for the Caravan Vaults server. NOT a migration: CREATE ROLE is
-- cluster-level, and the grants below are per database, so this script is applied to
-- each database by the OWNER role after migrating:
--
--   pnpm db:roles        (reads MIGRATE_DATABASE_URL, falls back to DATABASE_URL)
--
-- The test suite's global setup applies it to TEST_DATABASE_URL on every run.
--
-- WHY. Every permanence guard in the schema is a trigger or CHECK on a table the
-- `caravan` role owns. An owner (or superuser) connection can `ALTER TABLE ... DISABLE
-- TRIGGER`, `TRUNCATE`, or drop constraints, which would silently undo GUARDRAILS §3/§5.
-- So the server process never connects as the owner:
--
--   caravan       owner / superuser  -> migrations only          (MIGRATE_DATABASE_URL)
--   caravan_app   plain login role   -> the running server       (DATABASE_URL)
--                 SELECT/INSERT/UPDATE/DELETE on tables, USAGE/SELECT on sequences.
--                 No ALTER, no TRUNCATE, no TRIGGER, no CREATE in the schema.
--
-- Idempotent: safe to re-run. The password is the dev/test default; set a real one in
-- any shared environment (ALTER ROLE caravan_app PASSWORD '...') and update DATABASE_URL.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'caravan_app') THEN
    CREATE ROLE caravan_app LOGIN PASSWORD 'caravan_app'
      NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

-- Schema access, but no CREATE in it (the app never defines objects).
GRANT USAGE ON SCHEMA public TO caravan_app;
REVOKE CREATE ON SCHEMA public FROM caravan_app;

-- Existing objects: DML only. Deliberately NOT granted: TRUNCATE, REFERENCES, TRIGGER.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES    IN SCHEMA public TO caravan_app;
GRANT USAGE, SELECT                   ON ALL SEQUENCES IN SCHEMA public TO caravan_app;
REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM caravan_app;

-- The migration bookkeeping table is the migrator's, not the app's.
REVOKE ALL ON TABLE schema_migrations FROM caravan_app;

-- Future migrations: tables and sequences the owner role creates later get the same grants
-- automatically, so no migration has to remember to GRANT.
ALTER DEFAULT PRIVILEGES FOR ROLE caravan IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO caravan_app;
ALTER DEFAULT PRIVILEGES FOR ROLE caravan IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO caravan_app;

-- ---------------------------------------------------------------------------------
-- Projected columns are read-only for the app (QA-02 S1)
-- ---------------------------------------------------------------------------------
-- account.coin_balance and the progress numbers on pool_progress are PROJECTIONS of the
-- ledger: the only legitimate writer is ledger_event_project(), which runs as the owner
-- (SECURITY DEFINER, migration 002). Column-level privileges only bite when no table-level
-- UPDATE is held, so revoke the table grant and re-grant UPDATE on every OTHER column.
-- The column list is read from the catalog so a later migration that adds a column to
-- either table does not have to remember this; re-run `pnpm db:roles` after migrating.
REVOKE UPDATE ON TABLE account, pool_progress FROM caravan_app;
DO $$
DECLARE
  cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'account'
     AND column_name NOT IN ('coin_balance');
  EXECUTE format('GRANT UPDATE (%s) ON TABLE account TO caravan_app', cols);

  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'pool_progress'
     AND column_name NOT IN ('reputation', 'ladder_level', 'ladder_points',
                             'unlock_points_granted', 'unlock_points_spent');
  EXECUTE format('GRANT UPDATE (%s) ON TABLE pool_progress TO caravan_app', cols);
END
$$;

-- ---------------------------------------------------------------------------------
-- Job status moves only through the owner's writers (QA-02 R2-S3)
-- ---------------------------------------------------------------------------------
-- resolution_job.status, the lease (leased_by, lease_expires_at), the attempt counter that
-- fences completion, and the requeue audit columns are written only by the SECURITY
-- DEFINER functions resolution_job_{lease,complete,fail,park,requeue} (migration 002),
-- which run as the owner. The app role keeps UPDATE on the remaining columns (the guard
-- trigger still polices those) and EXECUTE on the writers. Same catalog-driven pattern as
-- above, so a later column needs no edit here.
REVOKE UPDATE ON TABLE resolution_job FROM caravan_app;
DO $$
DECLARE
  cols text;
BEGIN
  SELECT string_agg(quote_ident(column_name), ', ' ORDER BY ordinal_position) INTO cols
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'resolution_job'
     AND column_name NOT IN ('status', 'leased_by', 'attempts', 'lease_expires_at',
                             'requeued_at', 'requeued_by', 'requeue_count');
  EXECUTE format('GRANT UPDATE (%s) ON TABLE resolution_job TO caravan_app', cols);
END
$$;
GRANT EXECUTE ON FUNCTION
  resolution_job_lease(text, integer, integer),
  resolution_job_complete(text, jsonb, text, integer),
  resolution_job_fail(text, integer, text, integer, text),
  resolution_job_park(text, integer, text, text),
  resolution_job_requeue(text, integer, text)
TO caravan_app;

-- ---------------------------------------------------------------------------------
-- Replays are written once, by the resolution path only (QA-13 S4, migration 016)
-- ---------------------------------------------------------------------------------
-- encounter_log: no direct INSERT, UPDATE or DELETE for the app role. A replay is written by
-- encounter_log_write() (fenced on the job's live lease, checked against the job by the insert
-- guard) and leaves only through encounter_log_prune() (the retention rule, on the database
-- clock and the constant encounter_log_retention row). Both run as the owner (SECURITY
-- DEFINER). The retention row itself is read-only for the app.
REVOKE INSERT, UPDATE, DELETE ON TABLE encounter_log FROM caravan_app;
REVOKE INSERT, UPDATE, DELETE ON TABLE encounter_log_retention FROM caravan_app;
GRANT EXECUTE ON FUNCTION
  encounter_log_write(text, text, integer, uuid, uuid, uuid, integer, integer, text, bytea, integer, text, text, text, text, text),
  encounter_log_prune(uuid)
TO caravan_app;

-- ---------------------------------------------------------------------------------
-- Chunk 32: the admin flag is read-only for the app role
-- ---------------------------------------------------------------------------------
-- account_admin decides who may read /admin/*. The server only ever READS it; the operator
-- CLI (src/admin.ts) writes it over the owner connection. Without INSERT /
-- UPDATE / DELETE here, no player route — and no bug in one — can grant or revoke admin.
-- (An account's deletion still cascades: referential actions run as the table owner.)
-- Client telemetry rows are insert-only for the app (deleted only on opt-out or cascade).
-- Guarded by to_regclass so this script still applies to a database rolled back below 020.
DO $$
BEGIN
  IF to_regclass('public.account_admin') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE ON TABLE account_admin FROM caravan_app;
  END IF;
  IF to_regclass('public.analytics_client_event') IS NOT NULL THEN
    REVOKE UPDATE ON TABLE analytics_client_event FROM caravan_app;
  END IF;
END
$$;
