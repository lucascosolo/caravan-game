-- Chunk 24: onboarding progress, ACCOUNT-level (PHASE-2 §24: "progress stored on the account,
-- not the caravan, so a future second caravan does not retrigger it").
--
--   account_onboarding   One row per player account. `step` is the furthest guide step the
--                        player has reached (the ordered list lives in
--                        apps/server/src/onboarding/steps.ts and is mirrored by the CHECK below);
--                        it only ever moves forward (trigger). `skipped_at` is set when the
--                        player skipped the rest of the guide (never on the first screen);
--                        `completed_at` when the step reached 'done' (by finishing or skipping).
--
-- The row is a marker of what the player has SEEN. Nothing reads it to grant Coin, units, unlock
-- points or access: onboarding is a real trip under the ordinary rules (GUARDRAILS §2, §3).
--
-- Accounts that existed before this migration are existing players, not new ones: they are
-- backfilled as 'done' (they never see the guide). System accounts (authored parties) get no row.
-- Numbered 017: 014 (trip void), 015 (inbox) and 016 (chunk 13 fixes) are taken on main.

CREATE TABLE account_onboarding (
  account_id    uuid        PRIMARY KEY REFERENCES account (id) ON DELETE CASCADE,
  step          text        NOT NULL DEFAULT 'welcome',
  skipped_at    timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT account_onboarding_step_known CHECK (step IN ('welcome', 'roster', 'outfit', 'scout', 'arrange', 'result', 'free', 'bank', 'party', 'done')),
  CONSTRAINT account_onboarding_done_consistent CHECK ((step = 'done') = (completed_at IS NOT NULL)),
  CONSTRAINT account_onboarding_skip_completes CHECK (skipped_at IS NULL OR completed_at IS NOT NULL)
);

CREATE OR REPLACE FUNCTION account_onboarding_rank(s text) RETURNS integer LANGUAGE sql IMMUTABLE AS $$
  SELECT array_position(ARRAY['welcome', 'roster', 'outfit', 'scout', 'arrange', 'result', 'free', 'bank', 'party', 'done'], s)
$$;

-- Forward only: a step never moves back, and a finished guide never reopens.
CREATE OR REPLACE FUNCTION account_onboarding_forward_only() RETURNS trigger AS $$
BEGIN
  IF account_onboarding_rank(NEW.step) < account_onboarding_rank(OLD.step) THEN
    RAISE EXCEPTION 'onboarding step cannot move back (% -> %)', OLD.step, NEW.step USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.completed_at IS NOT NULL AND (NEW.completed_at IS DISTINCT FROM OLD.completed_at OR NEW.skipped_at IS DISTINCT FROM OLD.skipped_at) THEN
    RAISE EXCEPTION 'a finished onboarding is permanent' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.account_id <> OLD.account_id THEN
    RAISE EXCEPTION 'account_onboarding.account_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER account_onboarding_forward_only BEFORE UPDATE ON account_onboarding
  FOR EACH ROW EXECUTE FUNCTION account_onboarding_forward_only();

INSERT INTO account_onboarding (account_id, step, completed_at)
  SELECT id, 'done', now() FROM account WHERE NOT is_system;
