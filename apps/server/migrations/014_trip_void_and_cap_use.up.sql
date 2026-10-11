-- Chunk 15 QA fixes (D3, N7): the void path and the trip ↔ cap-use tie.
--
--   ledger_event_type 'trip_voided'   D3: an encounter whose resolution job PARKED (a
--                        deterministic resolver failure, a refused outcome, a content stamp no
--                        worker can serve) voids the trip: the voided encounter is discarded,
--                        the trip banks as of its last survived encounter (nothing if none),
--                        nothing of the voided fight applies, and the trip-cap use is NOT
--                        refunded. Caravan-scoped (the ELSE branch of ledger_event_scope).
--   trip.end_reason 'voided'           how such a trip ended (frozen like the others).
--   trip_cap_use                       N7 (defense in depth): one row per trip the trip loop
--                        started, naming the trip-cap timestamp its start consumed. Each start
--                        strictly raises trip_cap.tat_ms (GCRA), so UNIQUE (account_id, tat_ms)
--                        means no two trips share a use, and the insert must name the account's
--                        CURRENT tat_ms (the start sets it in the same transaction). A trip may
--                        only be settled (trip_encounter insert) or given an end_reason with its
--                        cap use recorded. Chunk 14's bare createTrip/endTrip seam (its tests)
--                        needs none: it never settles and never names an end reason.
--                        Trips that existed before this migration are back-filled as `legacy`.
--
-- Postgres cannot drop an enum label: the down migration leaves 'trip_voided' in the type
-- (harmless while unused) and refuses while any voided trip exists.

ALTER TYPE ledger_event_type ADD VALUE IF NOT EXISTS 'trip_voided';

ALTER TABLE trip DROP CONSTRAINT trip_end_reason_known;
ALTER TABLE trip ADD CONSTRAINT trip_end_reason_known CHECK (end_reason IS NULL OR end_reason IN ('banked', 'overrun', 'voided'));

-- ---------------------------------------------------------------------------------
CREATE TABLE trip_cap_use (
  trip_id    uuid        PRIMARY KEY REFERENCES trip (id) ON DELETE CASCADE,
  -- No FK to account: the trip row (caravan → account) is the owner; the insert trigger checks it.
  account_id uuid        NOT NULL,
  -- trip_cap.tat_ms right after this trip's start consumed its use. NULL only for `legacy`.
  tat_ms     bigint,
  legacy     boolean     NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trip_cap_use_tat_present CHECK (legacy OR tat_ms IS NOT NULL),
  CONSTRAINT trip_cap_use_tat_nonneg CHECK (tat_ms IS NULL OR tat_ms > 0),
  CONSTRAINT trip_cap_use_one_trip_per_use UNIQUE (account_id, tat_ms)
);

-- Back-fill every trip that predates the tie (so an open one can still settle and end).
INSERT INTO trip_cap_use (trip_id, account_id, tat_ms, legacy)
SELECT t.id, c.account_id, NULL, true FROM trip t JOIN caravan c ON c.id = t.caravan_id;

CREATE FUNCTION trip_cap_use_guard_insert() RETURNS trigger AS $$
DECLARE
  owner uuid;
  tat bigint;
BEGIN
  IF NEW.legacy THEN
    RAISE EXCEPTION 'trip_cap_use: legacy rows exist only from migration 014''s back-fill' USING ERRCODE = 'check_violation';
  END IF;
  SELECT c.account_id INTO owner FROM trip t JOIN caravan c ON c.id = t.caravan_id WHERE t.id = NEW.trip_id;
  IF owner IS NULL OR owner <> NEW.account_id THEN
    RAISE EXCEPTION 'trip_cap_use: trip % is not a trip of account %', NEW.trip_id, NEW.account_id USING ERRCODE = 'check_violation';
  END IF;
  SELECT tat_ms INTO tat FROM trip_cap WHERE account_id = NEW.account_id;
  IF tat IS NULL OR tat <> NEW.tat_ms THEN
    RAISE EXCEPTION 'trip_cap_use: trip % names cap timestamp %, but the account''s trip cap stands at % (a start must consume a use in the same transaction)', NEW.trip_id, NEW.tat_ms, tat
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM trip WHERE id = NEW.trip_id AND ended_at IS NOT NULL) THEN
    RAISE EXCEPTION 'trip_cap_use: trip % has already ended', NEW.trip_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER trip_cap_use_guard_insert BEFORE INSERT ON trip_cap_use FOR EACH ROW EXECUTE FUNCTION trip_cap_use_guard_insert();

CREATE FUNCTION trip_cap_use_guard_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'trip_cap_use (trip %) is immutable', OLD.trip_id USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER trip_cap_use_guard_update BEFORE UPDATE ON trip_cap_use FOR EACH ROW EXECUTE FUNCTION trip_cap_use_guard_update();

CREATE FUNCTION trip_cap_use_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trip WHERE id = OLD.trip_id) THEN
    RAISE EXCEPTION 'trip_cap_use (trip %) may not be deleted while its trip exists', OLD.trip_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER trip_cap_use_guard_delete BEFORE DELETE ON trip_cap_use FOR EACH ROW EXECUTE FUNCTION trip_cap_use_guard_delete();
CREATE TRIGGER trip_cap_use_guard_truncate BEFORE TRUNCATE ON trip_cap_use FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();

-- A trip can only end with a named reason (the trip loop's ends) once its cap use is recorded.
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
$$ LANGUAGE plpgsql;

-- And an encounter can only be settled on a trip whose cap use is recorded.
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
  IF NOT EXISTS (SELECT 1 FROM trip_cap_use WHERE trip_id = NEW.trip_id) THEN
    RAISE EXCEPTION 'trip % has no recorded trip-cap use; no encounter can be settled on it', NEW.trip_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
