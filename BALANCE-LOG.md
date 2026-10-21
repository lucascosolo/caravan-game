# Balance log

Every tuning change, in plain English: what changed, from what to what, why, and what was measured
before and after (PHASE-2 §37). Newest pass first. Measurements come from the offline tools in
`scripts/balance/`. They are pure resolver fights through the server's own adapter path
(`resolverInputOf` = `toBattlefield` + `toResolverParty` + `resolverTunables`), so a number here is
what the server would resolve.

## Tools

| script | what it measures |
|---|---|
| `matchup-sweep.ts` | Every authored party against the defending corpus. Per matchup: the best of 76 skilled layouts, the guided arrangement, and the best of 3 naive layouts. Reports hold rate by band × roster, fight length, depth, healing offset, owner income, presence flags and pushed-trip curves by encounter index. `--quick` runs desert + mountain only (≈ 17 min at 2 jobs); the full run takes ≈ 75 min. `--json` writes the matrix and trip curves out. |
| `first-trip.ts` | A fresh account's first trip, as the server serves it (authored-only, the raider cap applied): the bands searched, and the guide's pick, layout and bank-or-push advice from the client's own code (`@caravan/circle` `guide.ts` / `guideLayout.ts`, since pass 6) at encounter 1 and at the encounter 2 the guide pushes into. This is chunk 24 QA D1's acceptance probe; pass 6 adds the pushed-encounter-2 target. |
| `probes.ts` | The two standing probes from chunk 12: the healer stalemate turtle, and structure-breaker stacking. |
| `measured-ev.ts` | Feeds the sweep's trip curves into the trip EV model (`model.ts`): EV at each roster's equilibrium band, plus the weekly free earn. |
| `trip-ev.ts` | The EV model with hand-entered rates (chunk 19). Unchanged apart from the weekly-earn band. |
| `unlock-pace.ts` | The week model read for ladder points: the days of play until the first tier-2 living unlock, at 15 / 30 / 42 trips a week and bank points 1–3 (`--costs` evaluates another cost curve). Pass 2, D8. |
| `party-rating.ts` | The Reputation equilibrium check on a sweep's `--json` matrix: each caravan roster's equilibrium band, and a standing party's siege-Reputation drift per strike by strength and band, under the current and the old party-loss rule. Pass 2, D6. |
| `first-trip.ts --raised` | The later trips' gate (play-test review round 2, S2): every region's raised starter parties (each pair of its starters, ranged pairs included, and since pass 6 the whole roster plus its refugee, 7 units) against every fresh guided roster, the guided layout and the best skilled one, and which of them a bands 0–1 search can serve against the five-post circle. Pass 4; the CI slice runs half of it. |
| `low-bands.ts` | The bands 0–1 gate (pass 8): every band 0–1 authored outfit against the 56 fresh guided packs (each region × refugee × rotation of who stays home), the guided layout; flags any under 60 % and a band with more than a third core-stance-heavy. `--variants` also fights each outfit's stance / size variants. |
| `first-trip.ts --phase` | The authored-only phase (pass 8): trip 1 then trip 2 with the attrition carried, the guide's pick, Arrange for me and encounter-aware advice throughout; delivery, Coin per trip, overruns by outfit. `--old-advice` replays the encounter-1 rule at every encounter. |
| `outliers.ts` | Authored outliers (round 3, D2): every authored party's hold rate for the best skilled layout against its band's typical rosters (and, in bands 0–1, the fresh guided pack); flags any under 20 %. `--bands` limits it. Pass 6. |
| `fast-runners.ts` | Fast core- and trap-stance runners (round 2, D1): band-0/1 authored outfits with such raiders against fresh rosters; overrun share, overruns within 20 s, units lost per fast overrun. `--explore` tries a lever. Pass 4. |
| `cold-start.ts` | The cold-start raider cap (S1; keyed on the roster since pass 3, and in bands 0–1 on the caravan's own band since pass 7) re-checked: rebuilt 1–4 unit caravans, with the cap on and off, against the authored pool. `--rating` sets the caravan's living Reputation (default REPUTATION_START). Passes 2 and 3. |
| `apps/server/test/balance-sweep.test.ts` | The CI slice, with a time budget of 150 s. It checks that encounter 1 is searched in band 0, that the guided layout holds ≥ 70 %, that the encounter 2 the guide pushes into is held ≥ 60 % (pass 6), that the harness's pick is the client's shared rule, the raised gate over what can be served, that skill beats naive, and that the sweep is deterministic. |

**The corpus and its assumptions.** Each region gets a fresh caravan and eight "band-typical"
rosters. A band-typical roster is a stated assumption of the sweep, not something measured in play.
For band ordinal o:

- 8 units (at band 0: the starting roster plus one refugee);
- merge level 1, 1, 2, 2, 3, 3, 4, 5;
- living-web tier 0, 0, 1, 1, 2, 2, 3, 4;
- six traps of the tiers reachable by then (traps cost nothing to pack);
- a full fence budget of the best tier reachable by then.

"Skilled" means the best of the search set. A player cannot try all 76 layouts, so this is an
upper bound on what one reading of the scout gets. "Naive" layouts ignore the scout.

A roster's **equilibrium band** is the highest band whose skilled encounter-1 hold rate is at least
the Reputation break-even. The break-even is 20 / (8 + 20) ≈ 71 % since change #27 (20 / (10 + 20) ≈ 67 % from #16; 20 / (15 + 20) = 57 % before), because a hold earns +8 and an
overrun costs −20.

---

## Pass 9 — 2026-10-21 (chunk 50: the guide's layout on the round wagon ring). RESOLVER_VERSION 10 (chunk 50's bump).

No unit stat, authored party or tunable changed: `AUTHORED_SET_VERSION`, `FENCE_MATERIAL_BUDGET`
(11) and the 60 % gate are as chunk 50 left them. Only the guide's "Arrange for me" rule changed
(`@caravan/circle` `guideLayout.ts`, shared by the client checklist and the harness).

**Why the guided layout lost on the round ring.** One raider reaching the core is an overrun, and
the ring's core sits about four cells inside it. Two things in the square-camp rule broke:

- *The leftover openings faced the raiders.* The rest of the fence went side by side (main side,
  then sides by raider count, then ENTRY_EDGES order). The ring's sides are labels on a circle:
  "west" positions 13 and 14 sit on the north-west diagonal, a few cells from the north band, and
  with 11 segments for 16 positions they were the ones left open. Dry Gulch Boys (2 core runners,
  one edge) went straight through them: overrun at tick 150 with the defenders untouched, 7 / 56.
- *Every post stood behind the main gap.* Against 2- and 4-edge `nearest` parties the far-side
  raiders broke or walked through an opening the posts could not reach in time (Windmill, Alkali,
  Hardrock overruns at ~85–90 % defender HP, no deaths).

A fence budget sweep 8..15 did not help because neither cause is the amount of fence.

**The rule now.** Step 3: posts go round-robin over the edges raiders start on (most raiders
first); a main-side unit behind the gap as before, any other side's unit on the core front two
cells toward that side. Step 5: the rest of the fence goes nearest a raider's entry edge first,
so the openings the budget cannot close are the farthest from the raiders. Steps 1, 2 and 4 are
unchanged. Variants measured and rejected (`low-bands.ts`, held of 56, outfits under the bar):
posts deeper / shallower / at the core or midway (5–7 under); threat-ordered fence with the old
posts (5 under: Dry Gulch fixed, the multi-edge outfits not); posts evenly round the core (4–5
under); the sum of edge distances instead of the nearest (2 under: Hardrock, Snake Oil).

`low-bands.ts`, guided vs 56 fresh guided packs, before → after:

| outfit | before | after |
|---|---|---|
| Dry Gulch Boys (b0, 2 core, 1 edge) | 7 | 56 |
| Prairie Wolf Pack (b0, 2 nearest, 2 edges) | 26 | 56 |
| Alkali Freighters (b0, 4 nearest, 4 edges) | 33 | 56 |
| Windmill Gang (b0, 4 nearest, 4 edges) | 30 | 56 |
| Hardrock Hirelings (b0, 4 nearest, 4 edges) | 26 | 40 |
| Claim Jumpers' League (b0) | 41 | 52 |
| Snake Oil Caravan (b1, 4 nearest, 4 edges) | 13 | 37 |
| Rattler Den Gang (b1) | 46 | 42 |
| Buffalo Wallow Crew (b1) | 35 | 56 |
| Vulture Roost Crew (b1) | 47 | 46 |
| Mesa Line Riders (b1) | 43 | 47 |
| The Avalanche Club (b1) | 49 | 53 |
| The Cistern Gang (b1) | 51 | 51 |
| every other band 0–1 outfit | 56 | 56 |

- Band 0 74 % → **97 %**, band 1 84 % → **91 %** (square camp, pass 8: 97 % / 93 %). Under the
  bar: 6 → 0. Lowest: Snake Oil 37 / 56 (66 %) and Hardrock 40 / 56 (71 %), the two 4-edge
  `nearest` outfits; the next balance pass should watch them.
- The CI slice (`balance-sweep.test.ts`) passes whole: first trip ≥ 70 % and pushed encounter 2
  ≥ 60 %, the authored-only phase ≥ 50 %, the raised gate, skill over naive.

---

## Pass 8 — 2026-10-20 (the authored-only phase: bands 0–1 re-authored; the guide's raise). RESOLVER_VERSION unchanged at 9.

No resolver code changed, and no unit stat or tunable that a fight reads changed. The goldens and
work counters are unchanged. The authored set moves to v7 (bands 0–1 only). The guide's one-tap
raise changes in two ways: a smaller size, and a different order and stance. That folds in pass 7's
open item. The harness now models the whole authored-only phase with the round-4 rules: the
encounter-aware advice and `raiseUnits`.

### What changed

| # | number | from → to | why |
|---|---|---|---|
| 33 | `AUTHORED_REAUTHORED`, bands 0–1 (`AUTHORED_SET_VERSION` 6 → 7) | 12 band 0–1 outfits re-authored (table below) | Re-plays showed trip 2 banking about 1 in 4 during the authored-only phase, with the guide's help. Almost every loss was to a core-stance outfit, or to Prairie Wolf Pack, in bands 0–1. The decision: at most a third of each band core-stance-heavy (half or more raiders on `core`). Every band 0–1 outfit must be held ≥ 60 % by the guided layout of the guide's default pack. Variety and rising difficulty stay. New override fields `edgeCount`, `types` and `siege`: each region keeps a 1-, 2- and 4-edge party in each band, and an edge split only moves between two of a region's own outfits. |
| 34 | `SUGGESTED_PARTY_MAX` | 5 → **3** | Pass 7's open item, re-measured under round 4's raise (`raiseUnits`: two starter edges, stance by role). A raise of 5 was held by a fresh guided five-post circle only 0 % (desert), 30 % (high plains), 22 % (mountain) and 41 % (badlands) of the time. It is served to such circles from a caravan's third trip. See "The raise" below for why 3 and not 4. |
| 35 | the raise's order (`@caravan/circle` `raiseOrder`, inside `raiseUnits`) | roster order → **round-robin over unit types** | With 3 raised from a fresh roster (3 + 3 of two starter types, then the refugee), roster order raises A, A, A, for example three Dust Riders or three Grizzlies. Round-robin raises A, B, A. Measured, it is the stronger lever at every size (below). |
| 36 | the raise's stance for a `dash` type (`raiseStance`) | `core` → **`nearest`** | Under round 4's rule a desert raise (Dust Rider dash → `core`, Well Digger → `traps`) was held 0–12 % at every size, and high plains (Prairie Wolf dash) 17–53 %. Core runners from two sides beat a guided circle whatever its size. Breakers and bursts still raise `traps`, and both starter edges stay, so the population of raised parties still varies (round 4 D2). A player who wants runners sets `core` in the builder. |
| — | the harness (`first-trip.ts`, `sweep.ts`) | — | `guideAdvice` passes the encounter just survived (round 4 D1). `raisedStarterParty` raises through `raiseUnits`; the raised gate fights the raises of 4 caravans, one per starter-edge pair. New `first-trip.ts --phase`: the whole authored-only phase, trip 1 then trip 2, with the attrition carried. It uses the guide's pick, "Arrange for me" (`guidedFormation`) and the advice at every encounter, plus Coin per trip (`--old-advice` replays the encounter-1 rule at every encounter). New `low-bands.ts`: the bands 0–1 gate. Both have a CI slice. |

**#33 — bands 0–1** (`low-bands.ts`: the guided layout against 56 fresh guided packs, i.e. each
region × each refugee × every rotation of who stays home; held before → after):

| outfit | was | now | held |
|---|---|---|---|
| Dry Gulch Boys (b0, desert) | 2 nearest | **core**: band 0's core-stance outfit | 56 → 56 |
| Grizzly Creek Trappers (b0) | 2 core | traps | 30 → 56 |
| Timberline Gang (b0) | 2 core | mixed (nearest + traps) | 28 → 56 |
| Prairie Wolf Pack (b0) | 2 traps | nearest | 50 → 56 (the guide's most frequent encounter-1 pick, and the phase's top overrunner) |
| Windmill Gang (b0) | 4 traps, 4 edges | nearest | 19 → 52 |
| Claim Jumpers' League (b0) | 4 mixed, 4 edges | traps | 5 → 54 |
| The Cistern Gang (b1, desert) | 3 traps | **core**: band 1's core-stance outfit | 56 → 52 |
| Sodbusters' Levy (b1) | 4 core | traps | 34 → 56 |
| Buffalo Wallow Crew (b1) | 4 core | nearest | 0 → 56 |
| The Grange Riders (b1) | 4 core, 4 edges | traps | 7 → 56 |
| The Avalanche Club (b1, mountain) | 3 mixed, 2 edges | 4 Trappers, nearest, no siege, **4 edges** | 13 → 46. A Grizzly party from four sides held ≤ 6 whatever its stance or siege. |
| Mule Skinner Mafia (b1, mountain) | 4 mixed, 4 edges | 3 mixed, **2 edges** | 0 → 56 |
| *(Hardrock Hirelings, b0, pass 6: 4 nearest)* | | unchanged | 46 |

- Every band 0–1 outfit now clears the bar. The lowest are Hardrock Hirelings 46 / 56 (82 %) and
  The Avalanche Club 46 / 56.
- Band 0 is held 76 % → **97 %** overall, and band 1 61 % → **93 %**.
- Core-stance-heavy: band 0 2 / 12 → 1 / 12, band 1 3 / 12 → 1 / 12.
- Raiders per band are unchanged (32 · 44), and so is every band above.
- Variety: ranged-only outfits (Gunslinger's Dozen, Bounty Board Riders, Rattler Den Gang, Vulture
  Roost, Snake Oil, Avalanche) and trap-runners (Homestead Holdouts, Grizzly Creek, Claim Jumpers,
  Sodbusters, Grange Riders, Sidewinder, Mesa Line) stay. So do siege pieces, the two core
  outfits, and every stance pattern in each band.

**Difficulty still rises, but less steeply into band 1.**
- Guided against the guide's pack: band 0 97 %, band 1 93 %.
- Sweep, fresh roster (7 units): skilled 100 / 100 / 92 % and guided 100 / 100 / 63 % at bands
  0 / 1 / 2 (before: skilled 100 / 90 / 92 %).
- The step into band 2 is steep for the guided layout. A caravan meets band 2 only after leaving the
  floor, with live parties served by then (open item 2).

### Before → after

"Before" is main at e0a40ab (set v6, `SUGGESTED_PARTY_MAX` 5, round 4's raise). Every number is
measured with the round-4 rules: encounter-aware advice and `raiseUnits`.

**The authored-only phase** (`first-trip.ts --phase`, 200 fresh caravans; trip 1 then trip 2 with
the attrition carried; the guide's pick, Arrange for me and advice throughout; at most 5 encounters):

| | before | **after** | after, the encounter-1 advice rule throughout (`--old-advice`) |
|---|---|---|---|
| trip 1 delivered | 156 / 200 = 78 % | **189 / 200 = 95 %** | 183 / 200 = 92 % |
| **trip 2 delivered (target ≥ 50 %)** | 137 / 200 = 69 % | **188 / 200 = 94 %** | 187 / 200 = 94 % |
| trip 2, by region (desert / high plains / mountain / badlands) | 20 / 19 / 50 / 48 of 50 | 49 / 43 / 50 / 46 | 47 / 42 / 50 / 48 |
| trip 2 after an overrun on trip 1 | 6 / 44 | 2 / 11 | 7 / 17 |
| Coin delivered per trip (mean, overruns 0), trip 1 / trip 2 | 1,231 / 1,072 | **1,374 / 1,397** | 2,462 / 2,515 |
| encounters per trip (mean); share that reaches encounter 3 | 1.79; 1 % | 1.79; 1 % | 2.61; 44–49 % |
| top overrunners (both trips) | Prairie Wolf Pack 37, Timberline Gang 31, Sodbusters' Levy 19 | The Cistern Gang 11, Deadfall Crew 4, Prairie Wolf Pack 3 | Cistern 10, Deadfall 9, Prairie Wolf 3 |

- **The two advice rules** (round 4 D1, measured as asked):
  - Delivery is about the same under both: 95 % / 94 % against 92 % / 94 %.
  - The new rule banks almost every guided trip at encounter 2, because a circle is rarely
    untouched. So it delivers about **half the Coin per trip**: 1,374 against 2,462.
  - The old rule pushed 44–49 % of trips to encounter 3, and lost few more of them.
- **The outfits the re-plays named** (overruns in the phase before → after):
  - Prairie Wolf Pack 37 → 3. As the encounter-1 pick it is now held 110 / 110 (was 99 / 110).
  - Timberline Gang 31 → 2. As the pick it is held 28 / 28 (was 11 / 28).
  - Grizzly Creek Trappers 6 → 0.
  - The remaining overruns are mostly The Cistern Gang. It is band 1's one core-stance outfit, so
    some outfit has to fill that role, and Cistern is the best-held core variant in band 1. It
    overruns hurt circles on trip 2.

**Target 1 — the guided first trip** (`first-trip.ts`, 200 caravans):

| | before | after |
|---|---|---|
| encounter 1, guided (target ≥ 70 %) | 172 / 200 = 86 % | **200 / 200 = 100 %** |
| pushed encounter 2, the guide's pick and layout (target ≥ 60 %) | 140 / 156 = 90 % | **145 / 156 = 93 %**; best skilled 151 / 156 = 97 % |
| first trip delivered (one hold, then an advised bank, or a hold, a push and a hold) | 156 / 200 = 78 % | 189 / 200 = 95 % |

**The raise** (pass 7's open item; the guided layout against the fresh guided packs, raised by
`raiseUnits` for 4 caravans, one per starter-edge pair; 112 fights per cell):

| raise | desert | high plains | mountain | badlands |
|---|---|---|---|---|
| **before**: 5, roster order, dash → core | **0 %** | **30 %** | **22 %** | **41 %** |
| 4, roster order (pass 7's `SUGGESTED_PARTY_MAX` 4 lever) | 0 % | 50 % | 32 % | 66 % |
| 3, roster order | 0 % | 85 % | 48 % | 69 % |
| 4, round-robin | 6 % | 17 % | 54 % | 79 % |
| 3, round-robin | 12 % | 53 % | 71 % | 85 % |
| 4, round-robin, dash → nearest | 66 % | 57 % | 54 % | 79 % |
| 4, round-robin, dash → nearest, one edge | 100 % | 100 % | 72 % | 83 % |
| **after: 3, round-robin, dash → nearest** (#34–36) | **73 %** | **76 %** | **71 %** | **85 %** |

- Pass 7's two levers do not reach 60 % on their own. With "fewer ranged units first", mountain
  gets worse: its Trappers are the easy half and its Grizzlies the hard one. With 4, desert stays
  at 0 %.
- With round 4's raise, the core stance is what decides: desert and high plains start with a dash
  type.
- 4 with a single edge also clears the bar, but it undoes round 4 D2's spread across two edges. 3
  keeps both edges and every role but dash, and clears 60 % in every region.
- The passive side stays live. A 3-raider party is served to every circle that packs 3 or more, in
  bands 0–1 too.

The later trips' gate (`first-trip.ts --raised`, 768 fights: 24 raised parties × 8 fresh packs × 4
caravans; all 76 layouts):
- The suggested party (3), guided / best: desert 26 / 32, 32 / 32; high plains 24 / 32, 32 / 32;
  mountain 28 / 32, 32 / 32; badlands 28 / 32, 32 / 32.
- **What a bands 0–1 search can serve: guided 416 / 512 = 81 %, best 512 / 512 = 100 %** (targets
  60 / 70 %).
- The weakest pair a player could still raise by hand is two Well Diggers, held 18 / 32 guided.
- Whole rosters of 7 are never served in bands 0–1 against 5 posts. Mountain holds them 2 / 32 and
  0 / 32, Badlands 6 / 32 and 2 / 32.

**Targets 2–4** (the full sweep, 6,528 matchups; `measured-ev.ts`):
| | before (passes 6–7) | after |
|---|---|---|
| band-typical at its own band, skilled / guided / naive: b0; b1 | 100/89/90; 90/74/85 | 100/100/100; 100/97/94 (b2–b7 unchanged) |
| skilled − naive at the band-typical diagonal | 26 pts | 25 pts |
| stalemates (corpus; turtle) | 0; 0 / 96 | 0; 0 / 96 (turtle 83 held / 13 overrun, healing offset 44 %) |
| fight length median; share in 20–90 s | 21.8 s; 59 % | 21.8 s; 58 % |
| overruns in the corpus | 1730 | 1701 |
| flagged within band × stance | 7 | 6, none above 32 pts |
| held share of core-stance parties, b0…b7 | 100 92 89 56 39 40 20 26 | 100 100 89 56 39 40 20 26 |
| equilibrium band, fresh / L1 / L2 / L3 / L4 | 3 / 3 / 4 / 4 / 7 | 3 / 3 / 4 / 4 / 7 |
| **trip EV best bank point L1 / L2 / L3** | +5,960 / +9,485 / +5,783 | **+5,960 / +9,486 / +5,785** (L4 still negative) |

**The cap and the runners:**
- `cold-start.ts` at 400: a rebuilt caravan packing 1 / 2 / 3 / 4 units, guided with the cap on,
  holds 48 / 69 / 90 / 90 %.
- `fast-runners.ts`: no band 0–1 outfit with a core- or trap-stance raider overruns a fresh guided
  pack. That is 0 of 112 fights; pass 6 had 38 % of 136.
  The phase's remaining overruns are against hurt circles on later encounters, which this probe
  does not model.

### Tests whose pins moved

- server `balance-sweep` (the CI slice), two new gates:
  - the bands 0–1 gate: core-heavy ≤ a third per band, and every band 0–1 outfit ≥ 60 % over 16
    packs;
  - the authored-only phase: trip 2 delivered ≥ 50 % over 32 caravans.
  - The raised gate fights one caravan's raise.
- server `final-review-r4`: the suggested party is 3, round-robin (Grizzly, Trapper, Grizzly).
- server `final-playtest-r4`: the raise rule is checked by its place in `raiseOrder`.
- web `guideModel`: the raise's expected order is `raiseOrder`.
- circle `raise.test`: dash raises `nearest`; a `raiseOrder` case.

### Open — for the play test's telemetry

1. **Coin per guided trip under the round-4 advice**: about half of what the encounter-1 rule
   delivered (1,374 against 2,462), with the same delivery rate. Watch push rate and Coin per trip
   by encounter index on guided trips.
2. **The step into band 2** for a circle arranged the guide's way: the fresh roster's guided hold
   goes 100 % → 63 %.
3. **The Cistern Gang**, band 1's one core-stance outfit, is now the phase's top overrunner, with 11
   of 400 trips.
4. **Round 4 D3**: the defender picks from three, so a strong party is rarely chosen, and the
   passive hook rewards looking weak. Watch strikes per live party by party size and strength, and
   the share of menus where the largest party is passed over.
5. **Round 4 D5**: a week of steady play ends about where it started, with Coin idle. Watch merge
   levels lost per week against merge levels bought, Coin balance at day 7 by decile, and the share
   of merged units posted at the gap.
6. Still open from passes 6–7: whole raised rosters above band 1, 8 × L3 one fight under the band-5
   break-even, healing in the four-healer turtle, 8 × L4 trip EV, and core-stance dominance from
   band 3 up.

---

## Pass 7 — 2026-10-20 (final guardrail review round 4: S1, D1). RESOLVER_VERSION unchanged at 9.

No resolver code, no unit stat and no tunable a fight reads changed, so the goldens and work counters
are unchanged and the authored set stays at v6. Two matchmaking rules changed and one new tunable
shapes what the guide raises.

### What changed

| # | number | from → to | why |
|---|---|---|---|
| 31 | `COLD_START_PACKED_CAP_MAX_BAND` (#29) | keyed on the **search centre's** band → keyed on the **caravan's own** band (bandOf its living Reputation) | Round-4 D1. Keyed on the centre, every caravan rated below 850 was capped at encounter 1 (searched 150 below it), band-2 caravans paid ×2.0 included: a 7-unit caravan at 840 packing one unit met only 2-raider floor outfits. The rule is for low-band caravans, so it now reads their band. The menu row records `raider_cap.caravanBand` (older rows keep `centreBand`). |
| 32 | `SUGGESTED_PARTY_MAX` (new) | — → **5**: "Raise my party" and the server's `suggested` party add roster units only up to 5 (a saved party is never cut; a bigger one can still be built by hand) | Round-4 D1, the passive side. With #29 a party bigger than a new player's packed circle (5, the guide's pack) is never served to them in bands 0–1, so the guide's whole-roster party of 7 was hardly ever served while most testers live there. At 5 it is. |
| — | the cap's input (round-4 S1, a fix, not a tunable) | computed over every party near the centre → computed over the parties the draw can serve, **after** the authored-only filter | Three live one-raider parties held the cap at 1, the authored-only rule then dropped them, and a 1-unit caravan before its second bank had nothing to draw (503, stuck on the trail). Against the authored pool alone nothing a harness measures moves: the cap relaxes over the same authored parties as before. |

### Measured (all at this pass; `first-trip.ts` and `cold-start.ts` read the caravan-band key through `sweep.ts servedMenu`)

**Target 1 — the guided first trip** (`first-trip.ts`, 200 caravans): **identical to pass 6.** A new
caravan (400, band 1) searches encounter 1 at 250 and encounter 2 at about 405: both the old key and
the new one put it under the cap.

| | pass 6 | **pass 7** |
|---|---|---|
| encounter 1, guided (target ≥ 70 %) | 172 / 200 = 86 % | **172 / 200 = 86 %** |
| the guide's advice after a hold | bank 16, push 156 | bank 16, push 156 |
| pushed encounter 2, guide's layout (target ≥ 60 %) | 140 / 156 = 90 % | **140 / 156 = 90 %**; best skilled 145 / 156 = 93 % |
| first trip delivered | 156 / 200 = 78 % | **156 / 200 = 78 %** |

**The later trips' gate** (`first-trip.ts --raised`, now 192 fights: the 160 of pass 6 plus each
region's **suggested party of 5**, the first five of its starting roster, against the 8 fresh guided
packs; all 76 layouts):

| raised party | guided / best | served in bands 0–1 against 5 posts? |
|---|---|---|
| every region's pairs (12 parties) | 96 / 96, 96 / 96 | yes |
| whole rosters + refugee (7) | unchanged from pass 6 (desert 12 / 16, high plains 16 / 16, mountain 2 / 16, badlands 0 / 16) | no |
| desert suggested (5) | 8 / 8, 8 / 8 | **yes (new)** |
| high plains suggested (5) | 8 / 8, 8 / 8 | **yes (new)** |
| mountain suggested (5) | **2 / 8, 4 / 8** | **yes (new)** |
| badlands suggested (5) | **2 / 8, 6 / 8** | **yes (new)** |
| **what can be served** (targets 60 / 70 %) | pass 6: 96, 100 % / 100 % | **128: guided 116 = 91 %, best 122 = 95 %** |
| everything | pass 6: 160, 79 % / 83 % | 192: guided 146 = 76 %, best 158 = 82 % |

The targets hold. The CI slice (`balance-sweep.test.ts`: one fresh pack per region, 24 layouts) now
scores 64 served fights of 96 and passes. The cost is visible in two rows: a tester's raised Mountain
or Badlands party of 5 is now served to a fresh 5-post circle after its second bank, and the guided
layout holds it 2 of 8 times (the best layout 4 and 6 of 8). That is the passive side being served, as
decided; it is the open item below.

**The cap re-checked** (`cold-start.ts`, 4 regions × 25 seeds; rebuilt rosters of 1–4 unmerged
starters, which the roster rule caps at any band):

| packed | rating 400: cap off / on (guided, skilled) | rating 700: off / on | rating 840: off / on |
|---|---|---|---|
| 1 | 48 / 67 %, 48 / 67 % | 12 / 12 %, **48 / 67 %** | 0 / 0 %, **48 / 67 %** |
| 2 | 58 / 88 %, 54 / 83 % | 46 / 49 %, **54 / 83 %** | 0 / 0 %, **54 / 83 %** |
| 3 | 71 / 82 %, 68 / 78 % | 56 / 58 %, 35 / 43 % | 1 / 25 %, 35 / 43 % |
| 4 | 81 / 93 %, 81 / 93 % | 61 / 67 %, 61 / 67 % | 9 / 40 %, 31 / 55 % |

A rebuilding caravan keeps the band-0 rebuild odds at any rating, as pass 3 decided (the rows move
from pass 3's only through pass 6's re-authored outfits). The 3-packed cell that the cap makes worse at
700 (pass 3 named it) is unchanged.

**What #31 stops** (live, round-4 review, recorded there): a 7-unit caravan at 840 packing one unit
was capped to three 2-raider outfits; it now meets the 4–5-raider parties of its search. The tanked
one-unit pack was not a Coin farm (round-4 table: +181 to +725 a trip against +5 960 for honest
8 × L1 play), so no EV number here moves.

### Tests whose pins moved

- server `matchmaking-pure`: `coldStartRaiderCap` takes the caravan's rating (third argument); the
  record field is `caravanBand`; a new case: centre in band 1, caravan in band 2 → not capped, and the
  reverse → capped.
- server `matchmaking`: the r3 S2(b) test reads `caravanBand`.
- server `party`: the suggested party is the first `min(PARTY_SLOT_CAP, SUGGESTED_PARTY_MAX)` units.
- server `balance-sweep`: the raised gate is 96 fights, 64 served.
- web `guideModel` / `Onboarding`: the guide's raise stops at `SUGGESTED_PARTY_MAX`.

### Open — for the play test's telemetry

1. **Raised Mountain and Badlands parties of 5 against fresh 5-post circles** (guided 2 / 8 each).
   They are served from a caravan's third trip on. Watch the new dashboard panel
   `partyStrikes` (strikes per live party by party size, and how many were against bands 0–1) next to
   overrun-by-band for bands 0–1: if those parties overrun most caravans they meet, the lever is the
   guide's raise (fewer ranged units first) or `SUGGESTED_PARTY_MAX` 4, not the cap.
2. Everything still open from pass 6.

---

## Pass 6 — 2026-10-20 (final play-test review round 3: S1's harness, S2, D1–D3). RESOLVER_VERSION unchanged at 9.

No resolver code changed, and no unit stat or tunable that a fight reads changed, so the goldens
and work counters are unchanged. Two matchmaking rules changed, 19 authored outfits were
re-authored (10 outliers, plus 9 that put the difficulty of bands 5–6 back), and the harness now
runs the client's own guide code.

### What changed

| # | number | from → to | why |
|---|---|---|---|
| 28 | `AUTHORED_ONLY_FIRST_TRIPS` → **`AUTHORED_ONLY_UNTIL_BANKS`** | the first trip → **until the caravan has banked 2 trips**; a voided or overrun trip does not count | Round-3 S2(a). Trip 2 was serving other testers' whole raised rosters, 7 raiders against 5 posts. Badlands held 0 of 16 and Mountain 2 of 16. A caravan now meets authored outfits only, at every encounter, until it has banked twice. The menu still records `draw_rules.authoredOnlyTrip`. |
| 29 | `COLD_START_PACKED_CAP_MAX_BAND` (new) | — → **1**: while the search centre is in band 0 or 1, the raider cap applies whatever the roster size | Round-3 S2(b). In bands 0–1, no party with more raiders than the caravan packed is offered. The cap relaxes only to fill a menu, as before. It is stored on the menu row (`raider_cap.centreBand` / `bandMax`), so menus replay. Above band 1 the roster rule (`COLD_START_ROSTER_MAX`, #23) is unchanged. |
| 30 | `AUTHORED_REAUTHORED` (new, authored.ts; `AUTHORED_SET_VERSION` 5 → 6) | 19 outfits; table below | Round-3 D2. Every authored party whose best skilled layout held its band's typical rosters less than 20 % of the time was re-authored. In bands 0–1 the fresh five-post pack counts as a typical roster too. Lifting the six band-5/6 outliers made those bands easy: band 5 at its own band went from 67 % to 84 %. That moved 8 × L3 up to band 5, where its trip EV is negative. Nine other outfits there were made harder to put the curve back. |
| — | the harness's guide (`sweep.ts guidePick` / `GUIDED`, `first-trip.ts`) | its own mirror of the client, at encounter 1 only → **the client's code from `@caravan/circle`**: `guide.ts` (the pick and the bank-or-push advice, new) and `guideLayout.ts` (`guidedFormation`, the client's), at every guided encounter | Round-3 S1. The pick passes over ranged-only parties, then takes the smallest. The advice never suggests a push when every candidate is ranged-heavy and the circle is hurt. Encounter 2 is arranged with the guide's layout over the survivors. `first-trip.ts` and the CI slice measure pushed encounter 2 only where the guide advises the push. Before the switch, the old `GUIDED` port and `guidedFormation` built byte-identical formations in all 6,528 sweep matchups and in 444 pushed-encounter survivor manifests, so no earlier number moves. A CI test pins the harness's pick to the shared function. apps/web imports the same module; its own `guideRule.ts` is gone. |
| — | `first-trip.ts --raised` | the whole starting roster (6) → **the whole roster plus the refugee (7)**, one variant per starter type as the refugee | Round-3 S2: 7 is what "Raise my party from my roster" actually makes. The gate's targets are read over the fights a bands 0–1 search can still serve against the five-post circle. Every fight is still reported. |

**#30 — the re-authored outfits** (`outliers.ts`, the best of 76 skilled layouts. "Typical" means
the band's 8 typical rosters; "fresh-5" means the 8 fresh guided packs):

| outfit (band) | was | change | typical held, before → after |
|---|---|---|---|
| Hardrock Hirelings (b0) | 4 core, mountain | stance → nearest | 3/8 → 8/8; fresh-5 **0/8 → 8/8**. Mixed gave 6/8 fresh-5 and still lost pushed encounter 2. |
| Boot Hill Society (b3) | 6 core | stance → mixed | 0/8 → 3/8 |
| The Cirque Company (b4) | 6 core | stance → mixed | 1/8 → 5/8 |
| Prairie Doctor's Party (b5) | 7 core | mixed, 6 raiders | 0/8 → 7/8 |
| Buffalo Hunter Cooperative (b5) | 7 core | mixed, 8 raiders | 0/8 → 2/8 |
| Lumberjack Levy (b5) | 7 mixed | 6 raiders | 0/8 → 3/8 |
| Copper Canyon Cartel (b6) | 8 core | 7 raiders (mixed held 1/8) | 0/8 → 2/8 |
| Sand Ridge Wranglers (b6) | 8 core | stance → mixed | 0/8 → 8/8 |
| Cyclone Cellar Boys (b6) | 8 mixed | stance → nearest (one or two fewer held 1/8) | 0/8 → 7/8 |
| The Ocotillo Ring (b6) | 8 core | stance → nearest (mixed or fewer held 0/8) | 0/8 → 8/8 |
| *harder, to keep the curve:* Coffin Ridge Riders (b5) | 7 nearest | stance → mixed | 8/8 → 2/8 |
| Scorpion Pass Toll (b5) | 7 traps | stance → mixed | 8/8 → 6/8 |
| Pine Marten Crew (b5) | 7 mixed | 8 raiders | 8/8 → 6/8 |
| Badwater Toll Company (b5) | 7 nearest | mixed, 8 raiders | 8/8 → 7/8 |
| Boulder Field Boys (b6) | 8 nearest | stance → mixed | 8/8 → 4/8 |
| Icefall Irregulars (b6) | 8 nearest | stance → mixed | 7/8 → 2/8 |
| Pack Mule Brigade (b6) | 8 nearest | stance → core | 7/8 → 6/8 |
| Gallows Gulch Gang (b6) | 8 traps | stance → mixed | 7/8 → 6/8 |
| Dead Man's Draw Outfit (b6) | 8 traps | stance → mixed | 8/8 → 7/8 |

- After the change, no authored party is below the bar. The lowest are 2/8 (25 %): Buffalo
  Hunter, Coffin Ridge, Copper Canyon and Icefall. Claim Jumpers' League (b0) holds 8/8 typical
  and 4/8 fresh-5, so it stays as it was.
- Band-typical held at its own band, b0…b7: before 95 · 90 · 100 · 84 · 84 · 67 · 60 · 92 % →
  after **100 · 90 · 100 · 88 · 89 · 68 · 74 · 92 %**.
- The set still passes `validateSpecs`. Tier, base merge level and raiders in the band never fall,
  and one of them rises at every step. Raiders per band: 32 · 44 · 54 · 66 · 72 · 85 · 95 · 96.
- Every band still fields every stance pattern. Band 5's core-stance outfit is Tallgrass Toll
  Riders; band 6's are Copper Canyon Cartel and Pack Mule Brigade.
- For one roster, a band up is still harder. The 8 × L3 circle (b4-typical defensive) holds
  92 · 90 · **71 · 40** % at bands 3–6.

### Before → after

"Before" is main at e73a8ab. The first-trip and raised numbers come from the round-3 reviewer's
probes (`probes/probe1-25.txt`, `_r3probe2.ts`) and the client behaviour seen in play. The sweep
numbers come from pass 5's full sweep. `outliers.ts` was also run on main's content. "After" is
this pass. The full sweep has 6,528 matchups.

**Target 1 — the guided first trip** (`first-trip.ts`, 200 caravans):

| | before (the client in play) | after |
|---|---|---|
| encounter 1, guided (target ≥ 70 %) | 172 / 200 = 86 % | **172 / 200 = 86 %** |
| the guide's advice after a hold | push, every time | bank 16, push 156 |
| pushed encounter 2, guide's layout (new target ≥ 60 %) | 97 / 172 = **56 %**: the smallest party, the scout reading not shown, a free layout | **140 / 156 = 90 %**: the guide's pick and layout; best skilled 145 / 156 = 93 % |
| encounter 2 over every hold, guide's pick: guide's layout / best skilled | 148 / 172 = 86 % / 154 / 172 = 90 % (the reviewer's guidePick row) | 154 / 172 = 90 % / 160 / 172 = 93 % |
| first trip delivered | ≈ 48 % (0.86 × 0.56) | **156 / 200 = 78 %** (a hold then the advised bank, or a hold, a push and a hold) |

The guide's picks at pushed encounter 2, as guide's layout / best / fights:

- Deadfall Crew 77/77/78.
- The Cistern Gang 28/28/28.
- Sodbusters' Levy 31/36/46.
- Hardrock Hirelings 4/4/4 (before #30: 0/0/4). Against Badlands, the case the client fixer's
  re-play lost, Hardrock now loses to every fresh Badlands pack (14 of 14 rotations, guided and
  best) and to all 3 Badlands circles pushed into it.

**The later trips' gate** (`first-trip.ts --raised`: 160 fights, 7-unit whole rosters, all 76
layouts):

| raised party | guided / best (the same fights before and after) | served in bands 0–1 against 5 posts? |
|---|---|---|
| every region's pairs (12 parties) | 96 / 96, 96 / 96 | yes |
| desert whole + refugee (7) | 12 / 16, 16 / 16 | before yes; **after no** (#29) |
| high plains whole (7) | 16 / 16, 16 / 16 | before yes; **after no** |
| mountain whole (7) | **2 / 16, 4 / 16** | before yes; **after no** |
| badlands whole (7) | **0 / 16, 0 / 16** | before yes; **after no** |
| **what can be served** (targets 60 / 70 %) | before: all 160, guided 126 = 79 %, best 132 = 83 % | **after: 96, guided 96 = 100 %, best 96 = 100 %** |

No fight input changed. What changed is what is served. Before 2 banks, no tester's party is
served at all (#28). In bands 0–1, a 7-raider roster is never offered against a 5-post circle
(#29).

**Target 2 — skilled vs naive** (band-typical roster at its own band; skilled / guided / naive %):

| | b0 | b1 | b2 | b3 | b4 | b5 | b6 | b7 |
|---|---|---|---|---|---|---|---|---|
| before (pass 5) | 95/80/83 | 90/74/85 | 100/77/90 | 84/54/67 | 84/61/63 | 67/42/46 | 60/38/38 | 92/49/54 |
| after | 100/89/90 | 90/74/85 | 100/77/90 | 88/54/67 | 89/61/64 | 68/28/25 | 74/24/18 | 92/49/54 |

Skilled beats naive by 26 points on average, up from 18. The re-authored band-5/6 outfits are mixed-stance
parties, which a scout reading answers and a scout-blind layout does not.

**Target 3 — stalemates, fight length, dominance:**

| | before (pass 5) | after |
|---|---|---|
| stalemates in the corpus | 0 of 6528 | 0 of 6528 |
| healer turtle (`probes.ts`, 96 fights): held / stalemate / overrun; healing offset | 73 / 0 / 23; 47 % | 83 / 0 / 13; 44 % |
| fight length p10 / median / p90; share in 20–90 s | 12.2 / 21.4 / 33.8 s; 56 % | 12.7 / 21.8 / 33.4 s; 59 % |
| overruns in the corpus | 1706 | 1730 |
| flagged within band × stance (\|Δ\| > 25 points) | 5 | 7, none above 32: raiding Rail Bull +32, posted Rail Bull +27, posts with heal radius +27, heavy strike +27, posted Vaquero, Snake Oil Peddler, Powder Thief +26 |
| held share of core-stance parties, b0…b7 | 96 92 89 48 35 16 1 26 | 100 92 89 56 39 40 20 26 |
| fast runners (`fast-runners.ts`), guided: overrun; within 20 s; units lost per fast overrun | 42 %; 90 %; 4.8 (144 fights) | 38 %; 88 %; 4.7 (136 fights: Hardrock is no longer a runner) |
| the same, best skilled | 25 %; 72 %; 4.8 | 21 %; 71 %; 4.7 |

**Target 4 — trip EV for L1–L3** (`measured-ev.ts`; best bank point at each roster's equilibrium
band; skilled):

| circle | before (pass 5) | after #30's outliers alone | **after** |
|---|---|---|---|
| 8 × L1 | band 3: +5,930 at k = 4 | band 3: +5,983 at k = 4 | band 3: **+5,960 at k = 4** |
| 8 × L2 | band 3–4: +3,752 at k = 4 / +9,475 at k = 5 | band 4: +9,500 at k = 5 | band 4: **+9,485 at k = 5** |
| 8 × L3 | band 4: +5,761 at k = 5 | **band 5: −631, no positive bank point** | band 4: **+5,783 at k = 5** |
| 8 × L4 | band 7: −3,699 | band 7: −3,699 | band 7: −4,163 (still open) |

The 8 × L3 circle holds 70.8 % (34 of 48) at band 5. That is one fight under the 71 % break-even,
so it settles in band 4. The margin is thin, and the play test's live hold rates should show where
it really sits.

### D1 and D3 — recorded, no change before the play test (orchestrator decision)

- **D1, fast core and trap runners.**
  - Round 3: 3 of 11 guided first fights were decided by them. g2 lost to Timberline Gang (2
    core-stance raiders, 4 units lost outright). g9 and g10 lost to Prairie Wolf Pack (traps
    stance, Lope); g9 lost 5 units with 0 killed.
  - This pass, the guide's encounter-1 pick held: Timberline Gang 11 / 28 (39 %), Prairie Wolf
    Pack 99 / 110 (90 %), Salt Flat Drifters 54 / 54, Alkali Freighters 8 / 8.
  - `fast-runners.ts` (above): 38 % of guided fights against band-0/1 runners are overrun, 88 %
    of those within 20 s.
  - Still open: should the guide pass over core-stance-only parties too? Or should Timberline Gang
    and Grizzly Creek Trappers (fresh-5 6 / 8 each) leave band 0?
  - Telemetry: hold rate and time to overrun, by the raiders' stance, in guided first fights.
- **D3, unlock pace in week 1.**
  - Round 3: after g4's 11 trips (9 banked), its living ladder stood at rung 1 of 20.
  - It had been granted 3 unlock points in all, and bought Claim Jumper and Tripwire Snare.
    Tier-3 living nodes cost 8 points each.
  - It had 20 L1 units and 9,937 Coin, and had never merged.
  - Pass 2 D8 measured the first tier-2 node at 2–3 days.
  - Telemetry: the Webs' share of screen flow, and points granted per banked trip in week 1.

### Tests whose pins moved

- server `matchmaking-pure`: the raider-cap tests take a band-2 centre, where the roster rule
  alone applies. A new test covers the bands 0–1 rule (#29).
- server `matchmaking`:
  - the r2 S2 test now covers 2 banks, with overrun and voided trips not counting (#28);
  - the r2 D1 test covers band 2, and band 0 for a merged-down roster (#29).
- server `helpers.seasonCaravan` gives `AUTHORED_ONLY_UNTIL_BANKS` banked trips.
- server `balance-sweep` (the CI slice):
  - pushed encounter 2 must reach ≥ 60 % on the guide's advice;
  - the pick is pinned to `@caravan/circle` `guidePick`;
  - the raised gate is 80 fights, scored over the 48 a bands 0–1 search can serve.
- circle `guide.test` (new): the shared rule. web `guideRule.test` now imports it from `@caravan/circle`.
- server `inbox`, `party`, `replay-ledger`, `account-lifecycle`: the round-3 N5, N6 and N10 server
  changes (not balance).

### Open — for the play test's telemetry

1. **Whole raised rosters above band 1.** Mountain holds 2 / 16 and Badlands 0 / 16 against five
   posts. Such a roster is never served before 2 banks, and never in bands 0–1 against a smaller
   packed circle. From band 2 up, a caravan whose roster is past 6 can meet one. Watch the hold
   rate by raider party size from band 2.
2. **8 × L3 sits one fight under the band-5 break-even** (70.8 %).
3. D1 and D3 above.
4. Still open from pass 5:
   - healing in the four-healer turtle (now 44 %);
   - 8 × L4 trip EV;
   - core-stance dominance. #30 re-authored only the worst core-stance outfits, and core is still
     the weakest-held stance from band 3 up.

---

## Pass 5 — 2026-10-20 (the second trip's ranged starter parties). RESOLVER_VERSION 8 → 9.

The decision was to give posts +1 cell of engagement, the lever pass 4 measured. It is a content
change: every living unit's aggro radius and leash now carry one new tunable. No resolver code
changed. The bump to 9 marks that a stored encounter input now resolves to a different fight. All
72 goldens and the work counters were regenerated with `UPDATE_GOLDEN=1`, and `pnpm determinism`
against main reports "accepted — RESOLVER_VERSION 8 → 9, every changed golden carries v9".

### What changed

| # | number | from → to | why |
|---|---|---|---|
| 26 | `POST_ENGAGEMENT_BONUS` (new; units.ts `engage`) | 0 → +1 cell, added to **every** unit's authored `aggroRadius` and `leashDistance` | A ranged raider shoots the circle from outside the fence while the posts stand idle. With one more cell of notice and chase, the posts answer it. The value is written into content, so the scout and the formation screen show the real reach. The authored literals keep each type's own profile. A raider never reads aggro or leash. |
| 27 | `REPUTATION_CARAVAN_HELD` | +10 → +8 (overrun stays −20) | #26 makes posts stronger everywhere, so at +10 an 8 × L3 circle climbed to band 5 (skilled hold 67 % there, right at the break-even). Its best bank point there is negative (−1,055). At +8 the break-even is 20 / 28 ≈ 71 %, the circle settles in band 4 again, and its EV is positive (target 4). |
| — | the harness's guide pick (`sweep.ts isRangedRaider`) | ranged = reach above the melee default → ranged = reach ≥ `GUIDE_RANGED_MIN_CELLS` (3) cells | Mirrors the client's round-2 opt-in (TrailGuide). It changes only the "before" baseline below; both columns use it. |

**Tried and not taken: +½ cell** (`fpMilli(500)`).
- Second-trip gate: 83 % guided, 88 % skilled.
- Badlands: 62.5 % guided, 69 % skilled. Mountain: 75 % guided, 81 % skilled.
- It still pushed 8 × L3 to band 5 at +10 (−969).
- So it needed the same Reputation change as +1 cell, with a weaker gate. +1 cell does not
  overshoot: stalemates stay at zero, and the turtle's stalemates fall.

### Before → after

"Before" is main at 3d13921 (with the harness's guide pick mirrored); "after" is this pass. Full
sweep, 6528 matchups, unless noted.

**Target 1 — the guided first fight** (`first-trip.ts`, 200 caravans):

| | before | after |
|---|---|---|
| encounter 1, guided (target ≥ 70 %) | 161 / 200 = 81 % | **172 / 200 = 86 %** |
| encounter 2, guide's shape / best skilled | 73 % / 81 % | 86 % / 90 % |
| first trip completed | 59 % | 74 % |

(Main's 90 % in pass 4 was under the old ranged rule. The new rule lets the guide pick Timberline
Gang, a Grizzly and Trapper outfit that is not all-ranged, which holds 9 of 28 before and 11 of 28
after.)

**The second-trip gate** (`first-trip.ts --raised`, 128 fights):

| raised parties of | before guided / skilled | after guided / skilled |
|---|---|---|
| desert | 100 / 100 % | 94 / 100 % (the whole roster: 75 % guided) |
| high plains | 100 / 100 % | 100 / 100 % |
| mountain | 56 / 81 % | **81 / 81 %** (pairs all 100 %; the whole roster 25 / 25 %) |
| badlands | **37.5 / 44 %** | **75 / 75 %** (pairs all 100 %; the whole roster 0 / 0 %) |
| **all** (targets 60 / 70 %) | 94 / 128 = 73 % / 104 / 128 = 81 % | **112 / 128 = 88 % / 114 / 128 = 89 %** |

No region is below 50 % guided. One gap remains: the whole six-unit roster of Mountain (25 %) and
Badlands (0 %), raised as one party, still beats a five-unit guided circle.

**Target 2 — skilled vs naive** (band-typical roster at its own band, skilled / guided / naive %):

| | b0 | b1 | b2 | b3 | b4 | b5 | b6 | b7 |
|---|---|---|---|---|---|---|---|---|
| before | 95/77/79 | 81/63/71 | 97/76/81 | 80/54/58 | 82/56/57 | 61/25/28 | 57/31/30 | 92/48/40 |
| after | 95/80/83 | 90/74/85 | 100/77/90 | 84/54/67 | 84/61/63 | 67/42/46 | 60/38/38 | 92/49/54 |

Skilled beats naive by 18 points on average, down from 25. The longer reach helps the scout-blind
layouts most, but the gap is still well above 10.

**Target 3 — stalemates, fight length, dominance:**

| | before | after |
|---|---|---|
| stalemates in the corpus | 0 of 6528 | 0 of 6528 |
| healer turtle (96 fights): held / stalemate / overrun; healing offset | 67 / 2 / 27; 41 % | 73 / **0** / 23; 47 % |
| fight length p10 / median / p90; share in 20–90 s | 12.2 / 22.4 / 37.0 s; 59 % | 12.2 / 21.4 / 33.8 s; 56 % |
| overruns in the corpus | 1964 | 1706 (−13 %) |
| flagged within band × stance (\|Δ\| > 25 points) | 4: Drover −37, Grizzly −25, posted Rail Bull +26, posts with heavy strike +29 | 5: Drover −42, Prairie Wolf +26, Mountain Lion +30, raiding Rail Bull +32, posts with heavy strike +27 |
| held share of core-stance parties, b0…b7 | 94 83 82 40 27 10 1 17 | 96 92 89 48 35 16 1 26 |

The longer reach makes no stalemates: a post chasing further still kills or is killed. Melee
raiders are not hopeless: nearest-stance parties are still held 42 % at b7, and Mountain Lion and
Prairie Wolf, both fast melee types, are flagged weak by +26–30 points, not shut out. The
four-healer turtle's healing offset rises to 47 % (over target; open below).

**Target 4 — trip EV for L1–L3** (`measured-ev.ts`, best bank point at each roster's equilibrium
band, skilled):

| circle | before (+10/−20) | +1 cell at +10/−20 | **after (+1 cell, +8/−20)** |
|---|---|---|---|
| 8 × L1 | band 3: +4,539 at k = 3 | band 3: +5,930 at k = 4 | band 3: **+5,930 at k = 4** |
| 8 × L2 | band 3: +3,208 at k = 3 | band 4: +9,475 at k = 5 | band 3–4: **+3,752 at k = 4 / +9,475 at k = 5** |
| 8 × L3 | band 4: +2,328 at k = 4 | band 5: −1,055 (no positive bank point) | band 4: **+5,761 at k = 5** |
| 8 × L4 | band 7: −3,376 | band 7: −3,699 | band 7: −3,699 (still open, pass 1's cause) |

The two L2 figures are for the two band-typical L2 rosters, which settle in bands 3 and 4.

**The fast-runner probe** (`fast-runners.ts`, 144 fights):

| | before | after |
|---|---|---|
| guided: overrun; of them within 20 s; units lost per fast overrun | 51 %; 81 %; 4.6 | 42 %; 90 %; 4.8 |
| best skilled | 35 %; 64 %; 4.6 | 25 %; 72 %; 4.8 |

Fewer fast runners get through. The ones that still do get through faster and cost about the same,
because the posts that chase them leave the core open sooner. D1's telemetry question stands.

### Tests whose pins moved

- web `ReplayPlayer.test`: Reputation for the recorded hold +10 → +8 (#27).
- The re-recorded contract fixtures: replay, replay-owner, replay-compacted, replay-no-log and
  trip-preview-2 (resolver version 9 and the new fight).
- resolver: all 72 goldens and `work-counters.json` (v9, `UPDATE_GOLDEN=1`).

### Open — for the play test's telemetry

1. **A whole six-unit ranged roster raised as one party** (Mountain 25 %, Badlands 0 % against a
   guided circle). Watch the second trip's hold rate by raider region and party size.
2. **Healing in the four-healer turtle**, now 47 %.
3. **8 × L4 trip EV**, still negative.
4. **Core-stance dominance**, unchanged.

---

## Pass 4 — 2026-10-12 (final play-test review round 2: S2, D1, D4). RESOLVER_VERSION unchanged at 8.

No resolver code, content stat or resolver tunable changed (RESOLUTION_CONTENT_HASH and the goldens
are unchanged). One matchmaking rule and the harness's model of the guide moved.

### What changed

| # | number | from → to | why |
|---|---|---|---|
| 25 | `AUTHORED_ONLY_FIRST_TRIPS` (new) | 1 | Round-2 S2. A caravan's first trip meets **authored outfits only**, at every encounter (live parties are left out of the pool before the seeded draw; the menu records `draw_rules.authoredOnlyTrip`). Testers' raised starter parties — Mountain's and Badlands' are ranged pairs that shoot the guided circle from outside the fence — are never a player's first fight, and the guided first trip is now exactly what `first-trip.ts` measures (an authored-only pool). |
| — | the harness's guide pick (`sweep.ts guidePick`) | "fewest raiders, then least HP" → the client's rule: least total HP, then fewest siege, then fewest raiders, then menu order, **passing over all-ranged parties** whenever another candidate exists (a raider is ranged when its attack range exceeds `ATTACK_RANGE_MELEE_DEFAULT`, as `TrailGuide.isRangedRaider`) | The harness modelled an older ordering; the client fix round of round 2 added the ranged rule. The numbers below are the guide testers now follow. |

### Target 1 — the guided first trip (`first-trip.ts --reserve 2`, 200 caravans)

```
encounter 1 (guided):   bands searched {"0":200}   held 179/200 = 90% (stalemates 0)
encounter 2 (free):     bands searched {"1":179}   guided shape held 112/179 = 63%   skilled best held 131/179 = 73%
first trip completed (two holds, then bank): 112/200 = 56%
guide's pick at encounter 1: Alkali Freighters 28/28, Bounty Board Riders 5/5, Gunslinger's Dozen 2/3, Prairie Wolf Pack 90/110, Salt Flat Drifters 54/54
```

Was 73 % (pass 3). The ranged rule takes the guide off the two badlands ranged outfits that made up
pass 2's gap (Bounty Board Riders 60 / 81, Gunslinger's Dozen 53 / 79 then; 5 / 5 and 2 / 3 now, only
where every candidate was ranged). Target ≥ 70 % met; encounter 2's guide shape (63 %) stays above
its > 50 % target. Because of #25 this is now the whole first trip, live parties or not.

### The second trip's gate (`first-trip.ts --raised`, 128 fights, all 76 skilled layouts)

Every region's raised starter parties (L1, north edge, `nearest`, Battering Wagon — the guide's
"Raise my party" and the server's `suggested`) against every fresh guided roster (4 regions × each
refugee type, GUIDE_RESERVE left home, 1 Spike Pit):

| raised party | guided | best skilled |
|---|---|---|
| desert, high plains: every pair and the whole roster | 100 % | 100 % |
| mountain: Grizzly + Grizzly | 100 % | 100 % |
| mountain: Grizzly + Trapper | 75 % | 100 % |
| mountain: Trapper + Trapper | 50 % | 75 % |
| mountain: the whole starting roster (6) | **0 %** | 50 % |
| badlands: Gunslinger + Gunslinger | 50 % | 50 % |
| badlands: Gunslinger + Bounty Hunter | 50 % | 50 % |
| badlands: Bounty Hunter + Bounty Hunter | 50 % | 75 % |
| badlands: the whole starting roster (6) | **0 %** | **0 %** |
| **all raised parties** | **94 / 128 = 73 %** (target ≥ 60 %) | **104 / 128 = 81 %** (target ≥ 70 %) |

The decision's targets are met over the raised starter parties as a whole, so no lever was applied.
**Recorded for the orchestrator, not hidden by the aggregate:** a region's own raised parties are
far below it for Badlands (guided 37 %, skilled 44 %) and below it guided for Mountain (56 %), and a
fresh Badlands or Mountain tester's *whole* raised roster (six raiders, all or half ranged) beats a
five-unit guided circle nearly always. Two mitigations already apply: the guide's pick passes over
all-ranged parties whenever the menu has another (so a guided player meets these only when all three
candidates are ranged), and the first trip never meets them (#25). The lever was measured, not taken:
`--explore aggro=1024` (every post's engagement and leash +1 cell) lifts every ranged *pair* to
100 % guided and skilled, and the whole-roster parties to 0–25 % / 0–25 %; it changes every fight,
so it would need content edits to every unit's aggro and leash, a RESOLVER_VERSION bump, regenerated
goldens and a full re-sweep of targets 1–3. Telemetry: the second trip's hold rate against live
parties by raider region, and how often a menu is all-ranged.

The CI slice (`balance-sweep.test.ts`) runs a quarter of the gate (one fresh roster per region, the
first 24 skilled layouts) and asserts the same two targets.

### D1 — fast core and trap runners (`fast-runners.ts`): no content lever accepted

18 band-0/1 authored outfits with a core- or trap-stance raider × 8 fresh rosters (reserve 2):

| | overrun | overruns within 20 s | units standing (lost) per fast overrun |
|---|---|---|---|
| guided, as built | 51 % | 81 % | 4.6 |
| best skilled, as built | 35 % | 64 % | 4.6 |
| `--explore trapRadius=1536` and `=1792` (trap trigger 1.25 → 1.5 / 1.75 cells), guided / best skilled — identical for both | 51 % / 36 % | 81 % / 62 % | 4.6 / 4.6 |
| `--explore speed=0.85` (raiders 15 % slower), guided / best skilled | 44 % / 28 % | 53 % / 55 % | 4.8 / 4.6 |

The trap trigger changes nothing. A slower runner turns some fast overruns into slow ones, but every
fast overrun still costs about 4.6 standing units, which is the experience D1 is about (PROJECT.md
§13's rule stays, by decision). And it is not a content-only lever for one unit type: `--explore`
scales every raider, and a per-type speed edit changes resolution (goldens, RESOLVER_VERSION) and needs
targets 1–3 re-swept. No lever is accepted. **Top telemetry question for the play test:** the share
of week-1 overruns that end within 20 s with ≥ 3 packed units standing, by band and by raider stance,
and whether those players come back the next day.

### D4 — Coin with nothing to buy in week 1: no change, a telemetry question

Round 2's returning week (g4, Badlands): 14,353 Coin after seven simulated days (16,371 after one
more trip, with the mine not aged), 7 L1 units and 4 unlocks, and **no merge ever**, because overruns
kept the roster under the 8 deployment slots and a merge below them lowers what a caravan can pack
(the merge dialog says so). The only Coin sink was mercenaries (15 bought, 9,000 Coin, to rebuild).
So the PROJECT.md §1 merge/loadout hook does not appear in week 1. Telemetry: the merge-spend panel's
first-merge day, Coin balance by day of play, and the mercenary share of Coin spent.

---

## Pass 3 — 2026-10-12 (final guardrail review round 2: D1, S1). RESOLVER_VERSION unchanged at 8.

No resolver code, content stat or resolver tunable changed (RESOLUTION_CONTENT_HASH and the goldens
are unchanged). Two matchmaking / acquisition rules moved; nothing a fight reads.

### What changed

| # | number | from → to | why |
|---|---|---|---|
| 23 | `COLD_START_RAIDER_CAP_BANDS` → **`COLD_START_ROSTER_MAX`** | "band 0 of the search centre" → **the caravan's whole roster (in town plus packed) is at most 6 starting-unit equivalents** (Σ 2^(level − 1); 6 = the starting roster, 3 copies × 2 starter types, pinned by a test) | Round-2 D1. Keyed on the search centre, the cap ran for every caravan rated 400–549 (encounter 1 is searched 150 below), so a band-1 caravan (×1.5 encounter Coin) packing one strong unit was offered only 2-raider parties; at 550 it met 5-, 3- and 4-raider ones. The rule is for a caravan **rebuilding**, so it now follows the roster, at any encounter and any Reputation. A merged unit counts as the units it took, so merging a roster down to a few strong units never turns it on (one L5 unit = 16). A fresh caravan that has taken its first refugee (7) is already past it. |
| 24 | `ACCOUNT_RATE_LIMITS.refugeeActionsPerAccount` (new) | 30 a minute per account, claim / refresh / reroll together | Round-2 S1 (operational). With relief owing one menu at a time (below), a person needs a handful of refugee calls an hour; this bounds a script. |

Not a number, recorded here because it changes the rebuild path that pass 2 measured: **roster
relief owes one menu at a time** (round-2 S1). Below `REFUGEE_ROSTER_FLOOR` the next free menu comes
only once the current one is claimed; another menu before claiming is the ordinary paid reroll. Pass
2's rebuild (a wiped caravan takes three free refugees, one per claim) is unchanged; what is gone is
the unlimited free re-draw of an unclaimed menu.

### The guided first fight (`first-trip.ts --reserve 2`, 200 caravans) — unchanged, 73 %

```
roster: STARTING_ROSTER model + one refugee, 2 left in town (GUIDE_RESERVE 2); 200 fresh caravans (4 regions × each refugee type × 25 seeds)
encounter 1 (guided):   bands searched {"0":200}   held 146/200 = 73% (stalemates 2)
encounter 2 (free):     bands searched {"1":146}   guided shape held 108/146 = 74%   skilled best held 113/146 = 77%
first trip completed (two holds, then bank): 108/200 = 54%
guide's pick at encounter 1: Bounty Board Riders 60/81, Gunslinger's Dozen 53/79, Prairie Wolf Pack 22/29, Salt Flat Drifters 11/11
```

Identical to pass 2 (target ≥ 70 % met). The guided caravan holds 7 (6 starters plus the guide's
refugee), so under #23 the cap does not run for it — and against the authored pool it never changed
these fights anyway (pass 2: cap on and off gave identical rows).

### The cap re-checked (`cold-start.ts`, 4 regions × 25 seeds; rebuilt rosters of 1–4 unmerged starters)

At REPUTATION_START (encounter 1 searched at 250, band 0) the table is identical to pass 2's
after-#22 column, cap on and off: packed 1 → 42 % guided / 50 % skilled, 2 → 46 / 85, 3 → 57 / 89,
4 → 66 / 79, every pick a 2-raider outfit.

New in this pass: the same rebuilt caravans at living Reputation 700 (`--rating 700`, encounter 1 at
550, band 1), where the old rule never ran and #23 now does:

| packed | cap off: raiders faced, guided / skilled held | cap on (#23): raiders faced, guided / skilled held |
|---|---|---|
| 1 | 3–4 (mean 3.2): 11 % / 11 % | 2: 42 % / 50 % |
| 2 | 3–4 (mean 3.2): 41 % / 41 % | 2: 46 % / 85 % |
| 3 | 3–4 (mean 3.2): 49 % / 53 % | 2–3 (mean 2.1): 31 % / 57 % |
| 4 | 3–4 (mean 3.2): 57 % / 63 % | 3–4 (mean 3.2): 57 % / 63 % |

So a band-1 caravan rebuilding with 1–2 units now gets the band-0 rebuild path's odds instead of
11–41 %. One cell moves the other way: with 3 packed, the cap offers 2- and 3-raider outfits whose
guide-picked fights hold 31 % guided (49 % without it) while the skilled best rises to 57 %; the
smaller outfits it leaves are the ranged ones the guided layout handles worst (the same gap pass 2
names for the badlands outfits). Recorded, not tuned: it touches only a wiped caravan above band 0
with exactly 3 units, and the lever, if telemetry item 8 shows it, is the floor band's ranged
outfits, not the cap.

---

## Pass 2 — 2026-10-12 (final play-test review: S1, D6, D8; D3/D4 recorded). RESOLVER_VERSION unchanged at 8.

No resolver code, content stat or resolver tunable changed, so RESOLUTION_CONTENT_HASH and the golden
corpus are unchanged. Before #17 and #22, the quick sweep reproduced pass 1's quick-corpus diagonal
exactly (skilled / guided / naive: b0 92/67/67, b1 83/63/71, b2 96/75/79, b3 75/58/54, b4 83/54/54,
b5 58/29/29, b6 54/38/42, b7 83/38/42 %). After them, the quick sweep (`--quick --no-trips`, 1,728
matchups) moves in two columns only:

- **Band 0, from #22.** Guided holds at b0 went from 67–92 % to 79–92 % across the rosters, and naive
  holds rose too. Skilled holds are unchanged, at 92–100 %.
- **Band 7, from #17.** The authored outfits pick their living types greedily within a capped
  ladder's 30 points, and a cheaper tier 2 changes which types the top band can afford. Skilled
  holds at b7 moved by −4 to +12 points depending on the roster; the b7 diagonal is now 88 / 42 /
  38 % (was 83 / 38 / 42). No other band's outfits changed. `first-trip.ts` gained `--reserve` (default GUIDE_RESERVE). New tools:
`unlock-pace.ts` (D8), `party-rating.ts` (D6) and `cold-start.ts` (S1's raider cap).

### What changed

| # | number | from → to | why |
|---|---|---|---|
| 17 | `UNLOCK_NODE_COST_BY_TIER.living` tier 2 | 4 → 2 (curve 0, 1, **2**, 8, 14) | D8: the first tier-2 living unit should arrive in about 2–3 days of normal play. Measured below. The living web's paid total falls from 39 to 35, so a capped ladder (30 points) reaches 86 % of it, not 77 %: still "most but not all", and every node is still reachable at cap. Trap and siege curves are unchanged. |
| 18 | `REPUTATION_LOSS_ATTACKER` | −15 → **0**, now fixed by design | D6, PROJECT.md §10: a standing party that is held or withdraws never lowers its owner's Reputation; only a success (+25, gap-scaled) raises it. Asserted at boot. The defender's split (+10 / −20) is unchanged. |
| 19 | `REFUGEE_ROSTER_FLOOR` (new) | 3 | S1: while a caravan in town has fewer than 3 living units, its free refugee menu is due at once. Each claim brings the next menu in the same request until the roster is at 3. A tuning of §15's free timer: still 3 offers from the unlocked pool, one pick, nothing locked. |
| 20 | `COLD_START_RAIDER_CAP_BANDS` (new) | 1 (band 0 only) | S1: in band 0 no party with more raiders than the caravan packed units is offered. The cap rises one raider at a time when fewer than 3 parties near the centre would fit, so it never empties a menu. Stored on the menu row (`raider_cap`), so menus replay. |
| 21 | `GUIDE_RESERVE` (new; the client fix round's definition) | 2 | S1: the client guide packs at most `roster − 2`. Presentation only: the server never reads it. |
| 22 | `AUTHORED_FLOOR_BAND_PARTY_SIZE` (new); `AUTHORED_SET_VERSION` 4 → 5 | the floor band's 1- and 2-edge outfits: 3 → **2** raiders (its 4-edge outfits keep 4; every band above is unchanged) | With the reserve, the guided first fight posts 5 units, not 7, and held only **66 %** (132 / 200) against the three-raider floor outfits. The decision's bar is ≥ 70 %. The raider cap could not help, because every floor outfit fielded 3 and the guide already picks the fewest. Two levers were tried: dropping the floor band's siege changed nothing (66 %, identical fights), and 2-raider floor outfits gave **73 %** (146 / 200). The validator's 3-unit minimum is relaxed to this size for the floor band only. |

### The first fight with the guide's reserve (`first-trip.ts`, 4 regions × each refugee × 25 seeds = 200 caravans; 1 trap)

The guide now packs `roster − GUIDE_RESERVE` = 5 of 7. Which 2 stay home depends on instance ids, so
the probe rotates them by the seed.

| | packs 7 (`--reserve 0`) | packs 5, floor outfits of 3 | **packs 5, floor outfits of 2 (#22)** |
|---|---|---|---|
| guided encounter 1 held | 161 / 200 = 81 % | 132 / 200 = 66 % | **146 / 200 = 73 %** (target ≥ 70 %) |
| encounter 2, guide's shape | 125 / 161 = 78 % | 105 / 132 = 80 % | 108 / 146 = 74 % |
| encounter 2, best of the skilled set | 127 / 161 = 79 % | 112 / 132 = 85 % | 113 / 146 = 77 % |
| first trip completed (two holds, then bank) | 63 % | 53 % | 54 % |

The guide's picks at encounter 1 after #22 were Bounty Board Riders 60 / 81, Gunslinger's Dozen
53 / 79, Prairie Wolf Pack 22 / 29 and Salt Flat Drifters 11 / 11. The two badlands ranged outfits are
what is left of the gap. Encounter 2 (band 1) is unchanged by #22.

### D8: time to the first tier-2 living unlock (`unlock-pace.ts`)

The week model's trip counts (`weeklyFreeEarn`: 15 / 30 / 42 trips a week, 30 being the mid) and the
first-trip probe's measured hold rates (encounter 1 81 %, encounter 2 78 %, pass 1). A hold earns
25 living-ladder points and an overrun earns 10. Rungs are at 100 / 282 / 519 / 800 / 1,118 points,
with one unlock point per rung. A tier-2 living node needs only a free tier-0 prerequisite. "Save" means
every point goes to it. "Tier 1 first" means the first point buys a tier-1 node as it arrives.

| 30 trips a week, banked after | before (tier 2 = 4): save / tier 1 first | **after (tier 2 = 2): save / tier 1 first** |
|---|---|---|
| 1 hold (cautious; 22 points a trip) | 8.4 / 11.8 days | 3.0 / 5.5 days |
| 2 holds (the guide's first-trip plan; 40 points a trip) | 4.7 / 6.6 days | **1.7 / 3.0 days** |
| 3 holds (the 8 × L1 best-EV point; 53 points a trip) | 3.5 / 4.9 days | 1.2 / 2.3 days |

At 15 trips a week, banked after 2 holds, it takes 3.3 / 6.1 days (was 9.4 / 13.1). At 42 trips a
week it takes 1.2 / 2.2 days (was 3.4 / 4.7). Target met at the mid: about 2–3 days. The play-test
reviewer's h8 (six holds: 150 points, rung 1) is consistent with the model.

### D6: the equilibrium check (`party-rating.ts` on the `--quick --no-trips` sweep after #17 and #22, 1,728 matchups)

**Caravans, unchanged.** D6 does not touch the defender's side and no fight changed. Quick corpus,
break-even 67 %. Equilibrium band by roster: fresh 3, b0-typical 3, b1-typical 3, b2-typical 3,
b3-typical 3, b4-typical 4, b5-typical 4, b6-typical 7, b7-typical 7.

**Standing parties: there is no equilibrium any more, by design.** The table gives the drift per
strike when a party of band-p strength (the authored outfits of band p stand in for it) meets the
band-k typical roster. Under the old rule (+25 / −15) a party settled where it won 37.5 % of the time.
Under the new rule its rating never falls, and it climbs ever more slowly until it can no longer win:

| party strength | old: settles at | new: climbs to | strikes to get there from its own band |
|---|---|---|---|
| b0 | below b0 (sinks to the floor) | b2 | ≈ 430 |
| b1 | below b0 | b4 | ≈ 360 |
| b2 | below b0 | b4 | ≈ 580 |
| b3 | below b0 | b7 | ≈ 530 |
| b4 | b3 | above b7 | ≈ 360 to b7 |
| b5 | b5 | above b7 | ≈ 130 to b7 |
| b6 | b7 | above b7 | ≈ 60 to b7 |
| b7 | b5 | above b7 | ≈ 100 to b7 |

What this means: a weak party (b0–b2 strength) used to sink to the floor and be served only to fresh
caravans. Now it stays where it climbed to and drifts up only slowly (≈ 1–4 Reputation a strike). A
strong party still climbs fast. Live parties' siege ratings will therefore sit at or above their
strength, never below it. The caravans they meet at a given band will face slightly weaker parties
than that band's authored outfits, and hold a little more often there. The authored set does not move
and anchors every band. This is a population effect that the offline sweep cannot measure.

### S1: the band-0 raider cap re-checked (`cold-start.ts`, 4 regions × 25 seeds)

This is a rebuilt caravan of 1–4 unmerged starters with 1 Spike Pit and a full Brush Pile budget, at
REPUTATION_START (encounter 1 in band 0), served from the authored pool with the guide's pick:

| packed | before #22: raiders faced, guided / skilled held | **after #22**: raiders faced, guided / skilled held |
|---|---|---|
| 1 | 3 (the cap relaxes to 3): 0 % / 13 % | 2 (relaxes to 2): 42 % / 50 % |
| 2 | 3 (relaxes to 3): 33 % / 54 % | 2: 46 % / 85 % |
| 3 | 3: 45 % / 57 % | 2: 57 % / 89 % |
| 4 | 3: 57 % / 63 % | 2: 66 % / 79 % |

The cap on and off gives identical rows against the authored pool. The guide already picks the
fewest raiders, and every 1–2-edge floor outfit fields the same count. So the cap only bites once
live parties larger than a rebuilt caravan stand in band 0. The rebuild path the decision intends
now works like this. A wiped caravan takes three free refugees at once (relief), packs 3, and holds
57 % of guided / 89 % of skilled encounter-1 fights (it was 45 / 57 % before #22). If the play test
shows wiped testers stalling, the next lever is REFUGEE_ROSTER_FLOOR (3 → 4). It is not moved here:
the decision fixed it at 3.

### Open — for the play test's telemetry (chunk 32), no mechanic change now

5. **D3: traps cost nothing to pack.** Every tester packs all six, every trip. Watch traps packed per
   trip, and trap lays per encounter against hold rate. If packing is always "all six", the trap
   loadout is not a decision. The candidates for a fix are a restock cost or a stock, which would be
   a mechanic change.
6. **D4: bank-or-push in week 1.** Measure the push rate after encounter 1 by band 0–1 caravans and
   their encounter-2 hold rate (the reviewer saw 5 of 9). Measure it again now that S1 bounds the
   blast radius (GUIDE_RESERVE leaves 2 units home; relief rebuilds to 3). If pushing is still
   clearly wrong at k = 1 for fresh rosters, the levers are the encounter-2 reward or the delivery
   bonus at bands 0–1.
7. **D6's inflation.** Watch the live parties' siege-rating distribution against their hold rate by
   band, and the caravans' hold rate by band against the authored outfits. A drift of live parties
   above their strength shows up as caravans holding more against live parties than against
   authored ones at the same band.
8. **S1's rebuild.** Watch the hold rate of caravans that packed ≤ 3 units, and the time from a wipe
   back to a banked trip.
9. **Ranged raiders against the guard leash** (final play-test review N11). A lone Bounty Hunter
   with range 4 shot posts over the fence for 84 s while five guards stood inside their leash. Watch
   fight length and the share of quiet time in fights with ranged raiders. The replay label for it
   needs a log-format change and is left for after the play test.

---

## Pass 1 — 2026-10-12 (chunk 37). RESOLVER_VERSION unchanged at 8.

No resolver code changed. The golden corpus did not change either: the resolver's fixtures carry
their own numbers, and `pnpm determinism` reports "golden corpus unchanged". Only content and
tunables moved, so RESOLUTION_CONTENT_HASH changes as expected.

### What was wrong (measured before any change, at roadmap/phase-2-spec)

- **A fresh caravan was searched in band 2, not band 0.** REPUTATION_START is 1000 (band 3), and
  1000 − 150 = 850 is band 2. Band 2 outfits are 5–6 raiders at merge level 1–3.
- **The guided first fight was never held: 0 of 64.** The roster was STARTING_ROSTER (one per
  starter type) plus one refugee, with one trap. The skilled search did no better: 0 of 48.
- **Defense lost at equal numbers.** Three level-1 starter posts against three level-1 starter
  raiders held 5 % with the guided layout and 13 % with the best layout. Raiders on the core stance
  reached the core in about 7 s, mostly before the posts engaged them.
- **Lever probes.** Five starter posts against the twelve band-2 outfits re-cut to three level-1
  starter raiders, all four regions, 48 fights per row. Each lever was applied to the resolver input
  only (guided / best):

  | lever | with 3 traps | with 1 trap |
  |---|---|---|
  | none | 33 / 65 % | 33 / 44 % |
  | fence HP ×2 or ×3 | 33 / 65 % | — |
  | trap damage ×1.5 | 38 / 73 % | — |
  | raider speed ×0.7 | 42 / 73 % | — |
  | posts' defense ×1.5 | — | 52 / 71 % |
  | defense ×1.5, traps ×1.5 | — | 52 / 75 % |
  | defense ×1.5, traps ×1.5, speed ×0.75 | — | 58 / 79 % |
  | defense ×2, traps ×1.5 | — | 69 / 83 % |

  Fence HP changes nothing, because runners walk round to the gaps. The problem is time-to-kill
  against time-to-core.

### What changed

| # | number | from → to | why |
|---|---|---|---|
| 1 | every unit's `defense` rating (units.ts) | ×1.5, rounded half up (e.g. Dust Rider 55 → 83, Well Digger 100 → 150; range 40–105 → 60–158) | `defense` is used ONLY when a unit is posted: it is the post's damage rating and its resistance. So it is the one stat lever that favours the defending side without touching offense. ×1.5 is the most the "no fixed offense/defense ratio" invariant allows (its max ratio must stay above 1.8; Gunslinger 118 / 63 = 1.87). |
| 2 | `BASE_DEFENSE_MIN` / `MAX` | 40 / 120 → 60 / 160 | These are the bounds of #1 (the "spread is used" test needs min = MIN). |
| 3 | every unit's `moveSpeed` | ×0.7 (e.g. Dust Rider 2.6 → 1.82 cells/s; range 0.9–3.0 → 0.63–2.1) | Core runners reached the core before the posts could kill them. Slower movement gives posts and traps time and lengthens fights (median 17.6 s → 22.3 s). Speed is shared by both sides, but posts mostly stand. |
| 4 | `MOVE_SPEED_MIN` / `MAX` / `DEFAULT` | 0.8 / 3.0 / 1.5 → 0.56 / 2.1 / 1.05 cells/s | The bounds of #3. |
| 5 | every trap's `damage` (traps.ts) | ×1.5 (Spike Pit 250 → 375, Jaw Trap 160 → 240, Tripwire 60 → 90, Caltrop 90 → 135, Powder Keg 220 → 330, Tar Pot 140 → 210) | Traps are defense-only. One Spike Pit now kills an unmerged Dust Rider or Gunslinger on a core run. |
| 6 | `TRAP_DAMAGE_MIN` / `MAX` | 60 / 250 → 90 / 375 | The bounds of #5. |
| 7 | `TRAP_TRIGGER_RADIUS` | 0.75 → 1.25 cells | A trap one cell off a runner's line now fires. In the diagonal probe this lifted core-stance holds at most bands (band 0: 33 → 50 %, band 3: 50 → 67 %); the other stances were already near 100 %. |
| 8 | `REPUTATION_START` | 1000 → 400 | 400 is band 1, so encounter 1 (400 − 150 = 250) is searched in band 0, the floor outfits. A caravan climbs from there. FIRST_ENCOUNTER_CENTRE_OFFSET stays −150. |
| 9 | `STARTING_ROSTER.copiesPerStarterType` | 1 → 3 | A fresh caravan has 6 starter units, plus the guide's refugee makes 7. Even with #1–#7, three posts against three raiders held 35 %; seven hold 81 % of guided first fights. The roster is still bounded: these are level-1 starters, about 600 Coin each to replace. |
| 10 | authored party size (new tunables `AUTHORED_PARTY_SIZE_FLOOR` 3, `AUTHORED_PARTY_SIZE_RISE` 6) | was 3 + band ordinal (+1 on odd parties) → 3 at the floor, rising by 6 over the set, capped at 8 | The floor bands become the three-raider starter outfits a fresh caravan meets. The rise is gentler at first, so band 1 (encounter 2 of the first trip) stays winnable. |
| 11 | authored merge curve (`baseMergeLevel`; new `AUTHORED_CLIMB_BANDS` 6, `AUTHORED_LEADER_FROM_BAND_ORDINAL` 2, `AUTHORED_FULL_LEVEL_FROM_BAND_ORDINAL` 2) | levels 1,2,2,3,3,4,4,5 with a half-step offset, a leader one level up in every band, and every second raider one level down → levels 1,1,2,3,3,4,5,5; leaders only from ordinal 2; every raider at the base level from ordinal 2 | Before, band 1 was harder than band 2 (L3 leaders). Difficulty now rises monotonically, and from band 3 the outfits sit about a level ahead of a caravan's own progress. |
| 12 | authored-set rule (chunk 25 QA N5) | "no two adjacent bands share (tier, base level)" → "(tier, base level, raiders in the band) never falls, and at least one of them rises" | The floor bands now share tier 0 and level 1 and differ by party size. `AUTHORED_SET_VERSION` 3 → 4. |
| 13 | Claim Jumper `offense` | 82 → 94 | Flagged weak with stance held fixed (+33 points for the defender). |
| 14 | Lumberjack `offense` | 88 → 100 | Flagged weak with stance held fixed (+28 points). |
| 16 | `REPUTATION_CARAVAN_HELD` | +15 → +10 (overrun stays −20) | Orchestrator decision on target 4: keep total loss on overrun (PROJECT.md / chunk 19) and use the Reputation split. A caravan now settles where it holds about 67 % of encounters instead of 57 %, which is one band lower for merged circles. Measured with `measured-ev.ts --held/--overrun` against the same sweep: +12 left 8 × L3 negative; +10 makes it positive at k = 4; +8 and +6 change nothing more for L3 and still leave 8 × L4 negative. +10 is the smallest change that reaches L3. Stalemates also give the caravan +10. |
| 15 | weekly free-earn derivation band (model.ts `L1_EQUILIBRIUM_BAND`) | REPUTATION_START's band → 3, the band an 8 × L1 circle settles at in the sweep | It was band 3 before, but via REPUTATION_START. The derived mid week is unchanged (55,000), so FREE_WEEKLY_EARN_ESTIMATE stays 55,000 and the ceiling stays 60,000 / 55,000 = 1.09× (bound 1.5×). |

Tried and reverted: `FENCE_MATERIAL_BUDGET` 20 → 24. It made no measurable difference (diagonal
within ±5 points; the first trip held 73 % at 24 and 81 % at 20), and the 20-segment budget is pinned across
the web and e2e suites. Also reverted: `COIN_ENCOUNTER_BAND_SCALE_BP` 5000 → 15000. It fixes
nothing structural (see "not met" below) and would inflate every Coin number.

### Acceptance targets — before → after

**1. The fresh account's first trip** (`first-trip.ts`, 4 regions × each refugee × 25 seeds = 200
caravans; one trap packed, as the guide says):

| | before (main, 8 seeds) | after (25 seeds) |
|---|---|---|
| band searched at encounter 1 | 2 (64 of 64) | **0** (200 of 200) |
| guided encounter 1 held | 0 / 64 = 0 % | **162 / 200 = 81 %** (target ≥ 70 %) |
| encounter 2 band | — | 1 (162 of 162) |
| encounter 2, the guide's shape again (a sensible free layout) | — | **126 / 162 = 78 %** (target > 50 %; 82 % before change #16 moved the encounter-2 menu) |
| encounter 2, best of the skilled set | — | 130 / 162 = 80 % |
| first trip completed (two holds, then bank) | 0 % | 63 % |

Of the guide's picks at encounter 1, the weakest is Timberline Gang, held 5 of 11. The onboarding
fixer's two phone walks were desert against Tumbleweed Syndicate and badlands against Saguaro Toll
Company. Both were band-2 outfits served at encounter 1 because the start band was wrong, and a
fresh account is no longer served band 2 at encounter 1 or encounter 2. Against those two outfits
directly, a fresh roster still loses to Tumbleweed (core-stance L2) and beats Saguaro with the best
layout but not with the guided one. A caravan meets them only after climbing about 300 rating.

**2. Skilled layouts hold a fair share; naive layouts lose more** (full sweep: 68 rosters × 96
parties = 6528 matchups). Target chosen: the band-typical roster at its own band holds 55–85 % with
the skilled search, lower in the top bands; naive layouts hold ≥ 10 points less on average; and the
pushed-trip hold rate falls with encounter index.

| band-typical roster at its own band | before (quick corpus) skilled / guided / naive | after (full corpus) skilled / guided / naive |
|---|---|---|
| b0 | 58 / 38 / 38 % | 95 / 68 / 73 % |
| b1 | 38 / 21 / 29 % | 81 / 63 / 71 % |
| b2 | 63 / 46 / 46 % | 97 / 76 / 81 % |
| b3 | 54 / 29 / 29 % | 80 / 54 / 58 % |
| b4 | 54 / 21 / 25 % | 82 / 56 / 57 % |
| b5 | 8 / 4 / 0 % | 61 / 25 / 28 % |
| b6 | 50 / 25 / 25 % | 57 / 31 / 30 % |
| b7 | 54 / 17 / 29 % | 83 / 45 / 40 % |

The skilled-minus-naive gap on this diagonal now averages 25 points (was 20). For a like-for-like
comparison, the quick corpus after the pass gives, skilled / guided / naive: b0 92/67/67, b1
83/63/71, b2 96/75/79, b3 75/58/54, b4 83/54/54, b5 58/29/29, b6 54/38/42, b7 83/38/42 %. Fight-length
median is 22.6 s, 59 % of fights are in 20–90 s, and the equilibrium bands are fresh 3, L1 3–4, L2
4, L3 5, L4 7, L5 7.

Hold rate at encounter j on pushed trips (band-typical roster from its band centre; skilled picks
the best of the served menu; full corpus, 4 seeds × 4 regions; after change #16 — the single fights
above do not read the Reputation split, only the trips' menus do):

| band | skilled, encounters 1–5 | naive (menu slot 0), encounters 1–5 | deaths per held fight |
|---|---|---|---|
| b0 | 100 100 100 88 93 | 88 79 64 71 100 | 0.11 |
| b1 | 100 88 79 91 90 | 63 90 67 100 67 | 0.23 |
| b2 | 100 100 100 100 94 | 69 55 67 50 0 | 0.28 |
| b3 | 100 100 100 69 36 | 75 67 63 20 0 | 0.67 |
| b4 | 100 100 100 94 80 | 75 50 50 0 – | 0.68 |
| b5 | 94 67 40 0 – | 44 0 – – – | 1.69 |
| b6 | 94 47 29 0 – | 31 0 – – – | 2.38 |
| b7 | 100 94 73 27 33 | 50 13 0 – – | 1.17 |

Before, these curves collapsed at encounter 2–3 at every band (b2: 100 63 0; b5: 50 0).

Equilibrium band (skilled encounter-1 hold ≥ the break-even), defensive rosters: at the +15/−20
split (≥ 57 %) fresh 3, L1 3, L2 4, L3 5, L4 7, L5 7; after change #16 (≥ 67 %) fresh 3, L1 3, L2 3,
L3 4, L4 7, L5 7. Before the pass (at 57 %): fresh 0, L1 0, L2 2, L3 3, L4 2, L5 6. Progression is
now monotone: a stronger roster settles in a band at least as high.

**3. Stalemates, fight length, dominance.**

| | before (quick) | after (full) |
|---|---|---|
| stalemates in the corpus | 1 of 1728 | 0 of 6528 (the turtle probe: 2 of 96) |
| fight length p10 / median / p90 | 7.0 / 17.6 / 40.0 s | 12.2 / 22.3 / 36.6 s |
| fights in 20–90 s | 42 % | 59 % |
| flagged within band × stance pattern (\|Δ\| > 25 points) | 16 features: 5 traps, 6 posts, 4 post abilities, Claim Jumper | 3: Claim Jumper (+40 for the defender, even after #13), Drover (−36), posts with heavy strike (+29) |

**The stance is the dominant predictor, not a unit.** Within a band, core-stance parties are held
far less than nearest- or traps-stance parties. After, band by band:

| party stance | b0 | b1 | b2 | b3 | b4 | b5 | b6 | b7 |
|---|---|---|---|---|---|---|---|---|
| core | 94 | 83 | 82 | 40 | 27 | 10 | 1 | 8 |
| nearest | 100 | 98 | 100 | 100 | 96 | 74 | 49 | 35 |
| traps | 100 | 100 | 100 | 97 | 100 | 79 | 66 | 57 |

The within-band unit flags (Longhorn Bull −34, Blasting Crate −37, Pack Mule +34, Apothecary +31)
mostly vanish once the stance is held fixed: the authored set assigns stances by party index, so
some types sit only in core parties.

**4. Trip EV at measured hold rates** (`measured-ev.ts` on the full sweep after change #16; losses
at rebuild Coin; 36 % of the posts in an overrun fight die in it, measured; the rest are
destroyed). Best bank point at each roster's equilibrium band:

| circle | +15/−20: band, skilled best | **+10/−20: band, skilled best** | +10/−20, no menu choice |
|---|---|---|---|
| 8 × L1 | 3: +4,984 at k = 5 | 3: **+4,539 at k = 3** | −106 at k = 1 |
| 8 × L2 | 4: +5,709 at k = 4 | 3: **+3,239 at k = 3** | −1,181 at k = 1 |
| 8 × L3 | 5: −2,452 at k = 1 | 4: **+2,327 at k = 4** | −3,264 at k = 1 |
| 8 × L4 | 7: −4,799 at k = 1 | 7: −3,932 at k = 1 | −21,054 |
| 8 × L5 | 7: −18,043 at k = 1 | 7: −15,466 at k = 1 | −39,496 |

Before the pass (same tool, quick corpus): L1 +1,189 at k = 2 at band 0; L2–L5 negative at every bank
point. "Skilled" picks the best of the three served parties; "no menu choice" fights a random one.

**Met for L1–L3 (k ≥ 2); not met for L4.** For L4 no split helps. An 8 × L4 circle settles in band 7
under every split from +15 to +6. There it loses 1.17 units per HELD fight, at one merge level
(≈ 5,000 Coin) each. That is ≈ 5,800 a hold against encounter 1's 1,800 + 125, so even a 100 % hold
rate is negative before any overrun is counted. Splits tried: +12 (L3 still negative), +10, +8 and
+6 (L4 moves to band 4 at +8, and is still −1,826 there). +10 is recorded as the best. What would
reach L4 is a number this pass did not get to move: the deaths in held top-band fights. Candidates
are band-7 outfits slightly smaller or less burst-heavy, or encounter Coin scaling further at the
top band. Both are left for the play test's data.

**Weekly free earn.** The derivation (trickle + 30 trips at p1 0.65, band 3) gives 55,538. The
constant stays FREE_WEEKLY_EARN_ESTIMATE 55,000 and WEEKLY_PAY_CEILING 60,000 = 1.09× (bound 1.5×).
At the measured skilled curve, free earn is far higher (an 8 × L1 trip banked at k = 3 grosses ≈ 4,500),
which only lowers the paid/free ratio. The bound holds either way.

**5. Owner loot from held fights** (depth from the ring line; encounter 1, as if player-owned):

| | before (quick) | after (full) |
|---|---|---|
| mean loot per held fight | 536 Coin (18 % of owner income) | 505 Coin (39 % of owner income) |
| mean per overrun (transfer + party win) | 1,559 Coin | 1,777 Coin |

A held fight pays about 28 % of an overrun's mean, so loot is meaningful but minor per fight. Its
share of owner income rose only because holds are now more common.

### The standing probes (`probes.ts`, after)

- **Healer stalemate.** The maximal healer turtle (four healers and the four sturdiest, all L5,
  Stacked Stone, the six heaviest traps), arranged at its best including `hold` shapes, against the
  24 top-two-band parties in 4 regions: held 66, stalemate 2 (2 %), overrun 28 of 96. Stalemate
  farming is not reachable (bar: < 25 %). Healing offsets 40 % of post damage in this
  four-healer turtle, above the 25–35 % target. Across the corpus, where posts are mostly not
  healers, it is 2 %. Chunk 12's light-encounter gate now measures a delta of 7–25 points (below).
- **Structure-breaker stacking.** 6 breaker types × L1–5 × counter siege on/off × 4 tiers = 240
  fights. The worst share of one segment taken by one unit in one tick was 50.0 %, which is
  exactly FENCE_HIT_SEGMENT_CAP and within it. 179 of the 240 fights broke a segment.

### Tests whose pins moved with these numbers

- circle `abilities-qa`: light encounters 2 → 4 raiders. With defense ×1.5, two raiders left
  nothing for healing to undo. "Healers turn at most one loss into a hold" ≤ 1 → ≤ 2 (healing now
  does real work).
- circle `battlefield`: trapTriggerRadius 768 → 1280.
- server `matchmaking-pure`: the authored-curve step rule and the start band (3 → 1; encounter 1 in
  band 0).
- server `economy-guards`: the start band.
- server `progression-pure`: the road to the floor (> 100 → > 20 losses).
- server `party`: Dust Rider defense 55 → 83.
- server `concurrency`, `account-lifecycle` and `matchmaking`: ratings set to 1000 by hand →
  REPUTATION_START, or parked out of band.
- server `telemetry`: start band 3 → 1.
- web `FormationScreen` and the replay tests: the contract fixture's fight was re-recorded under
  the new content (no posted unit falls; 0:30 long; the trap does 375).
- web e2e `onboarding.spec.ts` and `town.spec.ts`: the board count, the packed roster, the raised
  party, the starting-roster ledger events and the merge levels are read from content
  (`STARTING_ROSTER.copiesPerStarterType` × the region's tier-0 living types), not hard-coded
  as two. The guide copy needed no change: it never counts the starting roster ("its region's
  starter units"), and "raise from what is left" holds for any size.
- web replay `ReplayPlayer.test`: Reputation for the recorded hold +14 → +9 (change #16, gap-scaled).
- New: server `balance-sweep` (the CI slice).

### Open — for the play test's telemetry (chunk 32), no mechanic change now

1. **8 × L4 trip EV is negative at equilibrium** under every Reputation split tried. The cause is
   deaths in held band-7 fights, not overruns (target 4).
2. **The core targeting stance dominates offense.** Core-stance parties are held 1–40 % in bands
   3–7, against 35–100 % for the other stances. A player who learns this sets every party to core.
   Watch the stance mix of live parties and hold rate by stance. A fix would be a mechanic change
   (a time or depth cost for core runners), not done here.
3. **Healing in a four-healer turtle offsets 40 %** of post damage, over the 25–35 % target. It is
   not a stalemate risk (2 %). Watch the healing share in real circles.
4. **The band-typical roster is an assumption.** Chunk 32's roster-by-band data should replace it.
