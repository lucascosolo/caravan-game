-- Chunk 29 QA fixes (S4, N3).
--
-- S4: the inbox reads an owner's strikes by time (14-day horizon, 1-hour windows). Without an
-- index on (account_id, occurred_at) for this one event type, every inbox read and every badge
-- poll scanned all of the owner's ledger rows, so its cost grew with the account's lifetime.
-- Partial: only `party_served_as_encounter` rows are in it.
CREATE INDEX ledger_event_party_served_at_idx ON ledger_event (account_id, occurred_at)
  WHERE event_type = 'party_served_as_encounter';

-- N3: a read mark only moves forward — and that must hold against DELETE + re-INSERT too, not
-- only UPDATE. A mark may be deleted only by its account's cascade (the account row is gone by
-- the time the cascade fires), the same rule as ledger_event_guard_delete (migration 002).
CREATE FUNCTION inbox_read_guard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE id = OLD.account_id) THEN
    RAISE EXCEPTION 'inbox_read: a read mark only moves forward; DELETE refused (%)', OLD.item_key USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$;

CREATE TRIGGER inbox_read_guard_delete BEFORE DELETE ON inbox_read
  FOR EACH ROW EXECUTE FUNCTION inbox_read_guard_delete();
