-- Chunk 05: a node is reached at most once per web owner, ever — enforced at the storage
-- layer, not only in the spend service. Each `unlock_node_purchased` event names its node
-- (payload.nodeId) and pool; the per-account append lock already serializes two spends for
-- the same owner, but a retried request that slipped past the service's "already reached"
-- read collides here and fails instead of charging twice. There is no refund or respec
-- (PROJECT.md), so "once" is the whole lifetime of the account.
--
-- Scope follows pool_progress: a living-pool purchase is keyed by its caravan, a trap/siege
-- purchase by its account (caravan_id NULL, folded to the nil uuid so it takes part in the
-- key). The index also serves the access check's read ("which nodes has this owner
-- reached for this pool").
--
-- What this index does NOT do: it says nothing about whether the node is in the owner's
-- web (a desert caravan's event naming `mountain.grizzly` is unique and accepted), whether
-- its prerequisites were reached, or whether the cost matches the tier. The spend service
-- is the only writer and validates all of that against the authored web; the storage layer
-- only guarantees once-per-node and (migration 006) a well-formed, non-free purchase.
CREATE UNIQUE INDEX ledger_event_unlock_node_once
  ON ledger_event (
    (payload->>'pool'),
    account_id,
    (coalesce(caravan_id, '00000000-0000-0000-0000-000000000000'::uuid)),
    (payload->>'nodeId')
  )
  WHERE event_type = 'unlock_node_purchased';
