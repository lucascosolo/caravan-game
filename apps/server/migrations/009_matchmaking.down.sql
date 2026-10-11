-- Chunk 25 (chunk 14 QA B2): rolling this migration back would drop is_system and so
-- silently turn every authored system account into a player account (it could log in,
-- its party could earn Coin). Refuse while any system account exists: delete them first
-- (DELETE FROM account WHERE is_system) if the rollback is really wanted.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE is_system) THEN
    RAISE EXCEPTION 'migration 009 cannot be rolled back while system (is_system) accounts exist; delete them first'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
DROP TRIGGER IF EXISTS encounter_candidates_guard_truncate ON encounter_candidates;
DROP TRIGGER IF EXISTS encounter_candidates_guard_delete ON encounter_candidates;
DROP TRIGGER IF EXISTS encounter_candidates_guard_update ON encounter_candidates;
DROP TRIGGER IF EXISTS encounter_candidates_guard_insert ON encounter_candidates;
DROP TABLE IF EXISTS encounter_candidates;
DROP FUNCTION IF EXISTS encounter_candidates_guard_delete();
DROP FUNCTION IF EXISTS encounter_candidates_guard_update();
DROP FUNCTION IF EXISTS encounter_candidates_guard_insert();
DROP TRIGGER IF EXISTS trip_guard_truncate ON trip;
DROP TRIGGER IF EXISTS trip_guard_delete ON trip;
DROP TRIGGER IF EXISTS trip_guard_update ON trip;
DROP TABLE IF EXISTS trip;
DROP FUNCTION IF EXISTS trip_guard_delete();
DROP FUNCTION IF EXISTS trip_guard_update();
DROP INDEX IF EXISTS pool_progress_pool_reputation_idx;
ALTER TABLE account DROP COLUMN IF EXISTS is_system;
