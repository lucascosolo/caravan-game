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

CREATE TABLE ledger_event (
  -- Global total order of the ledger. Assigned at insert; appends for one account are
  -- serialized by an advisory lock in app code so per-account seq order == commit order.
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
    OR (coalesce(jsonb_typeof(payload->'amount'), '') = 'number' AND (payload->>'amount')::numeric >= 0
        AND (payload->>'amount')::numeric = trunc((payload->>'amount')::numeric))
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

-- Live projection. The ONLY writer of account.coin_balance and of the progress numbers
-- on pool_progress is this trigger; application code appends events and reads the result.
-- The fold here must match src/ledger/projection.ts exactly (tested).
CREATE FUNCTION ledger_event_project() RETURNS trigger AS $$
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
  -- Number of leases taken so far. Fences failure bookkeeping (a stale worker's failure
  -- cannot clobber a newer lease). Completion is guarded by the row lock + status instead:
  -- first valid completion wins, since every completion is a pure function of `input`.
  attempts         integer     NOT NULL DEFAULT 0,
  max_attempts     integer     NOT NULL,
  leased_by        text,
  lease_expires_at timestamptz,
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
  )
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
