-- Chunk 29: the in-app inbox's two pieces of server-side state.
--
-- The inbox's ITEMS are not stored. They are derived on read from the ledger (party strikes:
-- `party_served_as_encounter` and the owner-side events under the same causation) and from
-- the lazily computed timers that already exist (the refugee drip's grid, the trip cap's
-- stored timestamp, the trickle, the weekly pack rotation). A notification is therefore never
-- a second copy of a fact that could drift from the ledger, and nothing here is a ledger event:
-- reading a notification is UI state, not a game fact, so the append-only ledger is untouched.
--
--   inbox_read        what the player has seen: one row per item key, with the item VERSION
--                     seen (a strike batch's newest seq, the trip cap's refill instant, ...).
--                     An item is unread while its current version is above the stored one,
--                     so a strike landing in an already-read batch makes the batch unread
--                     again. Versions only move forward (trigger), so a stale or replayed
--                     request can never make something read look unread or vice versa.
--   inbox_preference  per-category opt-out (PHASE-2 §29). A missing row means the category
--                     default: party strikes on, everything else off.
--
-- ACCOUNT-level (GUARDRAILS §5): the inbox is the player's; a refugee item names its caravan
-- inside the key, so a future second caravan gets its own items without a schema change.

CREATE TABLE inbox_read (
  account_id uuid        NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  item_key   text        NOT NULL,
  version    bigint      NOT NULL,
  read_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, item_key),
  CONSTRAINT inbox_read_key_shape   CHECK (item_key ~ '^[a-z_]+:[A-Za-z0-9:_-]{1,160}$'),
  CONSTRAINT inbox_read_version_nonneg CHECK (version >= 0)
);

CREATE FUNCTION inbox_read_forward_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_id <> OLD.account_id OR NEW.item_key <> OLD.item_key THEN
    RAISE EXCEPTION 'inbox_read: account_id and item_key are immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'inbox_read: a read mark only moves forward (% -> %)', OLD.version, NEW.version USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER inbox_read_forward_only BEFORE UPDATE ON inbox_read
  FOR EACH ROW EXECUTE FUNCTION inbox_read_forward_only();

CREATE TABLE inbox_preference (
  account_id uuid        NOT NULL REFERENCES account (id) ON DELETE CASCADE,
  category   text        NOT NULL,
  enabled    boolean     NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, category),
  CONSTRAINT inbox_preference_category_known CHECK (
    category IN ('party_strike', 'refugees_arrived', 'trip_cap_refilled', 'mine_near_cap', 'packs_rotated')
  )
);
