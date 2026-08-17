# Caravan Vaults — Guardrails

**Read this in full before every work session, Maker or QA, regardless of chunk.**
These five rules hold across the entire codebase. A chunk that ships while
violating one of them is not done, no matter how well it implements its own goal.

---

## 1. Determinism — no hidden randomness in any outcome

Given identical inputs, every outcome must be identical, forever.

- Raid resolution is a **pure function**: `(attacker loadout, defender layout) → outcome`.
  No wall-clock reads, no `Math.random()`, no `Date.now()`, no map/set iteration
  order that depends on insertion timing, no floating-point drift across platforms,
  no parallelism that can reorder effects.
- Ties are resolved by an **explicit, documented, stable tie-break rule** (unit id
  order or an equivalent total ordering). "It never happens in practice" is not a
  tie-break rule.
- The tick log produced during resolution **is** the replay. Nothing is ever
  re-simulated for playback. If replay and original outcome can diverge, that's a bug.
- Randomness is permitted in exactly one place: **which options are offered**
  (the refugee drip's set of 3, matchmaking's candidate list). Never in **which
  outcome the player receives**. Once a player picks from a menu, the result of
  that pick is fixed and known in advance.
- Any randomness that does exist must be **seeded and reproducible** from stored
  state, so a QA pass can replay it.

**QA probe:** re-run the same resolution 100× and byte-compare the tick logs.
Then re-run on a different machine/process and compare again.

---

## 2. No pay-to-win — Coin buys pace, certainty, and cosmetics; never power or ceiling

- Nothing purchasable may affect a stat, a damage number, a resolution rule, or a
  power ceiling. Merge cap is level 5 for everyone.
- **Resolution logic must be byte-identical for a paying and a non-paying account.**
  There must be no account flag, entitlement, or purchase record readable from
  inside the resolver. If the resolver can see billing state at all, that's a
  finding — fix the boundary, not just the usage.
- A merged unit is **not stronger than its unmerged components combined**; it is
  more *slot-efficient*. That is the only thing Coin accelerates. If merging ever
  becomes a net power gain rather than a slot-efficiency gain, the whole
  monetization guardrail collapses.
- Pack contents are **fixed, previewed before purchase, and consistent week to
  week** in Coin amount. No mystery boxes, no randomized bundles.
- The pay-to-accelerate ceiling is the **combined total of all three tiers**
  ($5 + $10 + $25, all stackable in the same week), not any single tier.
- Matchmaking re-roll is **free but time-gated**, never resource-gated — search
  behavior must be identical for paying and non-paying players.

**QA probe:** does any code path inside resolution, matchmaking, or acquisition
read a purchase, entitlement, or spend record? Does grinding the free path to the
same Coin total produce exactly the same capabilities?

---

## 3. The unlock web is the only access gate

**Coin and refugees affect acquisition speed and certainty. They never affect access.**

- The unlock web (funded only by permanent ladder-milestone points) decides
  **which unit/trap/siege types exist for a given player**. Nothing else does.
- **Mercenary recruit** (Coin, guaranteed, exact pick) may only offer types the
  player has **already unlocked**. It is a speed/certainty valve, never a bypass.
- **Refugee drip** may only draw its 3 offers from the player's **already-unlocked
  pool**. The Coin reroll buys a *sooner menu*, not a *better menu* and not a
  *wider pool*.
- Enforce this **server-side at the acquisition boundary**, not just by filtering
  the UI list. A hand-crafted request naming an unlocked-by-nobody type must be
  rejected.
- Ladder levels and granted unlock points, once earned, are **permanent and
  unrevocable** — no raid outcome, wipe, or loss event may reduce them.

**QA probe:** can Coin, by any path, produce an instance of a type not present in
the player's unlocked set? Can any failure state remove a ladder level or an
already-granted unlock point?

---

## 4. Legibility — anything a player commits resources against is previewable first

If a player is about to spend Coin, units, or trip risk on it, they can inspect it
beforehand.

- **Camp layout is scoutable before raiding**: fence segments and their HP, gaps,
  trap positions/types, garrison units and their stats. Reading the camp is the
  intended skill expression — do not hide it to create surprise.
- **Pack contents are previewed before purchase**: exact Coin amount, exact cosmetics.
- **Unlock costs are visible before spending**: the whole web, including nodes not
  yet affordable.
- **Merge costs, mercenary costs, and reroll costs** are shown before commit.
- Stakes are previewable: before choosing push-vs-bank, the player can see exactly
  what they stand to lose (unbanked Coin total, which units are alive and exposed).
- A wipe must always be a **foreseeable consequence**, never bad luck. If the
  player couldn't have known, the design is broken, not the player.

**QA probe:** list everything the player commits a resource against; for each,
confirm a preview exists and is accurate.

---

## 5. Account vs. caravan data split — must be right in the initial schema

Retrofitting this after multi-caravan ships would be a painful migration. Get it
right now, even though multi-caravan is post-v1.

- **Account-level** (persists across future caravans):
  trap Reputation / ladder / unlock web, siege Reputation / ladder / unlock web.
  Also account-level: Coin and its storage cap, purchases, auth identity.
- **Caravan-level** (region-specific, does not transfer):
  living-unit Reputation / ladder / unlock web, the region choice itself, the camp
  layout, owned living-unit instances and their merge levels.
- **Anything reading or writing living-unit progress at the account level, or
  trap/siege progress at the caravan level, is a bug** — not a style preference.
- The schema must already support **multiple caravans per account** (a caravan
  table keyed by account, not caravan fields inlined on the account), even though
  v1 creates exactly one. Region is chosen once per caravan and is not swappable.

**QA probe:** grep every read/write of ladder, reputation, and unlock-point state
and confirm each lands on the correct side of the split.

---

## Bounded stakes (corollary of the above, check every time)

The loss system is deliberately harsh but **bounded**:

- A trip can only risk **that trip's unbanked Coin** and **units within the
  deployment slot cap**. Never a whole collection, never banked Coin.
- Coin transferred to the killing defender is **capped by that defender's storage
  cap** — one kill can't overflow their economy.
- Per-death penalty is **one merge level, floored at level 1** — a unit type can
  never be erased by de-merging alone.
- Units alive at the moment of a trip's final wipe are lost completely.
- Unlock rights and ladder progress are **never** touched by any loss.

---

## Scope discipline

PROJECT.md is the source of truth. Do not invent mechanics or silently deviate.
Where a **number** is unspecified, use the default proposed in the chunk file and
mark it clearly as tunable — never block on balance data.

**Out of scope for v1** (do not build, do not scaffold speculatively): multi-caravan,
prestige/reset systems, recycling duplicates, campaign mode.
