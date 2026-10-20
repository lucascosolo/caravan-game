-- Reverses 030: drop the menu's version stamp and restore migration 027's guard.
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
     OR NEW.raider_cap IS DISTINCT FROM OLD.raider_cap THEN
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

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM encounter_candidates WHERE chosen_at IS NOT NULL GROUP BY trip_id, encounter_index HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'migration 030 down: an encounter has a stale chosen menu and a fresh one; the one-chosen index of 009 cannot hold them';
  END IF;
END
$$;
DROP INDEX encounter_candidates_one_chosen;
CREATE UNIQUE INDEX encounter_candidates_one_chosen ON encounter_candidates (trip_id, encounter_index) WHERE chosen_at IS NOT NULL;
ALTER TABLE encounter_candidates DROP COLUMN content_hash, DROP COLUMN resolver_version;
