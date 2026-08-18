# Chunk 19 — Stakes & loss wiring

**Depends on:** 13, 15, 16. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Wire the consequences of failure: merge-level regression on unit death, full unit
loss on a trip wipe, and the transfer of unbanked Coin to the defender who landed the
final blow. This is the last integration chunk — expect it to surface findings in the
resolver, the trip loop, and the economy.

## Design constraints that apply here

**Two independent resources are at risk, operating at different scopes — this dual
structure is deliberate, not redundant.**

**Coin (trip-scoped, all-or-nothing):**
- If a trip ends in a wipe, **all of that trip's unbanked Coin is lost**, and
  **transfers to the specific defender whose camp landed the final blow** —
  **capped by that defender's Coin storage cap, so one kill can't overflow their
  economy.**
- **Banking before a wipe locks the Coin in permanently.** Banked Coin is never at risk.

**Units (per-death, granular):**
- **Any unit that dies in any stop of a trip — regardless of whether the trip is
  ultimately banked or wiped — permanently loses one merge level, floored at level 1**
  (a unit type can never be fully erased by this alone).
- **Units still alive at the moment a trip's final wipe occurs are lost completely**
  (permadeath), not just de-merged.

Note the deliberate inversion, and get it exactly right: **units that die are
de-merged; units that survive to the wipe are destroyed.** It creates real
greed-vs-caution tension — *"units kept safely in the back (to avoid cheap per-death
de-merge dings) are exactly the ones exposed to full loss if the whole trip
collapses."* Implementing this backwards would invert the game's central risk decision.

**Why this is fair, and what must therefore hold:**
1. **Loss is never RNG-driven** — every push-or-bank decision is made with full
   information from a deterministic, scoutable system, so a wipe is a **foreseeable
   consequence, not bad luck.**
2. **Blast radius is capped by the deployment slot limit** — a catastrophic trip
   costs a slot's worth of units, **never a whole collection.**
3. **Unlock rights (the web nodes) and ladder progress are permanent and untouched by
   any of this** — a wiped-out unit type remains **fully re-acquirable**, just costly
   to rebuild.
4. It creates real greed-vs-caution tension.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `DEMERGE_LEVELS_PER_DEATH` | 1 | Floored at level 1. Fixed by design. |
| `DEMERGE_FLOOR` | level 1 | A unit type can never be erased by de-merging alone. |
| `DEMERGE_APPLIES_ON` | any death in any stop, whether the trip is banked or wiped | Not only on failure. |
| `WIPE_DESTROYS` | units alive at the moment of the final wipe | Complete permadeath for those instances. |
| `UNBANKED_COIN_ON_WIPE` | 100% lost | All-or-nothing by design. |
| `COIN_TRANSFER_RECIPIENT` | the defender whose camp landed the final blow | Exactly one recipient. Define "final blow" precisely: the camp at which the wipe occurred. |
| `COIN_TRANSFER_CAP` | recipient's remaining headroom under `COIN_STORAGE_CAP` | Excess is destroyed, not banked elsewhere and not queued. |
| `LOSS_PREVIEW_REQUIRED` | true | The bank/push prompt must itemize exactly what a wipe would cost. |

## Definition of done

- [ ] Per-death de-merge: one level, floored at 1, applied on **every** death in
      **every** stop, regardless of how the trip ends.
- [ ] Full loss on wipe applies **only to units still alive at that moment** — and a
      test asserts a unit that died earlier in the trip is de-merged, **not** destroyed.
- [ ] The inversion is covered by an explicit test: same trip, one unit dies at stop 2
      and one survives to the wipe; assert the first is de-merged and the second is gone.
- [ ] Unbanked Coin fully lost on wipe; transferred to the final-blow defender.
- [ ] Transfer capped by the recipient's storage headroom; overflow destroyed, tested.
- [ ] Banked Coin is untouched by any wipe — tested.
- [ ] **Ladder levels, Reputation-derived unlock points, and reached web nodes are
      untouched by every loss path** — tested through a total wipe.
- [ ] Blast radius bounded: a single trip can never affect units outside the
      deployment slot cap, nor Coin beyond that trip's unbanked earnings.
- [ ] The bank/push prompt itemizes exactly what a wipe would cost, before the choice.
- [ ] All effects written to the ledger (`unit_demerged_on_death`, `unit_lost_on_wipe`,
      `coin_lost_on_wipe`, `coin_transferred_to_defender`) and idempotent under retry.
- [ ] The defender is notified they received Coin and can watch the replay.

## QA guardrail checks for this chunk

- **Bounded stakes — the primary check:** *does the loss system ever exceed its
  intended scope — e.g., can a single trip touch units outside the deployment slot
  cap, or Coin beyond what that trip earned?* Try to construct a case where it does:
  concurrent trips, a retry after partial commit, a unit both garrisoned and deployed.
- **The inversion:** verify by hand that units which **died** are de-merged and units
  which **survived to the wipe** are destroyed — not the reverse. Getting this
  backwards inverts the game's central greed-vs-caution decision and would be easy to
  miss in a passing test suite.
- **Permanence:** after a total wipe, are all ladder levels, all granted unlock
  points, and all reached web nodes intact? A wiped-out unit type must remain fully
  re-acquirable.
- **Determinism:** is loss ever RNG-driven, anywhere? The design's fairness argument
  rests entirely on loss being a foreseeable consequence of a deterministic, scoutable
  system. Any randomness here breaks the justification, not just the rule.
- **Legibility:** at the bank/push prompt, is the exact cost of a wipe itemized —
  unbanked Coin, which specific units would be destroyed, which would be de-merged?
  If the player can be surprised, "foreseeable consequence, not bad luck" is false.
- **Coin cap on transfer:** can one kill overflow a defender's economy? Test a
  defender at 99% of cap receiving a large transfer.
- **Idempotency / race conditions:** a wipe job retried after partial commit must not
  double-de-merge, double-destroy, or double-transfer. A defender receiving two
  simultaneous transfers must respect the cap for both.
- **Generous acquisition holds up:** after a worst-case wipe, compute the real Coin
  and time cost to rebuild. Is recovery real in practice, not just in theory?
