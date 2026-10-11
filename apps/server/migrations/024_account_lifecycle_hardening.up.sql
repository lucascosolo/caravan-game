-- Chunk 30 QA fix round (roadmap/qa/30-punchlist.md). Number 024 is provisional (renumbered on merge).
--
--   S2  Temp-table shadowing. Postgres searches pg_temp FIRST for relations unless the search
--       path names it, so a `CREATE TEMP TABLE account_erasure_active` (or `session`) shadowed the
--       real table inside every guard and every SECURITY DEFINER function. Fixed three ways:
--         * db/roles.sql revokes TEMPORARY on the database from PUBLIC and caravan_app;
--         * EVERY function in schema public gets `search_path = pg_catalog, public, pg_temp`
--           (pg_temp LAST: a temp object can no longer shadow a public one) — set below by a
--           catalog loop, so no function is missed; a test enumerates pg_proc and fails on any
--           function (present or future) without exactly this setting;
--         * the two invoker functions the guards call name `public.account_erasure_active`.
--   S1  Sessions are issued by ONE audited path: session_issue() (SECURITY DEFINER) hashes the
--       raw token inside the database; caravan_app loses INSERT and UPDATE on `session` (it keeps
--       UPDATE of last_used_at only, and DELETE). Threat model, stated honestly: the server role
--       issues sessions, so no database check can stop a FULLY compromised server from erasing an
--       account. account_erase's token check stops a BUG from erasing the wrong account (an id
--       passed without that account's own live token is refused), and every session now comes
--       from one place.
--   S3  caravan_app loses DELETE on account and caravan (db/roles.sql): account_erase is the only
--       way an account leaves, so a stray DELETE can no longer cascade another player's replay away.
--   S4  session.last_used_at: a device's sessions are evicted least-recently-USED first, so a tab
--       in use is never the one a new tab's resume pushes out.
--   D2  account_erase(account, token, reason): 'guest_left' (a guest leaving: the account is
--       ERASED, not orphaned) and 'guest_replaced' (a new sign-in on a device that held a guest);
--       account_erase_expired_guests(limit): a guest with no live device and no live session for
--       DEVICE_TTL (180 days) is unreachable for good and is erased as 'guest_expired'.
--   N2  The candidate-menu step reads only menus whose drawn pool held the erased account's party
--       (GIN jsonb_path_ops index on encounter_candidates.pool), not every menu.

-- ---------------------------------------------------------------------------------
-- S2: the guards' exception reads only the real table
-- ---------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION account_erasure_rewrite(j jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  a public.account_erasure_active;
BEGIN
  SELECT * INTO a FROM public.account_erasure_active WHERE txid = txid_current();
  IF NOT FOUND THEN RETURN j; END IF;
  RETURN public.account_erasure_walk(j, a.map, a.username);
END
$$;

CREATE OR REPLACE FUNCTION account_erasure_permits(o jsonb, n jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.account_erasure_active WHERE txid = txid_current()) THEN RETURN false; END IF;
  RETURN o IS DISTINCT FROM n AND n = public.account_erasure_rewrite(o);
END
$$;

-- ---------------------------------------------------------------------------------
-- S1 / S4: sessions
-- ---------------------------------------------------------------------------------
ALTER TABLE session ADD COLUMN last_used_at timestamptz NOT NULL DEFAULT now();
UPDATE session SET last_used_at = created_at;

-- The one way a bearer session is created. The raw token is hashed HERE (sha256 hex, the same
-- digest src/auth/sessions.ts hashToken computes), never by the caller.
CREATE FUNCTION session_issue(p_account uuid, p_device uuid, p_token text, p_expires timestamptz) RETURNS public.session
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  a public.account;
  s public.session;
BEGIN
  SELECT * INTO a FROM public.account WHERE id = p_account;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session_issue: no account %', p_account USING ERRCODE = 'no_data_found';
  END IF;
  IF a.is_system THEN
    RAISE EXCEPTION 'session_issue: account % is a system account and cannot hold a session', p_account USING ERRCODE = 'check_violation';
  END IF;
  IF p_token IS NULL OR length(p_token) < 32 THEN
    RAISE EXCEPTION 'session_issue: a token of at least 32 characters is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_expires IS NULL OR p_expires <= now() THEN
    RAISE EXCEPTION 'session_issue: expiry must be in the future' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_device IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.device WHERE id = p_device AND account_id = p_account) THEN
    RAISE EXCEPTION 'session_issue: device % is not account %''s', p_device, p_account USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO public.session (account_id, token_hash, expires_at, device_id)
    VALUES (p_account, encode(sha256(convert_to(p_token, 'UTF8')), 'hex'), p_expires, p_device)
    RETURNING * INTO s;
  RETURN s;
END
$$;

-- ---------------------------------------------------------------------------------
-- D2 / N2: erasure reasons, the narrowed menu step
-- ---------------------------------------------------------------------------------
ALTER TABLE account_erasure_audit DROP CONSTRAINT account_erasure_audit_reason;
ALTER TABLE account_erasure_audit ADD CONSTRAINT account_erasure_audit_reason
  CHECK (reason IN ('player_request', 'guest_left', 'guest_replaced', 'guest_expired'));

CREATE INDEX encounter_candidates_pool_gin ON encounter_candidates USING gin (pool jsonb_path_ops);

DROP FUNCTION account_erase(uuid, text);

-- The erasure itself (020's body; the caller proof moved to the wrappers). NOT executable by the
-- app role: only account_erase (caller proof) and account_erase_expired_guests (unreachable
-- guests only) reach it.
CREATE FUNCTION account_erasure_core(p_account uuid, p_reason text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
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
    RAISE EXCEPTION 'account_erasure: no account %', p_account USING ERRCODE = 'no_data_found';
  END IF;
  IF a.is_system THEN
    RAISE EXCEPTION 'account_erasure: account % is a system account and is never erased', p_account USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.account_erasure_active) THEN
    RAISE EXCEPTION 'account_erasure: another erasure is active in this transaction' USING ERRCODE = 'check_violation';
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
  INSERT INTO public.account_erasure_active (txid, map, username) VALUES (txid_current(), m, a.username);

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
     -- QA-30 N2: only menus whose drawn pool held this account's party (GIN index below), not every menu.
     WHERE ec.pool @> jsonb_build_array(jsonb_build_object('ownerAccountId', p_account::text)) AND cv.account_id <> p_account
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

  INSERT INTO public.account_erasure_audit (reason, was_guest, counts) VALUES (p_reason, a.username IS NULL, counts);
  DELETE FROM public.account_erasure_active WHERE txid = txid_current();
  RETURN counts;
END
$$;


-- Caller proof: the RAW bearer token of a live session of p_account (only its hash is stored). A
-- guest_* reason is accepted only for a guest.
CREATE FUNCTION account_erase(p_account uuid, p_bearer_token text, p_reason text DEFAULT 'player_request') RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  a public.account;
BEGIN
  SELECT * INTO a FROM public.account WHERE id = p_account FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'account_erase: no account %', p_account USING ERRCODE = 'no_data_found';
  END IF;
  IF a.is_system THEN
    RAISE EXCEPTION 'account_erase: account % is a system account and is never erased', p_account USING ERRCODE = 'check_violation';
  END IF;
  IF p_reason IS NULL OR p_reason NOT IN ('player_request', 'guest_left', 'guest_replaced') THEN
    RAISE EXCEPTION 'account_erase: reason % is not one a caller may give', p_reason USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_reason <> 'player_request' AND a.username IS NOT NULL THEN
    RAISE EXCEPTION 'account_erase: % applies to a guest only', p_reason USING ERRCODE = 'check_violation';
  END IF;
  IF p_bearer_token IS NULL OR NOT EXISTS (
       SELECT 1 FROM public.session s
        WHERE s.account_id = p_account AND s.expires_at > now()
          AND s.token_hash = encode(sha256(convert_to(p_bearer_token, 'UTF8')), 'hex')) THEN
    RAISE EXCEPTION 'account_erase: no live session of account % for the token given', p_account USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN public.account_erasure_core(p_account, p_reason);
END
$$;

-- D2: guests nobody can reach any more (no live device, no live session, older than DEVICE_TTL).
-- Returns how many were erased; at most p_limit per call. For the scheduled retention job.
CREATE FUNCTION account_erase_expired_guests(p_limit integer) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  g uuid;
  n integer := 0;
BEGIN
  FOR g IN
    SELECT a.id FROM public.account a
     WHERE a.username IS NULL AND NOT a.is_system
       AND a.created_at < now() - interval '180 days'
       AND NOT EXISTS (SELECT 1 FROM public.device d WHERE d.account_id = a.id AND d.expires_at > now())
       AND NOT EXISTS (SELECT 1 FROM public.session s WHERE s.account_id = a.id AND s.expires_at > now())
     ORDER BY a.created_at, a.id
     LIMIT greatest(coalesce(p_limit, 0), 0)
  LOOP
    PERFORM public.account_erasure_core(g, 'guest_expired');
    n := n + 1;
  END LOOP;
  RETURN n;
END
$$;

REVOKE EXECUTE ON FUNCTION account_erasure_core(uuid, text) FROM PUBLIC;

-- ---------------------------------------------------------------------------------
-- S2: pin every function's search path, pg_temp last (catalog-driven: none is missed)
-- ---------------------------------------------------------------------------------
DO $$
DECLARE
  f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' LOOP
    EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public, pg_temp', f);
  END LOOP;
END
$$;
