-- Chunk 20: monetization packs (sandboxed) and the minimal cosmetics system (PHASE-2 §28).
--
-- Everything here is ACCOUNT-level (GUARDRAILS §5) and NOTHING here is reachable from a
-- resolution: no table in this file is referenced by resolution_job, wagon_formation,
-- wagon_manifest, standing_party, trip or encounter_candidates, and no column of theirs
-- references anything here (a test asserts the foreign-key graph). The resolver cannot
-- import the server at all (scripts/resolver-boundary-check.mjs); the only link between a
-- purchase and play is the Coin it credits, which lands through the ledger's ordinary
-- `coin_purchased` event, clamped to the same storage cap as earned Coin.
--
--   pack_purchase       One row per (account, rotation week, tier). The UNIQUE constraint IS
--                       the purchase limit (GUARDRAILS §2: each tier once per week, tiers
--                       stackable across each other) — two racing purchases of the same tier
--                       cannot both commit, whatever the application does. `contents` is the
--                       exact previewed list that was granted, and a CHECK refuses any
--                       content kind but 'coin' and 'cosmetic': a pack cannot hold unlock
--                       points, unit access, trip-cap uses, slot count, fence material,
--                       repairs, resupply or matchmaking rerolls, by schema. `backend` is
--                       CHECKed to the sandbox stub: no real charge exists anywhere in this
--                       codebase, and wiring a real one means a migration a reviewer sees.
--                       Rows are immutable and leave only with their account.
--   cosmetic_ownership  Account-level ownership of a cosmetic by id (the catalog lives in
--                       @caravan/content). EVERY row names the purchase it came from (NOT
--                       NULL): in v1 no cosmetic is earned from a fight outcome or anything
--                       else, and the schema says so.
--   cosmetic_equip      The equip preference: one cosmetic per slot per account. The FK to
--                       cosmetic_ownership means only an owned cosmetic can be equipped.
--                       A preference, nothing more: no formation, manifest, party or job
--                       row references it, and the resolver's input types cannot carry it
--                       (packages/circle/test/no-cosmetic-field.test.ts).

-- The only two things a pack may contain (TUNABLES.PACK_CONTENT_KINDS, fixed by design).
-- A 'coin' entry is {kind, amount: non-negative integer}; a 'cosmetic' entry is
-- {kind, cosmeticId: text}. Exactly those keys, nothing else, no other kind.
CREATE FUNCTION pack_contents_ok(c jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT jsonb_typeof(c) = 'array'
     AND jsonb_array_length(c) >= 1
     AND NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(c) AS e
       WHERE jsonb_typeof(e) <> 'object'
          OR NOT (
               (e->>'kind' = 'coin'
                  AND jsonb_is_integer(e->'amount')
                  AND (e->>'amount')::bigint >= 0
                  AND (SELECT count(*) FROM jsonb_object_keys(e)) = 2)
            OR (e->>'kind' = 'cosmetic'
                  AND jsonb_typeof(e->'cosmeticId') = 'string'
                  AND length(e->>'cosmeticId') > 0
                  AND (SELECT count(*) FROM jsonb_object_keys(e)) = 2)
          )
     )
$$;

-- ---------------------------------------------------------------------------------
CREATE TABLE pack_purchase (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid        NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  -- The rotation week the offer belonged to (TUNABLES.PACK_ROTATION_EPOCH_MS + n periods).
  week_index      integer     NOT NULL,
  tier            smallint    NOT NULL,
  -- LOUD: the only backend this schema admits is the MVP stub that charges nothing.
  backend         text        NOT NULL,
  sandbox_receipt text        NOT NULL,
  price_cents     integer     NOT NULL,
  -- The exact contents granted: what was previewed (GUARDRAILS §4), CHECKed to Coin + cosmetics only.
  contents        jsonb       NOT NULL,
  -- Coin: requested = the tier's fixed amount; credited + discarded = requested (cap clamp).
  coin_requested  bigint      NOT NULL,
  coin_credited   bigint      NOT NULL,
  coin_discarded  bigint      NOT NULL,
  -- The ledger causation id of the `coin_purchased` event: `pack:<account>:w<week>:t<tier>`.
  causation_id    text        NOT NULL,
  purchased_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pack_purchase_tier_range        CHECK (tier BETWEEN 1 AND 3),
  CONSTRAINT pack_purchase_backend_sandbox   CHECK (backend = 'sandbox_stub'),
  CONSTRAINT pack_purchase_price_positive    CHECK (price_cents > 0),
  CONSTRAINT pack_purchase_contents_kinds    CHECK (pack_contents_ok(contents)),
  CONSTRAINT pack_purchase_coin_nonneg       CHECK (coin_requested >= 0 AND coin_credited >= 0 AND coin_discarded >= 0),
  CONSTRAINT pack_purchase_coin_accounted    CHECK (coin_credited + coin_discarded = coin_requested),
  CONSTRAINT pack_purchase_causation_unique  UNIQUE (causation_id),
  -- THE purchase limit: one of each tier per week per account (TUNABLES.PURCHASE_LIMIT_PER_TIER_PER_WEEK = 1).
  CONSTRAINT pack_purchase_once_per_tier_per_week UNIQUE (account_id, week_index, tier)
);
CREATE INDEX pack_purchase_account_idx ON pack_purchase (account_id, purchased_at);

CREATE FUNCTION pack_purchase_guard_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'pack_purchase % is a record and may not be updated', OLD.id USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER pack_purchase_guard_update BEFORE UPDATE ON pack_purchase FOR EACH ROW EXECUTE FUNCTION pack_purchase_guard_update();

CREATE FUNCTION pack_purchase_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE id = OLD.account_id) THEN
    RAISE EXCEPTION 'pack_purchase % is a record and may not be deleted while its account exists', OLD.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER pack_purchase_guard_delete BEFORE DELETE ON pack_purchase FOR EACH ROW EXECUTE FUNCTION pack_purchase_guard_delete();
CREATE TRIGGER pack_purchase_guard_truncate BEFORE TRUNCATE ON pack_purchase FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();

-- ---------------------------------------------------------------------------------
CREATE TABLE cosmetic_ownership (
  account_id  uuid        NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  cosmetic_id text        NOT NULL,
  kind        text        NOT NULL,
  -- v1: a cosmetic comes from a pack and from nothing else.
  purchase_id uuid        NOT NULL REFERENCES pack_purchase (id) ON DELETE CASCADE,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, cosmetic_id),
  CONSTRAINT cosmetic_ownership_kind CHECK (kind IN ('unit_skin', 'wagon_skin', 'fence_style', 'town_decoration', 'party_banner')),
  CONSTRAINT cosmetic_ownership_id_nonempty CHECK (length(cosmetic_id) > 0)
);
CREATE INDEX cosmetic_ownership_purchase_idx ON cosmetic_ownership (purchase_id);

CREATE FUNCTION cosmetic_ownership_guard_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'cosmetic_ownership (% / %) is permanent and may not be updated', OLD.account_id, OLD.cosmetic_id USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER cosmetic_ownership_guard_update BEFORE UPDATE ON cosmetic_ownership FOR EACH ROW EXECUTE FUNCTION cosmetic_ownership_guard_update();

CREATE FUNCTION cosmetic_ownership_guard_delete() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM account WHERE id = OLD.account_id) THEN
    RAISE EXCEPTION 'cosmetic_ownership (% / %) is permanent while its account exists', OLD.account_id, OLD.cosmetic_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER cosmetic_ownership_guard_delete BEFORE DELETE ON cosmetic_ownership FOR EACH ROW EXECUTE FUNCTION cosmetic_ownership_guard_delete();
CREATE TRIGGER cosmetic_ownership_guard_truncate BEFORE TRUNCATE ON cosmetic_ownership FOR EACH STATEMENT EXECUTE FUNCTION guard_refuse_truncate();

-- ---------------------------------------------------------------------------------
-- The equip preference. Freely changed and cleared by its owner; a slot is `unit_skin:<unit
-- type id>` for a unit skin and the kind name for every other kind.
CREATE TABLE cosmetic_equip (
  account_id  uuid        NOT NULL,
  slot        text        NOT NULL,
  cosmetic_id text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, slot),
  CONSTRAINT cosmetic_equip_owned FOREIGN KEY (account_id, cosmetic_id)
    REFERENCES cosmetic_ownership (account_id, cosmetic_id) ON DELETE CASCADE,
  CONSTRAINT cosmetic_equip_slot_nonempty CHECK (length(slot) > 0)
);
