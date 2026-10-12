-- Final play-test review, server fixes (S1, S2).
--
--   ledger_event_type 'standing_party_repaired'   S2: a merge or a trip loss removed an instance the
--                        standing party named, and the party repaired itself in the same
--                        transaction (a merge re-points the slot to the merged unit, a destroyed
--                        unit's slot is dropped). ACCOUNT-scoped, like every standing-party event:
--                        the party is account-level (GUARDRAILS §5). It replaces chunk 09 QA S3's
--                        'standing_party_invalidated', which stays in the type for history.
--   inbox_preference category 'party_changed'     S2: the inbox's "your standing party changed"
--                        notice, derived from those events (on by default, like party strikes).
--   encounter_candidates.raider_cap               S1: the band-0 cold-start raider cap a search
--                        applied (packed units, the cap, whether it relaxed, which parties it left
--                        out), stored with the menu like draw_rules so a menu replays. NULL when
--                        the rule did not apply and on every row written before this migration.
--
-- Postgres cannot drop an enum label: the down migration leaves 'standing_party_repaired' in the
-- type (harmless while unused) and refuses while any such event exists.

ALTER TYPE ledger_event_type ADD VALUE IF NOT EXISTS 'standing_party_repaired';

-- The new label cannot be used as an enum literal in the transaction that added it, so the scope
-- function compares the label's text. Same answers for every older label.
CREATE OR REPLACE FUNCTION ledger_event_scope(t ledger_event_type) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN t::text IN ('coin_earned', 'coin_spent', 'coin_transferred_to_party_owner', 'coin_purchased',
               'standing_party_saved', 'standing_party_invalidated', 'party_served_as_encounter',
               'standing_party_repaired') THEN 'account'
    WHEN t::text IN ('reputation_changed', 'ladder_progress_gained',
               'unlock_points_granted', 'unlock_node_purchased') THEN 'pool'
    ELSE 'caravan'
  END
$$;

ALTER TABLE inbox_preference DROP CONSTRAINT inbox_preference_category_known;
ALTER TABLE inbox_preference ADD CONSTRAINT inbox_preference_category_known CHECK (
  category IN ('party_strike', 'refugees_arrived', 'trip_cap_refilled', 'mine_near_cap', 'packs_rotated', 'party_changed')
);

ALTER TABLE encounter_candidates ADD COLUMN raider_cap jsonb;
ALTER TABLE encounter_candidates ADD CONSTRAINT encounter_candidates_raider_cap_shape CHECK (
  raider_cap IS NULL OR (
    jsonb_typeof(raider_cap) = 'object'
    AND coalesce(jsonb_typeof(raider_cap -> 'cap'), '') = 'number'
    AND coalesce(jsonb_typeof(raider_cap -> 'packedUnits'), '') = 'number'
    AND coalesce(jsonb_typeof(raider_cap -> 'excludedPartyIds'), '') = 'array'
  )
);
