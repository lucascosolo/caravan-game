-- Chunk 30: account lifecycle (PHASE-2 §30, play-test cut: no Apple / Google sign-in yet).
--
--   GUEST-FIRST. account.username and account.password_hash become nullable together: a
--   guest is an ordinary account row with neither, created silently on first launch. Linking
--   sets both once (account_guard_identity): the id never changes, nothing is migrated, and a
--   linked username is permanent (no unlink, no rename). linked_at records when.
--
--   DEVICES. Every sign-in (guest creation, registration, login) creates a `device`: a
--   long-lived credential whose raw value only ever lives in an HttpOnly cookie, stored here
--   hashed. A reload trades it for a fresh bearer `session` (POST /auth/resume). The device
--   list a player sees is this table; revoking a device deletes it and, by cascade, every
--   bearer session it issued. Sessions that existed before this migration are backfilled
--   one device each, with a token hash no cookie can ever match ('legacy:<id>').
--
--   ERASURE. account_erase(account) (SECURITY DEFINER) is the ONE path that deletes a player
--   account while other players' records name it. It deletes the account, its caravans,
--   its party, its purchases and its own ledger rows (the existing cascades), and
--   ANONYMIZES — never deletes — the records it shares with another player:
--     * a fight it defended against another player's party: the resolution job, its stored
--       replay (encounter_log) and the account's own non-projecting record of that fight
--       (encounter_resolved) are re-pointed to the shared tombstone account / caravan;
--     * a fight its party struck against another player's caravan: the job input / result,
--       the replay's party_owner_account_id, and its party_served_as_encounter record are
--       re-pointed to the tombstone;
--     * every other account's ledger payload, trip_encounter row and stored candidate menu
--       that names it: the account id and its caravan ids become the tombstone's, and the
--       username shown as a candidate's displayName becomes ERASED_DISPLAY_NAME.
--   The rewrite is a closed rule (account_erasure_walk): exact JSON string values equal to
--   an erased id (and object keys) are mapped, and a `displayName` equal to the erased
--   username is replaced. Nothing else in any row may change.
--
--   HOW THE IMMUTABILITY GUARDS ALLOW IT. The guards of ledger_event, resolution_job,
--   encounter_log, trip_encounter and encounter_candidates are redefined with one extra first
--   test, account_erasure_permits(OLD, NEW): true only while an erasure is ACTIVE in the
--   current transaction (a row in account_erasure_active for txid_current(), which only
--   account_erase writes and removes before it returns — the app role has no INSERT, UPDATE
--   or DELETE on it, db/roles.sql) AND the new row is exactly the rewrite of the old one.
--   Every other update is judged by the guard's original body, unchanged.
--
--   The tombstone (fixed ids below) is a system account (is_system: no login, no Coin, no
--   standing party, never served) owning one caravan. It is created lazily by account_erase,
--   so a test suite that empties `account` loses nothing it needs. Every account's erasure
--   is recorded in account_erasure_audit — when, whether it was a guest, and how many rows
--   of each kind were anonymized or removed; never the erased id or username.

-- ---------------------------------------------------------------------------------
-- Guest-first identity
-- ---------------------------------------------------------------------------------
ALTER TABLE account
  ALTER COLUMN username DROP NOT NULL,
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD COLUMN linked_at timestamptz;
UPDATE account SET linked_at = created_at WHERE username IS NOT NULL;
ALTER TABLE account
  ADD CONSTRAINT account_credentials_together CHECK ((username IS NULL) = (password_hash IS NULL)),
  ADD CONSTRAINT account_linked_at_matches CHECK ((username IS NULL) = (linked_at IS NULL));

CREATE FUNCTION account_guard_identity() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION 'account %: the id is immutable (linking keeps it)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.username IS NOT NULL AND NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'account %: a linked username is permanent (no unlink, no rename)', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.username IS NULL AND NEW.username IS NOT NULL THEN
    IF OLD.is_system THEN
      RAISE EXCEPTION 'account %: a system account cannot be linked to a login', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    NEW.linked_at := now();
  ELSIF NEW.linked_at IS DISTINCT FROM OLD.linked_at THEN
    RAISE EXCEPTION 'account %: linked_at is set once, by linking', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER account_guard_identity BEFORE UPDATE ON account FOR EACH ROW EXECUTE FUNCTION account_guard_identity();

-- An account created WITH a login (registration, the seed) is linked from birth.
CREATE FUNCTION account_stamp_linked() RETURNS trigger AS $$
BEGIN
  NEW.linked_at := CASE WHEN NEW.username IS NULL THEN NULL ELSE now() END;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER account_stamp_linked BEFORE INSERT ON account FOR EACH ROW EXECUTE FUNCTION account_stamp_linked();

-- ---------------------------------------------------------------------------------
-- Devices
-- ---------------------------------------------------------------------------------
CREATE TABLE device (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid        NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  -- sha256 (hex) of the cookie value. The raw value is never stored.
  token_hash   text        NOT NULL,
  -- A short, player-readable description derived from the User-Agent ("Firefox on Android").
  label        text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  -- Sliding: every resume moves it DEVICE_TTL forward.
  expires_at   timestamptz NOT NULL,
  CONSTRAINT device_token_hash_unique UNIQUE (token_hash),
  CONSTRAINT device_label_length CHECK (length(label) BETWEEN 1 AND 120)
);
CREATE INDEX device_account_idx ON device (account_id, last_seen_at DESC);

ALTER TABLE session ADD COLUMN device_id uuid REFERENCES device (id) ON DELETE CASCADE;
INSERT INTO device (id, account_id, token_hash, label, created_at, last_seen_at, expires_at)
  SELECT s.id, s.account_id, 'legacy:' || s.id::text, 'Earlier sign-in', s.created_at, s.created_at, s.expires_at FROM session s;
UPDATE session SET device_id = id;
ALTER TABLE session ALTER COLUMN device_id SET NOT NULL;
CREATE INDEX session_device_idx ON session (device_id);

-- Every session belongs to a device. A session inserted without one (a script, a fixture)
-- gets a device of its own whose token hash no cookie can match ('bare:<session id>').
CREATE FUNCTION session_ensure_device() RETURNS trigger AS $$
BEGIN
  IF NEW.device_id IS NULL THEN
    INSERT INTO device (account_id, token_hash, label, created_at, last_seen_at, expires_at)
      VALUES (NEW.account_id, 'bare:' || NEW.id::text, 'Signed-in session', now(), now(), NEW.expires_at)
      RETURNING id INTO NEW.device_id;
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER session_ensure_device BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION session_ensure_device();

-- ---------------------------------------------------------------------------------
-- Erasure: bookkeeping
-- ---------------------------------------------------------------------------------
-- At most one row, and only inside account_erase's own transaction (it deletes it before
-- returning). `map`: erased id (text) -> tombstone id; `username`: the erased handle, if linked.
CREATE TABLE account_erasure_active (
  txid      bigint PRIMARY KEY,
  map       jsonb  NOT NULL,
  username  text,
  CONSTRAINT account_erasure_active_map_is_object CHECK (jsonb_typeof(map) = 'object')
);

CREATE TABLE account_erasure_audit (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  erased_at  timestamptz NOT NULL DEFAULT now(),
  reason     text        NOT NULL,
  was_guest  boolean     NOT NULL,
  counts     jsonb       NOT NULL,
  CONSTRAINT account_erasure_audit_reason CHECK (reason IN ('player_request')),
  CONSTRAINT account_erasure_audit_counts_is_object CHECK (jsonb_typeof(counts) = 'object')
);
CREATE FUNCTION account_erasure_audit_guard() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'account_erasure_audit is append-only' USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER account_erasure_audit_guard BEFORE UPDATE OR DELETE ON account_erasure_audit
  FOR EACH ROW EXECUTE FUNCTION account_erasure_audit_guard();
CREATE TRIGGER account_erasure_audit_guard_truncate BEFORE TRUNCATE ON account_erasure_audit
  FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();

-- The tombstone's fixed ids and the name a candidate menu shows for an erased owner.
CREATE FUNCTION account_erasure_tombstone_account() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '00000000-0000-4000-8000-0000000000d0'::uuid $$;
CREATE FUNCTION account_erasure_tombstone_caravan() RETURNS uuid LANGUAGE sql IMMUTABLE AS $$ SELECT '00000000-0000-4000-8000-0000000000d1'::uuid $$;
CREATE FUNCTION account_erasure_display_name() RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT 'Departed outfit'::text $$;

-- The rewrite rule. Pure: exact string values (and object keys) found in `m` are mapped; a
-- `displayName` equal to `uname` becomes the erased display name. Everything else is kept.
CREATE FUNCTION account_erasure_walk(j jsonb, m jsonb, uname text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  s text;
BEGIN
  IF j IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      RETURN coalesce((
        SELECT jsonb_object_agg(
                 CASE WHEN m ? e.key THEN m ->> e.key ELSE e.key END,
                 CASE WHEN e.key = 'displayName' AND uname IS NOT NULL AND e.value = to_jsonb(uname)
                      THEN to_jsonb(account_erasure_display_name())
                      ELSE account_erasure_walk(e.value, m, uname) END)
          FROM jsonb_each(j) e), '{}'::jsonb);
    WHEN 'array' THEN
      RETURN coalesce((SELECT jsonb_agg(account_erasure_walk(x.v, m, uname) ORDER BY x.i)
                         FROM jsonb_array_elements(j) WITH ORDINALITY AS x(v, i)), '[]'::jsonb);
    WHEN 'string' THEN
      s := j #>> '{}';
      IF m ? s THEN RETURN m -> s; END IF;
      RETURN j;
    ELSE
      RETURN j;
  END CASE;
END
$$;

-- The rewrite under the erasure active in THIS transaction (identity when there is none).
CREATE FUNCTION account_erasure_rewrite(j jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  a account_erasure_active;
BEGIN
  SELECT * INTO a FROM account_erasure_active WHERE txid = txid_current();
  IF NOT FOUND THEN RETURN j; END IF;
  RETURN account_erasure_walk(j, a.map, a.username);
END
$$;

-- The guards' one exception: an erasure is active in this transaction, the row changed, and
-- the new row is exactly the rewrite of the old one.
CREATE FUNCTION account_erasure_permits(o jsonb, n jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM account_erasure_active WHERE txid = txid_current()) THEN RETURN false; END IF;
  RETURN o IS DISTINCT FROM n AND n = account_erasure_rewrite(o);
END
$$;

-- ---------------------------------------------------------------------------------
-- The immutability guards, each with the erasure exception first (bodies otherwise as before)
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_event_guard_update() RETURNS trigger AS $$
BEGIN
  IF account_erasure_permits(to_jsonb(OLD), to_jsonb(NEW)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'ledger_event is append-only: UPDATE refused (seq %)', OLD.seq
    USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION encounter_log_guard_update() RETURNS trigger AS $$
BEGIN
  IF account_erasure_permits(to_jsonb(OLD), to_jsonb(NEW)) THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'encounter_log % is immutable: a replay is never rewritten', OLD.job_id USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION resolution_job_guard() RETURNS trigger AS $$
BEGIN
  IF account_erasure_permits(to_jsonb(OLD), to_jsonb(NEW)) THEN RETURN NEW; END IF;
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
  IF account_erasure_permits(to_jsonb(OLD), to_jsonb(NEW)) THEN RETURN NEW; END IF;
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
  IF account_erasure_permits(to_jsonb(OLD), to_jsonb(NEW)) THEN RETURN NEW; END IF;
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

-- ---------------------------------------------------------------------------------
-- account_erase: the one audited path
-- ---------------------------------------------------------------------------------
-- PROOF OF THE CALLER. p_bearer_token is the RAW bearer token of a live session of p_account.
-- The database stores only sha256(token) (session.token_hash). What this guarantees (corrected
-- in QA-30 S1, see migration 023): a BUG passing the wrong account id is refused, since it has no
-- live token of that account. It does NOT stop a fully compromised server, which issues sessions.
-- A wrong or expired token, or another account's, is refused (42501) before anything is touched.
CREATE FUNCTION account_erase(p_account uuid, p_bearer_token text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  a          account;
  t_acct     uuid := account_erasure_tombstone_account();
  t_car      uuid := account_erasure_tombstone_caravan();
  m          jsonb;
  ids        text[];
  pats       text[];
  defended   text[];
  struck     text[];
  n          integer;
  counts     jsonb := '{}'::jsonb;
BEGIN
  SELECT * INTO a FROM account WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_erase: no account %', p_account USING ERRCODE = 'no_data_found';
  END IF;
  IF a.is_system THEN
    RAISE EXCEPTION 'account_erase: account % is a system account and is never erased', p_account USING ERRCODE = 'check_violation';
  END IF;
  IF p_bearer_token IS NULL OR NOT EXISTS (
       SELECT 1 FROM session s
        WHERE s.account_id = p_account AND s.expires_at > now()
          AND s.token_hash = encode(sha256(convert_to(p_bearer_token, 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'account_erase: no live session of account % for the token given', p_account USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM account_erasure_active) THEN
    RAISE EXCEPTION 'account_erase: another erasure is active in this transaction' USING ERRCODE = 'check_violation';
  END IF;

  -- The tombstone (lazily; a fixed id so concurrent erasures converge on one).
  INSERT INTO account (id, username, password_hash, coin_storage_cap, is_system)
    VALUES (t_acct, NULL, NULL, 1, true) ON CONFLICT (id) DO NOTHING;
  INSERT INTO caravan (id, account_id, region_id, name)
    VALUES (t_car, t_acct, (SELECT id FROM region ORDER BY id LIMIT 1), 'Departed caravan') ON CONFLICT (id) DO NOTHING;
  -- Progress rows like any account's, so a queued fight against an erased party still settles
  -- (as a system owner: the party side is skipped, never credited). They never move.
  INSERT INTO pool_progress (pool, account_id, reputation) VALUES ('trap', t_acct, 0), ('siege', t_acct, 0) ON CONFLICT DO NOTHING;
  INSERT INTO pool_progress (pool, caravan_id, reputation) VALUES ('living', t_car, 0) ON CONFLICT DO NOTHING;

  m := jsonb_build_object(p_account::text, t_acct::text)
       || coalesce((SELECT jsonb_object_agg(c.id::text, t_car::text) FROM caravan c WHERE c.account_id = p_account), '{}'::jsonb);
  SELECT array_agg(k) INTO ids FROM jsonb_object_keys(m) k;
  pats := (SELECT array_agg('%' || k || '%') FROM unnest(ids) k);
  IF a.username IS NOT NULL THEN pats := pats || ('%"' || a.username || '"%'); END IF;
  INSERT INTO account_erasure_active (txid, map, username) VALUES (txid_current(), m, a.username);

  -- 1. Fights this account DEFENDED against another player's party: theirs too, so kept and
  --    re-pointed to the tombstone. (Fights against authored parties, unfinished ones and
  --    ones whose owner is already gone have no other participant: they go with the caravan.)
  SELECT coalesce(array_agg(j.id), '{}') INTO defended FROM resolution_job j
   WHERE j.account_id = p_account AND j.kind = 'encounter_resolution' AND j.status = 'completed'
     AND EXISTS (SELECT 1 FROM account o WHERE o.id::text = j.input->>'partyOwnerAccountId' AND o.id <> p_account AND NOT o.is_system);
  UPDATE resolution_job SET account_id = t_acct, caravan_id = t_car,
         input = account_erasure_rewrite(input), result = account_erasure_rewrite(result)
   WHERE id = ANY(defended);
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('fightsDefendedKept', n);
  UPDATE encounter_log SET caravan_id = t_car, defender_account_id = t_acct WHERE job_id = ANY(defended);
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('replaysDefendedAnonymized', n);

  -- 2. Fights this account's PARTY struck: the other player's caravan's record, any status.
  SELECT coalesce(array_agg(j.id), '{}') INTO struck FROM resolution_job j
   WHERE j.kind = 'encounter_resolution' AND j.account_id <> p_account AND j.input->>'partyOwnerAccountId' = p_account::text;
  UPDATE resolution_job SET input = account_erasure_rewrite(input), result = account_erasure_rewrite(result)
   WHERE id = ANY(struck);
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('fightsStruckAnonymized', n);
  UPDATE encounter_log SET party_owner_account_id = t_acct WHERE party_owner_account_id = p_account AND defender_account_id <> p_account;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('replaysStruckAnonymized', n);

  -- 3. This account's own record OF a kept fight (non-projecting: it moves no balance) joins
  --    the tombstone, so the job's events stay contiguous and verifyJobReplay still holds.
  UPDATE ledger_event SET account_id = t_acct, caravan_id = CASE WHEN caravan_id IS NULL THEN NULL ELSE t_car END,
         payload = account_erasure_rewrite(payload)
   WHERE account_id = p_account AND causation_id = ANY(defended || struck)
     AND event_type IN ('encounter_resolved', 'party_served_as_encounter', 'stop_resolved');
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('ownFightRecordsAnonymized', n);

  -- 4. Every other account's ledger payloads that name this account.
  WITH c AS (
    SELECT seq, account_erasure_rewrite(payload) AS np FROM ledger_event
     WHERE account_id <> p_account AND payload::text LIKE ANY (pats)
  )
  UPDATE ledger_event e SET payload = c.np FROM c WHERE e.seq = c.seq AND c.np IS DISTINCT FROM e.payload;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('otherLedgerRowsAnonymized', n);

  -- 5. Other players' trips that met this account's party, and their stored candidate menus.
  UPDATE trip_encounter SET party_owner_account_id = t_acct WHERE party_owner_account_id = p_account;
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('tripEncountersAnonymized', n);
  WITH c AS (
    SELECT ec.trip_id, ec.encounter_index, ec.search_seq FROM encounter_candidates ec
      JOIN trip t ON t.id = ec.trip_id
      JOIN caravan cv ON cv.id = t.caravan_id
     WHERE cv.account_id <> p_account AND to_jsonb(ec)::text LIKE ANY (pats)
  )
  UPDATE encounter_candidates ec SET
         pool = account_erasure_rewrite(ec.pool),
         excluded_party_ids = account_erasure_rewrite(ec.excluded_party_ids),
         skipped_party_ids = account_erasure_rewrite(ec.skipped_party_ids),
         candidates = account_erasure_rewrite(ec.candidates),
         authored_served = account_erasure_rewrite(ec.authored_served),
         draw_rules = account_erasure_rewrite(ec.draw_rules)
    FROM c
   WHERE ec.trip_id = c.trip_id AND ec.encounter_index = c.encounter_index AND ec.search_seq = c.search_seq
     AND to_jsonb(ec) IS DISTINCT FROM account_erasure_rewrite(to_jsonb(ec));
  GET DIAGNOSTICS n = ROW_COUNT; counts := counts || jsonb_build_object('candidateMenusAnonymized', n);

  -- 6. Delete. Caravans, party, purchases, cosmetics, sessions, devices, the account's own
  --    ledger rows and snapshots, its trips and its unshared jobs and replays all cascade
  --    through their delete guards (which allow exactly this: the owner is gone).
  SELECT count(*) INTO n FROM ledger_event WHERE account_id = p_account;
  counts := counts || jsonb_build_object('ownLedgerRowsDeleted', n);
  SELECT count(*) INTO n FROM pack_purchase WHERE account_id = p_account;
  counts := counts || jsonb_build_object('purchasesDeleted', n);
  SELECT count(*) INTO n FROM caravan WHERE account_id = p_account;
  counts := counts || jsonb_build_object('caravansDeleted', n);
  DELETE FROM account WHERE id = p_account;

  INSERT INTO account_erasure_audit (reason, was_guest, counts) VALUES ('player_request', a.username IS NULL, counts);
  DELETE FROM account_erasure_active WHERE txid = txid_current();
  RETURN counts;
END
$$;
