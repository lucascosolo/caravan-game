# Chunk 04 — QA punch list (commit dbb7a11)

No blockers.

## Decisions (orchestrator)
D1. **Matchmaking rating pairing accepted:** caravan = its living Reputation (caravan-level); standing party = owner's siege Reputation (account-level), documented as "offense Reputation, stored on the siege pool". **Trap Reputation stops moving** — it stays at REPUTATION_START until a reader exists (a visible number that never matters violates GUARDRAILS §4). Record in the chunk 04 file, in `/progression/rules`, and add a note to roadmap/chunks/14-matchmaking-and-scouting.md ("Decided in chunk 04 QA").
D2. **Sandbagging:** no structural change. Add tunable `REPUTATION_GAP_MULT_MIN_LOSS` = fp 0.5 (losses clamp at ×0.5; wins keep ×0.25 floor) so the passive-side tank is ~2× slower. Carry PHASE-2 §28's Coin floor and recent-opponent exclusion into chunk 14's checklist (append to its chunk file).

## Should-fix
S1. Crafted `ladder_progress_gained` with negative `pointsDelta` lowers ladder points as the app role. Migration 003: CHECK `pointsDelta >= 0 AND levelsGained >= 0`; `unlock_points_granted` requires `points > 0`, integer `rung` in 1..cap; `pool_progress_guard_permanence` refuses `ladder_points` decreases. Fix stale comment events.ts:103; add `rung` to `UnlockPointsGrantedPayload`.
S2. Exactly-once index bypassed by a grant without `rung`; with S1 making rung mandatory, drop the `payload ? 'rung'` predicate.
S3. Same causation id with different input silently accepted; store an input hash in the payload (or re-derive from recorded fields) and throw on mismatch.
S4. `GET /me/progression/events` malformed query → defaults or 500. Fastify querystring schema (after int ≥0 ≤2^53, limit 1..500, pool enum) → 400.
S5. Pagination applies limit before the type filter and has no `hasMore`. Filter in SQL via `listProgressionEventsForAccount`; return `hasMore`.
S6. Dead ledger-bypassing writers `raiseLadderLevel` / `grantUnlockPoints` in repo/poolProgress.ts; delete them and their uses in test/permanence.test.ts (replace with ledger-driven equivalents).
S7. Trap Reputation adjusted by the living/siege gap with wrong `selfRating`. Resolved by D1: trap Reputation no longer written.
S8. No cap on `levelsGained` / `ladder_level`. CHECK `ladder_level <= LADDER_RUNGS_PER_POOL` (test pins it to the tunable like qa03-merge-cap) and `levelsGained <= cap` in the ledger CHECK.

## Nits
N1. Write no `reputation_changed` when delta === 0 (keep `floored` on the first clamped event only).
N2. `applyEncounterOutcome` must assert it runs inside a transaction (`pg_current_xact_id_if_assigned()` non-null) or throw.
N3. Two exported `applyEncounterOutcome` (progression vs circle); rename the circle one to `applyAttritionOutcome` (update its callers/tests).
N4. Normalise `-0` in gapScaledDelta (`|| 0`) and assert `|base| × MULT_MIN ≥ FIXED_ONE` at startup.
N5. Registration writes no initial event; rebuild hardcodes REPUTATION_START. Note for chunk 15 (no change now).
N6. Events expose `opponentRating` to the party owner; note for chunk 19's post-fight report design (no change now).
N7. view.ts: assert `row.caravan_id !== null` for living.
