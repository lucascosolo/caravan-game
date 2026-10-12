DROP TRIGGER IF EXISTS refugee_menu_guard_truncate ON refugee_menu;
DROP TRIGGER IF EXISTS refugee_menu_guard_delete ON refugee_menu;
DROP TRIGGER IF EXISTS refugee_menu_guard_update ON refugee_menu;
DROP FUNCTION IF EXISTS refugee_menu_guard_delete();
DROP FUNCTION IF EXISTS refugee_menu_guard_update();

DO $$
DECLARE
  def text := pg_get_functiondef('public.account_erasure_core(uuid, text)'::regprocedure);
  old_line text := 'draw_rules = account_erasure_rewrite(ec.draw_rules),' || chr(10) || '         raider_cap = account_erasure_rewrite(ec.raider_cap)';
BEGIN
  IF position(old_line IN def) = 0 THEN
    RAISE EXCEPTION 'migration 027 down: account_erasure_core is not the body migration 027 wrote; patch it by hand';
  END IF;
  EXECUTE replace(def, old_line, 'draw_rules = account_erasure_rewrite(ec.draw_rules)');
END
$$;

-- Migration 020's guard (search_path pinned by 023).
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
     OR NEW.draw_rules IS DISTINCT FROM OLD.draw_rules OR NEW.authored_weighted_down IS DISTINCT FROM OLD.authored_weighted_down THEN
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
