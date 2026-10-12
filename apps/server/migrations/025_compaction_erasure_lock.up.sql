-- PHASE-2 §36 QA fix round (S1, N6): compaction and account erasure are SERIALIZED per fight.
--
-- Before this, `encounter_log_compact_rows` read encounter_log from its statement snapshot with no
-- lock and no coordination with chunk 30's erasure (`account_erasure_core`), so the two racing on
-- one fight could (QA-36 S1, observed):
--   * defender erased while a compaction of their caravan was uncommitted: the follow-erasure
--     trigger could not see the uncommitted summary, so the caravan cascade deleted the summaries
--     kept for the other player (their replay route then answered 410);
--   * party owner erased while a compaction was uncommitted: the summary kept the erased id;
--   * erasure committed first, compaction second: the summary insert named the deleted caravan
--     (23503), failing a whole sweep batch, or a fight's completion.
--
-- THE LOCK. Both paths take the same transaction-scoped advisory lock, keyed on the fight's job:
-- pg_advisory_xact_lock(36, hashtext(job_id)) — namespace 36 (ledger/ledger.ts LOCK_NS_ENCOUNTER_LOG).
--   * Erasure takes it per kept fight, in a BEFORE UPDATE trigger on resolution_job that fires only
--     while an erasure is active in the transaction and only on the rows it re-points (account or
--     input changed): it WAITS for an in-flight compaction of that fight to commit, so the
--     follow-erasure trigger (migration 022) then sees and rewrites the committed summary.
--   * Compaction TRIES it per job (pg_try_advisory_xact_lock), sorted, and SKIPS any fight it cannot
--     lock (an erasure, or another compactor, holds it); the hourly sweep or the caravan's next prune
--     picks it up. Compaction never waits on an erasure, so the two cannot deadlock on these locks.
--     Then it locks the fights' caravans FOR KEY SHARE and their logs FOR UPDATE, and only then reads
--     them (a new statement, so READ COMMITTED sees the post-erasure rows: a re-pointed log is
--     compacted with the tombstone's ids, a cascaded one is simply gone). A row the erasure moved
--     out of eligibility (e.g. into the tombstone caravan's newest N) is re-checked against the
--     retention rule and left in place rather than tripping the delete guard.
-- The sweep's choice of candidates stays a plain read: the try-lock is its SKIP LOCKED.
--
-- N6: both triggers on resolution_job fire only when a row's account or input changes (erasure's
-- rewrite), never on a lease, heartbeat, failure or completion.

CREATE OR REPLACE FUNCTION encounter_log_compact_rows(p_jobs text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  r     public.encounter_log_retention;
  mine  text[] := '{}';
  j     text;
  n     integer;
BEGIN
  SELECT * INTO r FROM public.encounter_log_retention WHERE singleton;
  FOR j IN SELECT DISTINCT x FROM unnest(p_jobs) x WHERE x IS NOT NULL ORDER BY x LOOP
    IF pg_try_advisory_xact_lock(36, hashtext(j)) THEN
      mine := mine || j;
    END IF;
  END LOOP;
  IF cardinality(mine) = 0 THEN
    RETURN 0;
  END IF;
  -- Caravans before logs, each in a fixed order: an erasure deleting a caravan is waited out here,
  -- before this transaction holds any log row it would cascade to.
  PERFORM 1 FROM public.caravan c
   WHERE c.id IN (SELECT l.caravan_id FROM public.encounter_log l WHERE l.job_id = ANY(mine))
   ORDER BY c.id FOR KEY SHARE OF c;
  PERFORM 1 FROM public.encounter_log l WHERE l.job_id = ANY(mine) ORDER BY l.job_id FOR UPDATE OF l;
  INSERT INTO public.encounter_log_summary (job_id, caravan_id, defender_account_id, party_owner_account_id, reason, resolver_version, log_format,
                                            raw_bytes, stored_bytes, log_sha256, content_hash, log_created_at, summary)
  SELECT l.job_id, l.caravan_id, l.defender_account_id, l.party_owner_account_id,
         CASE WHEN l.stored_bytes > r.size_budget_bytes THEN 'size_budget' ELSE 'retention' END,
         l.resolver_version, l.log_format, l.raw_bytes, l.stored_bytes, l.log_sha256, l.content_hash, l.created_at,
         jsonb_build_object(
           'outcome', CASE WHEN jsonb_typeof(jb.result -> 'outcome') = 'object'
                           THEN jsonb_build_object('kind', jb.result -> 'outcome' -> 'kind', 'depth', jb.result -> 'outcome' -> 'depth',
                                                   'endTick', jb.result -> 'outcome' -> 'endTick', 'loot', jb.result -> 'outcome' -> 'loot')
                           ELSE 'null'::jsonb END,
           'tally', CASE WHEN jsonb_typeof(jb.result -> 'replay' -> 'tally') = 'object' THEN jb.result -> 'replay' -> 'tally' ELSE 'null'::jsonb END)
    FROM public.encounter_log l
    JOIN public.resolution_job jb ON jb.id = l.job_id AND jb.status = 'completed'
   WHERE l.job_id = ANY(mine)
     -- Re-checked now that the row is locked (the delete guard's rule): over budget, or past the
     -- window AND outside its caravan's newest N.
     AND (l.stored_bytes > r.size_budget_bytes
          OR (l.created_at < now() - make_interval(days => r.days)
              AND (SELECT count(*) FROM (SELECT 1 FROM public.encounter_log k
                                          WHERE k.caravan_id = l.caravan_id AND (k.created_at, k.job_id) > (l.created_at, l.job_id)
                                          LIMIT r.min_per_caravan) newer) >= r.min_per_caravan))
  ON CONFLICT (job_id) DO NOTHING;
  -- Only rows that now have a summary.
  DELETE FROM public.encounter_log l WHERE l.job_id = ANY(mine) AND EXISTS (SELECT 1 FROM public.encounter_log_summary s WHERE s.job_id = l.job_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE EXECUTE ON FUNCTION encounter_log_compact_rows(text[]) FROM PUBLIC;

-- The erasure's half of the lock: wait for an in-flight compaction of this fight before re-pointing it.
CREATE FUNCTION encounter_log_erasure_lock() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.account_erasure_active WHERE txid = txid_current()) THEN
    PERFORM pg_advisory_xact_lock(36, hashtext(OLD.id));
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER encounter_log_erasure_lock BEFORE UPDATE ON resolution_job
  FOR EACH ROW WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.input IS DISTINCT FROM NEW.input)
  EXECUTE FUNCTION encounter_log_erasure_lock();

-- N6: the follow-erasure trigger only on the rows erasure rewrites.
DROP TRIGGER encounter_log_summary_follow_erasure ON resolution_job;
CREATE TRIGGER encounter_log_summary_follow_erasure AFTER UPDATE ON resolution_job
  FOR EACH ROW WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id OR OLD.input IS DISTINCT FROM NEW.input)
  EXECUTE FUNCTION encounter_log_summary_follow_erasure();
