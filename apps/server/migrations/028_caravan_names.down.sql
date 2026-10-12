DO $$
DECLARE
  def text := pg_get_functiondef('public.account_erasure_core(uuid, text)'::regprocedure);
  old_pats text := $q$IF a.username IS NOT NULL THEN pats := pats || ('%"' || a.username || '"%'); END IF;
  pats := pats || coalesce((SELECT array_agg('%"' || c.name || '"%') FROM public.caravan c WHERE c.account_id = p_account), '{}');$q$;
  new_pats text := $q$IF a.username IS NOT NULL THEN pats := pats || ('%"' || a.username || '"%'); END IF;$q$;
  old_ins text := $q$INSERT INTO public.account_erasure_active (txid, map, username, names)
    VALUES (txid_current(), m, a.username, coalesce((SELECT array_agg(c.name) FROM public.caravan c WHERE c.account_id = p_account), '{}'));$q$;
  new_ins text := $q$INSERT INTO public.account_erasure_active (txid, map, username) VALUES (txid_current(), m, a.username);$q$;
BEGIN
  IF position(old_pats IN def) = 0 OR position(old_ins IN def) = 0 THEN
    RAISE EXCEPTION 'migration 028 down: account_erasure_core is not the body migration 028 wrote; patch it by hand';
  END IF;
  EXECUTE replace(replace(def, old_pats, new_pats), old_ins, new_ins);
END
$$;

-- Migration 023's rewrite.
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

DROP FUNCTION IF EXISTS account_erasure_walk_names(jsonb, jsonb, text[]);
ALTER TABLE account_erasure_active DROP COLUMN IF EXISTS names;
DROP INDEX IF EXISTS caravan_name_lower_idx;
