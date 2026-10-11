-- Chunk 25 QA S1: rolling this migration back would drop the is_system guards (the flag
-- could be cleared, a system account could be credited Coin) while the system accounts
-- still exist. Refuse, exactly like 009: delete them first (DELETE FROM account WHERE
-- is_system) if the rollback is really wanted. migrate.ts runs a multi-step rollback in one
-- transaction, so this refusal leaves every migration applied.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE is_system) THEN
    RAISE EXCEPTION 'migration 011 cannot be rolled back while system (is_system) accounts exist; delete them first (DELETE FROM account WHERE is_system)'
      USING ERRCODE = 'check_violation';
  END IF;
END
$$;
DROP TABLE IF EXISTS authored_party;
DROP INDEX IF EXISTS account_system_idx;
DROP INDEX IF EXISTS encounter_candidates_band_chosen_idx;
CREATE OR REPLACE FUNCTION encounter_candidates_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.trip_id <> OLD.trip_id OR NEW.encounter_index <> OLD.encounter_index OR NEW.search_seq <> OLD.search_seq
     OR NEW.seed <> OLD.seed OR NEW.caravan_rating <> OLD.caravan_rating OR NEW.centre <> OLD.centre
     OR NEW.band_width_used <> OLD.band_width_used OR NEW.pool <> OLD.pool
     OR NEW.excluded_party_ids <> OLD.excluded_party_ids OR NEW.skipped_party_ids <> OLD.skipped_party_ids
     OR NEW.candidates <> OLD.candidates OR NEW.searched_at_ms <> OLD.searched_at_ms OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'encounter_candidates (trip %, encounter %, search %) is a stored menu and is immutable', OLD.trip_id, OLD.encounter_index, OLD.search_seq
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.chosen_at IS NOT NULL AND (NEW.chosen_at IS DISTINCT FROM OLD.chosen_at OR NEW.chosen_candidate_id IS DISTINCT FROM OLD.chosen_candidate_id) THEN
    RAISE EXCEPTION 'encounter_candidates (trip %, encounter %): the chosen candidate is frozen', OLD.trip_id, OLD.encounter_index
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
ALTER TABLE encounter_candidates DROP CONSTRAINT IF EXISTS encounter_candidates_authored_served_is_object;
ALTER TABLE encounter_candidates DROP CONSTRAINT IF EXISTS encounter_candidates_band_nonneg;
ALTER TABLE encounter_candidates DROP CONSTRAINT IF EXISTS encounter_candidates_draw_rules_is_object;
ALTER TABLE encounter_candidates DROP COLUMN IF EXISTS authored_weighted_down;
ALTER TABLE encounter_candidates DROP COLUMN IF EXISTS draw_rules;
ALTER TABLE encounter_candidates DROP COLUMN IF EXISTS band;
ALTER TABLE encounter_candidates DROP COLUMN IF EXISTS authored_served;
DROP TRIGGER IF EXISTS ledger_event_guard_system_coin ON ledger_event;
DROP FUNCTION IF EXISTS ledger_event_guard_system_coin();
DROP TRIGGER IF EXISTS account_guard_is_system ON account;
DROP FUNCTION IF EXISTS account_guard_is_system();
