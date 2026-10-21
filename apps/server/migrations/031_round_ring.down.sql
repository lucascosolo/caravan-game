CREATE OR REPLACE FUNCTION trip_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.caravan_id <> OLD.caravan_id OR NEW.manifest_id <> OLD.manifest_id OR NEW.started_at <> OLD.started_at THEN
    RAISE EXCEPTION 'trip identity is immutable (trip %)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.ended_at IS NOT NULL AND (NEW.ended_at IS DISTINCT FROM OLD.ended_at OR NEW.end_reason IS DISTINCT FROM OLD.end_reason) THEN
    RAISE EXCEPTION 'trip % has ended and is frozen', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.end_reason IS NOT NULL AND OLD.end_reason IS NULL AND NOT EXISTS (SELECT 1 FROM trip_cap_use WHERE trip_id = NEW.id) THEN
    RAISE EXCEPTION 'trip % has no recorded trip-cap use; the trip loop cannot end it', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp; -- pinned by migration 023 for every public function

ALTER TABLE trip DROP COLUMN IF EXISTS battlefield_version;
