-- Chunk 15: the trip loop — encounter chaining, bank / push, the trip cap.
--
--   trip.end_reason     How a trip ended: 'banked' (the player delivered) or 'overrun' (the
--                       caravan fell). Set together with ended_at, never changed after.
--                       A stalemate does not end a trip: the caravan may bank or push.
--                       NULL with ended_at set is legal only for trips ended through
--                       chunk 14's bare endTrip seam (its tests); the trip loop always names it.
--   trip_encounter      One row per SETTLED encounter of a trip: the resolution outcome the
--                       trip loop folded in (kind, depth, who died), the Coin that encounter
--                       accrued as UNBANKED trip state (never in the account balance until a
--                       bank), and the player's decision after surviving it (push / bank).
--                       Written once, in the same transaction that advances the manifest's
--                       encounters_resolved; immutable except the one-time decision.
--   trip_cap            The account's trip-start budget as a single theoretical-arrival
--                       timestamp (GCRA): uses available at time t are
--                       CAP − ceil(max(0, tat_ms − t) / REGEN), and a start sets
--                       tat_ms := max(tat_ms, t) + REGEN. Computed lazily on read; no
--                       background tick. tat_ms never decreases — no path refunds a use —
--                       and there is no Coin column: the cap is never purchasable.
--
-- CARAVAN-level: trip, trip_encounter (GUARDRAILS §5). ACCOUNT-level: trip_cap (a player's
-- budget of trips; a second caravan must never multiply it). No geography, no route, no
-- travel timer anywhere (chunk 15 brief).

ALTER TABLE trip
  ADD COLUMN end_reason text,
  ADD CONSTRAINT trip_end_reason_known CHECK (end_reason IS NULL OR end_reason IN ('banked', 'overrun')),
  ADD CONSTRAINT trip_end_reason_needs_end CHECK (end_reason IS NULL OR ended_at IS NOT NULL);

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

-- ---------------------------------------------------------------------------------
CREATE TABLE trip_encounter (
  trip_id                uuid        NOT NULL REFERENCES trip (id) ON DELETE CASCADE,
  encounter_index        integer     NOT NULL,
  -- The resolution job whose stored outcome this row folded in (encounter:<trip>:<n>).
  job_id                 text        NOT NULL,
  outcome_kind           text        NOT NULL,
  -- Fixed-point fraction (FIXED_ONE = 1024 = the core) of how deep the party got.
  depth_fp               integer     NOT NULL,
  -- Unit refs (instance ids) whose HP reached 0 in THIS encounter. Chunk 19 de-merges them.
  deaths                 jsonb       NOT NULL,
  -- Coin this encounter is worth to the caravan, UNBANKED (at risk) until the trip banks.
  coin_accrued           integer     NOT NULL,
  party_owner_account_id uuid        NOT NULL,
  -- After surviving: 'pushed' (on to the next encounter) or 'banked' (delivered). Once.
  decision               text,
  decided_at             timestamptz,
  settled_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trip_id, encounter_index),
  CONSTRAINT trip_encounter_index_positive CHECK (encounter_index >= 1),
  CONSTRAINT trip_encounter_kind_known CHECK (outcome_kind IN ('caravan_held', 'caravan_overrun', 'stalemate')),
  CONSTRAINT trip_encounter_depth_range CHECK (depth_fp >= 0 AND depth_fp <= 1024),
  CONSTRAINT trip_encounter_deaths_is_array CHECK (jsonb_typeof(deaths) = 'array'),
  CONSTRAINT trip_encounter_coin_nonneg CHECK (coin_accrued >= 0),
  -- An overrun encounter earns the caravan nothing and offers no decision: the trip is over.
  CONSTRAINT trip_encounter_overrun_no_coin CHECK (outcome_kind <> 'caravan_overrun' OR coin_accrued = 0),
  CONSTRAINT trip_encounter_overrun_no_decision CHECK (outcome_kind <> 'caravan_overrun' OR decision IS NULL),
  CONSTRAINT trip_encounter_decision_known CHECK (decision IS NULL OR decision IN ('pushed', 'banked')),
  CONSTRAINT trip_encounter_decision_both CHECK ((decision IS NULL) = (decided_at IS NULL))
);

CREATE FUNCTION trip_encounter_guard_insert() RETURNS trigger AS $$
BEGIN
  IF NEW.decision IS NOT NULL THEN
    RAISE EXCEPTION 'trip_encounter rows are inserted undecided' USING ERRCODE = 'check_violation';
  END IF;
  -- Settled in order: encounter n only after n-1 was survived and pushed past.
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
CREATE TRIGGER trip_encounter_guard_insert BEFORE INSERT ON trip_encounter FOR EACH ROW EXECUTE FUNCTION trip_encounter_guard_insert();

-- What was settled never changes; the only legal update is deciding, once.
CREATE FUNCTION trip_encounter_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.trip_id <> OLD.trip_id OR NEW.encounter_index <> OLD.encounter_index OR NEW.job_id <> OLD.job_id
     OR NEW.outcome_kind <> OLD.outcome_kind OR NEW.depth_fp <> OLD.depth_fp OR NEW.deaths <> OLD.deaths
     OR NEW.coin_accrued <> OLD.coin_accrued OR NEW.party_owner_account_id <> OLD.party_owner_account_id
     OR NEW.settled_at <> OLD.settled_at THEN
    RAISE EXCEPTION 'trip_encounter (trip %, encounter %) is a settled outcome and is immutable', OLD.trip_id, OLD.encounter_index
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.decision IS NOT NULL AND (NEW.decision IS DISTINCT FROM OLD.decision OR NEW.decided_at IS DISTINCT FROM OLD.decided_at) THEN
    RAISE EXCEPTION 'trip_encounter (trip %, encounter %): the bank-or-push decision is final', OLD.trip_id, OLD.encounter_index
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER trip_encounter_guard_update BEFORE UPDATE ON trip_encounter FOR EACH ROW EXECUTE FUNCTION trip_encounter_guard_update();

CREATE FUNCTION trip_encounter_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM trip WHERE id = OLD.trip_id) THEN
    RAISE EXCEPTION 'trip_encounter (trip %, encounter %) is history and may not be deleted while its trip exists', OLD.trip_id, OLD.encounter_index
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER trip_encounter_guard_delete BEFORE DELETE ON trip_encounter FOR EACH ROW EXECUTE FUNCTION trip_encounter_guard_delete();
CREATE TRIGGER trip_encounter_guard_truncate BEFORE TRUNCATE ON trip_encounter FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();

-- ---------------------------------------------------------------------------------
CREATE TABLE trip_cap (
  account_id uuid   PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  tat_ms     bigint NOT NULL,
  CONSTRAINT trip_cap_tat_nonneg CHECK (tat_ms >= 0)
);

CREATE FUNCTION trip_cap_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.account_id <> OLD.account_id THEN
    RAISE EXCEPTION 'trip_cap identity is immutable (account %)', OLD.account_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tat_ms < OLD.tat_ms THEN
    RAISE EXCEPTION 'trip_cap (account %): a trip-cap use is never refunded (tat % -> %)', OLD.account_id, OLD.tat_ms, NEW.tat_ms
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER trip_cap_guard_update BEFORE UPDATE ON trip_cap FOR EACH ROW EXECUTE FUNCTION trip_cap_guard_update();

CREATE FUNCTION trip_cap_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE id = OLD.account_id) THEN
    RAISE EXCEPTION 'trip_cap (account %) may not be deleted while its account exists', OLD.account_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER trip_cap_guard_delete BEFORE DELETE ON trip_cap FOR EACH ROW EXECUTE FUNCTION trip_cap_guard_delete();
CREATE TRIGGER trip_cap_guard_truncate BEFORE TRUNCATE ON trip_cap FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();
