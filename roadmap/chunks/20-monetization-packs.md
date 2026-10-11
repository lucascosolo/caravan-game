# Chunk 20 — Monetization packs

**Depends on:** 16. **Status:** QA'd — QA round 1 (roadmap/qa/20-punchlist.md) closed 2026-10-11 (sandboxed storefront, cosmetic catalog + rotation, ownership/equip, guardrail tests).
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

The weekly rotating pack storefront: three fixed price tiers, fully previewed
contents, and a purchase flow that is **stubbed/sandboxed for MVP** (no real payment
processing). What must be real is the guardrail enforcement, not the billing.

## Design constraints that apply here

- **Weekly rotating packs**, three fixed price tiers: **$5 / $10 / $25.**
- **Each tier's Coin amount is fixed and stays consistent week to week** — no
  variance, **fully previewable**.
- **All three tiers are purchasable in the same week (stackable)** — the effective
  weekly pay-to-accelerate cap is the **combined total of all three tiers' Coin
  amounts, not any single tier's figure.** Anyone reasoning about the P2W ceiling
  must use the combined sum.
- **This combined sum must be sized against a normal week's free-play Coin earn rate
  during balancing to keep the guardrail meaningful.** Playtesting-dependent — record
  the ratio you're assuming, so it can be checked later.
- Packs bundle in **limited-release cosmetics that rotate weekly**, but contents are
  **always fixed and previewed before purchase — no randomization, no mystery-box
  element**, consistent with the legibility principle running through every other system.
- **Nothing purchasable affects combat stats or power ceiling — only pace (Coin →
  faster merges) and cosmetics/rotation exclusivity.**
- **Resolution logic is identical for paying and non-paying players at every step.**
- Purchased Coin lands in the same account balance and is subject to the same
  **storage cap** — accumulation, whether earned or bought, can't run unbounded.
- Cosmetics must be **purely visual**. A cosmetic that changes a hitbox, a stat, a
  readability advantage in scouting, or anything the resolver can observe is not a
  cosmetic.
- Matchmaking reroll is free and time-gated and **must not appear in any pack**.
  Nothing here may sell trip-cap uses, unlock points, unit access, or slot count.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `PACK_TIER_PRICES` | $5 / $10 / $25 | Fixed by design. |
| `PACK_COIN_BY_TIER` | 6,000 / 14,000 / 40,000 | Fixed week to week. Mild value scaling upward is fine; the amounts must not vary by week or by player. |
| `WEEKLY_PAY_CEILING` | 60,000 Coin (all three tiers combined) | **This is the number the P2W guardrail is measured against, not 40,000.** |
| `FREE_WEEKLY_EARN_ESTIMATE` | ~40,000 Coin/week for an active player | Derived from chunk 16 defaults (3 trips/hr cap + trickle). **Assumption to be validated in playtesting.** Target ratio: paying should not exceed roughly 1.5× an active free player's week. At the defaults above the ratio is ~1.5×. If either side's numbers move, re-check this. |
| `PACK_ROTATION_PERIOD` | 7 days, rotating cosmetics only | Coin amounts do not rotate. |
| `PURCHASE_BACKEND` | sandbox stub for MVP — records the grant, no real charge | Real payment integration is out of scope. |
| `PURCHASE_LIMIT` | one of each tier per week | Stackable across tiers; not stackable within a tier. |

## Definition of done

- [x] Three tiers displayed with fixed prices and fixed Coin amounts.
- [x] Full contents — exact Coin amount and exact cosmetics — previewed before purchase.
      No randomization, no hidden contents, no mystery element anywhere.
- [x] All three tiers purchasable in the same week; combined ceiling documented in
      code as the P2W-relevant number.
- [x] Purchased Coin credits the normal account balance, respects the storage cap,
      and writes `coin_purchased` to the ledger.
- [x] Sandbox purchase flow — no real charges, clearly marked as a stub.
- [x] Cosmetics rotate weekly on a deterministic schedule; Coin amounts do not.
- [x] Cosmetics are stored separately from anything the resolver reads, and are
      structurally incapable of affecting stats.
- [x] **An architectural check exists proving the resolver cannot read purchase or
      entitlement state** — a dependency boundary test, not just a code review note.
- [x] The assumed free-vs-paid weekly ratio is written down where a balancer will find it.

## QA guardrail checks for this chunk

- **No pay-to-win — the whole reason this chunk needs a careful review:**
  - Does anything purchasable affect a **stat, a power ceiling, or an outcome** —
    versus only **pace or cosmetics**?
  - **Does resolution logic differ in any way for a paying vs. non-paying account?**
    Verify structurally: the resolver must not be able to reach entitlement state at
    all, whether or not it currently uses it.
  - Is the pay ceiling being reasoned about as the **combined total of all three
    tiers**, or has someone anchored on a single tier's figure?
  - Are the cosmetics genuinely cosmetic? Check for any that alter visibility,
    readability, hitboxes, or anything observable during resolution.
- **Legibility:** are pack contents previewed before purchase, exactly and completely?
  Any randomization or mystery-box element is a direct design violation.
- **Bounded accumulation:** can purchased Coin push a balance past the storage cap?
  Can buying all three tiers in one transaction race the cap check?
- **Grind wall — check explicitly, don't assume the guardrails prevent it:** are there
  points where free-path progress is slow enough that the paid path stops feeling
  optional? Compare `WEEKLY_PAY_CEILING` against a realistic free week using chunk
  16's actual numbers. **This is the specific failure mode §16 calls out.**
- **Nothing else for sale:** confirm no pack contains or could contain unlock points,
  unit access, trip-cap uses, slot count, fence material, repairs, resupply, or
  matchmaking rerolls.
- **Determinism:** is pack rotation deterministic and identical for all players in a
  given week?

## Build notes (2026-10-11)

**Where things live.**
- `packages/content/src/cosmetics.ts` — the cosmetic catalog (PHASE-2 §28, minimal): 24
  entries across the five kinds (`unit_skin` ×8 on each region's two free starting types,
  `wagon_skin` ×4, `fence_style` ×4, `town_decoration` ×4, `party_banner` ×4), each with a
  `reviewNote` for scouting readability and **no numeric field** (asserted on load). The
  weekly rotation (**per-cosmetic since QA-20 S2**): `cosmeticRotationForWeek(w)` ranks every
  catalog id by `rotationRank(w, id)` = FNV-1a over `cosmetic-rotation:<w>|<id>` (ties by id),
  first 1/2/3 ids to tiers 1/2/3. A rank depends only on (week, id), so a catalog addition
  never re-deals an existing week — it can only enter a week's six and push the last one out. `cosmeticOfferWeeks(id, from, horizon)` is the
  "when does it return" schedule. Week 0 is pinned in a test.
- `packages/content/src/packs.ts` — `packOfferForWeek(w, tier)`: price, Coin (from the
  registry, never from the week), the week's cosmetics, and `contents` (the exact granted
  list; `PackContent` is a two-member union, coin | cosmetic). `weekIndexAt(nowMs)`,
  `weekBounds`, `weeklyPayCeiling()`; `assertPacksValid()` runs at content load and refuses
  a registry whose `WEEKLY_PAY_CEILING` is not the sum of the tiers or whose ratio to
  `FREE_WEEKLY_EARN_ESTIMATE` exceeds `PAID_TO_FREE_RATIO_MAX_BP`.
- Tunables (chunk 20 block in `tunables.ts`): `PACK_TIER_PRICES_CENTS` [500, 1000, 2500],
  `PACK_COIN_BY_TIER` [6000, 14000, 40000], **`WEEKLY_PAY_CEILING` 60,000 — the P2W number,
  documented as such in the block header**, `FREE_WEEKLY_EARN_ESTIMATE` 40,000 — the FLOOR of a range
  (QA-20 D3: flat 3 trips/h × 5 h + 45 h trickle ≈ 39k; 5 × 1 h sessions with regen bursts +
  full-week trickle ≈ 94k; 7 × 1 h ≈ 118k; the cap bounds the effective paid add to cap −
  balance per spend cycle; re-check when chunk 15's tunables land), `PAID_TO_FREE_RATIO_MAX_BP`
  15,000 (ratio at defaults is exactly 1.5×), `PACK_ROTATION_PERIOD_MS` 7 d,
  `PACK_ROTATION_EPOCH_MS` 2026-01-05T00:00Z (week 0), `PACK_ROTATION_PREVIEW_WEEKS` 1,
  `PACK_COSMETICS_BY_TIER` [1, 2, 3], `PURCHASE_BACKEND` "sandbox_stub",
  `PURCHASE_LIMIT_PER_TIER_PER_WEEK` 1, `PACK_CONTENT_KINDS` ["coin", "cosmetic"].
- Migration `010_store_and_cosmetics`: `pack_purchase` (UNIQUE (account, week, tier) IS the
  purchase limit; `contents` CHECKed by `pack_contents_ok()` to coin/cosmetic entries with
  exactly their keys; `backend` CHECKed to `'sandbox_stub'`; credited + discarded = requested;
  immutable, leaves only with its account), `cosmetic_ownership` (PK (account, cosmetic);
  `purchase_id NOT NULL` — in v1 a cosmetic comes from a pack and from nothing else;
  immutable), `cosmetic_equip` (PK (account, slot); FK (account, cosmetic) → ownership, so
  only an owned cosmetic can be equipped; freely changed). All account-level; no FK to or
  from any battle-side table (a test reads `pg_constraint`).
- `apps/server/src/store/`: `offers.ts` (`storeView`: three tiers with purchase state and
  the per-tier **and combined** overflow forecast over balance + pending trickle via
  `peekTrickle`; next week's rotation; the sandbox notice; the ceiling block), `sandbox.ts`
  (**the stub — "NO MONEY MOVES" banner, receipt `sandbox:<uuid>`, `chargedCents: 0`**),
  `purchase.ts` (`purchasePack`: one transaction under the account append lock → prior-row
  check (settled → replay) → `contentsHash` check → reservation row → sandbox charge keyed by
  the causation id → trickle force-flush → `appendCoinCredits` with `type: "coin_purchased"`,
  reason `pack_purchase`, payload {tier, weekIndex, priceCents, backend, chargedCents,
  cosmetics} → settle the reservation → ownership rows ON CONFLICT DO NOTHING; 23505
  backstop → the same replay — order as revised by QA-20), `cosmetics.ts` (`listCosmetics`, `equipCosmetic`, `unequipSlot`).
- Routes: `GET /me/store`, `POST /me/store/purchase {tier, weekIndex, contentsHash}` (201; 200
  `{replayed: true}` for a repeat; 400 `contents_hash_required` / `invalid_contents_hash`; 409
  `offer_changed` / `offer_not_current`), `GET /me/store/purchases`,
  `GET /me/cosmetics`, `POST /me/cosmetics/equip {cosmeticId}`, `POST /me/cosmetics/unequip {slot}`.
- `economy/coin.ts`: `CoinCreditSpec` gained an optional `type` (default `coin_earned`) and a
  JSON `extra`, so the store credits through the same batch-clamped path as earned Coin.
  The literal `coin_purchased` still appears in no economy file (chunk 16's scan holds).
- `scripts/resolver-boundary-check.mjs`: `cosmetic(s)` and `pack(s)` added to the banned
  specifiers, and a banned word now also matches as a file basename (`./cosmetics.js`).

**Conventions / decisions.**
- The purchase names the **week it previewed**; the server re-derives the offer from
  (current week, tier) and refuses a rolled-over week (`offer_not_current`). What was shown is
  what is granted, by construction — the client never sends contents.
- ~~A repeat of a tier in the same week is a 409.~~ **QA-20 D1:** a repeat is a **200
  `{replayed: true}`** with the stored purchase view and the stored `coin_purchased` event
  (the chunk 16 S6 convention); nothing moves, nothing is charged again. A racing duplicate
  that hits the UNIQUE backstop gets the same replay.
- **QA-20 S2 — fingerprint.** Every offer in `/me/store` carries `contentsHash` = sha256 of
  `canonicalPackContents(contents)` (fixed key order, no whitespace, entries in offer order).
  `POST /me/store/purchase` REQUIRES it over HTTP (optional for in-process callers) and answers
  409 `offer_changed`, writing nothing, if what would be granted hashes differently. A replay is
  answered before the hash check (the purchase already happened; its stored view is the truth).
- **QA-20 D2 — reserve → charge → credit + settle.** `pack_purchase` is inserted first as a
  reservation (`sandbox_receipt` NULL, nothing credited, `settled_at` NULL; its UNIQUE is our
  idempotency guard), the backend is charged with `idempotencyKey = causationId`, the Coin is
  credited, and the row is settled in place — the only UPDATE the row's guard admits, once,
  touching only receipt / credited / discarded / settled_at (CHECK `pack_purchase_settlement`).
  An unsettled reservation found later is resumed from the charge with the same key, granting
  the reservation's own recorded contents. The sandbox receipt is a pure function of the key.
  The rule, binding on a real backend (whose charge must run outside the DB transaction), is
  written in `store/sandbox.ts`.
- **QA-20 S1 — trickle flush.** After the account lock and before `appendCoinCredits`, the
  purchase calls `accrueTrickleTx(client, accountId, nowMs, { force: true })` (as `spendCoin`
  does), so the credit clamps against the balance the store showed (ledger + pending). The
  result carries `trickle` (null on a replay).
- **QA-20 N1:** `pack_contents_ok` requires exactly one coin entry, amount > 0.
- **QA-20 N2:** every `reviewNote` carries "(reviewed by <who>, YYYY-MM-DD)" or the marker
  "pending art review (chunk 26)" — every entry carries the marker in this build.
- **QA-20 N4:** `isPackTier` is integer equality on purpose (2.0 is 2; nothing coerces).
- The cosmetic grant's ledger record is the `coin_purchased` event itself (its payload
  carries `cosmetics: [...]` — the ids OFFERED, already-owned ones included; ownership rebuilds
  from the ledger as "the first event naming an id owns it", QA-20 N3, tested). No new ledger event type was added: the `ledger_event_type`
  enum would need `ALTER TYPE … ADD VALUE`, which cannot be used in the same transaction a
  migration runs in, and its scope function would have to be replaced; the ownership rows
  plus the event's `cosmetics` field reproduce ownership from the log.
- A cosmetic that rotates back is not granted twice; the response lists it under
  `cosmeticsAlreadyOwned`.
- No web screen in this chunk: the storefront is the JSON contract above; chunk 17/23 UI work
  renders it.

**Tests** (`apps/server/test/store.test.ts` 15, `store-guards.test.ts` 9,
`qa20-store-regressions.test.ts` 12, `packages/content/test/packs-and-cosmetics.test.ts` 17, `packages/circle/test/no-cosmetic-field.test.ts` 4):
fixed amounts over 520 weeks; the combined ceiling; the ratio; the week-0 pin (DELIBERATELY
re-pinned for the per-cosmetic draw, QA-20 S2) and catalog add/remove never re-ordering the
other ids in 122 weeks; rotation determinism in-process
and across two separate Node processes (sha256 over 302 weeks); the per-tier forecast and the
combined forecast matching what the purchase then records; all three tiers in one week with
the cap clamp; each tier once per week (serial, next week reopens, 8 racing purchases of one
tier → 1 created + 7 replays, 12 racing across tiers near the cap → 3 created + 9 replays and the cap never
passed); stale week / bad tier refused with nothing written; a returning cosmetic not granted
twice; ownership + equip + unequip; HTTP flow; every forbidden content kind refused by the
schema CHECK; immutability and FK guards against the app role; the FK graph; the boundary
script passing and its regex; greps that packages/resolver, packages/circle, src/matchmaking
(and jobs, economy, acquisition, unlocks, progression, circle, party, ledger, repo) never
name a purchase/cosmetic table or import the store; the store's SQL naming only its own
tables; `coin_purchased` written only by `store/purchase.ts`; no payment SDK in any
package. The circle test pins at the TYPE level (`@ts-expect-error`, checked by `tsc`) and at
RUNTIME (closed-key parsers and `assertResolveInput`) that Formation, PostPlacement,
Manifest, PackInput, PartyConfig, Battlefield and ResolveInput cannot carry a cosmetic field.
