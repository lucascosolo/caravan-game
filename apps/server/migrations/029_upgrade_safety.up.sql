-- Final guardrail review, round 3.
--
--   S1  A job enqueued for another RESOLVER_VERSION is never leased by this server (the lease
--       filters on the version, migration 002), so after an upgrade that bumps the version a
--       fight committed under the old one stayed "resolving" forever. The in-process worker now
--       calls resolution_job_park_other_version() at boot and on every poll: each queued job, and
--       each leased job whose lease has EXPIRED, of any other version is parked with an explicit
--       reason, and the worker's afterParked hook voids its trip through the existing void path
--       (banked as of the last survived encounter; nothing of the unresolved fight applies). A
--       live lease is left alone: a process that still runs that version may be finishing it,
--       and it is parked once the lease expires if nothing does. Re-resolving under the new
--       version is refused by design: the formation was committed against the old rules.
--       The job guard lets a job park only from 'leased', so the function first takes a lease
--       (a new attempt, as the guard requires) in the parking worker's name and parks it at once.
--   N2  Erasure's rewrite replaces the erased player's display name only inside an object that
--       names that player as its owner (`accountId` / `ownerAccountId`): the candidate's `owner`.
--       Before, any `displayName` equal to one of the account's names was replaced, which also
--       renamed unit, ability and siege labels when a caravan was named like one ("Dust Rider"),
--       and another caravan's owner name when two caravans shared a name.

-- ── S1 ───────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION resolution_job_park_other_version(p_worker text, p_resolver_version integer, p_reason text)
RETURNS SETOF resolution_job
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  v_id  text;
  v_row resolution_job;
BEGIN
  IF p_worker IS NULL OR p_worker = '' THEN
    RAISE EXCEPTION 'resolution_job_park_other_version: worker id is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_resolver_version IS NULL THEN
    RAISE EXCEPTION 'resolution_job_park_other_version: resolver version is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_reason IS NULL OR p_reason = '' THEN
    RAISE EXCEPTION 'resolution_job_park_other_version: a reason is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  LOOP
    SELECT id INTO v_id FROM public.resolution_job
     WHERE (input->>'resolverVersion')::integer <> p_resolver_version
       AND (status = 'queued' OR (status = 'leased' AND lease_expires_at < clock_timestamp()))
     ORDER BY created_at, id
     FOR UPDATE SKIP LOCKED
     LIMIT 1;
    IF NOT FOUND THEN RETURN; END IF;
    UPDATE public.resolution_job SET attempts = attempts + 1, status = 'leased', leased_by = p_worker,
           lease_expires_at = clock_timestamp() + interval '1 minute'
     WHERE id = v_id;
    UPDATE public.resolution_job SET status = 'parked', lease_expires_at = NULL,
           last_error = left(p_reason || ' (resolver v' || (input->>'resolverVersion') || ' → v' || p_resolver_version || ')', 2000)
     WHERE id = v_id
     RETURNING * INTO v_row;
    RETURN NEXT v_row;
  END LOOP;
END
$$;

-- ── N2 ───────────────────────────────────────────────────────────────────────────────────────
CREATE FUNCTION account_erasure_walk_owner(j jsonb, m jsonb, owner_id text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s        text;
  is_owner boolean;
BEGIN
  IF j IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      is_owner := owner_id IS NOT NULL AND (
        (jsonb_typeof(j -> 'accountId') = 'string' AND j ->> 'accountId' = owner_id)
        OR (jsonb_typeof(j -> 'ownerAccountId') = 'string' AND j ->> 'ownerAccountId' = owner_id));
      RETURN coalesce((
        SELECT jsonb_object_agg(
                 CASE WHEN m ? e.key THEN m ->> e.key ELSE e.key END,
                 CASE WHEN is_owner AND e.key = 'displayName' AND jsonb_typeof(e.value) = 'string'
                      THEN to_jsonb(public.account_erasure_display_name())
                      ELSE public.account_erasure_walk_owner(e.value, m, owner_id) END)
          FROM jsonb_each(j) e), '{}'::jsonb);
    WHEN 'array' THEN
      RETURN coalesce((SELECT jsonb_agg(public.account_erasure_walk_owner(x.v, m, owner_id) ORDER BY x.i)
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

CREATE OR REPLACE FUNCTION account_erasure_rewrite(j jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  a public.account_erasure_active;
  owner_id text;
BEGIN
  SELECT * INTO a FROM public.account_erasure_active WHERE txid = txid_current();
  IF NOT FOUND THEN RETURN j; END IF;
  -- The erased account is the map's one key that maps to the tombstone ACCOUNT (its caravans map to the tombstone caravan).
  SELECT e.key INTO owner_id FROM jsonb_each_text(a.map) e WHERE e.value = public.account_erasure_tombstone_account()::text LIMIT 1;
  RETURN public.account_erasure_walk_owner(j, a.map, owner_id);
END
$$;
