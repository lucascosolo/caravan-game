-- Final play-test review r2 (server side): caravan names.
--
--   N4   A new caravan's name is kept unique (case-insensitive) at creation (services/caravanNames.ts
--        uniqueCaravanName). This index makes that check an index probe instead of a scan of every
--        caravan. Not a UNIQUE index: existing databases may already hold duplicates, and the rule
--        is best effort (two creations racing on one name may both win).
--   N16  Every player's standing party is now served under its CARAVAN's name (a linked player's
--        username is no longer shown to strangers; guests' parties already were). So erasure must
--        anonymize that name too: wherever a stored menu, job or ledger payload shows the erased
--        player's party as `displayName: <caravan name>`, it becomes the generic departed name, as a
--        username always did. `account_erasure_active.names` carries the names to replace (the
--        username, if any, and every caravan name of the account); the walk replaces a displayName
--        equal to any of them, and the cross-account ledger scan looks for them too.

CREATE INDEX caravan_name_lower_idx ON caravan (lower(name));

ALTER TABLE account_erasure_active ADD COLUMN names text[] NOT NULL DEFAULT '{}';

CREATE FUNCTION account_erasure_walk_names(j jsonb, m jsonb, names text[]) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  s text;
BEGIN
  IF j IS NULL THEN RETURN NULL; END IF;
  CASE jsonb_typeof(j)
    WHEN 'object' THEN
      RETURN coalesce((
        SELECT jsonb_object_agg(
                 CASE WHEN m ? e.key THEN m ->> e.key ELSE e.key END,
                 CASE WHEN e.key = 'displayName' AND jsonb_typeof(e.value) = 'string' AND (e.value #>> '{}') = ANY (names)
                      THEN to_jsonb(public.account_erasure_display_name())
                      ELSE public.account_erasure_walk_names(e.value, m, names) END)
          FROM jsonb_each(j) e), '{}'::jsonb);
    WHEN 'array' THEN
      RETURN coalesce((SELECT jsonb_agg(public.account_erasure_walk_names(x.v, m, names) ORDER BY x.i)
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
BEGIN
  SELECT * INTO a FROM public.account_erasure_active WHERE txid = txid_current();
  IF NOT FOUND THEN RETURN j; END IF;
  RETURN public.account_erasure_walk_names(j, a.map, CASE WHEN a.username IS NULL THEN a.names ELSE a.names || a.username END);
END
$$;

-- account_erasure_core: record the caravan names with the username, and scan other accounts'
-- ledger payloads for them. Patched in place (as migration 027 did); refuses an unknown body.
DO $$
DECLARE
  def text := pg_get_functiondef('public.account_erasure_core(uuid, text)'::regprocedure);
  old_pats text := $q$IF a.username IS NOT NULL THEN pats := pats || ('%"' || a.username || '"%'); END IF;$q$;
  new_pats text := $q$IF a.username IS NOT NULL THEN pats := pats || ('%"' || a.username || '"%'); END IF;
  pats := pats || coalesce((SELECT array_agg('%"' || c.name || '"%') FROM public.caravan c WHERE c.account_id = p_account), '{}');$q$;
  old_ins text := $q$INSERT INTO public.account_erasure_active (txid, map, username) VALUES (txid_current(), m, a.username);$q$;
  new_ins text := $q$INSERT INTO public.account_erasure_active (txid, map, username, names)
    VALUES (txid_current(), m, a.username, coalesce((SELECT array_agg(c.name) FROM public.caravan c WHERE c.account_id = p_account), '{}'));$q$;
BEGIN
  IF position(old_pats IN def) = 0 OR position(old_ins IN def) = 0 THEN
    RAISE EXCEPTION 'migration 028: account_erasure_core is not the body migrations 023/027 wrote; patch it by hand';
  END IF;
  EXECUTE replace(replace(def, old_pats, new_pats), old_ins, new_ins);
END
$$;
