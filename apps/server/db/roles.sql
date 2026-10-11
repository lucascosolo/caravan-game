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
