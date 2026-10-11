-- Chunk 04: unlock points are granted exactly once per rung, ever — enforced at the
-- storage layer, not only in the service. Each `unlock_points_granted` event names the
-- rung it pays out (payload.rung). Two resolutions for the same owner that both believe
-- they crossed the same rung (a race the per-account append lock already serializes, but
-- belt and braces) collide here and the second one fails instead of double-granting.
--
-- Scope follows pool_progress: a living-pool grant is keyed by its caravan, a trap/siege
-- grant by its account (caravan_id NULL, folded to the nil uuid so it takes part in the key).
-- Events written without a rung (nothing in the game does; chunk 02's test fixtures do)
-- are outside the index and unaffected.
CREATE UNIQUE INDEX ledger_event_unlock_grant_once_per_rung
  ON ledger_event (
    (payload->>'pool'),
    account_id,
    (coalesce(caravan_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    ((payload->>'rung')::integer)
  )
  WHERE event_type = 'unlock_points_granted' AND payload ? 'rung';
