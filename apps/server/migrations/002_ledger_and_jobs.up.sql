-- Chunk 02: the append-only event ledger and the one-shot resolution job queue.
--
-- LEDGER. Every change to Coin, Reputation, ladder progress, unlock points, roster and
-- every trip/encounter outcome is an event here. Rows are INSERT-only: UPDATE is refused
-- by trigger, DELETE is refused while the owning account still exists (a row may only
-- vanish by cascade when its account is deleted). Live balances on `account` and
-- `pool_progress` are PROJECTIONS maintained by an AFTER INSERT trigger on this table, so
-- there is no code path that can move a balance without an event to explain it. A
-- rebuild-from-zero (src/ledger/projection.ts) folds the same log in application code and
-- must agree with the live columns; the test suite asserts it does.
--
-- The account-vs-caravan split (GUARDRAILS §5) is a CHECK here too: each event type has a
-- scope, and pool-scoped events (reputation, ladder, unlock points) take their scope from
-- payload->>'pool' exactly as pool_progress does.
--
-- JOB QUEUE. `resolution_job` holds pending resolutions. Nothing ticks: a worker is
-- invoked explicitly, leases one job (SKIP LOCKED), runs its pure handler, and commits the
-- handler's events + the job's completion in ONE transaction. Job ids are deterministic
-- (derived from trip/encounter identity by the enqueuer), never random. A completed job
-- is immutable, and its `input` (the snapshotted formation + attacking party) is immutable
-- from the moment it is enqueued, so later edits by either side cannot alter history.

-- ---------------------------------------------------------------------------------
-- Ownership key (QA-02 S2)
-- ---------------------------------------------------------------------------------
-- A caravan is already unique by id; this second key lets ledger_event and resolution_job
-- reference (caravan_id, account_id) together, so an account-A row can never name a
-- caravan owned by account B. The split (GUARDRAILS §5) is then a constraint on the pair,
-- not just on each column.
ALTER TABLE caravan ADD CONSTRAINT caravan_id_account_unique UNIQUE (id, account_id);

-- ---------------------------------------------------------------------------------
-- Ledger
-- ---------------------------------------------------------------------------------
CREATE TYPE ledger_event_type AS ENUM (
  'coin_earned',
  'coin_spent',
  'coin_lost_on_wipe',
  'coin_transferred_to_defender',
  'coin_purchased',
  'reputation_changed',
  'ladder_progress_gained',
  'unlock_points_granted',
  'unlock_node_purchased',
  'unit_acquired',
  'unit_merged',
  'unit_demerged_on_death',
  'unit_lost_on_wipe',
  'trip_started',
  'stop_resolved',
  'trip_banked',
  'trip_overrun',
  'encounter_resolved',
  'formation_committed',
  'standing_party_saved',
  'party_served_as_encounter'
);

-- Which side of the split an event type lives on.
--   account : caravan_id must be NULL   (Coin, the standing party, served-party feed)
--   caravan : caravan_id must be set    (roster, trips, encounters, formations)
--   pool    : decided by payload->>'pool' (living -> caravan, trap/siege -> account)
CREATE FUNCTION ledger_event_scope(t ledger_event_type) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
    WHEN t IN ('coin_earned', 'coin_spent', 'coin_transferred_to_defender', 'coin_purchased',
               'standing_party_saved', 'party_served_as_encounter') THEN 'account'
    WHEN t IN ('reputation_changed', 'ladder_progress_gained',
               'unlock_points_granted', 'unlock_node_purchased') THEN 'pool'
    ELSE 'caravan'
  END
$$;

-- Event types that record a resolution and must therefore carry the resolver version.
CREATE FUNCTION ledger_event_is_resolution(t ledger_event_type) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT t IN ('encounter_resolved', 'stop_resolved', 'party_served_as_encounter')
$$;

-- An integer-valued JSON number (QA-02 S3). Payload numbers that the projection folds must
-- be exactly this; a string "3", a 1.5 or a missing key fails the CHECK, never the fold.
CREATE FUNCTION jsonb_is_integer(j jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT j IS NOT NULL AND jsonb_typeof(j) = 'number'
     AND (j #>> '{}')::numeric = trunc((j #>> '{}')::numeric)
$$;

CREATE TABLE ledger_event (
  -- Global total order of the ledger. Assigned at insert; appends for one account are
  -- serialized by an advisory lock in app code so per-account seq order == commit order.
  --
  -- READ AS A JS NUMBER (QA-02 N2). db/pool.ts parses every bigint column through
  -- Number(), which is exact only below 2^53. A bigserial here is deliberately read that
  -- way: at one event per millisecond, continuously, 2^53 takes ~285,000 years, so no
  -- game-lifetime ledger approaches the lossy range. If seq is ever read with BigInt
  -- precision elsewhere, read it as `seq::text`; nothing in this codebase needs to.
  seq              bigserial         PRIMARY KEY,
  event_type       ledger_event_type NOT NULL,
  account_id       uuid              NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  caravan_id       uuid              REFERENCES caravan (id) ON DELETE CASCADE,
  -- Deterministic id of whatever produced this event (a job id, or
  -- '<verb>:<deterministic key>' for request-driven writes) and the event's index within
  -- that cause. Together they are the idempotency key: a retried cause cannot re-append.
  causation_id     text              NOT NULL,
  causation_seq    integer           NOT NULL,
  -- Required on resolution events (CHECK below). The replay of an outcome is only
  -- meaningful against the resolver that produced it.
  resolver_version integer,
  payload          jsonb             NOT NULL,
  occurred_at      timestamptz       NOT NULL DEFAULT now(),
  CONSTRAINT ledger_event_causation_unique UNIQUE (causation_id, causation_seq),
  CONSTRAINT ledger_event_causation_seq_nonneg CHECK (causation_seq >= 0),
  -- QA-02 S2: when a caravan is named it must belong to this event's account.
  CONSTRAINT ledger_event_caravan_owned_by_account
    FOREIGN KEY (caravan_id, account_id) REFERENCES caravan (id, account_id) ON DELETE CASCADE,
  CONSTRAINT ledger_event_payload_is_object CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT ledger_event_scope_matches_type CHECK (
    (ledger_event_scope(event_type) = 'account' AND caravan_id IS NULL) OR
    (ledger_event_scope(event_type) = 'caravan' AND caravan_id IS NOT NULL) OR
    (ledger_event_scope(event_type) = 'pool' AND (
      (coalesce(payload->>'pool', '') = 'living'            AND caravan_id IS NOT NULL) OR
      (coalesce(payload->>'pool', '') IN ('trap', 'siege')  AND caravan_id IS NULL)
    ))
  ),
  CONSTRAINT ledger_event_resolution_has_version CHECK (
    NOT ledger_event_is_resolution(event_type) OR resolver_version IS NOT NULL
  ),
  -- Coin events carry a non-negative integer `amount`.
  CONSTRAINT ledger_event_coin_amount CHECK (
    event_type NOT IN ('coin_earned', 'coin_spent', 'coin_lost_on_wipe',
                       'coin_transferred_to_defender', 'coin_purchased')
    OR (jsonb_is_integer(payload->'amount') AND (payload->>'amount')::numeric >= 0)
  ),
  -- QA-02 S3: every number the projection folds is an integer-valued JSON number. The
  -- projection trigger below and projection.ts both cast these; without this CHECK a
  -- string delta would commit and then crash every rebuild.
  CONSTRAINT ledger_event_pool_payload_integers CHECK (
    CASE event_type
      WHEN 'reputation_changed'     THEN jsonb_is_integer(payload->'delta')
      WHEN 'ladder_progress_gained' THEN jsonb_is_integer(payload->'pointsDelta') AND jsonb_is_integer(payload->'levelsGained')
      WHEN 'unlock_points_granted'  THEN jsonb_is_integer(payload->'points')
      WHEN 'unlock_node_purchased'  THEN jsonb_is_integer(payload->'cost')
      ELSE true
    END
  )
);
CREATE INDEX ledger_event_account_seq_idx ON ledger_event (account_id, seq);
CREATE INDEX ledger_event_caravan_seq_idx ON ledger_event (caravan_id, seq) WHERE caravan_id IS NOT NULL;
CREATE INDEX ledger_event_causation_idx   ON ledger_event (causation_id);

-- Append-only: no UPDATE, ever.
CREATE FUNCTION ledger_event_guard_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_event is append-only: UPDATE refused (seq %)', OLD.seq
    USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_event_guard_update
  BEFORE UPDATE ON ledger_event FOR EACH ROW EXECUTE FUNCTION ledger_event_guard_update();

-- Append-only: no DELETE while the account exists (only its cascade may remove rows).
CREATE FUNCTION ledger_event_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE id = OLD.account_id) THEN
    RAISE EXCEPTION 'ledger_event is append-only: DELETE refused (seq %)', OLD.seq
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_event_guard_delete
  BEFORE DELETE ON ledger_event FOR EACH ROW EXECUTE FUNCTION ledger_event_guard_delete();

-- Append-only: TRUNCATE fires no row triggers, so refuse it outright (QA-02 S7). The app
-- role has no TRUNCATE privilege either (db/roles.sql); this catches the owner.
CREATE TRIGGER ledger_event_guard_truncate
  BEFORE TRUNCATE ON ledger_event FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();

-- QA-02 N1: causation_seq is contiguous from 0 within a cause, in insert order. Event i
-- can only land once event i-1 has. appendEvents inserts in array order so this never
-- fires for it; it exists so a hand-written or out-of-order insert cannot leave a gap
-- that only verifyJobReplay would notice later.
CREATE FUNCTION ledger_event_guard_causation_seq() RETURNS trigger AS $$
BEGIN
  IF NEW.causation_seq > 0 AND NOT EXISTS (
    SELECT 1 FROM ledger_event WHERE causation_id = NEW.causation_id AND causation_seq = NEW.causation_seq - 1
  ) THEN
    RAISE EXCEPTION 'ledger_event causation_seq must be contiguous: % has no seq % (cause %)',
      NEW.causation_id, NEW.causation_seq - 1, NEW.causation_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_event_guard_causation_seq
  BEFORE INSERT ON ledger_event FOR EACH ROW EXECUTE FUNCTION ledger_event_guard_causation_seq();

-- Live projection. The ONLY writer of account.coin_balance and of the progress numbers
-- on pool_progress is this trigger; application code appends events and reads the result.
-- The fold here must match src/ledger/projection.ts exactly (tested).
--
-- SECURITY DEFINER (QA-02 S1): the function runs as the table owner, so the projected
-- columns can be REVOKEd from the app role (db/roles.sql) and still move when an event is
-- appended. search_path is pinned so a definer-rights function cannot be hijacked.
CREATE FUNCTION ledger_event_project() RETURNS trigger
SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  amt bigint;
  n   integer;
BEGIN
  CASE NEW.event_type
    WHEN 'coin_earned', 'coin_purchased', 'coin_transferred_to_defender' THEN
      amt := (NEW.payload->>'amount')::bigint;
      UPDATE account SET coin_balance = coin_balance + amt WHERE id = NEW.account_id;
    WHEN 'coin_spent' THEN
      amt := (NEW.payload->>'amount')::bigint;
      UPDATE account SET coin_balance = coin_balance - amt WHERE id = NEW.account_id;
    WHEN 'reputation_changed' THEN
      n := (NEW.payload->>'delta')::integer;
      IF NEW.payload->>'pool' = 'living' THEN
        UPDATE pool_progress SET reputation = reputation + n WHERE caravan_id = NEW.caravan_id AND pool = 'living';
      ELSE
        UPDATE pool_progress SET reputation = reputation + n
          WHERE account_id = NEW.account_id AND pool = (NEW.payload->>'pool')::pool;
      END IF;
      IF NOT FOUND THEN RAISE EXCEPTION 'no pool_progress row for event (seq %)', NEW.seq USING ERRCODE = 'check_violation'; END IF;
    WHEN 'ladder_progress_gained' THEN
      IF NEW.payload->>'pool' = 'living' THEN
        UPDATE pool_progress
          SET ladder_points = ladder_points + (NEW.payload->>'pointsDelta')::integer,
              ladder_level  = ladder_level  + (NEW.payload->>'levelsGained')::integer
          WHERE caravan_id = NEW.caravan_id AND pool = 'living';
      ELSE
        UPDATE pool_progress
          SET ladder_points = ladder_points + (NEW.payload->>'pointsDelta')::integer,
              ladder_level  = ladder_level  + (NEW.payload->>'levelsGained')::integer
          WHERE account_id = NEW.account_id AND pool = (NEW.payload->>'pool')::pool;
      END IF;
      IF NOT FOUND THEN RAISE EXCEPTION 'no pool_progress row for event (seq %)', NEW.seq USING ERRCODE = 'check_violation'; END IF;
    WHEN 'unlock_points_granted' THEN
      n := (NEW.payload->>'points')::integer;
      IF NEW.payload->>'pool' = 'living' THEN
        UPDATE pool_progress SET unlock_points_granted = unlock_points_granted + n
          WHERE caravan_id = NEW.caravan_id AND pool = 'living';
      ELSE
        UPDATE pool_progress SET unlock_points_granted = unlock_points_granted + n
          WHERE account_id = NEW.account_id AND pool = (NEW.payload->>'pool')::pool;
      END IF;
      IF NOT FOUND THEN RAISE EXCEPTION 'no pool_progress row for event (seq %)', NEW.seq USING ERRCODE = 'check_violation'; END IF;
    WHEN 'unlock_node_purchased' THEN
      n := (NEW.payload->>'cost')::integer;
      IF NEW.payload->>'pool' = 'living' THEN
        UPDATE pool_progress SET unlock_points_spent = unlock_points_spent + n
          WHERE caravan_id = NEW.caravan_id AND pool = 'living';
      ELSE
        UPDATE pool_progress SET unlock_points_spent = unlock_points_spent + n
          WHERE account_id = NEW.account_id AND pool = (NEW.payload->>'pool')::pool;
      END IF;
      IF NOT FOUND THEN RAISE EXCEPTION 'no pool_progress row for event (seq %)', NEW.seq USING ERRCODE = 'check_violation'; END IF;
    ELSE
      -- Informational for the balances this chunk projects (roster/trip/encounter events
      -- are folded by later chunks' own projections, which must also be rebuildable).
      NULL;
  END CASE;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_event_project
  AFTER INSERT ON ledger_event FOR EACH ROW EXECUTE FUNCTION ledger_event_project();

-- Projection checkpoints: purely a perf knob (LEDGER_SNAPSHOT_INTERVAL). A snapshot is
-- the folded state through `through_seq`; a rebuild may start from it instead of zero.
-- Written only under the same per-account append lock, so it is exact.
CREATE TABLE ledger_snapshot (
  account_id  uuid        NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  through_seq bigint      NOT NULL,
  state       jsonb       NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, through_seq)
);

-- Insert-only (QA-02 S7): a snapshot is a derived fact about the log through a seq, and
-- the log never changes, so neither does the snapshot. verifyProjection checks the latest
-- snapshot against a from-zero fold through its seq, so a tampered snapshot is a finding,
-- never a silently different starting point. Rows leave only by account cascade.
CREATE FUNCTION ledger_snapshot_guard_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ledger_snapshot is insert-only: UPDATE refused (account %, through_seq %)',
    OLD.account_id, OLD.through_seq USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_snapshot_guard_update
  BEFORE UPDATE ON ledger_snapshot FOR EACH ROW EXECUTE FUNCTION ledger_snapshot_guard_update();
CREATE FUNCTION ledger_snapshot_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE id = OLD.account_id) THEN
    RAISE EXCEPTION 'ledger_snapshot is insert-only: DELETE refused (account %, through_seq %)',
      OLD.account_id, OLD.through_seq USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER ledger_snapshot_guard_delete
  BEFORE DELETE ON ledger_snapshot FOR EACH ROW EXECUTE FUNCTION ledger_snapshot_guard_delete();
CREATE TRIGGER ledger_snapshot_guard_truncate
  BEFORE TRUNCATE ON ledger_snapshot FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();

-- ---------------------------------------------------------------------------------
-- Job queue
-- ---------------------------------------------------------------------------------
CREATE TYPE job_status AS ENUM ('queued', 'leased', 'completed', 'parked');

CREATE TABLE resolution_job (
  -- Deterministic, derived from what the job resolves (e.g. encounter:<trip>:<n>).
  id               text        PRIMARY KEY,
  kind             text        NOT NULL,
  -- The defending side: the player who is actually present. Both NOT NULL — a job is
  -- always about one caravan's encounter, and the caravan's advisory lock serializes it.
  account_id       uuid        NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  caravan_id       uuid        NOT NULL REFERENCES caravan (id) ON DELETE CASCADE,
  -- Everything the handler needs, snapshotted at enqueue. Immutable (trigger).
  input            jsonb       NOT NULL,
  status           job_status  NOT NULL DEFAULT 'queued',
  -- Number of leases taken so far. Together with leased_by it is the completion FENCE
  -- (QA-02 B1): a commit lands only while the row is 'leased' to this worker, at this
  -- attempt number, with the lease not yet expired. A stale worker (its lease expired or
  -- re-leased) loses cleanly: its transaction is rolled back and nothing is written.
  attempts         integer     NOT NULL DEFAULT 0,
  max_attempts     integer     NOT NULL,
  leased_by        text,
  lease_expires_at timestamptz,
  -- QA-02 N3: a failed attempt re-queues with exponential backoff rather than at the head
  -- of the queue. A queued job is ready only once this has passed.
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  result           jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  CONSTRAINT resolution_job_input_is_object   CHECK (jsonb_typeof(input) = 'object'),
  CONSTRAINT resolution_job_max_attempts_pos  CHECK (max_attempts > 0),
  CONSTRAINT resolution_job_attempts_nonneg   CHECK (attempts >= 0),
  CONSTRAINT resolution_job_completed_shape   CHECK (
    (status = 'completed') = (result IS NOT NULL AND completed_at IS NOT NULL)
  ),
  CONSTRAINT resolution_job_leased_shape      CHECK (
    status <> 'leased' OR lease_expires_at IS NOT NULL
  ),
  -- QA-02 S2: the job's caravan belongs to the job's (defending) account.
  CONSTRAINT resolution_job_caravan_owned_by_account
    FOREIGN KEY (caravan_id, account_id) REFERENCES caravan (id, account_id) ON DELETE CASCADE
);
CREATE INDEX resolution_job_ready_idx ON resolution_job (created_at, id) WHERE status IN ('queued', 'leased');
CREATE INDEX resolution_job_caravan_idx ON resolution_job (caravan_id);

CREATE FUNCTION resolution_job_guard() RETURNS trigger AS $$
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
  -- Parked is terminal for workers (QA-02 B1): only the operator path (requeueParkedJob)
  -- moves a parked job, and it goes back to 'queued', never straight to 'completed'.
  IF OLD.status = 'parked' AND NEW.status <> 'queued' THEN
    RAISE EXCEPTION 'resolution_job % is parked: it can only be re-queued by an operator', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'resolution_job.attempts never decreases (job %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER resolution_job_guard
  BEFORE UPDATE ON resolution_job FOR EACH ROW EXECUTE FUNCTION resolution_job_guard();

CREATE FUNCTION resolution_job_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE id = OLD.account_id) THEN
    RAISE EXCEPTION 'resolution_job rows are permanent while their account exists (job %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER resolution_job_guard_delete
  BEFORE DELETE ON resolution_job FOR EACH ROW EXECUTE FUNCTION resolution_job_guard_delete();
CREATE TRIGGER resolution_job_guard_truncate
  BEFORE TRUNCATE ON resolution_job FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();
