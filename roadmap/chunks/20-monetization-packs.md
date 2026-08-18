# Chunk 20 — Monetization packs

**Depends on:** 16. **Status:** not started.
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

- [ ] Three tiers displayed with fixed prices and fixed Coin amounts.
- [ ] Full contents — exact Coin amount and exact cosmetics — previewed before purchase.
      No randomization, no hidden contents, no mystery element anywhere.
- [ ] All three tiers purchasable in the same week; combined ceiling documented in
      code as the P2W-relevant number.
- [ ] Purchased Coin credits the normal account balance, respects the storage cap,
      and writes `coin_purchased` to the ledger.
- [ ] Sandbox purchase flow — no real charges, clearly marked as a stub.
- [ ] Cosmetics rotate weekly on a deterministic schedule; Coin amounts do not.
- [ ] Cosmetics are stored separately from anything the resolver reads, and are
      structurally incapable of affecting stats.
- [ ] **An architectural check exists proving the resolver cannot read purchase or
      entitlement state** — a dependency boundary test, not just a code review note.
- [ ] The assumed free-vs-paid weekly ratio is written down where a balancer will find it.

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
  unit access, trip-cap uses, slot count, matchmaking rerolls, or shields.
- **Determinism:** is pack rotation deterministic and identical for all players in a
  given week?
