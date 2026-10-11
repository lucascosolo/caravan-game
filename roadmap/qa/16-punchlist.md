# Chunk 16 — QA punch list (commit 6a33390)

No blockers.

**Round 1 closed 2026-10-11 by the Maker** (every item below is marked `[closed]` with where
it landed; regressions live in `apps/server/test/economy.test.ts` under "QA round 1 punch
list" and in `apps/server/test/economy-guards.test.ts`). Awaiting QA re-review.

## Should-fix
S1. [closed] `performMerge` ignores `caravan.state`: units packed on an open trip can be merged away mid-trip (loss evasion; breaks "nothing is repaired mid-trip"). Inside the transaction `SELECT state FROM caravan ... FOR SHARE`; refuse 409 `caravan_on_trip` unless `in_town`; same in `previewMerge`. Test.
    — `merge.ts` `readOwnedCaravanState` (FOR SHARE in the commit transaction) + `assertInTown`; preview and commit both 409 `caravan_on_trip`. Test "S1".
S2. [closed] Preview balance excludes pending trickle while commit accrues it first. Preview computes pending trickle read-only and reports `balance` including it.
    — `trickle.ts` `peekTrickle` (no lock, no write); `MergePreview.balance` = ledger + pending, plus `pendingTrickle`. Test "S2".
S3. [closed] Non-UUID `:caravanId` → 500. Validate before any query → 400 `invalid_caravan_id`.
    — `merge.ts` `assertCaravanId` first in both entry points; the route also maps non-object bodies to 400 `invalid_instance_ids`. Test "S3".
S4. [closed] Trickle materializes one ledger row per read ≥ 18 s and zero-amount rows at cap, unbounded. Materialize only when ≥ `TRICKLE_MATERIALIZE_MIN_COINS` (default 10, tunable) or ≥ `TRICKLE_MATERIALIZE_MIN_MS` (default 15 min) has accrued; display `balance + pendingTrickle`; at cap write nothing and define the accrual point as max(last trickle through, last `coin_spent` occurred_at) so no backlog banks.
    — Both tunables added to `@caravan/content`. `computeTrickle.shouldMaterialize`; `accrueTrickleTx` writes only then (or when a debit forces a flush); at the cap nothing is written; `readTrickleAccrualPoint` = max(last valid trickle `accruedThroughMs`, last `coin_spent` `occurred_at`). `GET /me/economy` `balance` is ledger + pending (`trickle.pending`, `trickle.ledgerBalance` broken out). Tests "S4" (DB: 50 polls → 5 rows; 50 polls at cap → 0 rows; spend after idling at cap → no backlog) and "S4" (pure).
S5. [closed] No enforced "accrue before debit": export `spendCoin(client, accountId, amount, reason, nowMs)` in economy/coin.ts that accrues then debits; module header states it is the only debit path; add a test that `coinDebitDraft` is not imported outside economy.
    — `spendCoin(client, accountId, amount, reason, nowMs, { causationId, extra?, alongside? })`: forced trickle flush → 409 `insufficient_coin` → `coin_spent` (+ `alongside`, e.g. `unit_merged`) in one batch. `performMerge` uses it; `merge.ts` no longer imports `coinDebitDraft`. Tests "S5" (DB) and "S5" (source scan: the only importer is `economy/coin.ts`; no `coin_spent` literal outside economy/ledger).
S6. [closed] Retried POST /merge after success → 404 "not owned". Check `causationExists('merge:<caravan>:<sorted ids>')` first and return 200 with the stored `unit_merged` payload; normalize ids to lowercase before building causation/consumedInstanceIds.
    — `normalizeInstanceIds` lowercases (mixed-case duplicates are `duplicate_instances`); after the account lock and the ownership check, `causationExists` → `replayMerge` returns `{ replayed: true, merged, events, consumedIds, producedIds }` with 200. The six-way race test now expects 1 winner + 5 replays, one `coin_spent`. Test "S6".

## Nits
N1. [closed] `prospectiveEarn` accepts unsafe floats; bound to `Number.isSafeInteger` and ≤ 10 × cap.
    — route: digits-only parse, `isSafeInteger`, ≤ 10 × the account's cap (else 400); `overflowForecast` also asserts a safe integer. Test "N1".
N2. [closed] Check `recipeForCount(instanceIds.length)` before any DB query.
    — in `normalizeInstanceIds`, before the first query. Test "N2" (20 000 ids → 400 `no_such_recipe`).
N3. [closed] Trickle fallback on a malformed latest trickle row re-credits from account creation; refuse `reason === TRICKLE_REASON` in `appendCoinCredits`; fall back to the previous valid row.
    — `readTrickleAccrualPoint` filters `jsonb_typeof(... ) = 'number'` and takes the newest safe-integer value; `appendCoinCredits` throws on reason `trickle`. Test "N3".
N4. [closed] `coinForEncounter(n)` exceeds 2^53 near n≈107; clamp the schedule at the cap and assert `isSafeInteger`.
    — `nextEncounterCoin` clamps each step at `COIN_STORAGE_CAP` and asserts; `coinForEncountersSurvived` asserts the sum. Test "N4".
N5. [closed] Overflow forecast is "as of now"; word the warning as "room right now" (text only).
    — `OverflowForecast` doc comment and the route's `overflow.message` ("room for N more Coin right now").
N6. [closed] Foreign caravan → 404 is the convention; record it in the chunk file.
    — recorded under "Conventions" in `roadmap/chunks/16-economy-coin.md` and in the `merge.ts` header.

## Notes carried forward (no change here)
- Grind wall: 6,275 Coin/h at the trip cap; first L5 ≈ 3.4 h capped play or 105 h trickle; full 8-slot L5 circle ≈ 4.2 weeks free vs ≈ 1.7 weeks with the paid ceiling. Coin does not make paying feel mandatory. The real L5 clock is **unit supply** via the refugee drip; re-run P2W/grind checks on chunk 18's reroll and recruit pricing.
- Chunk 20: COIN_STORAGE_CAP 50,000 < WEEKLY_PAY_CEILING 60,000; pack flow must show the overflow forecast before purchase.
- Chunk 15: `creditBankedTrip` is the only path turning encounter Coin into balance; never call `appendCoinCredits` with `encounter_survived` mid-trip.
