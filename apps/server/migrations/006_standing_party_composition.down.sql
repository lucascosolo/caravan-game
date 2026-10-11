DROP TRIGGER IF EXISTS standing_party_guard_truncate ON standing_party;
DROP TRIGGER IF EXISTS standing_party_guard_delete ON standing_party;
DROP TRIGGER IF EXISTS standing_party_guard_update ON standing_party;
DROP FUNCTION IF EXISTS standing_party_guard_delete();
DROP FUNCTION IF EXISTS standing_party_guard_update();
DROP INDEX IF EXISTS standing_party_account_idx;
ALTER TABLE standing_party
  DROP CONSTRAINT IF EXISTS standing_party_composition_shape,
  DROP CONSTRAINT IF EXISTS standing_party_one_per_slot,
  DROP CONSTRAINT IF EXISTS standing_party_slot_nonneg;
-- Pre-006 schema holds one party per account (account_id is the key): any extra slot a
-- later feature created cannot survive the rollback. The guards above are already gone.
DELETE FROM standing_party WHERE slot <> 0;
ALTER TABLE standing_party DROP CONSTRAINT standing_party_pkey;
ALTER TABLE standing_party
  DROP COLUMN composition,
  DROP COLUMN slot,
  DROP COLUMN id;
ALTER TABLE standing_party ADD PRIMARY KEY (account_id);
