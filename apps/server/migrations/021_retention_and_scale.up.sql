-- PHASE-2 §36: LOG_RETENTION and LOG_SIZE_BUDGET enforced by COMPACTION, not deletion; and the
-- matchmaking query's recent-opponent index (end of file).
--
-- Before this, a replay past its retention window was deleted outright and the replay route
-- answered 410: the party owner's feed and the caravan's trip history lost the fight's results
-- summary along with its tick log. Now a log leaves encounter_log only by being compacted to
-- its results summary, in the same statement-sequence, by the owner's definer functions:
--
--   encounter_log_summary        One row per compacted replay: what the replay summary shows
--                                without the tick log — outcome (kind, depth, endTick, loot)
--                                from the job's IMMUTABLE result, the end-card tally (raiders /
--                                defenders fallen, fences broken, traps sprung, core reached,
--                                the deepest raider) the worker recorded beside it at completion
--                                (result.replay.tally; null for fights resolved before it existed),
--                                and the stored log's metadata (versions, sizes, sha256, when it
--                                was written). Nothing in it is supplied by the caller: the
--                                compaction reads the log row and the job, and nothing else.
--                                Insert-once (definer only), never updated, never truncated; it
--                                leaves only with its caravan / job (account removal).
--                                Per-encounter Coin / Reputation / de-merge itemization is NOT
--                                copied: it is read from the ledger, which is permanent.
--   encounter_log_retention      gains size_budget_bytes = LOG_SIZE_BUDGET (100 KB stored),
--                                pinned to TUNABLES.LOG_SIZE_BUDGET_BYTES by a test.
--   encounter_log_compact_rows   (internal) summary first, then the delete, for a set of job ids
--                                the caller (one of the two functions below) already chose.
--   encounter_log_prune(uuid)    REPLACED (same signature, still called by encounter_log_write
--                                in the completion transaction): compacts — never deletes — the
--                                caravan's rows past retention (older than `days` AND outside the
--                                newest `min_per_caravan`) and any row over the size budget, of
--                                COMPLETED jobs only (the summary needs the job's result). The
--                                worker calls it once more after marking the job completed, in the
--                                same transaction, so an over-budget log never outlives its own
--                                completion transaction: LOG_SIZE_BUDGET is enforced at write.
--   encounter_log_retention_sweep(integer)
--                                The scheduled job's entry point (jobs/retentionWorker.ts): the
--                                same rule across every caravan, oldest first, at most p_limit
--                                rows per call (1..5000) so a backlog drains in short
--                                transactions. Returns the number compacted.
--   encounter_log_guard_delete   REPLACED: as before (retention rule or a cascade), plus a row
--                                over the size budget, and — for anything but a cascade — only
--                                once its summary exists. A log can never vanish without one.
--
-- ACCOUNTS (chunk 30, built concurrently). The summary copies the log row's account ids AS THEY
-- ARE at compaction, so a log anonymized before compaction compacts anonymized. The summary
-- holds no names, only the same two account uuids encounter_log does, under the same cascade
-- (its caravan / job). An anonymizer that rewrites encounter_log's account ids must cover
-- encounter_log_summary as well (its UPDATE guard below refuses every update; the merge with
-- chunk 30 adds the exception there, in a definer, exactly as for encounter_log).

CREATE TABLE encounter_log_summary (
  job_id                  text        PRIMARY KEY REFERENCES resolution_job (id) ON DELETE CASCADE,
  caravan_id              uuid        NOT NULL REFERENCES caravan (id) ON DELETE CASCADE,
  defender_account_id     uuid        NOT NULL,
  party_owner_account_id  uuid        NOT NULL,
  -- Why the log was compacted: past LOG_RETENTION, or over LOG_SIZE_BUDGET.
  reason                  text        NOT NULL,
  resolver_version        integer     NOT NULL,
  log_format              integer     NOT NULL,
  raw_bytes               integer     NOT NULL,
  stored_bytes            integer     NOT NULL,
  log_sha256              text        NOT NULL,
  content_hash            text        NOT NULL,
  log_created_at          timestamptz NOT NULL,
  compacted_at            timestamptz NOT NULL DEFAULT now(),
  -- {outcome: {kind, depth, endTick, loot} | null, tally: {...} | null}
  summary                 jsonb       NOT NULL,
  CONSTRAINT encounter_log_summary_reason_known CHECK (reason IN ('retention', 'size_budget')),
  CONSTRAINT encounter_log_summary_shape CHECK (jsonb_typeof(summary) = 'object' AND summary ? 'outcome' AND summary ? 'tally')
);
CREATE INDEX encounter_log_summary_caravan_idx ON encounter_log_summary (caravan_id, log_created_at DESC);
CREATE INDEX encounter_log_summary_party_owner_idx ON encounter_log_summary (party_owner_account_id);

-- The sweep finds expired rows by age across all caravans (the per-caravan index serves the prune).
CREATE INDEX encounter_log_created_idx ON encounter_log (created_at, job_id);
-- And legacy over-budget rows (new ones never persist past their own write).
CREATE INDEX encounter_log_stored_bytes_idx ON encounter_log (stored_bytes);

CREATE FUNCTION encounter_log_summary_guard_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'encounter_log_summary % is immutable: a compacted replay''s summary is never rewritten', OLD.job_id USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER encounter_log_summary_guard_update BEFORE UPDATE ON encounter_log_summary
  FOR EACH ROW EXECUTE FUNCTION encounter_log_summary_guard_update();

CREATE FUNCTION encounter_log_summary_guard_truncate() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'encounter_log_summary cannot be truncated: summaries leave only with their caravan or job' USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER encounter_log_summary_guard_truncate BEFORE TRUNCATE ON encounter_log_summary
  FOR EACH STATEMENT EXECUTE FUNCTION encounter_log_summary_guard_truncate();

-- Only a cascade from the caravan or the job (account removal) removes a summary.
CREATE FUNCTION encounter_log_summary_guard_delete() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM caravan WHERE id = OLD.caravan_id)
     OR NOT EXISTS (SELECT 1 FROM resolution_job WHERE id = OLD.job_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'encounter_log_summary % is kept: it is the fight''s permanent results summary', OLD.job_id USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER encounter_log_summary_guard_delete BEFORE DELETE ON encounter_log_summary
  FOR EACH ROW EXECUTE FUNCTION encounter_log_summary_guard_delete();

ALTER TABLE encounter_log_retention ADD COLUMN size_budget_bytes integer NOT NULL DEFAULT 102400 CHECK (size_budget_bytes >= 1024);

CREATE OR REPLACE FUNCTION encounter_log_guard_delete() RETURNS trigger AS $$
DECLARE
  r encounter_log_retention;
BEGIN
  -- A cascade from the caravan or the job (the account being removed) is not a prune.
  IF NOT EXISTS (SELECT 1 FROM caravan WHERE id = OLD.caravan_id)
     OR NOT EXISTS (SELECT 1 FROM resolution_job WHERE id = OLD.job_id) THEN
    RETURN OLD;
  END IF;
  SELECT * INTO r FROM encounter_log_retention WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'encounter_log_retention is empty: no retention rule, nothing may be deleted' USING ERRCODE = 'check_violation';
  END IF;
  -- Over the size budget, a row may go at any age; otherwise only outside the retention rule.
  IF OLD.stored_bytes <= r.size_budget_bytes THEN
    IF OLD.created_at >= now() - make_interval(days => r.days) THEN
      RAISE EXCEPTION 'encounter_log % is within the % day retention window: a replay leaves only through the retention prune', OLD.job_id, r.days
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.job_id IN (SELECT l.job_id FROM encounter_log l WHERE l.caravan_id = OLD.caravan_id
                       ORDER BY l.created_at DESC, l.job_id DESC LIMIT r.min_per_caravan) THEN
      RAISE EXCEPTION 'encounter_log % is among its caravan''s newest %: kept', OLD.job_id, r.min_per_caravan
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  -- And never without its results summary.
  IF NOT EXISTS (SELECT 1 FROM encounter_log_summary s WHERE s.job_id = OLD.job_id) THEN
    RAISE EXCEPTION 'encounter_log % has no results summary: a replay leaves only by being compacted (encounter_log_prune / encounter_log_retention_sweep)', OLD.job_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;

-- Compact the given rows: their summary (from the row and the job's immutable result) first,
-- then the delete (whose guard re-checks the rule). Internal: called only by the two definers
-- below, which choose the rows by the retention rule; not granted to the app role.
CREATE FUNCTION encounter_log_compact_rows(p_jobs text[]) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
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
  -- Only rows that now have a summary (a row whose job is not completed yet has none, and stays).
  DELETE FROM encounter_log l WHERE l.job_id = ANY(p_jobs) AND EXISTS (SELECT 1 FROM encounter_log_summary s WHERE s.job_id = l.job_id);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;
REVOKE EXECUTE ON FUNCTION encounter_log_compact_rows(text[]) FROM PUBLIC;

-- The retention prune for one caravan, now a compaction. Same rule as the delete guard.
CREATE OR REPLACE FUNCTION encounter_log_prune(p_caravan uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r encounter_log_retention;
  jobs text[];
BEGIN
  SELECT * INTO r FROM encounter_log_retention WHERE singleton;
  SELECT coalesce(array_agg(l.job_id ORDER BY l.created_at, l.job_id), '{}') INTO jobs
    FROM encounter_log l
   WHERE l.caravan_id = p_caravan
     AND EXISTS (SELECT 1 FROM resolution_job j WHERE j.id = l.job_id AND j.status = 'completed')
     AND (l.stored_bytes > r.size_budget_bytes
          OR (l.created_at < now() - make_interval(days => r.days)
              AND l.job_id NOT IN (SELECT k.job_id FROM encounter_log k WHERE k.caravan_id = p_caravan
                                    ORDER BY k.created_at DESC, k.job_id DESC LIMIT r.min_per_caravan)));
  IF cardinality(jobs) = 0 THEN
    RETURN 0;
  END IF;
  RETURN encounter_log_compact_rows(jobs);
END
$$;

-- The scheduled sweep: every caravan, oldest first, at most p_limit rows per call.
CREATE FUNCTION encounter_log_retention_sweep(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r encounter_log_retention;
  jobs text[];
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 5000 THEN
    RAISE EXCEPTION 'encounter_log_retention_sweep: limit % is outside 1..5000', p_limit USING ERRCODE = 'check_violation';
  END IF;
  SELECT * INTO r FROM encounter_log_retention WHERE singleton;
  SELECT coalesce(array_agg(c.job_id), '{}') INTO jobs FROM (
    (SELECT l.job_id, l.created_at
       FROM encounter_log l
      WHERE l.created_at < now() - make_interval(days => r.days)
        AND EXISTS (SELECT 1 FROM resolution_job j WHERE j.id = l.job_id AND j.status = 'completed')
        -- outside the caravan's newest N: at least N rows of its caravan are newer
        AND (SELECT count(*) FROM (SELECT 1 FROM encounter_log k
                                    WHERE k.caravan_id = l.caravan_id AND (k.created_at, k.job_id) > (l.created_at, l.job_id)
                                    LIMIT r.min_per_caravan) newer) >= r.min_per_caravan
      ORDER BY l.created_at, l.job_id
      LIMIT p_limit)
    UNION
    (SELECT l.job_id, l.created_at FROM encounter_log l
      WHERE l.stored_bytes > r.size_budget_bytes AND EXISTS (SELECT 1 FROM resolution_job j WHERE j.id = l.job_id AND j.status = 'completed')
      ORDER BY l.created_at, l.job_id LIMIT p_limit)
    ORDER BY created_at, job_id
    LIMIT p_limit) c;
  IF cardinality(jobs) = 0 THEN
    RETURN 0;
  END IF;
  RETURN encounter_log_compact_rows(jobs);
END
$$;

-- ---------------------------------------------------------------------------------
-- PHASE-2 §36: indexes for the matchmaking query (EXPLAIN plans in apps/server/db/explain/).
-- ---------------------------------------------------------------------------------
-- Reputation band: pool_progress_pool_reputation_idx (009) already drives the live branch, and
-- account_system_idx (011) the authored branch; each party is reached by key
-- (standing_party_one_per_slot). Linked-account exclusion: an `<> ALL($1)` filter on the rows
-- the band scan returns — there is no linked-account table until chunk 31, so nothing to index.
-- Recent-opponent exclusion: the account's newest chosen menus across its trips, read by key
-- from this index without touching the menus' candidate lists (matchmaking/service.ts
-- RECENT_OPPONENTS_SQL).
CREATE INDEX encounter_candidates_chosen_recent_idx
  ON encounter_candidates (trip_id, chosen_at DESC, encounter_index DESC) INCLUDE (search_seq) WHERE chosen_at IS NOT NULL;
