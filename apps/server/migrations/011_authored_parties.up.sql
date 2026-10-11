-- Chunk 25: authored cold-start parties (PHASE-2 §25) and the chunk 14 QA items that
-- belong with them (roadmap/qa/14-punchlist.md B2, N1).
--
--   account.is_system guard (14-N1)
--       The flag may only ever go false → true, and only while the account owns no caravan
--       and has no ledger events — i.e. only at the moment the seed creates the account.
--       A player account can never be turned into a system one (it would be locked out
--       and its Coin frozen), and a system account can never be turned into a player one
--       (its authored party would start earning).
--
--   ledger_event: no Coin credit for a system account
--       Coin a caravan loses to an authored party is DESTROYED, not banked (PHASE-2 §25);
--       Coin an authored party would "earn" is not minted. economy/coin.ts refuses first;
--       this trigger is the storage-level backstop, so no credit path — not even a
--       hand-written insert as the app role — can mint Coin onto a system account.
--
--   encounter_candidates.authored_served
--       Retire-by-ratio, second stage: the authored SERVED share of the band the search ran
--       in, measured over the rolling window of chosen candidates at search time, stored
--       with the menu so the draw replays from the row alone (GUARDRAILS §1). NULL on rows
--       written before this migration (replay treats it as "not weighted"). Immutable like
--       every other replay input (the update guard is redefined to cover it).
--
--   encounter_candidates.band / draw_rules / authored_weighted_down (chunk 25 QA S4, N2)
--       `band` is the display band of the search centre, so the served-share query walks
--       one index range per band instead of a centre range; `draw_rules` holds the
--       authored-draw tunables the menu was drawn under ({maxShareBp, overShareWeightBp,
--       fillNearestN}) and `authored_weighted_down` whether the served-share weight changed
--       that draw, so retuning a number never changes what an old row replays to. NULL only
--       on rows written before this migration. Immutable.
--
--   account_system_idx (chunk 25 QA S5)
--       The matchmaking pool scan is a UNION ALL of the live parties in the reputation
--       range (pool_progress (pool, reputation)) and the system accounts' parties (this
--       partial index), so neither branch scans the whole party table.

-- ---------------------------------------------------------------------------------
CREATE FUNCTION account_guard_is_system() RETURNS trigger AS $$
BEGIN
  IF OLD.is_system AND NOT NEW.is_system THEN
    RAISE EXCEPTION 'account %: is_system is permanent and may not be cleared', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT OLD.is_system AND NEW.is_system THEN
    IF EXISTS (SELECT 1 FROM caravan WHERE account_id = OLD.id) THEN
      RAISE EXCEPTION 'account %: is_system may only be set before the account owns a caravan', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM ledger_event WHERE account_id = OLD.id) THEN
      RAISE EXCEPTION 'account %: is_system may only be set before the account has ledger events', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER account_guard_is_system
  BEFORE UPDATE OF is_system ON account FOR EACH ROW EXECUTE FUNCTION account_guard_is_system();

-- ---------------------------------------------------------------------------------
CREATE FUNCTION ledger_event_guard_system_coin() RETURNS trigger AS $$
BEGIN
  IF NEW.event_type IN ('coin_earned', 'coin_purchased', 'coin_transferred_to_party_owner')
     AND EXISTS (SELECT 1 FROM account WHERE id = NEW.account_id AND is_system) THEN
    RAISE EXCEPTION 'system account % cannot be credited Coin (% refused): Coin lost to an authored party is destroyed, never minted',
      NEW.account_id, NEW.event_type USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_event_guard_system_coin
  BEFORE INSERT ON ledger_event FOR EACH ROW EXECUTE FUNCTION ledger_event_guard_system_coin();

-- ---------------------------------------------------------------------------------
ALTER TABLE encounter_candidates
  ADD COLUMN authored_served jsonb,
  ADD COLUMN band integer,
  ADD COLUMN draw_rules jsonb,
  ADD COLUMN authored_weighted_down boolean,
  ADD CONSTRAINT encounter_candidates_authored_served_is_object
    CHECK (authored_served IS NULL OR jsonb_typeof(authored_served) = 'object'),
  ADD CONSTRAINT encounter_candidates_band_nonneg CHECK (band IS NULL OR band >= 0),
  ADD CONSTRAINT encounter_candidates_draw_rules_is_object
    CHECK (draw_rules IS NULL OR jsonb_typeof(draw_rules) = 'object');

CREATE OR REPLACE FUNCTION encounter_candidates_guard_update() RETURNS trigger AS $$
BEGIN
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
$$ LANGUAGE plpgsql;

-- The served-share query walks one band's chosen rows newest first, in its total order
-- (chosen_at DESC, trip_id, encounter_index DESC), and stops after the window (QA S4).
CREATE INDEX encounter_candidates_band_chosen_idx
  ON encounter_candidates (band, chosen_at DESC, trip_id, encounter_index DESC) WHERE chosen_at IS NOT NULL;

-- The pool scan's system branch (QA S5): every system account, without a scan of account.
CREATE INDEX account_system_idx ON account (id) WHERE is_system;

-- ---------------------------------------------------------------------------------
-- The content-drop hook's bookkeeping: which version of the authored set each system
-- account's party was last built to, and the hash of the exact spec applied, so
-- seedAuthoredParties can update a party in place when the set changes and leave it
-- alone when it has not. One row per system account; nothing else reads it.
CREATE TABLE authored_party (
  account_id  uuid        PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  set_version integer     NOT NULL,
  spec_hash   text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT authored_party_version_positive CHECK (set_version >= 1)
);
