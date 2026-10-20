-- Final guardrail review, round 4.
--
--   N4  A menu records the resolver version and the resolution content hash it was searched
--       under. Its scout (every raider's stats) was derived from the content of that moment, so
--       a commit of a chosen menu stored under another version or hash is refused (409
--       `menu_stale`) and the player searches again, which is free (matchmaking/service.ts
--       `isStaleMenu`). Menus searched before this migration carry NULL and count as stale.
--       Both columns join the stored-menu immutability guard, and the one-chosen-menu index is
--       per stamp, so the fresh menu can be chosen.

ALTER TABLE encounter_candidates ADD COLUMN resolver_version integer, ADD COLUMN content_hash text;

-- One chosen menu per encounter AND per (resolver version, content hash): a menu chosen before an
-- upgrade can be superseded by one chosen after it, never by a second under the same rules. Rows
-- older than this migration (NULL stamps) still collide with each other, as before.
DROP INDEX encounter_candidates_one_chosen;
CREATE UNIQUE INDEX encounter_candidates_one_chosen
  ON encounter_candidates (trip_id, encounter_index, coalesce(resolver_version, 0), coalesce(content_hash, '')) WHERE chosen_at IS NOT NULL;

CREATE OR REPLACE FUNCTION encounter_candidates_guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF account_erasure_permits(to_jsonb(OLD), to_jsonb(NEW)) THEN RETURN NEW; END IF;
  IF NEW.trip_id <> OLD.trip_id OR NEW.encounter_index <> OLD.encounter_index OR NEW.search_seq <> OLD.search_seq
     OR NEW.seed <> OLD.seed OR NEW.caravan_rating <> OLD.caravan_rating OR NEW.centre <> OLD.centre
     OR NEW.band_width_used <> OLD.band_width_used OR NEW.pool <> OLD.pool
     OR NEW.excluded_party_ids <> OLD.excluded_party_ids OR NEW.skipped_party_ids <> OLD.skipped_party_ids
     OR NEW.candidates <> OLD.candidates OR NEW.searched_at_ms <> OLD.searched_at_ms OR NEW.created_at <> OLD.created_at
     OR NEW.authored_served IS DISTINCT FROM OLD.authored_served OR NEW.band IS DISTINCT FROM OLD.band
     OR NEW.draw_rules IS DISTINCT FROM OLD.draw_rules OR NEW.authored_weighted_down IS DISTINCT FROM OLD.authored_weighted_down
     OR NEW.raider_cap IS DISTINCT FROM OLD.raider_cap
     OR NEW.resolver_version IS DISTINCT FROM OLD.resolver_version OR NEW.content_hash IS DISTINCT FROM OLD.content_hash THEN
    RAISE EXCEPTION 'encounter_candidates (trip %, encounter %, search %) is a stored menu and is immutable', OLD.trip_id, OLD.encounter_index, OLD.search_seq
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.chosen_at IS NOT NULL AND (NEW.chosen_at IS DISTINCT FROM OLD.chosen_at OR NEW.chosen_candidate_id IS DISTINCT FROM OLD.chosen_candidate_id) THEN
    RAISE EXCEPTION 'encounter_candidates (trip %, encounter %): the chosen candidate is frozen', OLD.trip_id, OLD.encounter_index
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
