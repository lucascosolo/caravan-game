-- Chunk 50: the round wagon circle (BATTLEFIELD_VERSION 3, RESOLVER_VERSION 10).
--
-- A trip records the battlefield geometry it rode out under. A trip that rode out on the old
-- square camp (version 2) has a manifest whose stored formations name segment indices that no
-- longer exist, so the upgrade step (trip/service.ts voidTripsOfOtherGeometry, beside the
-- park-other-versions call) voids every open trip of another geometry that has no job in
-- flight, through the existing void path. Existing rows are stamped 2; the default is then
-- dropped so every new trip must state its geometry.
ALTER TABLE trip ADD COLUMN battlefield_version integer NOT NULL DEFAULT 2;
ALTER TABLE trip ALTER COLUMN battlefield_version DROP DEFAULT;

CREATE OR REPLACE FUNCTION trip_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.caravan_id <> OLD.caravan_id OR NEW.manifest_id <> OLD.manifest_id OR NEW.started_at <> OLD.started_at OR NEW.battlefield_version <> OLD.battlefield_version THEN
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
$$ LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp;
