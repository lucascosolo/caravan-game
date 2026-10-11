-- Chunk 01: core schema. The account-vs-caravan progress split (GUARDRAILS §5) is
-- enforced here by constraints and triggers, not by convention in app code.
--
--   ACCOUNT-LEVEL (persists across future caravans): auth identity, Coin + storage cap,
--     the home town, the standing raiding party, trap + siege pool progress.
--   CARAVAN-LEVEL (region-specific, never transfers): region, state, living-unit pool
--     progress, owned living-unit instances and their merge levels.
--
-- There is deliberately NO persistent per-player defensive layout table: a wagon circle
-- formation belongs to an encounter inside a trip (chunks 07/15), never to an account.
-- There is deliberately NO purchase/billing table yet (chunk 20), and nothing here should
-- make it convenient for progression code to join to billing when it arrives.

CREATE TYPE pool AS ENUM ('living', 'trap', 'siege');
CREATE TYPE caravan_state AS ENUM ('in_town', 'on_trip');

-- Regions: a one-time, non-swappable choice per caravan. Only affects which living units
-- exist for that caravan; no map, no travel. Seeded from @caravan/content REGIONS.
CREATE TABLE region (
  id           text PRIMARY KEY,
  display_name text NOT NULL
);
INSERT INTO region (id, display_name) VALUES
  ('desert',      'Desert'),
  ('high_plains', 'High Plains'),
  ('mountain',    'Mountain'),
  ('badlands',    'Badlands');

-- ---------------------------------------------------------------------------------
-- Account level
-- ---------------------------------------------------------------------------------
CREATE TABLE account (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  username         text        NOT NULL,
  password_hash    text        NOT NULL,
  coin_balance     bigint      NOT NULL DEFAULT 0,
  coin_storage_cap bigint      NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_username_unique    UNIQUE (username),
  CONSTRAINT account_coin_nonneg        CHECK (coin_balance >= 0),
  CONSTRAINT account_coin_within_cap    CHECK (coin_balance <= coin_storage_cap),
  CONSTRAINT account_coin_cap_positive  CHECK (coin_storage_cap > 0)
);

-- The home town: the safe hub, never attacked. One per account; a future second caravan
-- rides out from the same town. Chunk 17 adds the mine and merge board to it.
CREATE TABLE home_town (
  account_id uuid        PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The standing raiding party: the player's passive, asynchronous presence. A template,
-- never consumed, served into other players' trips. Account-level, not a caravan's.
-- Chunk 09 adds composition, stances and approach edges keyed on this row.
CREATE TABLE standing_party (
  account_id uuid        PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------------
-- Caravan level
-- ---------------------------------------------------------------------------------
-- One row per caravan, keyed by account. NO unique constraint on account_id: the schema
-- supports N caravans per account; v1 app logic refuses the second (MAX_CARAVANS_PER_ACCOUNT).
CREATE TABLE caravan (
  id         uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid          NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  region_id  text          NOT NULL REFERENCES region (id),
  name       text          NOT NULL,
  -- in_town: safe, refitted, no trip. on_trip: out, accumulating attrition and unbanked
  -- Coin. A caravan is never attackable outside a trip. Chunk 15 adds the trip rows.
  state      caravan_state NOT NULL DEFAULT 'in_town',
  created_at timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX caravan_account_idx ON caravan (account_id);

-- Region is chosen once and is not swappable; ownership never moves.
CREATE FUNCTION caravan_guard_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.region_id <> OLD.region_id THEN
    RAISE EXCEPTION 'caravan.region_id is chosen once and is not swappable (caravan %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.account_id <> OLD.account_id THEN
    RAISE EXCEPTION 'caravan.account_id is immutable (caravan %)', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER caravan_guard_immutable
  BEFORE UPDATE ON caravan FOR EACH ROW EXECUTE FUNCTION caravan_guard_immutable();

-- ---------------------------------------------------------------------------------
-- Pool progress: Reputation (a rating, never spent), ladder (permanent), unlock points
-- (granted permanently; spent against the web in chunk 05). One row per (owner, pool).
--
-- THE SPLIT IS A CONSTRAINT, NOT A CONVENTION:
--   pool = 'living'          -> caravan_id NOT NULL, account_id NULL
--   pool IN ('trap','siege') -> account_id NOT NULL, caravan_id NULL
-- Writing living-unit progress at account level, or trap/siege progress at caravan
-- level, is a database error.
-- ---------------------------------------------------------------------------------
CREATE TABLE pool_progress (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  pool                  pool        NOT NULL,
  account_id            uuid        REFERENCES account (id) ON DELETE CASCADE,
  caravan_id            uuid        REFERENCES caravan (id) ON DELETE CASCADE,
  -- Volatile rating that drives matchmaking. Shifts with fight outcomes. Never spent.
  reputation            integer     NOT NULL,
  -- Permanent. Rises only through use. Never decreases (trigger below).
  ladder_level          integer     NOT NULL DEFAULT 0,
  -- Progress toward the next rung. Chunk 04 owns the curve.
  ladder_points         integer     NOT NULL DEFAULT 0,
  -- Permanent. Granted exactly once per rung crossed. Never decreases (trigger below).
  unlock_points_granted integer     NOT NULL DEFAULT 0,
  -- Points committed to the unlock web (chunk 05). Spending is the ONLY thing that moves
  -- this; it can never exceed what was granted.
  unlock_points_spent   integer     NOT NULL DEFAULT 0,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pool_progress_scope_matches_pool CHECK (
    (pool = 'living'            AND caravan_id IS NOT NULL AND account_id IS NULL) OR
    (pool IN ('trap', 'siege')  AND account_id IS NOT NULL AND caravan_id IS NULL)
  ),
  CONSTRAINT pool_progress_account_pool_unique UNIQUE (account_id, pool),
  CONSTRAINT pool_progress_caravan_pool_unique UNIQUE (caravan_id, pool),
  CONSTRAINT pool_progress_reputation_nonneg   CHECK (reputation >= 0),
  CONSTRAINT pool_progress_ladder_nonneg       CHECK (ladder_level >= 0 AND ladder_points >= 0),
  CONSTRAINT pool_progress_unlock_nonneg       CHECK (unlock_points_granted >= 0 AND unlock_points_spent >= 0),
  CONSTRAINT pool_progress_unlock_spent_within_granted CHECK (unlock_points_spent <= unlock_points_granted)
);

-- Permanence guard: ladder level and granted unlock points can only go up, and a row's
-- scope (which pool, which owner) can never move. Any UPDATE that tries is refused.
CREATE FUNCTION pool_progress_guard_permanence() RETURNS trigger AS $$
BEGIN
  IF NEW.ladder_level < OLD.ladder_level THEN
    RAISE EXCEPTION 'pool_progress.ladder_level is permanent and may never decrease (% -> %)',
      OLD.ladder_level, NEW.ladder_level USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.unlock_points_granted < OLD.unlock_points_granted THEN
    RAISE EXCEPTION 'pool_progress.unlock_points_granted is permanent and may never decrease (% -> %)',
      OLD.unlock_points_granted, NEW.unlock_points_granted USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.pool <> OLD.pool
     OR NEW.account_id IS DISTINCT FROM OLD.account_id
     OR NEW.caravan_id IS DISTINCT FROM OLD.caravan_id THEN
    RAISE EXCEPTION 'pool_progress scope (pool/owner) is immutable' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER pool_progress_guard_permanence
  BEFORE UPDATE ON pool_progress FOR EACH ROW EXECUTE FUNCTION pool_progress_guard_permanence();

-- Delete guard: a progress row may only disappear together with its owner (cascade).
-- Deleting and re-inserting would otherwise be a back door to resetting a ladder.
CREATE FUNCTION pool_progress_guard_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.account_id IS NOT NULL AND EXISTS (SELECT 1 FROM account WHERE id = OLD.account_id) THEN
    RAISE EXCEPTION 'pool_progress rows are permanent while their account exists'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.caravan_id IS NOT NULL AND EXISTS (SELECT 1 FROM caravan WHERE id = OLD.caravan_id) THEN
    RAISE EXCEPTION 'pool_progress rows are permanent while their caravan exists'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER pool_progress_guard_delete
  BEFORE DELETE ON pool_progress FOR EACH ROW EXECUTE FUNCTION pool_progress_guard_delete();

-- ---------------------------------------------------------------------------------
-- Living-unit instances: caravan-scoped, with a merge level. Merge cap is 5 for everyone
-- (GUARDRAILS §2); the per-death penalty floors at 1 (chunk 19), never below.
-- unit_type_id references the content package (chunk 03), validated in app code.
-- ---------------------------------------------------------------------------------
CREATE TABLE unit_instance (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  caravan_id   uuid        NOT NULL REFERENCES caravan (id) ON DELETE CASCADE,
  unit_type_id text        NOT NULL,
  merge_level  smallint    NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unit_instance_merge_level_range CHECK (merge_level BETWEEN 1 AND 5)
);
CREATE INDEX unit_instance_caravan_idx ON unit_instance (caravan_id);

-- ---------------------------------------------------------------------------------
-- Sessions: opaque bearer tokens, stored hashed.
-- ---------------------------------------------------------------------------------
CREATE TABLE session (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid        NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  token_hash text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  CONSTRAINT session_token_hash_unique UNIQUE (token_hash)
);
CREATE INDEX session_account_idx ON session (account_id);
