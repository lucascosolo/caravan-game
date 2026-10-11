# Chunk 14 — QA punch list (commit ec9bc85, merge e91c082)

## Assigned to the chunk 25 Maker (owns authored.ts, band.ts authored logic, system accounts)
Closed by chunk 25 (2026-10-11); tests in `apps/server/test/authored.test.ts` and `matchmaking-pure.test.ts`.

B1. [closed] `is_system` is not a login gate: `/auth/login` must refuse system accounts with 401 regardless of password; test with a known password. → `routes/auth.ts` refuses `account.is_system` after the hash check (same 401); test sets a known hash on a system account and logs in.
B2. [closed] Migration 009 down/up de-flags authored accounts and the seed never re-asserts: seed re-asserts `is_system = true` for `sys_outfit_*` rows (refusing if a non-system account owns the name); down migration refuses while any `is_system` row exists. → `009_matchmaking.down.sql` raises while any `is_system` row exists (test rolls back 010+009 and proves 009 refuses, then re-migrates); `reassertSystemAccounts` runs first in every seed and re-flags only what the N1 trigger allows (a bare account), otherwise refuses naming the usernames. The test suite's global setup now empties `account` before its schema reset.
S4. [closed] Authored parties fill before widening, inverting EMPTY_POOL_BEHAVIOR: while live-in-band < 3 and width < max, widen (authored only by ratio); authored may fill to 3 only at the widest pass. Pure test "authored in band, live one step wider". → `authoredAllowance(live, count, { fill })`: `fill` only on the widest pass of `selectCandidates`; the pure test exists; the fresh-database path now fills at ±600.
S5. [closed] Authored ratings bypass the ledger: write them as ledger events the fold applies (preferred) so rebuild == live for system accounts; test. → `applyAuthoredSpec` appends `reputation_changed` (siege, delta from the current rating), plus `ladder_progress_gained` / `unlock_points_granted` per rung and `unlock_node_purchased` through `spendUnlockPoints`; `verifyProjection` is `ok` for all 96 system accounts (test), before and after an in-place update.
N1. [closed] Trigger: `is_system` may only change false→true, only while the account owns no caravan and has no ledger events. → migration 010 `account_guard_is_system`; tested against the app role and the owner role.
N2. [closed] Reserve the `sys_outfit_` prefix at registration (400). → `registerAccount` 400 `reserved_username`; `RESERVED_USERNAME_PREFIX` pinned equal to `AUTHORED_USERNAME_PREFIX` by a test.

## Assigned to a chunk 14 fixer
S1. `enqueueEncounterResolution` live re-resolve fallback is a trap for chunk 15: make `party` required (chunk 02 tests take their own snapshot), or throw when a chosen `encounter_candidates` row exists for (tripId, encounterIndex).
S2. Every search stores/scans the whole party table: filter in SQL to `abs(reputation − centre) ≤ WIDTH_MAX OR is_system`, index `pool_progress(pool, reputation)`, store the subset (replay stays exact).
S3. Server-initiated widening must not trigger the sandbag floor: measure the gap beyond `band_width_used`. Test the n=6 fresh-player path yields multiplier 1.0.
S6. Chunk files must be self-contained: append "From chunk 14" blocks to roadmap/chunks/19 (destroy Coin lost to `is_system` owners, skip their Reputation, apply `reputation.sandbagEarnMultiplier` through one exported function `applyEarnFloor`, tests) and 15 (createTrip/endTrip/enqueueChosenEncounter/encounter_candidates seam; new trip resets the reroll gate).
N3. snapshots.ts comment: skip-at-generation, not re-scout.
N4. Drop `skippedPartyIds` and `owner.accountId` from the client view (keep in the row).
N5. Add `authoredShare` to the menu view; `usedAuthoredFallback` means "outside the widest band" — rename to `authoredOutsideBand`.

## Decisions (orchestrator)
D1. Escalation stays 500 bp of the full span (+15/encounter); `DIFFICULTY_ESCALATION_BP` is the lever chunk 32 tunes. Record.
D2. Keep the sandbag earn floor with S3's fix; single apply-site `applyEarnFloor` named in chunk 19's checklist.
D3. `owner.authored: true` stays published (legibility beats disguise); amend PHASE-2 §25's QA check to "indistinguishable to the resolver and matchmaking, visibly labelled to the player".
