# Chunk 20 — QA punch list (commit 3d4c9a8, merged)

No blockers.

## Decisions (orchestrator)
D1. **[closed]** Repeat purchase of a tier in the same week returns **200 `{replayed: true}`** with the stored purchase view and event (the merge convention from chunk 16 S6), not 409.
D2. **[closed]** Charge ordering for a real backend: reserve the `pack_purchase` row first (UNIQUE as the idempotency guard), then charge with `causationId` as the backend idempotency key, then credit. Implement that ordering now against the stub and write the rule in sandbox.ts.
D3. **[closed]** `FREE_WEEKLY_EARN_ESTIMATE` stays 40,000 as the conservative floor; rewrite the derivation as a range (flat 3 trips/h with 45 h trickle ≈ 39k; 5×1 h sessions with regen bursts + full-week trickle ≈ 94k; 7×1 h ≈ 118k) and note the cap bounds the effective paid add to cap − balance per spend cycle. Re-check when chunk 15's tunables land.

## Should-fix
S1. **[closed]** Purchase credits against the ledger balance, not the shown balance: call `accrueTrickleTx(client, accountId, nowMs, { force: true })` after the account lock and before `appendCoinCredits` (mirror `spendCoin`); surface `trickle` in the result; test with nowMs = NOW + 2 h.
S2. **[closed]** The purchase carries no fingerprint of the previewed offer: accept `contentsHash` (sha256 of canonical `contents`) in POST /me/store/purchase and 409 `offer_changed` on mismatch; also make the rotation draw per-cosmetic (`hash(id, week)` ordering) so catalog additions never re-deal existing weeks. Record both in the chunk file.

## Nits
N1. **[closed]** `pack_contents_ok`: exactly one coin entry, amount > 0.
N2. **[closed]** `reviewNote` must carry reviewer/date; mark the placeholders as "pending art review (chunk 26)".
N3. **[closed]** Document in purchase.ts that `payload.cosmetics` lists offered ids and ownership rebuild is "first event naming an id owns it".
N4. **[closed]** Document `isPackTier` as integer-equality on purpose.

## Closed (2026-10-11, QA round 1 fixer)
All nine items closed; regressions in `apps/server/test/qa20-store-regressions.test.ts` (the
reviewer's probe P1–P5 turned into tests), `store.test.ts`, `store-guards.test.ts` and
`packages/content/test/packs-and-cosmetics.test.ts`. Week 0's pinned rotation changed on
purpose (S2, per-cosmetic draw); the old pin is recorded in the test.
