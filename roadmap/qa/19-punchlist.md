# Chunk 19 — QA punch list (commit 87a1ad0, merged)

Probes: scratchpad/qa19 (probe.test.ts, ev19.py, ev19b.py). No blocker in the loss code: bounded stakes, owner immunity, conservation, idempotency, preview equality all held over 24 randomised histories.

## Decisions (orchestrator)
D1. **[closed]** (`applyOverrunLosses` appends `partyWinCredit` in the transfer batch; feed `partyWinCoin`; tests) **Pay the party-win credit.** On every overrun by a player-owned party, credit `creditPartyWin` (COIN_PER_PARTY_WIN) to the owner alongside the capped transfer, same causation family (`transfer:<job>`), capped by headroom; system owners get nothing. The feed shows it.
D2. **[closed: (a), (b); (c) is the §37 pass — tool `scripts/balance/trip-ev.ts`, table in PHASE-2 §37]** **Trips must be worth taking with merged units.** Structural change now, numbers tuned later with the real resolver:
  (a) Encounter Coin scales with the caravan's living-rating band: `coinForEncounter(n, band) = base × 1.35^(n−1) × (1 + band × COIN_ENCOUNTER_BAND_SCALE_BP/10000)`, `COIN_ENCOUNTER_BAND_SCALE_BP` = 5000 (tunable). Bands are the matchmaking display bands. Stored per encounter at accrual (chunk 15 S1 rule already stores it).
  (b) Encounter 1 of a trip is matched below the caravan's rating: `FIRST_ENCOUNTER_CENTRE_OFFSET` = −150 (tunable), escalation per encounter unchanged; the sandbag floor measures beyond the band actually used, so the offset never triggers it.
  (c) A balance pass after chunk 13 (real resolver + authored parties) tunes these so that, at a circle's equilibrium rating, the best bank point has positive expected value for L1–L4 circles and is k ≥ 2. Record the EV table in PHASE-2 §37.
D3. **[closed]** (55 000 = the mid of ≈ 43.7k / 55.5k / 66.7k; derivation on the constant and in the script; pinned by a test; chunk 20 note updated) Recovery after losing 8 × L5 is ~3 weeks free (same type) to ~4.5 weeks (mixed, mercenaries), ~1.4–2.0 with the paid ceiling. Accepted for v1 with the D2 change (higher-rated trips earn more, shortening recovery). Re-derive FREE_WEEKLY_EARN_ESTIMATE from realistic hold rates (trickle 33.6k + trips at p1 0.6–0.7) and record the range; keep the 1.5× guardrail check against the derived mid value.

## Should-fix
S1. **[closed]** (`redactForeignAccountIds` in `/me/ledger`; feed `defender` without `accountId`) Account ids leak: filter `partyOwnerAccountId` from `trip_overrun` and any account ids from `party_served_as_encounter` in the `/me/ledger` read model; drop `defender.accountId` from the party feed (keep username, a public handle).
S2. **[closed]** (`coinDiscardedAtCap`, plus `coinTransferred` / `partyWinCoin`) Feed entry gains `coinDiscardedAtCap` from the event's `overflowDiscarded`.
S3. **[closed — with chunk 15 QA S4]** The worker settles in its completion transaction (`TRIP_SETTLE_HOOKS.afterCompleted`), so the transfer + party win (and a hold's loot) are clamped against the recipient's headroom at resolution time; lazy settle is the fallback. Owner-pay rule reconciled: an overrun pays transfer + party win (loot 0, `FULL_CLEAR_LOOT_SHARE` removed), a held fight pays depth-scaled loot (`party_loot`, same `transfer:<jobId>` causation, capped), a stalemate pays nothing; never a system owner (see roadmap/qa/15-punchlist.md). Settle at resolution so the recipient's headroom is read then.

## Nits
N1. **[closed]** Held-back units don't exist (formations require every living unit posted): close chunk 15 N1 as moot; correct the chunk 19 Build note.
N2. **[closed]** `stakesPreview` uses `deathIndex` and reads in one REPEATABLE READ transaction.
N3. **[closed]** (`bankTrip(…, nowMs)` forces a trickle flush before the credit) Bank forecast and credit read the same balance (flush the trickle first, as spendCoin does).
N4. **[closed]** Rebuild-cost test also pins the mixed-type, mercenary figure (96 L1 / 166,800 / 224,400).
