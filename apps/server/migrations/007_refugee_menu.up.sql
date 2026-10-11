-- Chunk 18: the refugee drip's stored menus.
--
-- One row per menu a caravan was ever offered, numbered by `sequence` (1, 2, 3, ... per
-- caravan, never reused). The CURRENT menu is the highest sequence. Every row carries the
-- seed the draw used and the exact unlocked pool it was drawn from, so any menu can be
-- replayed from stored state alone (GUARDRAILS §1: randomness only in which options are
-- offered, seeded and reproducible). The wall clock enters only as `generated_at_ms` (when
-- the row was written) and `window_opened_at_ms` (the free-timer grid point the row's reroll
-- window belongs to); neither touches what was offered.
--
-- The free timer is a FIXED GRID (chunk 18 QA D2): the caravan's first menu sets the anchor
-- and every later free menu sits on `anchor + k * REFUGEE_REFRESH_INTERVAL`, however late it
-- was taken — so the rate is one free menu per interval for everyone, whatever their polling
-- cadence. A free menu's `window_opened_at_ms` is its grid point (<= generated_at_ms); a
-- reroll's is copied from the free menu that opened its window.
--
-- `origin` says what produced the menu: the free timer ('free') or a Coin reroll
-- ('reroll'). `window_sequence` is the sequence of the free menu that opened the current
-- reroll window; the reroll cost index is `sequence - window_sequence`, so it resets on
-- every free refresh by construction.
--
-- A claim fills the three `claimed_*` columns together (exactly one pick per menu); the
-- instance id is not a foreign key because the instance may later be merged away or lost
-- on a trip while the menu row stays as history.
--
-- CARAVAN-level (GUARDRAILS §5): living-unit instances are the caravan's. No account column.
CREATE TABLE refugee_menu (
  caravan_id          uuid        NOT NULL REFERENCES caravan (id) ON DELETE CASCADE,
  sequence            integer     NOT NULL,
  origin              text        NOT NULL,
  window_sequence     integer     NOT NULL,
  -- fnv1a32(`<caravan id>:<sequence>`), stored for replay (fits in an integer; bigint for headroom).
  seed                bigint      NOT NULL,
  -- The unlocked living pool at draw time, sorted by type id. Replay input.
  pool_type_ids       jsonb       NOT NULL,
  -- Exactly REFUGEE_OFFER_COUNT type ids, in slot order. Replay output.
  offered_type_ids    jsonb       NOT NULL,
  generated_at_ms     bigint      NOT NULL,
  -- The grid point of the free window this menu belongs to (QA D2). Replay-irrelevant.
  window_opened_at_ms bigint      NOT NULL,
  claimed_type_id     text,
  claimed_instance_id uuid,
  claimed_at_ms       bigint,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (caravan_id, sequence),
  CONSTRAINT refugee_menu_sequence_positive   CHECK (sequence >= 1),
  CONSTRAINT refugee_menu_origin              CHECK (origin IN ('free', 'reroll')),
  CONSTRAINT refugee_menu_window_in_range     CHECK (window_sequence >= 1 AND window_sequence <= sequence),
  CONSTRAINT refugee_menu_free_opens_window   CHECK (origin <> 'free' OR window_sequence = sequence),
  CONSTRAINT refugee_menu_seed_nonneg         CHECK (seed >= 0),
  CONSTRAINT refugee_menu_pool_is_array       CHECK (jsonb_typeof(pool_type_ids) = 'array'),
  CONSTRAINT refugee_menu_offers_is_array     CHECK (jsonb_typeof(offered_type_ids) = 'array'),
  CONSTRAINT refugee_menu_generated_at_nonneg CHECK (generated_at_ms >= 0),
  CONSTRAINT refugee_menu_window_at_nonneg    CHECK (window_opened_at_ms >= 0),
  -- A free menu is never written before its own grid point.
  CONSTRAINT refugee_menu_free_after_window   CHECK (origin <> 'free' OR window_opened_at_ms <= generated_at_ms),
  -- One pick per menu, all three columns set together or none.
  CONSTRAINT refugee_menu_claim_all_or_none   CHECK (
    (claimed_type_id IS NULL AND claimed_instance_id IS NULL AND claimed_at_ms IS NULL) OR
    (claimed_type_id IS NOT NULL AND claimed_instance_id IS NOT NULL AND claimed_at_ms IS NOT NULL)
  ),
  -- What was claimed must be one of the offers.
  CONSTRAINT refugee_menu_claim_was_offered   CHECK (
    claimed_type_id IS NULL OR offered_type_ids ? claimed_type_id
  )
);
