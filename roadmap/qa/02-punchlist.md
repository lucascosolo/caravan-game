# Chunk 02 — QA punch list (commit 45c04b3)

Round 1 closed by the Maker (see ORCHESTRATION.md "chunk 02 QA round 1 closed"); every
item below is `[closed]` with its regression in `apps/server/test/qa02-regressions.test.ts`
unless noted.

## Blocker
B1. [closed] Completion is not fenced: `lockJobForCompletion` (jobs/queue.ts:108-113) checks only `status <> 'completed'`, so a stale worker, a never-leased job, or a parked job can be completed by anyone holding the id, and a worker on a different `RESOLVER_VERSION` than `input.resolverVersion` completes it anyway (GUARDRAILS §1). Fix: (a) handler/worker fails the job when `input.resolverVersion !== RESOLVER_VERSION`; (b) completion requires `status='leased' AND leased_by=$worker AND attempts=$fence`, parked is terminal; (c) add an explicit `requeueParkedJob` operator path. Keep the liveness property: lease timeout must exceed the handler budget, and a lease that expires while its worker is still running must lose cleanly (its commit is rejected) rather than win.

## Should-fix
S1. [closed] App role can UPDATE projected columns directly. Column-level REVOKE UPDATE (coin_balance) on account and (reputation, ladder_level, ladder_points, unlock_points_granted, unlock_points_spent) on pool_progress from caravan_app; make `ledger_event_project()` SECURITY DEFINER. Test as the app role.
S2. [closed] No cross-account caravan check: account-A event may carry account-B's caravan. `ALTER TABLE caravan ADD UNIQUE (id, account_id)` and composite FK `(caravan_id, account_id)` on ledger_event and resolution_job. Test.
S3. [closed] Pool-event payloads not type-checked; a string `delta` crashes rebuild. CHECK `jsonb_typeof` = number and integer-valued for delta/pointsDelta/levelsGained/points/cost; `rebuildAll` catches per account and lists it as a mismatch; `verifyProjection` returns ok=false instead of throwing.
S4. [closed] Re-enqueue of the same encounter with a different formation is silently ignored (ON CONFLICT DO NOTHING). Compare canonical JSON of inputs and throw a conflict error when they differ.
S5. [closed] Lock-order deadlock between `coinCreditDraft` and multi-account `appendEvents`. One `lockAccountsForAppend` in sorted order up front; `coinCreditDraft` asserts rather than takes. Keep exported function names and signatures stable (chunk 16 consumes them concurrently); add a deadlock regression test.
S6. [closed] Pure handlers cannot clamp credits to cap; the worker appends drafts verbatim and an over-cap credit parks the job. Worker-side clamp at commit recording overflowDiscarded; `verifyJobReplay` compares on requested amount; document committed stream = handler stream + clamp.
S7. [closed] No TRUNCATE guards on ledger_event / resolution_job; ledger_snapshot is mutable. Add BEFORE TRUNCATE triggers; make ledger_snapshot insert-only; verifyProjection compares latest snapshot to a from-zero fold through through_seq.
S8. [closed] GET /me/ledger 500s on malformed `after`/`limit`. Fastify querystring schema → 400; return `hasMore`.
S9. [closed] Placeholder handler writes permanent "resolutions" with resolver_version=0. Outside tests it must throw (→ parked with a clear last_error) rather than complete; chunk 13 must bump RESOLVER_VERSION to ≥ 1.

## Nits
N1. [closed] causation_seq contiguity/order not enforced; add a CHECK/trigger or document that only verifyJobReplay detects it.
N2. [closed] ledger_event.seq flows through the lossy Number parser; document the choice (bounded by 2^53 for this game's lifetime) at the column.
N3. [closed] markJobFailed re-queues at the head with no backoff; add `next_attempt_at` with exponential backoff (tunable).
N4. [closed] Move src/jobs/tunables.ts constants into a documented server-side infra section (chunk 03's decision: infra knobs stay server-side; just drop the TODO and document).

## Closure notes (Maker, round 1)

- **B1** `lockJobForCompletion(client, jobId, fence)` / `markJobCompleted(client, jobId, result, fence)` now take a `LeaseFence {workerId, attempts}` and succeed only while `status='leased' AND leased_by=worker AND attempts=fence AND lease_expires_at > clock_timestamp()`; parked is terminal (trigger: parked may only go to queued); `requeueParkedJob` is the operator path; the worker fails a job whose `input.resolverVersion !== RESOLVER_VERSION` (retryable, so a correctly-versioned worker can still take it). Liveness: the concurrency suite now shows 5 ms leases under 20–40 ms handlers losing every attempt cleanly (0 commits, parked with `lease expired`), then committing exactly once after re-queue under a lease that fits.
- **S1** `db/roles.sql` revokes table-level UPDATE on `account`/`pool_progress` and re-grants it per column (catalog-driven) minus the projected ones; `ledger_event_project()` is `SECURITY DEFINER`. Two assertions in `test/qa01-guards.test.ts` that updated `coin_balance`/`ladder_level` as the app role were adjusted.
- **S2** `caravan (id, account_id)` unique + composite FKs on `ledger_event` and `resolution_job` (migration 002, in place).
- **S3** `jsonb_is_integer()` CHECK on delta/pointsDelta/levelsGained/points/cost; `verifyProjection` returns `ok=false, error` instead of throwing; `rebuildAll` isolates per account.
- **S4** `enqueueJob` compares canonical input and throws `JobInputConflictError`; `enqueueEncounterResolution` compares the formation only (a fresh party snapshot is not a conflict).
- **S5** `lockAccountsForAppend(client, ids)` (sorted) is the one lock order; `coinCreditDraft` keeps its signature but now *asserts* the lock (`isAccountAppendLockHeld` via pg_locks) rather than taking it — behaviour change, noted in ORCHESTRATION.md. Deadlock regressions: the probe's mirror transactions and mirror two-account jobs under two workers.
- **S6** `clampCoinCreditDrafts` runs in the worker under the batch's locks; committed stream = handler stream + clamp; `verifyJobReplay` compares on `amount + overflowDiscarded` (`replayIdentity`).
- **S7** BEFORE TRUNCATE guards on all three tables; `ledger_snapshot` UPDATE/DELETE guards; `verifyProjection.snapshot` cross-checks the latest checkpoint against a from-zero fold through its seq.
- **S8** Fastify querystring schema (`after` integer 0..2^53, `limit` 1..500) → 400; response carries `hasMore` (`listEventsPageForAccount`).
- **S9** `DEFAULT_HANDLERS.encounter_resolution` throws `NonRetryableJobError` while `RESOLVER_VERSION < 1` → parked immediately with a clear `last_error`; the placeholder is `PLACEHOLDER_HANDLERS`, registered only by tests.
- **N1** BEFORE INSERT trigger enforces contiguity. **N2** documented at the `seq` column. **N3** `next_attempt_at` + `retryBackoffMs` (1 s doubling, 60 s cap; `WorkerOptions.retryBackoffMs` overrides). **N4** `src/jobs/tunables.ts` header documents the server-side-infra decision.

# Round 2 — B1 re-check (commit e139871): B1 holds. Remaining:

## Should-fix
R2-S1. worker.ts:93-94 treats a *missing* `input.resolverVersion` as a match. Require the key; add CHECK `resolution_job.input ? 'resolverVersion'` with `jsonb_typeof = 'number'` in migration 002.
R2-S2. A wrong-version worker leases the job and burns attempts; during a rolling deploy old workers park every new-version job. `leaseNextJob` takes `resolverVersion` and filters `(input->>'resolverVersion')::int = $n` so skewed workers never lease it.
R2-S3. `requeueParkedJob` writes no audit and the app role can do the same with raw UPDATE. Add `requeued_at`/`requeued_by`/`requeue_count` columns set by the function; REVOKE UPDATE(status) from caravan_app and make the lease/complete/fail/park/requeue status writers SECURITY DEFINER SQL functions (owner), so status changes only flow through them.
R2-S4. Transition trigger permits what the fence forbids. Defense in depth: `completed` requires `OLD.status='leased'`; a new lease (`leased` from non-leased, or a changed `leased_by`) requires `NEW.attempts > OLD.attempts`; `status<>'queued' OR max_attempts >= attempts`.

## Nits
R2-N1. Park-on-exhaustion sets `leased_by` to a worker that never ran it; set NULL.
R2-N2. `leaseNextJob` uses `now()`; use `clock_timestamp()` for symmetry with the fence.
R2-N3. `result` may be non-NULL on a non-completed row; CHECK `status='completed' OR result IS NULL`.
