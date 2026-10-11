DROP TRIGGER IF EXISTS pool_progress_guard_ladder_points ON pool_progress;
DROP FUNCTION IF EXISTS pool_progress_guard_ladder_points();
ALTER TABLE pool_progress DROP CONSTRAINT IF EXISTS pool_progress_ladder_level_cap;
ALTER TABLE ledger_event
  DROP CONSTRAINT IF EXISTS ledger_event_ladder_progress_nonneg,
  DROP CONSTRAINT IF EXISTS ledger_event_unlock_grant_shape;
DROP FUNCTION IF EXISTS jsonb_int(jsonb);
DROP INDEX IF EXISTS ledger_event_unlock_grant_once_per_rung;
