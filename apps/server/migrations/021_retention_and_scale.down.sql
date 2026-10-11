DROP INDEX IF EXISTS encounter_candidates_chosen_recent_idx;
-- Rolling back drops the compacted results summaries with their table (like 013's down drops the
-- logs): a development operation, never run against a live database.

DROP FUNCTION IF EXISTS encounter_log_retention_sweep(integer);

-- Migration 016's prune and delete guard, restored.
CREATE OR REPLACE FUNCTION encounter_log_prune(p_caravan uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r encounter_log_retention;
  n integer;
BEGIN
  SELECT * INTO r FROM encounter_log_retention WHERE singleton;
  DELETE FROM encounter_log l
   WHERE l.caravan_id = p_caravan
     AND l.created_at < now() - make_interval(days => r.days)
     AND l.job_id NOT IN (SELECT k.job_id FROM encounter_log k WHERE k.caravan_id = p_caravan
                           ORDER BY k.created_at DESC, k.job_id DESC LIMIT r.min_per_caravan);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

CREATE OR REPLACE FUNCTION encounter_log_guard_delete() RETURNS trigger AS $$
DECLARE
  r encounter_log_retention;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM caravan WHERE id = OLD.caravan_id)
     OR NOT EXISTS (SELECT 1 FROM resolution_job WHERE id = OLD.job_id) THEN
    RETURN OLD;
  END IF;
  SELECT * INTO r FROM encounter_log_retention WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'encounter_log_retention is empty: no retention rule, nothing may be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.created_at >= now() - make_interval(days => r.days) THEN
    RAISE EXCEPTION 'encounter_log % is within the % day retention window: a replay leaves only through the retention prune', OLD.job_id, r.days
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.job_id IN (SELECT l.job_id FROM encounter_log l WHERE l.caravan_id = OLD.caravan_id
                     ORDER BY l.created_at DESC, l.job_id DESC LIMIT r.min_per_caravan) THEN
    RAISE EXCEPTION 'encounter_log % is among its caravan''s newest %: kept', OLD.job_id, r.min_per_caravan
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS encounter_log_compact_rows(text[]);
ALTER TABLE encounter_log_retention DROP COLUMN IF EXISTS size_budget_bytes;
DROP INDEX IF EXISTS encounter_log_stored_bytes_idx;
DROP INDEX IF EXISTS encounter_log_created_idx;
DROP TABLE IF EXISTS encounter_log_summary;
DROP FUNCTION IF EXISTS encounter_log_summary_guard_delete();
DROP FUNCTION IF EXISTS encounter_log_summary_guard_truncate();
DROP FUNCTION IF EXISTS encounter_log_summary_guard_update();
