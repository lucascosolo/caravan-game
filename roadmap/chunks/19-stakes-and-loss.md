# Chunk 19 — Stakes & loss wiring

**Depends on:** 13, 15, 16. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first, including §0 on which way round the game runs.

## Goal

Wire the consequences of failure: merge-level regression on unit death, full loss of
what survived when a caravan is overrun, and the transfer of unbanked Coin to the
owner of the raiding party that broke it. This is the last integration chunk — expect
it to surface findings in the resolver, the trip loop, and the economy.

## Orientation

The player who has something at stake is the one **playing** — the caravan escort.
The **standing raiding party's owner risks nothing**: their party is a template, not
an expedition, and loses no units however many caravans it meets. That asymmetry is
deliberate. The player who is present and making decisions carries the risk; the
player who is absent cannot lose progress while they sleep.

## Design constraints that apply here

**Two independent resources are at risk, at different scopes — deliberate, not redundant.**

**Coin (trip-scoped, all-or-nothing):**
- If a caravan is overrun, **all of that trip's unbanked Coin is lost**, and
  **transfers to the owner of the raiding party that landed the final blow** —
  **capped by that owner's Coin storage cap, so one kill can't overflow their economy.**
- **Banking beforehand locks the Coin in permanently.** It goes home to a town that
  cannot be attacked, so banked Coin is never at risk by any path. This is what makes
  banking mean something.

**Units (per-death, granular):**
- **Any unit that dies in any encounter of a trip — whether the trip is ultimately
  banked or lost — permanently loses one merge level, floored at level 1** (a unit type
  can never be fully erased by this alone).
- **Units still alive at the moment the caravan is overrun are lost completely**
  (permadeath), not just de-merged.
- **Units left in town are never at risk.** Only what was packed can be lost.

Note the deliberate inversion, and get it exactly right: **units that die are
de-merged; units that survive to the moment of collapse are destroyed.** It creates
real greed-vs-caution tension — units kept safely at the back of the circle to avoid
cheap per-death dings are exactly the ones exposed to total loss if the caravan falls.
Implementing this backwards would invert the game's central risk decision.

**Why this is fair, and what must therefore hold:**
1. **Loss is never RNG-driven** — every push-or-bank decision is made with full
   information from a deterministic, scoutable system, so being overrun is a
   **foreseeable consequence, not bad luck.**
2. **Blast radius is capped by the deployment slot limit** — a catastrophic trip costs
   a packed loadout, **never the whole roster.**
3. **Unlock rights and ladder progress are permanent and untouched by any of this** —
   a wiped-out unit type remains **fully re-acquirable**, just costly to rebuild.
4. It creates real greed-vs-caution tension.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `DEMERGE_LEVELS_PER_DEATH` | 1 | Floored at level 1. Fixed by design. |
| `DEMERGE_FLOOR` | level 1 | A unit type can never be erased by de-merging alone. |
| `DEMERGE_APPLIES_ON` | any death in any encounter, whether the trip is banked or lost | Not only on failure. |
| `OVERRUN_DESTROYS` | units alive at the moment the caravan falls | Complete permadeath for those instances. |
| `UNBANKED_COIN_ON_OVERRUN` | 100% lost | All-or-nothing by design. |
| `COIN_TRANSFER_RECIPIENT` | the owner of the raiding party that overran the caravan | Exactly one recipient. Define "final blow" precisely: the party at whose encounter the caravan fell. |
| `COIN_TRANSFER_CAP` | recipient's remaining headroom under `COIN_STORAGE_CAP` | Excess is destroyed, not queued or banked elsewhere. |
| `PARTY_OWNER_UNIT_RISK` | none, ever | A standing party is a template. Any path that damages, de-merges, or destroys its units is a bug, not a balance choice. |
| `LOSS_PREVIEW_REQUIRED` | true | The bank/push prompt must itemize exactly what being overrun would cost. |

## Definition of done

- [ ] Per-death de-merge: one level, floored at 1, applied on **every** death in
      **every** encounter, regardless of how the trip ends.
- [ ] Total loss applies **only to units still alive when the caravan falls** — and a
      test asserts a unit that died earlier is de-merged, **not** destroyed.
- [ ] The inversion is covered by an explicit test: in one trip, one unit dies at
      encounter 2 and one survives to the collapse; assert the first is de-merged and
      the second is gone.
- [ ] Unbanked Coin fully lost; transferred to the winning party's owner.
- [ ] Transfer capped by the recipient's storage headroom; overflow destroyed, tested.
- [ ] Banked Coin untouched — tested. The roster left in town untouched — tested.
- [ ] **The winning party's owner loses nothing.** A test asserts their roster is
      byte-identical before and after, including after fights their party lost.
- [ ] **Ladder levels, granted unlock points, and reached web nodes are untouched by
      every loss path** — tested through a total collapse.
- [ ] Blast radius bounded: a single trip can never affect units outside the packed
      manifest, nor Coin beyond that trip's unbanked earnings.
- [ ] The bank/push prompt itemizes exactly what being overrun would cost.
- [ ] All effects written to the ledger and idempotent under retry.
- [ ] The party's owner is notified they earned Coin and can watch the replay — this is
      the asynchronous payoff of the passive side.

## QA guardrail checks for this chunk

- **Bounded stakes — the primary check:** does the loss system ever exceed its intended
  scope? Can a single trip touch units outside the packed manifest, the roster in town,
  or Coin beyond what that trip earned? Try to construct a case: concurrent trips, a
  retry after partial commit, a unit both in the standing party and packed on the trip.
- **The standing party never bleeds:** run a party through many losing fights and
  confirm its owner's roster is untouched. A player losing units while offline, with no
  chance to react, is the failure mode this design exists to avoid.
- **The inversion:** verify by hand that units which **died** are de-merged and units
  which **survived to the collapse** are destroyed — not the reverse. Getting this
  backwards inverts the central greed-vs-caution decision and would pass a naive test suite.
- **Permanence:** after a total collapse, are all ladder levels, granted unlock points,
  and reached web nodes intact? A wiped-out unit type must remain fully re-acquirable.
- **Determinism:** is loss ever RNG-driven, anywhere? The fairness argument rests
  entirely on loss being a foreseeable consequence of a deterministic, scoutable
  system. Randomness here breaks the justification, not just the rule.
- **Legibility:** at the bank/push prompt, is the exact cost itemized — unbanked Coin,
  which specific units would be destroyed, which would be de-merged? If the player can
  be surprised, "foreseeable consequence, not bad luck" is false.
- **Coin cap on transfer:** can one kill overflow a recipient's economy? Test a
  recipient at 99% of cap receiving a large transfer.
- **Idempotency / race conditions:** a retried job must not double-de-merge,
  double-destroy, or double-transfer. A recipient taking two simultaneous transfers
  must respect the cap for both.
- **Generous acquisition holds up:** after a worst-case collapse, compute the real Coin
  and time cost to rebuild. Is recovery real in practice, not just in theory?

## Notes from chunk 04 QA

- **N6 — progression events expose the opponent's rating to the party owner.** Every
  `reputation_changed` event carries `selfRating` and `opponentRating` so the gap scaling
  is auditable, and `GET /me/progression/events` returns the player's own events verbatim.
  For the passive side that means a party owner can read the exact living Reputation of
  every caravan their party was served to. Decide in the post-fight report design whether
  the owner should see the opponent's rating, a band, or nothing — and if less than the
  raw number, filter at the read model, not by removing the field from the ledger (the
  ledger is the auditable record). No change was made in chunk 04.
