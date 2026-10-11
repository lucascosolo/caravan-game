DROP TRIGGER IF EXISTS trip_cap_guard_truncate ON trip_cap;
DROP TRIGGER IF EXISTS trip_cap_guard_delete ON trip_cap;
DROP TRIGGER IF EXISTS trip_cap_guard_update ON trip_cap;
DROP TABLE IF EXISTS trip_cap;
DROP FUNCTION IF EXISTS trip_cap_guard_delete();
DROP FUNCTION IF EXISTS trip_cap_guard_update();
DROP TRIGGER IF EXISTS trip_encounter_guard_truncate ON trip_encounter;
DROP TRIGGER IF EXISTS trip_encounter_guard_delete ON trip_encounter;
DROP TRIGGER IF EXISTS trip_encounter_guard_update ON trip_encounter;
DROP TRIGGER IF EXISTS trip_encounter_guard_insert ON trip_encounter;
DROP TABLE IF EXISTS trip_encounter;
DROP FUNCTION IF EXISTS trip_encounter_guard_delete();
DROP FUNCTION IF EXISTS trip_encounter_guard_update();
DROP FUNCTION IF EXISTS trip_encounter_guard_insert();
CREATE OR REPLACE FUNCTION trip_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.caravan_id <> OLD.caravan_id OR NEW.manifest_id <> OLD.manifest_id OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'trip identity is immutable (trip %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.ended_at IS NOT NULL AND NEW.ended_at IS DISTINCT FROM OLD.ended_at THEN
    RAISE EXCEPTION 'trip % has ended and is frozen', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
ALTER TABLE trip DROP CONSTRAINT IF EXISTS trip_end_reason_needs_end;
ALTER TABLE trip DROP CONSTRAINT IF EXISTS trip_end_reason_known;
ALTER TABLE trip DROP COLUMN IF EXISTS end_reason;
