# Chunk 14 — Trip loop

**Depends on:** 09, 12, 13. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

The active player loop. A caravan sets out, encounters a chain of individually
matchmade, individually scoutable camps, and after each clear the player chooses to
**bank** or **push**. This chunk chains the pieces together and owns the attrition
and trip-state rules.

## Design constraints that apply here

**A trip, in order:**
1. Player **locks in a raiding party** (composition + per-unit stance) **for the
   whole trip. No swapping mid-trip.**
2. Matchmaking presents a scoutable candidate camp.
3. Player chooses an **approach and starting positions against that specific camp**,
   then resolves the fight.
4. On a clear: **bank** (end trip, keep everything earned) or **push** (matchmaking
   serves the next stop; party carries forward whatever damage/losses it has — **no
   healing until the trip ends**).
5. Trip ends on: **voluntary bank, full party wipe, or a tick-cap stalemate**
   (favors the defender).

**Critical framing — this is not a map or travel layer.** There is **no geography,
no route-picking, no spatial overworld, no travel timer**. Do not build one. "Region"
is a one-time account/caravan-level choice unrelated to trip structure. A trip is a
chain of matchmade encounters, nothing more. This is the specific way the concept
drifted once already; watch for it.

- **One trip, regardless of how many stops it includes, consumes one use of an
  hourly trip cap.**
- **Damage and unit deaths carry forward between stops** — no healing until the trip
  ends (via bank or wipe).
- Composition and stances are **fixed for the trip**; only approach and positioning
  are chosen fresh per stop.
- **The caravan is untargetable for the full duration of the trip** — from the moment
  it starts until it's banked or wiped. **No separate travel timer; "in progress" is
  simply the state between those two points.** It becomes raidable again the instant
  the trip ends, whether by bank or wipe.
- This untargetability "adds a **minor secondary pull** toward pushing further (it
  also extends how long the home camp stays safe), **layered on top of — but not
  replacing — the loss risk that actually balances the bank/push decision.**" Keep it
  minor; if safety-farming becomes the dominant reason to push, the balance has inverted.
- **A successfully completed trip is the "delivery"** — reaching the end and banking
  *is* the delivery. There is no separate delivery step.
- The push-or-bank decision must be made **with full information** — the player can
  see exactly what they stand to lose. A wipe must be a foreseeable consequence, not
  bad luck.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `TRIPS_PER_HOUR_CAP` | 3 | Regenerating, capped at 3 stored. Consumed at trip **start**, not per stop. |
| `TRIP_CAP_REGEN` | 1 per 20 minutes | |
| `MAX_STOPS_PER_TRIP` | none (unbounded) | The party's attrition is the natural limit. Add a cap only if testing shows a degenerate infinite push. |
| `NO_HEALING_BETWEEN_STOPS` | true | Hard design rule, not tunable. |
| `HEAL_ON_TRIP_END` | full heal on bank; nothing to heal on wipe | Survivors return to full HP when the trip ends. |
| `STOP_REWARD_SCALING` | stop N Coin value = base × 1.25^(N−1) | Escalating reward is what makes pushing tempting against rising attrition. Central balance lever. |
| `TRIP_ABANDON` | not permitted mid-stop; banking is only offered **after a clear** | Per the design: the choice appears on a clear. A failed stop ends the trip. |

## Definition of done

- [ ] Trip start: locks party composition and stances, consumes one trip-cap use,
      sets the caravan to `away`.
- [ ] Per stop: matchmaking candidate → scout → choose approach/positions → resolve.
- [ ] Bank/push offered **after a clear**; push draws a fresh candidate.
- [ ] Attrition carries forward: HP damage and unit deaths persist across stops with
      no healing.
- [ ] Trip ends on bank, full wipe, or stalemate. Each path sets the caravan back to
      `parked` immediately.
- [ ] Composition/stance edits are refused for the whole trip, server-side.
- [ ] Caravan is absent from every matchmaking pool for the whole trip, and returns
      instantly on end — tested for all three end paths.
- [ ] Trip cap enforced: one use per trip regardless of stop count; regen works.
- [ ] Before the bank/push prompt, the player sees: unbanked Coin at risk, which
      units are alive and would be lost entirely on a wipe, and current party damage.
- [ ] **No geography, no route, no travel timer anywhere in the implementation.**
      A reviewer should be able to grep for map/route/travel concepts and find none.
- [ ] Survivors heal fully on bank.

## QA guardrail checks for this chunk

- **The founding hooks — check this explicitly:** does the core loop still deliver
  the King-of-Thieves hook (designing a hard-to-beat defense, and the async tension
  of checking who raided you) and the loadout-optimization hook? **Flag any
  implementation choice that quietly changes what the player is actually doing versus
  what's designed** — this chunk is where the map/travel concept drifted once before.
- **Legibility of stakes:** at the bank/push prompt, can the player see everything
  they stand to lose? If a wipe can surprise them, the design's claim that loss is
  never bad luck is broken.
- **Bounded stakes:** can a trip touch units outside the deployment slot cap, or Coin
  beyond what that trip earned? Banked Coin must be untouchable.
- **Untargetable while away:** all three end paths return the caravan to the pool
  immediately. No window where a banked caravan is still hidden, or where an away
  caravan is raidable.
- **Determinism:** is stop sequencing, reward scaling, or matchmaking within a trip
  affected by wall-clock or randomness beyond the seeded candidate menu?
- **Race conditions:** two trips started concurrently for the same account;
  a trip resolving while the same caravan is being raided; a stop resolving twice on
  a retry. Exercise the job queue from chunk 02 here.
- **Balance drift:** is the untargetable-while-away benefit still a *minor* secondary
  pull, or has it become the dominant reason to push? If players push to stay safe
  rather than for reward, the loss risk is no longer balancing the decision.
- **Grind wall check:** with `TRIPS_PER_HOUR_CAP` at 3, does the free path feel
  gated enough that paying stops feeling optional? Trip cap is not purchasable — but
  check that its interaction with Coin earn rates doesn't create pressure.
