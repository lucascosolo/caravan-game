# Chunk 15 — Trip loop

**Depends on:** 07, 13, 14. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first, including §0 on which way round the game runs.

## Goal

The outer loop. A caravan sets out from town, meets a chain of individually matchmade,
individually scoutable **attacking parties**, and after surviving each one the player
chooses to **bank** (deliver) or **push**. This chunk chains the pieces together and
owns attrition, trip state, and the trip cap.

## Design constraints that apply here

**A trip, in order:**
1. Player packs the caravan in town — **manifest locked for the whole trip**: living
   units, traps, fence material. No resupply mid-trail.
2. Matchmaking presents a scoutable attacking party.
3. Player **arranges the wagon circle** against that specific party, then resolves.
4. On surviving: **bank** (end trip, deliver, keep everything earned) or **push**
   (matchmaking serves the next attacker; the caravan carries forward whatever damage
   and losses it has — **no repair, no resupply, no healing until the trip ends**).
5. Trip ends on: **voluntary bank, the caravan being overrun, or** — favorably —
   a tick-cap stalemate at which the attackers withdraw.

**Critical framing — this is not a map or travel layer.** There is **no geography, no
route-picking, no spatial overworld, no travel timer**. Do not build one. A trip is a
chain of matchmade encounters, nothing more. "Region" is a one-time choice unrelated
to trip structure. This is the specific way the concept drifted once already; watch for it.

- **One trip, regardless of how many encounters, consumes one use of an hourly trip cap.**
- **Attrition carries forward between encounters**: unit damage and deaths, destroyed
  fence segments, spent traps. Nothing is repaired or restocked until the trip ends.
- **Pushing is straightforwardly risky.** Each further encounter is another chance to
  lose the cargo and the caravan, against a party that arrives fresh while yours does
  not, and against escalating difficulty (chunk 14). **There is no safety bonus for
  staying out.** The escalating reward is the only reason to push; mounting attrition
  is the only reason to stop. That opposition is what makes bank-or-push a real
  decision — do not add any benefit to remaining on the trail.
- **Between trips the caravan is home in town and cannot be attacked at all.** There is
  no asynchronous raid against a player's caravan; the asynchronous layer is entirely
  on the standing-party side (chunk 09).
- **Banking is the delivery.** Reaching the end and banking *is* the delivery — there
  is no separate delivery step. Banked Coin goes home to a town that cannot be
  attacked, which is what makes §13's "banking locks Coin in permanently" true.
- The bank/push decision must be made **with full information**. A loss must always be
  a **foreseeable consequence, not bad luck**.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `TRIPS_PER_HOUR_CAP` | 3 | Regenerating, capped at 3 stored. Consumed at trip **start**, not per encounter. |
| `TRIP_CAP_REGEN` | 1 per 20 minutes | |
| `MAX_ENCOUNTERS_PER_TRIP` | none (unbounded) | Attrition plus escalating difficulty is the natural limit. Add a cap only if testing shows a degenerate infinite push. |
| `NO_REPAIR_BETWEEN_ENCOUNTERS` | true | Hard design rule, not tunable. Covers HP, fences, and traps alike. |
| `RESTORE_ON_TRIP_END` | full heal and full restock on bank; nothing to restore if overrun | The caravan refits in town. |
| `ENCOUNTER_REWARD_SCALING` | encounter N Coin value = base × 1.25^(N−1) | Escalating reward against rising attrition and rising difficulty. **The central balance lever of the outer loop.** |
| `TRIP_ABANDON` | not permitted mid-encounter; banking is offered only **after surviving one** | Per the design, the choice appears on surviving. Being overrun ends the trip. |

## Definition of done

- [ ] Trip start: locks the manifest, consumes one trip-cap use, sets caravan state to
      `on_trip`.
- [ ] Per encounter: matchmaking candidate → scout → arrange circle → resolve.
- [ ] Bank/push offered **after surviving**; push draws a fresh candidate at escalated
      difficulty.
- [ ] Attrition carries forward: unit damage and deaths, destroyed fence segments, and
      spent traps all persist with no repair or restock.
- [ ] Trip ends on bank, being overrun, or stalemate-then-bank. Each path returns the
      caravan to town.
- [ ] Manifest edits refused for the whole trip, server-side.
- [ ] Trip cap enforced: one use per trip regardless of encounter count; regen works.
- [ ] Before the bank/push prompt, the player sees: unbanked Coin at risk, which units
      are alive and would be lost entirely, current damage, remaining traps and fence
      material, and that the next encounter will be harder.
- [ ] **No geography, no route, no travel timer anywhere.** A reviewer should be able
      to grep for map/route/travel concepts and find none.
- [ ] Caravan is fully restored on bank.
- [ ] No path exists by which another player attacks a caravan outside a trip.

## QA guardrail checks for this chunk

- **The founding hooks — check explicitly:** does the loop deliver the King of Thieves
  hook (a hard-to-beat standing party, and the async tension of checking where it
  struck) and the loadout-optimization hook? **Flag any implementation choice that
  quietly changes what the player is actually doing versus what's designed** — this
  chunk is where the concept drifted before.
- **Which way round:** confirm the player's active experience here is defending, and
  that nothing has crept in letting them actively raid during a trip. Confirm no
  asynchronous attack against a caravan exists outside a trip.
- **Attrition is real:** push through several encounters and verify damage, deaths,
  spent traps, and broken fences all persist. If any resets, pushing is free and the
  outer loop has no stakes.
- **No safety bonus for pushing:** confirm nothing rewards remaining on the trail
  beyond the escalating Coin. The design deliberately removed the old
  untargetable-while-away pull; if some equivalent has crept back, risk and reward stop
  opposing each other.
- **Legibility of stakes:** at the bank/push prompt, can the player see everything they
  stand to lose *and* that difficulty escalates? If a loss can surprise them, the
  claim that loss is never bad luck is false.
- **Bounded stakes:** can a trip touch units outside the packed manifest, or Coin
  beyond what that trip earned? The roster in town and banked Coin must be untouchable.
- **Determinism:** is encounter sequencing, reward scaling, or difficulty escalation
  affected by wall-clock or unseeded randomness?
- **Race conditions:** two trips started concurrently for one account; an encounter
  resolving twice on a retry; a standing party edited mid-encounter. Exercise chunk 02.
- **Grind wall:** with `TRIPS_PER_HOUR_CAP` at 3, is free-path progress slow enough
  that the paid path stops feeling optional? Trip cap is not purchasable — but check
  its interaction with Coin earn rates.

## Notes from chunk 04 QA

- **N5 — no initial progression event at registration.** Registration writes no ledger
  event for a pool's starting Reputation; `pool_progress` rows are created at
  `REPUTATION_START` directly and the rebuild-from-zero fold
  (`apps/server/src/ledger/projection.ts`, `zeroPool()`) hardcodes the same constant.
  That is consistent today, but it means a retune of `REPUTATION_START` silently changes
  what "zero" means for every existing account on the next rebuild. When this chunk wires
  the first trip, decide whether registration (or the first trip) should emit an initial
  `reputation_changed`-style event per pool so the fold starts from 0 and the constant is
  recorded in the ledger. No change was made in chunk 04.
## Note from chunk 07 QA (N7) — `caravan.state` is the "on a trip" mark

`unit_instance` carries no per-unit "on a trip" flag, and chunk 07 added none. The mark is
`caravan.state = 'on_trip'`: chunk 16's fix S1 makes `performMerge`/`previewMerge` refuse
(409 `caravan_on_trip`) unless the caravan is `in_town`, which is what stops packed units
being merged away mid-trip. **This chunk must set `caravan.state = 'on_trip'` in the same
transaction as `lockManifest`, before the manifest is locked**, and set it back to
`in_town` on bank/overrun together with `closeManifest`. If the state is set after the
lock, there is a window in which a packed unit can be merged.

## From chunk 14 (matchmaking & scouting) — the seam this chunk builds on

Everything below is already built and tested in chunk 14; this chunk calls it, it does not
re-implement it. Files: `apps/server/src/matchmaking/{trips,service}.ts`, migration 009.

- **Trip rows.** `createTrip(client, caravanId)` (needs the caravan's open, locked manifest;
  one trip per manifest, at most one open per caravan — both DB-enforced) and
  `endTrip(client, tripId)`. The `trip` row is caravan-level and minimal: this chunk owns
  the trip cap (`TRIPS_PER_HOUR_CAP`), `caravan.state = 'on_trip'` (set in the same
  transaction as `lockManifest`, before the lock — chunk 07 N7 above), closing the manifest
  on bank/overrun, the `trip_started` ledger event and the bank/push loop. Trips and their
  menus are history: neither row can be deleted while the caravan exists.
- **Encounter index.** Search and choose accept `n` only while `n ===
  manifest.encounters_resolved + 1`; the manifest counter advances by exactly one per
  outcome (DB-guarded), so this chunk advances it from the resolution outcome, never by hand.
- **The encounter flow per index n:** `searchCandidates` (the player's `POST
  …/encounters/:n/search`; free, the reroll is time-gated on a caller-supplied `nowMs`)
  → `chooseCandidate` (`POST …/choose`) → `commitFormation` (chunk 07) →
  **`enqueueChosenEncounter(client, caravan, n, formation)`** — THE SEAM. It reads the
  chosen candidate from `encounter_candidates`, self-checks that its stored snapshot is
  canonical, and calls `enqueueEncounterResolution` with that snapshot as the REQUIRED
  `party` input (chunk 14 QA S1: there is no live-snapshot fallback; passing nothing throws
  before anything is written). The stored `job.input.party` is byte-identical to what the
  defender scouted, tested. `chosenCandidate(db, tripId, n)` returns the stored row shape
  (owner account id included) for this chunk's own reads; the client view omits it.
- **A new trip resets the reroll gate.** The gate is per `(trip, encounter_index)`: the
  first search of every encounter is immediate and only a repeat for the SAME encounter
  waits `REROLL_COOLDOWN_SECONDS`. Ending a trip and starting another therefore starts
  from an immediate search; nothing carries over, by design (free, time-gated, never
  resource-gated). Do not add a cross-trip cooldown here.
- **Recent opponents** are read from chosen `encounter_candidates` rows across ALL of the
  account's trips, so this chunk writes nothing extra for the exclusion to work.
- **Legibility hooks this chunk must surface before bank/push:** the menu carries
  `escalation.applied / perEncounter / nextEncounter` and each candidate carries
  `reputation.gapBeyondBand` and `reputation.sandbagEarnMultiplier`; put both next to the
  stakes preview (unbanked Coin, exposed units) in the bank-or-push decision.
