-- Chunk 04: progression guards at the storage layer, not only in the service.
--
-- 1. Unlock points are granted exactly once per rung, ever. Each `unlock_points_granted`
--    event names the rung it pays out (payload.rung) and the unique index below makes a
--    second grant for the same (pool, owner, rung) a constraint violation. Two resolutions
--    for the same owner that both believe they crossed the same rung (a race the
--    per-account append lock already serializes, but belt and braces) collide here and the
--    second one fails instead of double-granting.
--
--    Scope follows pool_progress: a living-pool grant is keyed by its caravan, a trap/siege
--    grant by its account (caravan_id NULL, folded to the nil uuid so it takes part in the
--    key). The index covers EVERY grant event — `rung` is mandatory (CHECK below), so no
--    grant can be written outside it (chunk 04 QA S2).
--
-- 2. Ladder and grant payloads can only ever say "up" (chunk 04 QA S1/S8). The app role may
--    INSERT ledger_event, and the projection trigger folds whatever the payload says, so a
--    crafted event is the one path by which permanent progress could have gone down.
--    `ladder_progress_gained`: pointsDelta and levelsGained are non-negative integers, and
--    levelsGained is at most the ladder cap. `unlock_points_granted`: points is a positive
--    integer, rung an integer in 1..cap.
--
-- 3. pool_progress: ladder_points is permanent too (the ladder is cumulative; chunk 01's
--    guard covered level and grants only), and ladder_level can never exceed the cap.
--
-- The ladder cap (20) is TUNABLES.LADDER_RUNGS_PER_POOL. A test pins the two together
-- (apps/server/test/qa04-progression.test.ts), as qa03-merge-cap does for the merge cap.

DROP INDEX IF EXISTS ledger_event_unlock_grant_once_per_rung;
CREATE UNIQUE INDEX ledger_event_unlock_grant_once_per_rung
  ON ledger_event (
    (payload->>'pool'),
    account_id,
    (coalesce(caravan_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    ((payload->>'rung')::integer)
  )
  WHERE event_type = 'unlock_points_granted';

-- A JSON value as a whole number, or NULL when it is absent, not a number, or fractional.
-- Nested CASEs so a non-number never reaches the cast (SQL AND does not short-circuit).
CREATE FUNCTION jsonb_int(v jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NOT NULL AND jsonb_typeof(v) = 'number' THEN
    CASE WHEN (v::text)::numeric = trunc((v::text)::numeric) THEN (v::text)::numeric END
  END
$$;

-- NULL (missing / malformed) must FAIL a CHECK, hence the coalesce(..., false).
ALTER TABLE ledger_event
  ADD CONSTRAINT ledger_event_ladder_progress_nonneg CHECK (
    event_type <> 'ladder_progress_gained'
    OR (coalesce(jsonb_int(payload->'pointsDelta') >= 0, false)
        AND coalesce(jsonb_int(payload->'levelsGained') BETWEEN 0 AND 20, false))
  ),
  ADD CONSTRAINT ledger_event_unlock_grant_shape CHECK (
    event_type <> 'unlock_points_granted'
    OR (coalesce(jsonb_int(payload->'points') > 0, false)
        AND coalesce(jsonb_int(payload->'rung') BETWEEN 1 AND 20, false))
  );

ALTER TABLE pool_progress
  ADD CONSTRAINT pool_progress_ladder_level_cap CHECK (ladder_level <= 20);

CREATE FUNCTION pool_progress_guard_ladder_points() RETURNS trigger AS $$
BEGIN
  IF NEW.ladder_points < OLD.ladder_points THEN
    RAISE EXCEPTION 'pool_progress.ladder_points is cumulative and may never decrease (% -> %)',
      OLD.ladder_points, NEW.ladder_points USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER pool_progress_guard_ladder_points
  BEFORE UPDATE ON pool_progress FOR EACH ROW EXECUTE FUNCTION pool_progress_guard_ladder_points();
