# Chunk 18 — Unit acquisition: refugee drip & mercenary recruit

**Depends on:** 05, 16. **Status:** built (2026-10-11); awaiting QA.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

The two paths to obtain a base (level-1) copy of an already-unlocked living-unit
type. Both are gated by the unlock web; neither can ever reach past it.

## Design constraints that apply here

**The hard constraint on both paths, stated verbatim in the design:**

> Neither can ever grant access to a unit type the player hasn't already unlocked.
> The unlock web is the only gate for *which* units exist for a given player — Coin
> and refugees only ever affect how fast or reliably they get **instances** of types
> they've already earned deliberate, ladder-funded access to. Coin can never buy
> progression past the unlock web; it can only buy pace and certainty within it.

**Refugee drip (free, passive):**
- Periodically offers a **choice of 3 unit types**, drawn from the player's
  **unlocked pool**.
- ***Which 3 are offered* is randomized; *which one the player takes is always their
  choice*** — randomness only shapes the menu, never the outcome.
- Refreshes on a **free timer**.
- A **Coin-cost reroll** is available to **skip the wait and see a new set of 3
  sooner**. The reroll buys *time*, not a better pool and not a wider pool.

**Mercenary recruit (Coin-cost, guaranteed):**
- Lets the player pick the **exact specific unit type** they want — **but only from
  types already unlocked via the web.**
- **No randomness, and no way to reach ahead of unlock-web progress.**
- This is the **safety valve that makes the refugee drip's randomness acceptable
  rather than frustrating** — as long as this path is always available for anything
  already unlocked, **no player is ever blocked from getting what they need; they
  just pay Coin instead of waiting.** If mercenary recruit is ever gated, rate-limited,
  or made unavailable for some unlocked type, that safety valve is gone and the
  refugee randomness becomes a genuine frustration.

Other:
- Both paths grant a **level-1** copy. Merging up is chunk 16's job.
- Living-unit instances are **caravan-level** and region-specific.
- Randomness in the refugee menu must be **seeded and reproducible** from stored
  state, so QA can replay it.
- Acquisition is where the "generous acquisition" claim lives: **a wiped-out unit
  type must remain fully re-acquirable, just costly to rebuild.**

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `REFUGEE_REFRESH_INTERVAL_MINUTES` | 90 | Free timer. |
| `REFUGEE_OFFER_COUNT` | 3 | Fixed by design. |
| `REFUGEE_REROLL_COST` | 150 Coin | Buys time only. Escalating within a refresh window: 150 / 300 / 600, resetting on the free refresh. Tunable. |
| `REFUGEE_OFFER_WEIGHTING` | uniform over the unlocked pool | Any weighting must be documented and must never exclude an unlocked type permanently. |
| `MERCENARY_COST_BASE` | 600 Coin per level-1 unit | **Always available for every unlocked type, with no cooldown and no daily limit** — this is the safety valve. |
| `MERCENARY_COST_SCALING` | none in MVP | If scaling is ever added, it must never make a type unobtainable. |
| `REFUGEE_OFFER_SEED` | derived deterministically from (caravan id, refresh sequence number) | Reproducible menus. |
| `UNIT_INVENTORY_CAP` | 200 instances per caravan | Storage guard only; must be generous enough never to block acquisition in practice. |

**Sanity check against chunk 16:** at `COIN_TRICKLE_RATE` 200/hr and
`MERCENARY_COST_BASE` 600, a fully idle player can buy one unit every 3 hours. A unit
type wiped from a level-3 unit needs 4 level-1 copies plus merge Coin to rebuild.
If that arithmetic makes recovery feel unreasonable, these are the numbers to move —
recovery must be real, not theoretical.

## Definition of done

- [x] Refugee drip: 3 offers from the unlocked pool, free timer refresh, player picks one.
- [x] Coin reroll for refugee: costs Coin, yields a new set of 3 **from the same
      unlocked pool**, does not widen or improve the pool.
- [x] Mercenary recruit: exact type pick, Coin cost, guaranteed, **available for every
      unlocked type at all times** with no cooldown or limit.
- [x] **Both paths validated server-side against `hasAccess` from chunk 05.** A direct
      API call naming an un-unlocked type is rejected on both paths. Filtering the UI
      list is not enough.
- [x] Refugee menu generation is seeded and reproducible; the same seed yields the same 3.
- [x] Once the menu is shown, the player's pick determines the result with no further
      randomness.
- [x] Grants are level-1, caravan-scoped, written to the ledger.
- [x] Costs and the full offer are shown before commit.
- [x] A rebuild-a-wiped-type walkthrough exists as a test or documented scenario,
      showing the Coin and time required.

## QA guardrail checks for this chunk

- **The unlock web is the only access gate — the central check of this chunk:**
  *"Can Coin, via mercenary recruit or any other path, ever grant a unit type the
  player hasn't reached through ladder/unlock-web progress — i.e., does spending Coin
  ever substitute for unlock-web progress rather than just accelerating instance
  acquisition within it?"* Test both paths by direct API call with an un-unlocked
  type id, an un-unlocked type from another region, and a type id that exists for no
  one. All must be refused.
- **Determinism:** hidden randomness in **acquisition outcome** as opposed to **menu
  generation**? The 3 offers may be random; what you get when you pick must not be.
  Is the menu seed reproducible? Does rerolling ever alter what a given pick yields?
- **No pay-to-win:** does the Coin reroll buy a *better* menu or a *wider* pool
  rather than a *sooner* menu? Either would be Coin buying outcome quality.
- **The safety valve:** is mercenary recruit genuinely always available for every
  unlocked type — no cooldown, no daily cap, no per-type restriction? If it is ever
  unavailable, the refugee drip's randomness becomes frustrating rather than
  acceptable, which is exactly what the design says this path exists to prevent.
- **Generous acquisition holds up in practice:** given the actual numbers, is losing
  a unit type recoverable in practice, **not just in theory**? Compute the real Coin
  and hours required to rebuild a level-3 unit from zero and judge it honestly.
- **Grind wall:** is the free refugee path slow enough that the paid path stops
  feeling optional?
- **Legibility:** are reroll cost, mercenary cost, and the full offer set visible
  before committing?
- **Split correctness:** unit instances are caravan-level, Coin is account-level.

## Build notes (Maker, 2026-10-11)

**Where it lives.** `apps/server/src/acquisition/{refugeeMenu,grant,refugees,recruit,index}.ts`,
`apps/server/src/routes/acquisition.ts` (registered in `app.ts`), migration
`006_refugee_menu`, chunk 18 block in `packages/content/src/tunables.ts`, tests in
`apps/server/test/acquisition.test.ts` (41).

**Routes.** `GET /me/caravans/:id/refugees` (menu, timer, next reroll cost, balance,
inventory); `POST .../refugees/claim {unitTypeId, sequence?}`; `POST .../refugees/reroll
{fromSequence?}`; `GET /me/caravans/:id/recruit` (every unlocked type at its cost, locked
types listed as not for sale); `POST .../recruit {unitTypeId, requestId?}`. 201 on a new
instance / menu, 200 on a replay. Foreign caravan → 404 (chunk 16's convention).

**The boundary.** `grant.ts#grantUnit` is the only INSERT into `unit_instance` in the
module and calls chunk 05's `hasAccess` immediately before it, inside the transaction,
under the account append lock. A stored menu row is NOT trusted as proof of access: a
tampered row offering a locked type is still refused (tested). Refusal code for a locked
node, another region's unit, or a type nobody has: 409 `not_unlocked`.

**Determinism.** Seed = fnv1a32(`<caravan id>:<sequence>`), draw = xorshift32 with
rejection sampling (no modulo bias), partial Fisher–Yates over the pool sorted by type id;
with-replacement only for slots beyond the pool size (a fresh caravan has 2 starters and
still sees exactly 3 offers). The row stores seed + the pool it drew from + the offers, and
`replayMenu(row)` regenerates and compares. The clock enters only as `generated_at_ms`
for "is the free timer up".

**Timer semantics (assumptions).** Lazy: the first read/claim/reroll after the interval
generates ONE new free menu (no stockpiling), anchored at that moment; it replaces the
current menu whether or not it was claimed and resets the reroll window. Rerolls never move
the free timer. A due free refresh is served before a reroll is charged. Rerolling an
unclaimed menu forfeits its offers (the view says so: `forfeitsUnclaimedOffer`). Past the
end of `REFUGEE_REROLL_COST_SCHEDULE` the last value (600) repeats until the next free
refresh.

**Idempotency.** Claim causation `refugee_claim:<caravan>:<sequence>` (8 concurrent
claims → 1 instance); reroll `refugee_reroll:<caravan>:<from>` (retry with the same
`fromSequence` charged once); recruit `recruit:<caravan>:<requestId>` when the client
sends one, else a fresh uuid per purchase (buying the same type repeatedly is legitimate:
no cooldown, no limit).

**On-trip caravans may acquire.** The instance joins the town roster, never the
trip-locked manifest (chunk 07), so nothing is resupplied mid-trip. Chunk 15 should keep
reading the trip's units from the manifest, not from `unit_instance`.

**Rebuild walkthrough (tested).** A level-3 unit from zero via mercenary: 4 × 600 +
2 × 250 + 900 = 3 800 Coin = 19 h of trickle, or about one banked 5-encounter trip
(3 782). Free path with the whole 8-node web reached: a given type is on 3/8 of menus, so
4 copies ≈ 16 h of free menus (+ 1 400 merge Coin, 7 h of trickle, overlapping); with only
the 2 starters reached the type is on every menu: 6 h. Recovery is real.

**Grind wall (for QA).** The refugee drip gives one free level-1 every 90 min (16/day) when
the pool is ≤ 3 types; at 8 types the wanted type arrives every 4 h on average. A reroll
at 150/300/600 is 0.75/1.5/3 h of trickle; a mercenary at 600 is 3 h. The paid path is a
convenience against a free path that is itself fast; nothing is gated on paying.
