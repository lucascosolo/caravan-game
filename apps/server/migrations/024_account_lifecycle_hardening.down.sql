-- Chunk 30 QA fix round, down. The audit is append-only, so guest_* rows written under 024 stay:
-- 020's reason CHECK comes back NOT VALID (enforced for new rows, existing ones kept).

DROP FUNCTION IF EXISTS account_erase_expired_guests(integer);
DROP FUNCTION IF EXISTS account_erase(uuid, text, text);
DROP FUNCTION IF EXISTS account_erasure_core(uuid, text);
DROP FUNCTION IF EXISTS session_issue(uuid, uuid, text, timestamptz);
DROP INDEX IF EXISTS encounter_candidates_pool_gin;
ALTER TABLE account_erasure_audit DROP CONSTRAINT account_erasure_audit_reason;
ALTER TABLE account_erasure_audit ADD CONSTRAINT account_erasure_audit_reason CHECK (reason IN ('player_request')) NOT VALID;
ALTER TABLE session DROP COLUMN IF EXISTS last_used_at;

CREATE OR REPLACE FUNCTION account_erasure_rewrite(j jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
  a account_erasure_active;
BEGIN
  SELECT * INTO a FROM account_erasure_active WHERE txid = txid_current();
  IF NOT FOUND THEN RETURN j; END IF;
  RETURN account_erasure_walk(j, a.map, a.username);
END
$$;

CREATE OR REPLACE FUNCTION account_erasure_permits(o jsonb, n jsonb) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM account_erasure_active WHERE txid = txid_current()) THEN RETURN false; END IF;
  RETURN o IS DISTINCT FROM n AND n = account_erasure_rewrite(o);
END
$$;

-- 020's account_erase, verbatim.
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


-- Search paths as before 024: the definers' `pg_catalog, public`, nothing on the rest.
DO $$
DECLARE
  f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS sig, p.prosecdef FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' LOOP
    IF f.prosecdef THEN
      EXECUTE format('ALTER FUNCTION %s SET search_path = pg_catalog, public', f.sig);
    ELSE
      EXECUTE format('ALTER FUNCTION %s RESET search_path', f.sig);
    END IF;
  END LOOP;
END
$$;
