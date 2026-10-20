-- Migration 028's rewrite (the walk over every displayName equal to one of the account's names).
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

DROP FUNCTION IF EXISTS account_erasure_walk_owner(jsonb, jsonb, text);
DROP FUNCTION IF EXISTS resolution_job_park_other_version(text, integer, text);
