# Chunk 16 — QA punch list (commit 6a33390)

No blockers.

## Should-fix
S1. `performMerge` ignores `caravan.state`: units packed on an open trip can be merged away mid-trip (loss evasion; breaks "nothing is repaired mid-trip"). Inside the transaction `SELECT state FROM caravan ... FOR SHARE`; refuse 409 `caravan_on_trip` unless `in_town`; same in `previewMerge`. Test.
S2. Preview balance excludes pending trickle while commit accrues it first. Preview computes pending trickle read-only and reports `balance` including it.
S3. Non-UUID `:caravanId` → 500. Validate before any query → 400 `invalid_caravan_id`.
S4. Trickle materializes one ledger row per read ≥ 18 s and zero-amount rows at cap, unbounded. Materialize only when ≥ `TRICKLE_MATERIALIZE_MIN_COINS` (default 10, tunable) or ≥ `TRICKLE_MATERIALIZE_MIN_MS` (default 15 min) has accrued; display `balance + pendingTrickle`; at cap write nothing and define the accrual point as max(last trickle through, last `coin_spent` occurred_at) so no backlog banks.
S5. No enforced "accrue before debit": export `spendCoin(client, accountId, amount, reason, nowMs)` in economy/coin.ts that accrues then debits; module header states it is the only debit path; add a test that `coinDebitDraft` is not imported outside economy.
S6. Retried POST /merge after success → 404 "not owned". Check `causationExists('merge:<caravan>:<sorted ids>')` first and return 200 with the stored `unit_merged` payload; normalize ids to lowercase before building causation/consumedInstanceIds.

## Nits
N1. `prospectiveEarn` accepts unsafe floats; bound to `Number.isSafeInteger` and ≤ 10 × cap.
N2. Check `recipeForCount(instanceIds.length)` before any DB query.
N3. Trickle fallback on a malformed latest trickle row re-credits from account creation; refuse `reason === TRICKLE_REASON` in `appendCoinCredits`; fall back to the previous valid row.
N4. `coinForEncounter(n)` exceeds 2^53 near n≈107; clamp the schedule at the cap and assert `isSafeInteger`.
N5. Overflow forecast is "as of now"; word the warning as "room right now" (text only).
N6. Foreign caravan → 404 is the convention; record it in the chunk file.

## Notes carried forward (no change here)
- Grind wall: 6,275 Coin/h at the trip cap; first L5 ≈ 3.4 h capped play or 105 h trickle; full 8-slot L5 circle ≈ 4.2 weeks free vs ≈ 1.7 weeks with the paid ceiling. Coin does not make paying feel mandatory. The real L5 clock is **unit supply** via the refugee drip; re-run P2W/grind checks on chunk 18's reroll and recruit pricing.
- Chunk 20: COIN_STORAGE_CAP 50,000 < WEEKLY_PAY_CEILING 60,000; pack flow must show the overflow forecast before purchase.
- Chunk 15: `creditBankedTrip` is the only path turning encounter Coin into balance; never call `appendCoinCredits` with `encounter_survived` mid-trip.
