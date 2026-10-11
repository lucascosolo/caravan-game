-- Chunk 13 QA round 1 (S4): encounter_log rows are written ONCE, only by the resolution path,
-- and leave only through the retention rule — enforced in the database, against the app role.
--
-- Before this, immutability was UPDATE-only: as `caravan_app`, DELETE + INSERT of a forged log
-- in one transaction was accepted, a fresh row could be deleted (the route then called it
-- "expired"), an INSERT naming another caravan, random account ids and resolver_version 1 was
-- accepted for a real job, and the writer's ON CONFLICT DO NOTHING let a row planted before
-- completion stand in for the real log.
--
--   encounter_log_retention     LOG_RETENTION as a constant row (days, min_per_caravan) the
--                               guards read, so the caller can never pass a narrower window.
--                               Mirrors TUNABLES.LOG_RETENTION_DAYS / _MIN_PER_CARAVAN (a test
--                               pins them equal); the app role cannot write it (db/roles.sql).
--   encounter_log_guard_insert  BEFORE INSERT: the job exists, is an encounter job, is LEASED
--                               (being completed right now), and the row's caravan, defender and
--                               party-owner accounts, resolver version and content hash are the
--                               job's own. created_at is the database clock (no backdating).
--   encounter_log_guard_delete  BEFORE DELETE: only a row outside the retention rule (older than
--                               `days` AND not among its caravan's newest `min_per_caravan`), or
--                               a cascade from its caravan / job being deleted (account removal).
--   encounter_log_write(...)    SECURITY DEFINER: the ONE writer. Fenced like
--                               resolution_job_complete (the caller must hold the job's live
--                               lease at its attempt), plain INSERT (a second write for a job is a
--                               unique violation, never DO NOTHING), then the caravan's prune.
--   encounter_log_prune(uuid)   SECURITY DEFINER: the retention prune for one caravan, on the
--                               database clock and the constant row; no parameters to widen it.
--
-- db/roles.sql revokes INSERT, UPDATE and DELETE on encounter_log (and all writes on the
-- retention row) from caravan_app: the two functions are its only way in or out.

CREATE TABLE encounter_log_retention (
  singleton        boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  days             integer NOT NULL CHECK (days >= 1),
  min_per_caravan  integer NOT NULL CHECK (min_per_caravan >= 1)
);
INSERT INTO encounter_log_retention (days, min_per_caravan) VALUES (30, 50);

CREATE FUNCTION encounter_log_guard_insert() RETURNS trigger AS $$
DECLARE
  j resolution_job;
BEGIN
  SELECT * INTO j FROM resolution_job WHERE id = NEW.job_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'encounter_log %: no such resolution job', NEW.job_id USING ERRCODE = 'check_violation';
  END IF;
  IF j.kind <> 'encounter_resolution' THEN
    RAISE EXCEPTION 'encounter_log %: job kind % is not an encounter resolution', NEW.job_id, j.kind USING ERRCODE = 'check_violation';
  END IF;
  IF j.status <> 'leased' THEN
    RAISE EXCEPTION 'encounter_log %: a replay is written only while its job is being completed (job is %)', NEW.job_id, j.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.caravan_id <> j.caravan_id
     OR NEW.caravan_id::text IS DISTINCT FROM j.input->>'defenderCaravanId'
     OR NEW.defender_account_id <> j.account_id
     OR NEW.defender_account_id::text IS DISTINCT FROM j.input->>'defenderAccountId'
     OR NEW.party_owner_account_id::text IS DISTINCT FROM j.input->>'partyOwnerAccountId' THEN
    RAISE EXCEPTION 'encounter_log %: caravan and account ids must be the job''s own', NEW.job_id USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.resolver_version IS DISTINCT FROM (j.input->>'resolverVersion')::integer THEN
    RAISE EXCEPTION 'encounter_log %: resolver_version % is not the job''s (%)', NEW.job_id, NEW.resolver_version, j.input->>'resolverVersion'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.content_hash IS DISTINCT FROM j.input->>'contentHash' THEN
    RAISE EXCEPTION 'encounter_log %: content_hash is not the job''s stamp', NEW.job_id USING ERRCODE = 'check_violation';
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER encounter_log_guard_insert BEFORE INSERT ON encounter_log
  FOR EACH ROW EXECUTE FUNCTION encounter_log_guard_insert();

CREATE FUNCTION encounter_log_guard_delete() RETURNS trigger AS $$
DECLARE
  r encounter_log_retention;
BEGIN
  -- A cascade from the caravan or the job (the account being removed) is not a prune.
  IF NOT EXISTS (SELECT 1 FROM caravan WHERE id = OLD.caravan_id)
     OR NOT EXISTS (SELECT 1 FROM resolution_job WHERE id = OLD.job_id) THEN
    RETURN OLD;
  END IF;
  SELECT * INTO r FROM encounter_log_retention WHERE singleton;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'encounter_log_retention is empty: no retention rule, nothing may be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.created_at >= now() - make_interval(days => r.days) THEN
    RAISE EXCEPTION 'encounter_log % is within the % day retention window: a replay leaves only through the retention prune', OLD.job_id, r.days
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.job_id IN (SELECT l.job_id FROM encounter_log l WHERE l.caravan_id = OLD.caravan_id
                     ORDER BY l.created_at DESC, l.job_id DESC LIMIT r.min_per_caravan) THEN
    RAISE EXCEPTION 'encounter_log % is among its caravan''s newest %: kept', OLD.job_id, r.min_per_caravan
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER encounter_log_guard_delete BEFORE DELETE ON encounter_log
  FOR EACH ROW EXECUTE FUNCTION encounter_log_guard_delete();

-- The retention prune for one caravan. Same rule as the delete guard (which also checks it).
CREATE FUNCTION encounter_log_prune(p_caravan uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  r encounter_log_retention;
  n integer;
BEGIN
  SELECT * INTO r FROM encounter_log_retention WHERE singleton;
  DELETE FROM encounter_log l
   WHERE l.caravan_id = p_caravan
     AND l.created_at < now() - make_interval(days => r.days)
     AND l.job_id NOT IN (SELECT k.job_id FROM encounter_log k WHERE k.caravan_id = p_caravan
                           ORDER BY k.created_at DESC, k.job_id DESC LIMIT r.min_per_caravan);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- The one writer: fenced on the caller's live lease (like resolution_job_complete), a plain
-- INSERT (the guard trigger checks the row against the job), then the caravan's prune.
CREATE FUNCTION encounter_log_write(
  p_job_id text, p_worker text, p_attempts integer,
  p_caravan uuid, p_defender uuid, p_owner uuid,
  p_resolver_version integer, p_log_format integer, p_encoding text, p_log bytea, p_raw_bytes integer,
  p_log_sha256 text, p_formation_sha256 text, p_survivors_sha256 text, p_party_sha256 text, p_content_hash text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM resolution_job
                  WHERE id = p_job_id AND status = 'leased' AND leased_by = p_worker AND attempts = p_attempts
                    AND lease_expires_at > clock_timestamp()) THEN
    RAISE EXCEPTION 'encounter_log_write %: the caller does not hold this job''s live lease (worker %, attempt %)', p_job_id, p_worker, p_attempts
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO encounter_log (job_id, caravan_id, defender_account_id, party_owner_account_id, resolver_version, log_format, encoding, log,
                             raw_bytes, stored_bytes, log_sha256, formation_sha256, survivors_sha256, party_sha256, content_hash)
  VALUES (p_job_id, p_caravan, p_defender, p_owner, p_resolver_version, p_log_format, p_encoding, p_log,
          p_raw_bytes, octet_length(p_log), p_log_sha256, p_formation_sha256, p_survivors_sha256, p_party_sha256, p_content_hash);
  RETURN encounter_log_prune(p_caravan);
END
$$;
