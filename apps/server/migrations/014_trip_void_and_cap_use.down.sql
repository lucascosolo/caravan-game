DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM trip WHERE end_reason = 'voided') THEN
    RAISE EXCEPTION 'migration 014 down: voided trips exist; their end reason has nowhere to go' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION trip_encounter_guard_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.decision IS NOT NULL THEN
    RAISE EXCEPTION 'trip_encounter rows are inserted undecided' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.encounter_index > 1 AND NOT EXISTS (
    SELECT 1 FROM trip_encounter WHERE trip_id = NEW.trip_id AND encounter_index = NEW.encounter_index - 1 AND decision = 'pushed'
  ) THEN
    RAISE EXCEPTION 'trip %: encounter % can only be settled after encounter % was survived and pushed past', NEW.trip_id, NEW.encounter_index, NEW.encounter_index - 1
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM trip WHERE id = NEW.trip_id AND ended_at IS NOT NULL) THEN
    RAISE EXCEPTION 'trip % has ended; no encounter can be settled on it', NEW.trip_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trip_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.caravan_id <> OLD.caravan_id OR NEW.manifest_id <> OLD.manifest_id OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'trip identity is immutable (trip %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.end_reason IS DISTINCT FROM OLD.end_reason) THEN
    RAISE EXCEPTION 'trip % has ended and is frozen', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trip_cap_use_guard_truncate ON trip_cap_use;
DROP TRIGGER IF EXISTS trip_cap_use_guard_delete ON trip_cap_use;
DROP TRIGGER IF EXISTS trip_cap_use_guard_update ON trip_cap_use;
DROP TRIGGER IF EXISTS trip_cap_use_guard_insert ON trip_cap_use;
DROP TABLE IF EXISTS trip_cap_use;
DROP FUNCTION IF EXISTS trip_cap_use_guard_delete();
DROP FUNCTION IF EXISTS trip_cap_use_guard_update();
DROP FUNCTION IF EXISTS trip_cap_use_guard_insert();

ALTER TABLE trip DROP CONSTRAINT IF EXISTS trip_end_reason_known;
ALTER TABLE trip ADD CONSTRAINT trip_end_reason_known CHECK (end_reason IS NULL OR end_reason IN ('banked', 'overrun'));
-- 'trip_voided' stays in ledger_event_type: Postgres cannot drop an enum label.
