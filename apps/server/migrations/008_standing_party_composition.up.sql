-- Chunk 09: the standing raid party's composition, stances and approach edges.
--
-- standing_party is ACCOUNT-level (GUARDRAILS §5) and a TEMPLATE (GUARDRAILS §0): it is
-- served into other players' trips, never consumed, never loses a unit. `composition` is
-- the owner's CHOICES only — @caravan/circle PartyConfig in canonical form: which roster
-- instances ride (by unit_instance id), each one's targeting stance, approach edge and
-- starting cell, and which siege types come along. It carries no HP, no stats and no merge
-- level: those are facts of the roster, joined at read time. There is deliberately NO
-- foreign key from a party unit to unit_instance — a merge or a trip loss removes the
-- instance and the party must then read as INVALID until the owner edits it (a validation
-- rule, service-side), rather than the party being silently trimmed or the roster change
-- being blocked. Nothing in the fight path writes this table; the resolution job reads a
-- frozen snapshot of it (chunk 02).
--
-- PARTIES_PER_ACCOUNT is 1 in v1 (the service refuses any slot but 0), but the schema now
-- allows more: the row has its own id and a per-account slot (PHASE-2 §43). Editing is free
-- and instant — there is no cooldown column and nothing to put one in.

ALTER TABLE standing_party DROP CONSTRAINT standing_party_pkey;
ALTER TABLE standing_party
  ADD COLUMN id          uuid     NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN slot        smallint NOT NULL DEFAULT 0,
  ADD COLUMN composition jsonb    NOT NULL DEFAULT '{"siege":[],"units":[],"v":1}'::jsonb,
  -- Chunk 09 QA S4: how many times the composition has changed. The save event's causation
  -- counter, kept as a column (not count(*) over the ledger) so it is O(1) and cannot drift
  -- from what the ledger holds. Moves by exactly 1 with each composition change (trigger).
  ADD COLUMN save_seq    integer  NOT NULL DEFAULT 0;
ALTER TABLE standing_party ADD PRIMARY KEY (id);
ALTER TABLE standing_party ADD CONSTRAINT standing_party_slot_nonneg CHECK (slot >= 0);
ALTER TABLE standing_party ADD CONSTRAINT standing_party_save_seq_nonneg CHECK (save_seq >= 0);
-- (account_id, slot) is the per-account lookup key; its unique index also serves every
-- account_id lookup, so there is no separate account index (chunk 09 QA N4).
ALTER TABLE standing_party ADD CONSTRAINT standing_party_one_per_slot UNIQUE (account_id, slot);
ALTER TABLE standing_party ADD CONSTRAINT standing_party_composition_shape CHECK (
  -- coalesce: a missing key would make jsonb_typeof NULL and the CHECK vacuously pass.
  jsonb_typeof(composition) = 'object'
  AND coalesce(jsonb_typeof(composition -> 'v'), '') = 'number'
  AND coalesce(jsonb_typeof(composition -> 'units'), '') = 'array'
  AND coalesce(jsonb_typeof(composition -> 'siege'), '') = 'array'
);

-- Identity is immutable; `updated_at` is the "which version was served" stamp (the job
-- snapshot records it as savedAt), so it moves exactly when the composition does and is
-- otherwise left as the caller set it. `save_seq` moves by exactly one with the
-- composition and is otherwise frozen, so the save counter and the ledger cannot diverge.
CREATE FUNCTION standing_party_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id OR NEW.slot <> OLD.slot OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'standing_party identity is immutable (party %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.composition IS DISTINCT FROM OLD.composition THEN
    NEW.updated_at := now();
    IF NEW.save_seq <> OLD.save_seq + 1 THEN
      RAISE EXCEPTION 'standing_party.save_seq must advance by exactly 1 with the composition (party %)', OLD.id
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.save_seq <> OLD.save_seq THEN
    RAISE EXCEPTION 'standing_party.save_seq moves only with the composition (party %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER standing_party_guard_update
  BEFORE UPDATE ON standing_party FOR EACH ROW EXECUTE FUNCTION standing_party_guard_update();

-- A party persists until edited: it leaves only with its account (cascade).
CREATE FUNCTION standing_party_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE id = OLD.account_id) THEN
    RAISE EXCEPTION 'standing_party % persists until edited and may not be deleted while its account exists', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER standing_party_guard_delete
  BEFORE DELETE ON standing_party FOR EACH ROW EXECUTE FUNCTION standing_party_guard_delete();
CREATE TRIGGER standing_party_guard_truncate
  BEFORE TRUNCATE ON standing_party FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();
