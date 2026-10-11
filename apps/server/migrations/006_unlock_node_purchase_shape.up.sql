-- Chunk 05 QA S3: a purchase is never free and always names a node — enforced at the
-- storage layer, as the app role sees it. The spend service is the only writer and always
-- sets both, but a crafted `unlock_node_purchased` with `cost: 0` would mint access for
-- nothing (the projection folds the cost into unlock_points_spent, so 0 charges nothing),
-- and one with no `nodeId` would sit outside the once-per-node index (005) and could be
-- appended any number of times. Both now fail the CHECK.
--
-- `cost` is already an integer-valued JSON number (002's ledger_event_pool_payload_integers);
-- this adds "strictly positive". `nodeId` must be a JSON string and non-empty. This still
-- says nothing about whether the node is in the owner's web or its cost matches the tier
-- (see 005's comment): that is the spend service's job against the authored web data.
ALTER TABLE ledger_event
  ADD CONSTRAINT ledger_event_unlock_node_purchase_shape CHECK (
    event_type <> 'unlock_node_purchased'
    OR (
      -- CASE, not AND: a CHECK may evaluate its terms in any order, and the cast of a
      -- non-number must never surface as a cast error instead of a check violation.
      CASE WHEN jsonb_typeof(payload->'cost') = 'number' THEN (payload->>'cost')::numeric > 0 ELSE false END
      AND jsonb_typeof(payload->'nodeId') = 'string'
      AND length(payload->>'nodeId') > 0
    )
  );
