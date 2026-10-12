-- Final guardrail review, round 2: the stored menus' guards.
--
--   S2  encounter_candidates.raider_cap (migration 026) joins the stored-menu immutability guard:
--       it is the record of which parties the band-0 cold-start cap left out, stored "like
--       draw_rules so a menu replays" (GUARDRAILS §1: seeded and reproducible from stored state).
--       The app role could rewrite it; now the guard refuses that like every other replay column.
--       Erasure's step 5 rewrites it with the menu's other jsonb columns, so the erasure exception
--       (`account_erasure_permits`: the new row equals the rewrite of the old) keeps matching the
--       whole row.
--   N5  refugee_menu gets the guard it never had. Every column is frozen once written, except the
--       claim (claimed_type_id / claimed_instance_id / claimed_at_ms), which may be set exactly once
--       from all-NULL (the table's CHECKs already say all three together, and one of the offers).
--       A menu row leaves only with its caravan (the account cascade, and erasure), never on its
--       own; TRUNCATE is refused.

-- ── S2 ───────────────────────────────────────────────────────────────────────────────────────
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

-- Erasure step 5 (account_erasure_core, migration 023): add raider_cap to the rewritten columns.
-- The function is patched in place from its live definition (one line), so the long body is not
-- copied here; the patch refuses to apply to a body it does not recognise.
DO $$
DECLARE
  def text := pg_get_functiondef('public.account_erasure_core(uuid, text)'::regprocedure);
  old_line text := 'draw_rules = account_erasure_rewrite(ec.draw_rules)';
  new_line text := 'draw_rules = account_erasure_rewrite(ec.draw_rules),' || chr(10) || '         raider_cap = account_erasure_rewrite(ec.raider_cap)';
BEGIN
  IF position(old_line IN def) = 0 OR position('raider_cap' IN def) > 0 THEN
    RAISE EXCEPTION 'migration 027: account_erasure_core is not the body migration 023 wrote; patch it by hand';
  END IF;
  EXECUTE replace(def, old_line, new_line);
END
$$;

-- ── N5 ───────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION refugee_menu_guard_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NEW.caravan_id <> OLD.caravan_id OR NEW.sequence <> OLD.sequence OR NEW.origin <> OLD.origin
     OR NEW.window_sequence <> OLD.window_sequence OR NEW.seed <> OLD.seed
     OR NEW.pool_type_ids <> OLD.pool_type_ids OR NEW.offered_type_ids <> OLD.offered_type_ids
     OR NEW.generated_at_ms <> OLD.generated_at_ms OR NEW.window_opened_at_ms <> OLD.window_opened_at_ms
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'refugee_menu (caravan %, menu %) is a drawn menu and is immutable', OLD.caravan_id, OLD.sequence
      USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.claimed_type_id IS NOT NULL OR OLD.claimed_instance_id IS NOT NULL OR OLD.claimed_at_ms IS NOT NULL)
     AND (NEW.claimed_type_id IS DISTINCT FROM OLD.claimed_type_id OR NEW.claimed_instance_id IS DISTINCT FROM OLD.claimed_instance_id
          OR NEW.claimed_at_ms IS DISTINCT FROM OLD.claimed_at_ms) THEN
    RAISE EXCEPTION 'refugee_menu (caravan %, menu %): the claim is final', OLD.caravan_id, OLD.sequence
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER refugee_menu_guard_update
  BEFORE UPDATE ON refugee_menu FOR EACH ROW EXECUTE FUNCTION refugee_menu_guard_update();

CREATE FUNCTION refugee_menu_guard_delete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.caravan WHERE id = OLD.caravan_id) THEN
    RAISE EXCEPTION 'refugee_menu (caravan %, menu %) is history and may not be deleted while its caravan exists', OLD.caravan_id, OLD.sequence
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;
CREATE TRIGGER refugee_menu_guard_delete
  BEFORE DELETE ON refugee_menu FOR EACH ROW EXECUTE FUNCTION refugee_menu_guard_delete();
CREATE TRIGGER refugee_menu_guard_truncate
  BEFORE TRUNCATE ON refugee_menu FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();
