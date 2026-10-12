DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ledger_event WHERE event_type::text = 'standing_party_repaired') THEN
    RAISE EXCEPTION 'migration 026 down: standing_party_repaired events exist; the ledger is append-only and they have nowhere to go' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

ALTER TABLE encounter_candidates DROP CONSTRAINT IF EXISTS encounter_candidates_raider_cap_shape;
ALTER TABLE encounter_candidates DROP COLUMN IF EXISTS raider_cap;

DELETE FROM inbox_preference WHERE category = 'party_changed';
ALTER TABLE inbox_preference DROP CONSTRAINT IF EXISTS inbox_preference_category_known;
ALTER TABLE inbox_preference ADD CONSTRAINT inbox_preference_category_known CHECK (
  category IN ('party_strike', 'refugees_arrived', 'trip_cap_refilled', 'mine_near_cap', 'packs_rotated')
);

CREATE OR REPLACE FUNCTION ledger_event_scope(t ledger_event_type) RETURNS text
LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT CASE
    WHEN t IN ('coin_earned', 'coin_spent', 'coin_transferred_to_party_owner', 'coin_purchased',
               'standing_party_saved', 'standing_party_invalidated', 'party_served_as_encounter') THEN 'account'
    WHEN t IN ('reputation_changed', 'ladder_progress_gained',
               'unlock_points_granted', 'unlock_node_purchased') THEN 'pool'
    ELSE 'caravan'
  END
$$;
-- 'standing_party_repaired' stays in ledger_event_type: Postgres cannot drop an enum label.
