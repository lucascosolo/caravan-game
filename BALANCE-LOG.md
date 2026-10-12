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
