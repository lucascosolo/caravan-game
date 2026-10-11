-- Chunk 32: telemetry and balance instrumentation (PHASE-2 §32).
--
--   account_admin           The admin flag: a row here makes an account an operator who may read
--                           the /admin/* dashboard. Keyed by account (one row or none), so no
--                           player-facing SELECT * on `account` can ever carry it. The app role
--                           can only READ it (db/roles.sql revokes INSERT/UPDATE/DELETE): no
--                           player route, and no bug in one, can grant it. It is set by the
--                           operator CLI (src/analytics/adminCli.ts) over the OWNER connection.
--                           It leaves with its account (cascade).
--   account_analytics       The opaque per-account analytics id (random, never derived from the
--                           account id) and the account's opt-out. Created lazily. Client
--                           telemetry is stored under analytics_id only.
--   analytics_client_event  Screen-flow and crash events from the web client: a closed screen
--                           name, and for a crash a closed error class and an 8-hex stack hash.
--                           No usernames, no ids of other rows, no free text. Rows cascade with
--                           account_analytics, so deleting an account (chunk 30) removes them
--                           with nothing to chase.
--
-- Analytics never feed back into play: nothing in the resolver, matchmaking, economy,
-- acquisition or trip loop reads these tables (a test greps src/ for it).
--
-- Indexes for the aggregate queries (src/analytics/queries.ts): every dashboard query is
-- bounded by a time window and reads through one of these, never a full ledger scan. Plans
-- are checked in under apps/server/db/explain/analytics/ (`pnpm --filter @caravan/server
-- explain:analytics`).

CREATE TABLE account_admin (
  account_id uuid        PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  granted_by text        NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_admin_granted_by_nonempty CHECK (length(granted_by) BETWEEN 1 AND 64)
);

CREATE TABLE account_analytics (
  account_id   uuid        PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  analytics_id uuid        NOT NULL DEFAULT gen_random_uuid(),
  opted_out    boolean     NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_analytics_id_unique UNIQUE (analytics_id)
);

-- The analytics id is opaque and permanent for the account: it never moves to another account.
CREATE FUNCTION account_analytics_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.account_id <> OLD.account_id OR NEW.analytics_id <> OLD.analytics_id THEN
    RAISE EXCEPTION 'account_analytics identity is immutable (only opted_out may change)' USING ERRCODE = 'check_violation';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER account_analytics_guard_update
  BEFORE UPDATE ON account_analytics FOR EACH ROW EXECUTE FUNCTION account_analytics_guard_update();

CREATE TABLE analytics_client_event (
  id           bigserial   PRIMARY KEY,
  analytics_id uuid        NOT NULL REFERENCES account_analytics (analytics_id) ON DELETE CASCADE,
  kind         text        NOT NULL,
  screen       text        NOT NULL,
  error_name   text,
  stack_hash   text,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT analytics_client_event_kind CHECK (kind IN ('screen', 'crash')),
  -- Closed vocabularies, so nothing free-form can be stored (the server validates the exact lists).
  CONSTRAINT analytics_client_event_screen_token CHECK (screen ~ '^[a-z_]{1,24}$'),
  CONSTRAINT analytics_client_event_error_token CHECK (error_name IS NULL OR error_name ~ '^[A-Za-z]{1,24}$'),
  CONSTRAINT analytics_client_event_stack_hash CHECK (stack_hash IS NULL OR stack_hash ~ '^[0-9a-f]{8}$'),
  CONSTRAINT analytics_client_event_shape CHECK (
    (kind = 'screen' AND error_name IS NULL AND stack_hash IS NULL) OR
    (kind = 'crash' AND error_name IS NOT NULL AND stack_hash IS NOT NULL)
  ),
  CONSTRAINT analytics_client_event_not_future CHECK (occurred_at <= received_at)
);
CREATE INDEX analytics_client_event_time_idx ON analytics_client_event (occurred_at);
CREATE INDEX analytics_client_event_id_time_idx ON analytics_client_event (analytics_id, occurred_at);

-- Aggregate-query indexes (bounded windows over large tables).
CREATE INDEX ledger_event_type_time_idx ON ledger_event (event_type, occurred_at);
CREATE INDEX ledger_event_account_time_idx ON ledger_event (account_id, occurred_at);
CREATE INDEX trip_ended_at_idx ON trip (ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX trip_encounter_settled_at_idx ON trip_encounter (settled_at);
CREATE INDEX refugee_menu_created_at_idx ON refugee_menu (created_at);
CREATE INDEX pack_purchase_purchased_at_idx ON pack_purchase (purchased_at);
-- (No encounter_candidates (chosen_at) index: it would tempt the planner off the matchmaker's
-- encounter_candidates_band_chosen_idx for the served-share query (qa25-scale). The pool-health
-- served query walks that band index once per band instead.)
CREATE INDEX account_created_at_idx ON account (created_at) WHERE NOT is_system;
