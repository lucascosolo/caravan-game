# Chunk 14 — QA punch list (commit ec9bc85, merge e91c082)

## Assigned to the chunk 25 Maker (owns authored.ts, band.ts authored logic, system accounts)
B1. `is_system` is not a login gate: `/auth/login` must refuse system accounts with 401 regardless of password; test with a known password.
B2. Migration 009 down/up de-flags authored accounts and the seed never re-asserts: seed re-asserts `is_system = true` for `sys_outfit_*` rows (refusing if a non-system account owns the name); down migration refuses while any `is_system` row exists.
S4. Authored parties fill before widening, inverting EMPTY_POOL_BEHAVIOR: while live-in-band < 3 and width < max, widen (authored only by ratio); authored may fill to 3 only at the widest pass. Pure test "authored in band, live one step wider".
S5. Authored ratings bypass the ledger: write them as ledger events the fold applies (preferred) so rebuild == live for system accounts; test.
N1. Trigger: `is_system` may only change false→true, only while the account owns no caravan and has no ledger events.
N2. Reserve the `sys_outfit_` prefix at registration (400).

## Assigned to a chunk 14 fixer
S1. [closed] `enqueueEncounterResolution` live re-resolve fallback is a trap for chunk 15: make `party` required (chunk 02 tests take their own snapshot), or throw when a chosen `encounter_candidates` row exists for (tripId, encounterIndex).
S2. [closed] Every search stores/scans the whole party table: filter in SQL to `abs(reputation − centre) ≤ WIDTH_MAX OR is_system`, index `pool_progress(pool, reputation)`, store the subset (replay stays exact).
S3. [closed] Server-initiated widening must not trigger the sandbag floor: measure the gap beyond `band_width_used`. Test the n=6 fresh-player path yields multiplier 1.0.
S6. [closed] Chunk files must be self-contained: append "From chunk 14" blocks to roadmap/chunks/19 (destroy Coin lost to `is_system` owners, skip their Reputation, apply `reputation.sandbagEarnMultiplier` through one exported function `applyEarnFloor`, tests) and 15 (createTrip/endTrip/enqueueChosenEncounter/encounter_candidates seam; new trip resets the reroll gate).
N3. [closed] snapshots.ts comment: skip-at-generation, not re-scout.
N4. [closed] Drop `skippedPartyIds` and `owner.accountId` from the client view (keep in the row).
N5. [closed] Add `authoredShare` to the menu view; `usedAuthoredFallback` means "outside the widest band" — rename to `authoredOutsideBand`.

## Decisions (orchestrator)
D1. [recorded] Escalation stays 500 bp of the full span (+15/encounter); `DIFFICULTY_ESCALATION_BP` is the lever chunk 32 tunes. Record.
D2. [recorded] Keep the sandbag earn floor with S3's fix; single apply-site `applyEarnFloor` named in chunk 19's checklist.
D3. [recorded] `owner.authored: true` stays published (legibility beats disguise); amend PHASE-2 §25's QA check to "indistinguishable to the resolver and matchmaking, visibly labelled to the player".
