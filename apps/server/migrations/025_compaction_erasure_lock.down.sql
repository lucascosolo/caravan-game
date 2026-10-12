DROP TRIGGER IF EXISTS encounter_log_summary_follow_erasure ON resolution_job;
CREATE TRIGGER encounter_log_summary_follow_erasure AFTER UPDATE ON resolution_job
  FOR EACH ROW EXECUTE FUNCTION encounter_log_summary_follow_erasure();
DROP TRIGGER IF EXISTS encounter_log_erasure_lock ON resolution_job;
DROP FUNCTION IF EXISTS encounter_log_erasure_lock();

-- Migration 022's compactor, restored (search_path as 023 pinned it).
CREATE OR REPLACE FUNCTION encounter_log_compact_rows(p_jobs text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r encounter_log_retention;
  n integer;
BEGIN
  SELECT * INTO r FROM encounter_log_retention WHERE singleton;
  INSERT INTO encounter_log_summary (job_id, caravan_id, defender_account_id, party_owner_account_id, reason, resolver_version, log_format,
                                     raw_bytes, stored_bytes, log_sha256, content_hash, log_created_at, summary)
  SELECT l.job_id, l.caravan_id, l.defender_account_id, l.party_owner_account_id,
         CASE WHEN l.stored_bytes > r.size_budget_bytes THEN 'size_budget' ELSE 'retention' END,
         l.resolver_version, l.log_format, l.raw_bytes, l.stored_bytes, l.log_sha256, l.content_hash, l.created_at,
         jsonb_build_object(
           'outcome', CASE WHEN jsonb_typeof(j.result -> 'outcome') = 'object'
                           THEN jsonb_build_object('kind', j.result -> 'outcome' -> 'kind', 'depth', j.result -> 'outcome' -> 'depth',
                                                   'endTick', j.result -> 'outcome' -> 'endTick', 'loot', j.result -> 'outcome' -> 'loot')
                           ELSE 'null'::jsonb END,
           'tally', CASE WHEN jsonb_typeof(j.result -> 'replay' -> 'tally') = 'object' THEN j.result -> 'replay' -> 'tally' ELSE 'null'::jsonb END)
    FROM encounter_log l
    JOIN resolution_job j ON j.id = l.job_id AND j.status = 'completed'
   WHERE l.job_id = ANY(p_jobs)
  ON CONFLICT (job_id) DO NOTHING;
  DELETE FROM encounter_log l WHERE l.job_id = ANY(p_jobs) AND EXISTS (SELECT 1 FROM encounter_log_summary s WHERE s.job_id = l.job_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE EXECUTE ON FUNCTION encounter_log_compact_rows(text[]) FROM PUBLIC;
