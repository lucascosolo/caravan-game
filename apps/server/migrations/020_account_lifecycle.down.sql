-- Chunk 30 down. Refuses while any account has no username (a guest, or the erasure
-- tombstone): username / password_hash cannot become NOT NULL again without deleting them,
-- and deleting the tombstone would cascade other players' kept replays. Delete them as the
-- owner first if a rollback is really wanted (a dev reset empties `account` anyway).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE username IS NULL) THEN
    RAISE EXCEPTION '020 down: guest or tombstone accounts exist (username IS NULL); delete them first' USING ERRCODE = 'check_violation';
  END IF;
END
$$;

DROP FUNCTION IF EXISTS account_erase(uuid, text);

-- The guards as they were before 019.
CREATE OR REPLACE FUNCTION ledger_event_guard_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_event is append-only: UPDATE refused (seq %)', OLD.seq
    USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION encounter_log_guard_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'encounter_log % is immutable: a replay is never rewritten', OLD.job_id USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION resolution_job_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.kind <> OLD.kind
     OR NEW.account_id <> OLD.account_id OR NEW.caravan_id <> OLD.caravan_id
     OR NEW.input <> OLD.input OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'resolution_job identity and input are immutable (job %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'completed' THEN
    RAISE EXCEPTION 'resolution_job % is completed and immutable', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'parked' AND NEW.status <> 'queued' THEN
    RAISE EXCEPTION 'resolution_job % is parked: it can only be re-queued by an operator', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'resolution_job.attempts never decreases (job %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'completed' AND (
       OLD.status <> 'leased' OR NEW.attempts <> OLD.attempts
       OR NEW.leased_by IS DISTINCT FROM OLD.leased_by
  ) THEN
    RAISE EXCEPTION 'resolution_job % can only be completed from leased by the worker holding the lease', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'leased'
     AND NOT (OLD.status = 'leased'
              AND NEW.leased_by IS NOT DISTINCT FROM OLD.leased_by
              AND NEW.lease_expires_at IS NOT DISTINCT FROM OLD.lease_expires_at)
     AND NEW.attempts <= OLD.attempts THEN
    RAISE EXCEPTION 'resolution_job % lease must be a new attempt (attempts must increase)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status = 'parked' AND OLD.status NOT IN ('leased', 'parked') THEN
    RAISE EXCEPTION 'resolution_job % can only be parked from leased', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trip_encounter_guard_update() RETURNS trigger AS $$
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

CREATE OR REPLACE FUNCTION encounter_candidates_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.trip_id <> OLD.trip_id OR NEW.encounter_index <> OLD.encounter_index OR NEW.search_seq <> OLD.search_seq
     OR NEW.seed <> OLD.seed OR NEW.caravan_rating <> OLD.caravan_rating OR NEW.centre <> OLD.centre
     OR NEW.band_width_used <> OLD.band_width_used OR NEW.pool <> OLD.pool
     OR NEW.excluded_party_ids <> OLD.excluded_party_ids OR NEW.skipped_party_ids <> OLD.skipped_party_ids
     OR NEW.candidates <> OLD.candidates OR NEW.searched_at_ms <> OLD.searched_at_ms OR NEW.created_at <> OLD.created_at
     OR NEW.authored_served IS DISTINCT FROM OLD.authored_served OR NEW.band IS DISTINCT FROM OLD.band
     OR NEW.draw_rules IS DISTINCT FROM OLD.draw_rules OR NEW.authored_weighted_down IS DISTINCT FROM OLD.authored_weighted_down THEN
    RAISE EXCEPTION 'encounter_candidates (trip %, encounter %, search %) is a stored menu and is immutable', OLD.trip_id, OLD.encounter_index, OLD.search_seq
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.chosen_at IS NOT NULL AND (NEW.chosen_at IS DISTINCT FROM OLD.chosen_at OR NEW.chosen_candidate_id IS DISTINCT FROM OLD.chosen_candidate_id) THEN
    RAISE EXCEPTION 'encounter_candidates (trip %, encounter %): the chosen candidate is frozen', OLD.trip_id, OLD.encounter_index
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP FUNCTION IF EXISTS account_erasure_permits(jsonb, jsonb);
DROP FUNCTION IF EXISTS account_erasure_rewrite(jsonb);
DROP FUNCTION IF EXISTS account_erasure_walk(jsonb, jsonb, text);
DROP FUNCTION IF EXISTS account_erasure_display_name();
DROP FUNCTION IF EXISTS account_erasure_tombstone_caravan();
DROP FUNCTION IF EXISTS account_erasure_tombstone_account();
DROP TABLE IF EXISTS account_erasure_audit;
DROP FUNCTION IF EXISTS account_erasure_audit_guard();
DROP TABLE IF EXISTS account_erasure_active;

DROP TRIGGER IF EXISTS session_ensure_device ON session;
DROP FUNCTION IF EXISTS session_ensure_device();
DROP INDEX IF EXISTS session_device_idx;
ALTER TABLE session DROP COLUMN IF EXISTS device_id;
DROP TABLE IF EXISTS device;

DROP TRIGGER IF EXISTS account_stamp_linked ON account;
DROP FUNCTION IF EXISTS account_stamp_linked();
DROP TRIGGER IF EXISTS account_guard_identity ON account;
DROP FUNCTION IF EXISTS account_guard_identity();
ALTER TABLE account
  DROP CONSTRAINT IF EXISTS account_linked_at_matches,
  DROP CONSTRAINT IF EXISTS account_credentials_together,
  DROP COLUMN IF EXISTS linked_at,
  ALTER COLUMN username SET NOT NULL,
  ALTER COLUMN password_hash SET NOT NULL;
