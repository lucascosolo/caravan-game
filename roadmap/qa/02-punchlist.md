# Chunk 02 — QA punch list (commit 45c04b3)

## Blocker
B1. Completion is not fenced: `lockJobForCompletion` (jobs/queue.ts:108-113) checks only `status <> 'completed'`, so a stale worker, a never-leased job, or a parked job can be completed by anyone holding the id, and a worker on a different `RESOLVER_VERSION` than `input.resolverVersion` completes it anyway (GUARDRAILS §1). Fix: (a) handler/worker fails the job when `input.resolverVersion !== RESOLVER_VERSION`; (b) completion requires `status='leased' AND leased_by=$worker AND attempts=$fence`, parked is terminal; (c) add an explicit `requeueParkedJob` operator path. Keep the liveness property: lease timeout must exceed the handler budget, and a lease that expires while its worker is still running must lose cleanly (its commit is rejected) rather than win.

## Should-fix
S1. App role can UPDATE projected columns directly. Column-level REVOKE UPDATE (coin_balance) on account and (reputation, ladder_level, ladder_points, unlock_points_granted, unlock_points_spent) on pool_progress from caravan_app; make `ledger_event_project()` SECURITY DEFINER. Test as the app role.
S2. No cross-account caravan check: account-A event may carry account-B's caravan. `ALTER TABLE caravan ADD UNIQUE (id, account_id)` and composite FK `(caravan_id, account_id)` on ledger_event and resolution_job. Test.
S3. Pool-event payloads not type-checked; a string `delta` crashes rebuild. CHECK `jsonb_typeof` = number and integer-valued for delta/pointsDelta/levelsGained/points/cost; `rebuildAll` catches per account and lists it as a mismatch; `verifyProjection` returns ok=false instead of throwing.
S4. Re-enqueue of the same encounter with a different formation is silently ignored (ON CONFLICT DO NOTHING). Compare canonical JSON of inputs and throw a conflict error when they differ.
S5. Lock-order deadlock between `coinCreditDraft` and multi-account `appendEvents`. One `lockAccountsForAppend` in sorted order up front; `coinCreditDraft` asserts rather than takes. Keep exported function names and signatures stable (chunk 16 consumes them concurrently); add a deadlock regression test.
S6. Pure handlers cannot clamp credits to cap; the worker appends drafts verbatim and an over-cap credit parks the job. Worker-side clamp at commit recording overflowDiscarded; `verifyJobReplay` compares on requested amount; document committed stream = handler stream + clamp.
S7. No TRUNCATE guards on ledger_event / resolution_job; ledger_snapshot is mutable. Add BEFORE TRUNCATE triggers; make ledger_snapshot insert-only; verifyProjection compares latest snapshot to a from-zero fold through through_seq.
S8. GET /me/ledger 500s on malformed `after`/`limit`. Fastify querystring schema → 400; return `hasMore`.
S9. Placeholder handler writes permanent "resolutions" with resolver_version=0. Outside tests it must throw (→ parked with a clear last_error) rather than complete; chunk 13 must bump RESOLVER_VERSION to ≥ 1.

## Nits
N1. causation_seq contiguity/order not enforced; add a CHECK/trigger or document that only verifyJobReplay detects it.
N2. ledger_event.seq flows through the lossy Number parser; document the choice (bounded by 2^53 for this game's lifetime) at the column.
N3. markJobFailed re-queues at the head with no backoff; add `next_attempt_at` with exponential backoff (tunable).
N4. Move src/jobs/tunables.ts constants into a documented server-side infra section (chunk 03's decision: infra knobs stay server-side; just drop the TODO and document).
