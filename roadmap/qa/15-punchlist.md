# Chunk 15 — QA punch list (commit cfc81f9, merged at 08ad586; migration 012)

Probes: scratchpad/qa15 (probe.test.ts with vitest.config.mjs; ev.py). No blocker at the seam-gated scope.

## Decisions (orchestrator)
D1. **Push must be a real decision.** With a flat 500 delivery bonus, banking after encounter 1 dominates at the equilibrium hold rate (~0.57–0.60). Change: `COIN_PER_BANKED_TRIP` becomes `COIN_DELIVERY_PER_ENCOUNTER` = 125 × encounters survived (no flat bonus), and `COIN_ENCOUNTER_ESCALATION_MULT` ×1.25 → ×1.35. Break-even hold rate to push past encounter 1 drops from 0.643 to ~0.44, so at a 0.6 hold rate the best bank point moves to 2–3; chunk 19's unit losses still price caution. Update chunk 16's schedule, chunk 20's FREE_WEEKLY_EARN_ESTIMATE range note, and record the EV table in PHASE-2 §37 (balance owner re-tunes from play data).
D2. Trip cap is per account (one cap across a future account's caravans). Record in the chunk 15 file and GUARDRAILS §5's account-level list.
D3. **Void path for an unresolvable encounter:** when a resolution job parks (deterministic resolver failure, refused outcome), the trip is voided: the voided encounter is discarded, the trip banks as of the last survived encounter (nothing if none), no losses apply, the cap use is not refunded, ledger `trip_voided` with the reason. And `POST trip/start` refuses 409 `resolver_unavailable` while ENCOUNTER_RESOLUTION_WIRED is false.
D4. Stalemate: the caravan may bank or push (§11). Correct PROJECT.md §2 line 44 and the chunk 15 DoD wording.

## Assigned to the chunk 13 Maker (seam)
S2. `resolve` returns `{ outcome, log }`; the handler stores the log (or hash + location) in job.result separately from the validated outcome.
    **[closed — chunk 13]** `EncounterResolver.resolve → { outcome, log }`, `resolveEncounter → { outcome (+loot), log }`. The handler hands the log to the worker (`HandlerOutput.encounterLog`), which writes it gzip-compressed to the new immutable `encounter_log` table (migration 013, keyed by job id: resolver version, log format, raw/stored bytes, sha256 of the log and of the formation / survivors / party snapshots, content hash) in the completion transaction, then prunes per LOG_RETENTION (30 days or the caravan's newest 50, whichever keeps more). `job.result.replay` holds only `{store, jobId, logFormat, sha256, rawBytes}`. Tests: `trip-resolver.test.ts`.
S3. Stamp a content/tunables hash in the job input at enqueue; resolve refuses/flags a mismatch (or embed resolved stats). Decide before goldens freeze.
    **[closed — chunk 13]** Hash chosen (not embedded stats): `RESOLUTION_CONTENT_HASH` = sha256 of `resolutionContent()` (@caravan/circle: content units, traps, siege, fences + `resolverTunables()`), stamped as `contentHash` at enqueue; the adapter throws `ContentHashMismatchError` on a different or missing stamp, re-thrown RETRYABLE by the handler (parks after the attempt budget → D3). The goldens are resolver-level (literal inputs), so they do not depend on content.
N3. `survivors` becomes a top-level EncounterJobInput key, not smuggled inside `formation`.
    **[closed — chunk 13]** `EncounterJobInput.survivors` (top level), passed through `enqueueChosenEncounter(…, formation, survivors)`; the idempotent re-enqueue compares it; `resolverInputFromJob` reads it there. Pinned in trip.test.ts "the production handler is wired".
N8. The adapter normalizes DEPTH_METRIC to an integer 0..1024.
    **[closed — chunk 13]** Normalized in the resolver itself (so it is in every golden): `outcome.depth` = floor(1024 × share of the deepest raider's straight-line distance to the core block it closed), 1024 on an overrun; the adapter passes it through. One-sentence UI text in the replay response (`depthExplained`).

## Assigned to the chunk 19 Maker (same code)
S1. [closed — chunk 19: `bankTrip` passes the stored `coin_accrued` rows to `creditBankedTrip({ encounterCoin })`; schedule assertion removed; test `stakes.test.ts` "chunk 15 QA S1"] Bank credits the stored per-encounter `coin_accrued` (after `applyEarnFloor`), never recomputes from the live schedule; drop the schedule assertion.
S7. [closed — chunk 19: `bankNow.unitsDeMerged` = `planUnitLosses(…, "banked").deMerged` ({ref, typeId, fromLevel, toLevel, diedAtEncounter}), the same plan the bank applies and returns as `restored.deMerged` (which replaced `deMergePending`); tested equal] Preview `bankNow.unitsDeMerged` (ref, level → level after), from the same data as `deMergePending`.

## Assigned to a chunk 15 fixer after chunk 19 lands
S4. Settle in the worker's completion transaction (or enqueue a settle job on completion); keep lazy settle as fallback. The absent party owner must get Reputation (and chunk 19's transfer) without the defender reopening the app.
S5. → D3.
S6. Validate `tripId` with `isUuid` → 400.
N1. [closed as moot — chunk 19 QA N1: a formation must post every living unit, so there are no held-back units to split] Label/split `ifOverrun.unitsLostOutright` (held-back certain vs posted "if still standing").
N2. Before the first survival, omit `harderThanThisEncounter` and `bankNow`.
N4. Retire chunk 07's raw `…/formation/commit` route, or gate it on a chosen candidate within an open trip encounter.
N5. Persist `balanceAfter` in the `trip_banked` payload so replays return it; document that replay bodies are equivalent, not byte-identical.
N6. Superseded by chunk 19's applyEarnFloor (the multiplier then applies).
N7. DB guard tying a trip row to a cap consumption (defense in depth).
