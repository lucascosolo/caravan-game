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
| `first-trip.ts` | A fresh account's first trip, as the server serves it: the bands searched, the guide's pick, the guided layout at encounter 1, a free layout at encounter 2. This is chunk 24 QA D1's acceptance probe. |
| `probes.ts` | The two standing probes from chunk 12: the healer stalemate turtle, and structure-breaker stacking. |
| `measured-ev.ts` | Feeds the sweep's trip curves into the trip EV model (`model.ts`): EV at each roster's equilibrium band, plus the weekly free earn. |
| `trip-ev.ts` | The EV model with hand-entered rates (chunk 19). Unchanged apart from the weekly-earn band. |
| `unlock-pace.ts` | The week model read for ladder points: the days of play until the first tier-2 living unlock, at 15 / 30 / 42 trips a week and bank points 1–3 (`--costs` evaluates another cost curve). Pass 2, D8. |
| `party-rating.ts` | The Reputation equilibrium check on a sweep's `--json` matrix: each caravan roster's equilibrium band, and a standing party's siege-Reputation drift per strike by strength and band, under the current and the old party-loss rule. Pass 2, D6. |
| `first-trip.ts --raised` | The second trip's gate (play-test review round 2, S2): every region's raised starter parties (each pair of its starters, ranged pairs included, and the whole starting roster) against every fresh guided roster, the guided layout and the best skilled one. Pass 4; the CI slice runs a quarter of it. |
| `fast-runners.ts` | Fast core- and trap-stance runners (round 2, D1): band-0/1 authored outfits with such raiders against fresh rosters; overrun share, overruns within 20 s, units lost per fast overrun. `--explore` tries a lever. Pass 4. |
| `cold-start.ts` | The cold-start raider cap (S1; keyed on the roster since pass 3) re-checked: rebuilt 1–4 unit caravans, with the cap on and off, against the authored pool. `--rating` sets the caravan's living Reputation (default REPUTATION_START). Passes 2 and 3. |
| `apps/server/test/balance-sweep.test.ts` | The CI slice, with a time budget of 150 s. It checks that encounter 1 is searched in band 0, that the guided layout holds ≥ 70 %, that encounter 2 is held more often than not, that skill beats naive, and that the sweep is deterministic. |

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
the Reputation break-even. The break-even is 20 / (10 + 20) ≈ 67 % since change #16 (it was 20 / (15 + 20) = 57 %), because a hold earns +10 and an
overrun costs −20.

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
