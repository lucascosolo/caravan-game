# Studio design review: Caravan Vaults (greenlight)

Reviewer: senior game designer, studio greenlight review (design and fun, not guardrails or code
quality). Build: `roadmap/phase-2-spec` at 0058f0d (RESOLVER_VERSION 9, authored set v7, balance
pass 8). Date: 2026-10-20. Bar: what a competent studio would ship to soft launch, not "ready for a
play test".

## Headline verdict

**Not ready for soft launch; greenlight a depth milestone first.** The foundation is unusually
good: the inverted polarity (you defend live, your raid party works while you are away) is a
genuinely fresh take on the genre, every stake is legible, fights are deterministic and
replayable, and the first hour is now tuned so a newcomer rarely loses badly. But the long game
does not hold. I played three simulated weeks on the real production server (11 accounts: one by
hand on a phone, ten API players; about 3,300 real fights) and pushed the balance harness to the
endgame. Every candidate on the menu pays the same, so scouting is a search for the softest of
three. The circle then compresses to about three shapes with every post on guard: a scout-blind
circle holds 57 % of matchups, a three-shape playbook 78 %, and the best of 76 shapes 87 %. The
scout is the exact resolver input, so my solver predicted every one of the 1,731 live
outcomes it simulated. Bank or push is a real gamble for a newcomer. But the push is made blind
(the next menu is unseen), it risks the whole packed roster, and it pays nothing once Coin hits
the 50,000 cap, which skilled players reach on day 3. All six merging accounts that played 20
days ended weaker than on day 3. The passive side rewards looking weak: weak raised parties were
served 256–338 times in 20 days, against 8–79 for parties that overran a quarter to half of
their caravans, and earned four to five times the Coin. From the mid game up, the offense is one
switch: the best layout holds all-`core` parties 3 % of the time at L2 and 0 % at L5, and
all-`nearest` ones 100 %. There is no social, competitive, event or seasonal layer, so run 500
differs from run 5 only in which players are in the pool. All of it is fixable inside the five
guardrails. Most of the fixes need a PROJECT.md amendment, and I name each one.

## How I played (so the evidence can be reproduced)

- **Hosting, per `docs/PLAYTEST-HOSTING.md`, single-process production mode.**
  - `pnpm install --frozen-lockfile && pnpm build`. Then step 2's shared-instance roles,
    `caravan_sdes_owner` (`IN ROLE caravan`, `SET role = caravan`) and `caravan_sdes_app`
    (`IN ROLE caravan_app`), with `openssl rand -hex 24` passwords, and the database
    `caravan_studio_design` owned by `caravan`.
  - The env file: `NODE_ENV=production`, `SERVE_WEB=1`, `STORE_MODE=off`, `HOST=127.0.0.1`,
    `PORT=3935`. There was no proxy, so no `TRUST_PROXY`, and no `CARAVAN_TEST_RESOLVER`.
  - `migrate.js up` applied 30 migrations, and `seed.js` printed "Authored parties (set v7): 96
    created … No login accounts were created". The boot lines were "encounters resolve in-process
    with the real resolver", "store: off (packs previewed, not sold)" and "serving the client …
    source maps not served".
  - I never touched ports 3931, 3933 or 3941.
- **By hand, as a phone** (Playwright Chromium from `/opt/pw-browsers`, Pixel 5 profile, touch,
  390×844 and 360×740). A fresh desert guest (`d1`) played its guided first trip, then four more
  trips (13 fights in all; the appendix lists them). In those trips I arranged the circle myself
  through the real UI picker, followed the guide's "Arrange for me", rebuilt after two total
  wipes, merged, recruited, raised a party and watched owner-side replays. I also signed in as
  one of the API players, at 390, to read its mid-game inbox. Screenshots, logs, scripts and probes are in this session's scratchpad,
  `/tmp/claude-0/-home-user-caravan-game/edcaf182-6a4d-5af1-b736-5ca8113d60f8/scratchpad/studio/`
  (written `…/studio/` below): `shots/d1/`, `logs/`, `probes/`. They are not part of this commit.
  The UI text quoted below is copied from those dumps.
- **Ten API players on the same server** (`…/studio/bot.mts`). They play through the real routes,
  and the server's real resolver decides every fight. The bot only makes a player's choices: pick,
  circle, bank or push, refugees, unlocks, mercenaries, merges and the standing party. The
  personas:
  - `guide` ×2: takes the guide's pick, its circle (`guidedFormation`, which is what "Arrange for
    me" lays) and its bank-or-push advice.
  - `naive` ×1: one session a day, the first candidate, a scout-blind circle, banks after
    encounter 1.
  - `designer` ×3: guided circles, pushes to encounter 3, and builds a real party (core runners,
    two or four edges). One of them, `sd_core1`, builds all-`core`.
  - `solver` ×4: for every candidate on the menu it rebuilds the party from the scout, fights
    all 76 of the harness's skilled layouts offline with the server's own adapter path
    (`scripts/balance/sweep.ts`), and picks the best candidate and the best layout. Two of them
    (`sd_smart*`) also bank whenever the menu they just faced held a fight they would lose, and
    wait out the free reroll when all three candidates are losses.
  - The seven original players played 20 simulated days. The two smart solvers and the all-core
    designer, added later, played 10. I stopped them there for time: their 3-minute reroll waits
    made each simulated day take 15–20 minutes of wall clock.
- **Time travel, stated.** Only the time caps were aged, by `…/studio/age.sql` as the owner role
  with `session_replication_role = replica`, and every aging is logged with its wall-clock time in
  `…/studio/logs/aging.log`:
  - before each session, `trip_cap.tat_ms` went back 1 h (three trips) and the refugee menu's
    timestamps went back 1.5 h (one free menu);
  - an engaged persona plays three sessions a simulated day (9 trips), the naive one plays one
    (3 trips);
  - the agings ran from 18:34 to 20:08 UTC on 2026-10-20 (453 agings, one line each).

  **I did not age the mine or the ledger.** Every account's Coin therefore under-counts a real day
  by the mine's 4,800 Coin (200 an hour). That changes no conclusion below. It makes the Coin-cap
  findings conservative.
- **The balance harness, further ahead than play reaches.** Probes in `…/studio/probes/`, all
  built on `scripts/balance/sweep.ts` (`fight`, `SKILLED`, `GUIDED`,
  `NAIVE`, the band-typical corpus, the authored parties):
  - `read-value.mts`: 1,056 matchups (the band-typical rosters of 4 regions × the authored parties
    within one band) × all 76 layouts, once with the real scout and once with the scout's main
    edge forced to north. That is 160,512 fights.
  - `endgame.mts`: maxed circles (band-7-typical and 8 × L5) against 8 × L5 "meta" parties in
    six stance and edge shapes. `endgame2.mts` repeats it with mixed-composition circles, and
    `midgame.mts` with L2 parties against band-2 and band-3 circles.
  - `curve.py`: the day-1-to-day-90 ladder, web and Coin curve from the live tunables.

  The existing harness's own tables (BALANCE-LOG passes 1–8, `unlock-pace.ts`) are cited where
  they agree.

---

## 1. The core loop

**At fight 20, 100 and 500.**
- **Fight 20 (day 1–2)** is the game at its best. The guide and "Arrange for me" carry a newcomer
  through authored outfits, the replay explains every loss, and the first greedy push to
  encounter 4 or 5 is a real thrill.
- **Fight 100 (about day 4–7 for a mid-core player)**:
  - the player has learned the two or three circle shapes that work and put every post on guard;
  - they pick the smallest party on every menu;
  - they have lost a merged roster at least once to a push they could not read;
  - and they hand-place every circle, because the assist has gone.
- **Fight 500 (week 3–5)**:
  - nothing on the field has changed since fight 1;
  - the ladders are at or near rung 20;
  - Coin is at the cap or is being fed into re-merging what the last overrun took;
  - the only new information in a fight is the population.

  The cohort's players at 300–500 fights were doing exactly what they did at fight 100.

### F1. The three-candidate menu is a search for the softest target, not a read — P0, M

**Evidence.**
- Every candidate card shows the same reward. In the first encounter I scouted, Prairie Wolf
  Pack (2 raiders, 1,260 HP), Alkali Freighters (4 raiders from four sides, 3,440 HP) and
  Gunslinger's Dozen (2 shooters) each read "Coin earn ×100%". On my first live menu, Dusty
  Trailhands (3 raiders, 1,380 HP), Buckskin Company (5 raiders, 4,751 HP) and Cottonwood
  Wagons (8 raiders, 9,875 HP) also each read "Coin earn ×100%".
  - Encounter Coin is `coinForEncounter(n, caravan band)` (`economy/coin.ts`). The chosen party
    changes it only to cut it, through the sandbag multiplier, when the party is 300 or more
    below the caravan.
- Every persona converged on "fewest raiders". By day 10 the bots had taken the smallest-raider
  party in 76–86 % of 1,300+ fights: the guide's rule 77–80 %, the designers 84–86 %. Even the
  solver, which scores every candidate by a full simulation and so can pick anything, chose it in
  76–81 %.
- The pick is worth more than the arrangement. In the `read-value` matrix, at the same-band
  diagonal:

  | band | random candidate + best of 76 layouts | best of 3 + best of 76 | best of 3 + Arrange for me |
  |---|---|---|---|
  | 3 | 87 % | 100 % | 93 % |
  | 5 | 67 % | 93 % | 70 % |
  | 6 | 77 % | 99 % | 54 % |

  A player who can tell which of three parties is softest almost never loses an encounter 1.
- The guide teaches exactly this: "Prairie Wolf Pack is the smallest of the parties not made up
  only of shooters … That is a reading of the scout, not a promise."

**Why it matters.** PROJECT.md §1 and §9 make "reading an incoming force and countering it" the
skill. With flat rewards, the rational read is "which one is weakest", and the counter is
secondary. It also starves the passive side (F7): the hard-to-beat party, the King of Thieves hook,
is the one nobody picks.

**Proposal: bounty-priced menus.** Each candidate carries a printed **bounty** derived from the
party's threat against *this* caravan, shown on the card before the choice:
- The threat measure is deterministic: the party's Reputation relative to the caravan's, plus its
  own served record (a live party's rolling overrun share; an authored party's authored band).
- Bands of ×0.6 / ×1.0 / ×1.6 / ×2.2, applied to the encounter's Coin, its Reputation gain and
  its ladder points.
- The draw keeps one "soft", one "fair" and one "dangerous" slot whenever the pool allows, so
  every menu is a risk/reward choice and never "three equal prices".
- Picking the dangerous party is the greedy play. Picking the soft one is the cautious play.
  That is a read.
- Guardrails: deterministic, previewed (4), the same for every player (2), and randomness still
  only shapes the offer (1). Re-derive `FREE_WEEKLY_EARN_ESTIMATE` afterwards so the pay ceiling
  stays within the 1.5× bound.
- **Needs a PROJECT.md amendment:** §14 (encounter Coin depends on the chosen party) and §17
  (menus are stratified by threat).

### F2. The arrangement puzzle compresses to a small playbook, and stance is a dead dimension — P0, L

**Evidence** (`read-value`, 1,056 band-typical matchups × 76 layouts; hold share):

| how the circle is chosen | all bands | b0 | b2 | b4 | b6 |
|---|---|---|---|---|---|
| one fixed circle, scout ignored (always built facing north) | 57 % | 94 % | 78 % | 48 % | 32 % |
| one shape, keyed to the scouted main edge (`openFront/coreFront/guard/lane`) | 63 % | 100 % | 83 % | 56 % | 26 % |
| Arrange for me (`guidedFormation`) | 60 % | 100 % | 76 % | 50 % | 34 % |
| best of a 3-shape playbook | 78 % | 100 % | 92 % | 72 % | 60 % |
| best of all 76 | 87 % | 100 % | 94 % | 84 % | 82 % |

- **Early on, the read is worth almost nothing.** In bands 0–2 a fixed circle holds 78–94 %. The
  first two weeks of a typical player's life contain little arrangement decision at all.
- **Seven shapes cover 95 %** of everything any of the 76 can hold. Of the matchups that can be
  held at all, 51 % are held by at least half of the 76 layouts. Only 14 % are "tight" (held by
  5 or fewer). About one fight in seven is a real puzzle.
- **Stance is solved.** Restricting the search to `guard` for every post gives 86 %. The full
  search, with `hold` on ranged posts, gives 86.8 %. Every layout in the top 8 is all-guard. The
  four worst all put some or all of their posts on hold. The harness's search covers `guard` and
  `hold`; neither it nor the guide ever uses `reserve`, which tells its own story.
- Reading the main edge versus ignoring it, each with the best of 76, is 86.8 % against 83.0 %.
  Where they come from matters much less than "which of a few shapes".
- By hand I tried two "clever" reads:
  - Decoy traps on the far side against a trap-stance party with Bridging Planks. Its Prairie
    Wolves cut straight through the fence towards the traps, "reached the core" on the way, and
    the fight was over in 0:08.
  - A wall of four hold posts against three core-stance Well Diggers. The Cistern Gang reached
    the core at 0:21 while all seven of my units were alive.

  Both lost the whole packed roster. The guide's counter-intuitive pinhole funnel, and the
  open-front shape, are what work. Once learned, they are what a player lays every time.

**Why it matters.** At 500 fights, a puzzle with three answers and a dead dimension is a chore.
The arena never changes either (F5), so the playbook never goes stale.

**Proposal (three parts).**
- **(a) Trail conditions per encounter.** Each served encounter comes with a terrain and weather
  card, deterministic from the menu seed and shown on the scout card and the circle:
  - a dry wash crossing one side (impassable to wagons, so no fence there, but it slows raiders);
  - a rock outcrop (2–4 impassable cells);
  - high ground (+1 range for posts on it);
  - a creek ford (raiders slowed in a band);
  - dusk (aggro −1 for both sides);
  - a dust storm (ranged reach −1).

  This multiplies the shape space without hiding anything. **It changes a settled decision**
  (INDEX "the play area is flat level ground"; the tiers stay scenery) and **needs a PROJECT.md
  amendment** (§9, §11). The resolver gains terrain as an input, so RESOLVER_VERSION is bumped
  and the goldens are regenerated.
- **(b) Give each stance a real job:**
  - `hold` posts get a "braced" bonus, e.g. +25 % defense while at their post;
  - `reserve` posts get an "ambush": the first hit on a raider inside the ring is ×2.

  Re-run `read-value` until no stance is dominated in more than 70 % of matchups. This is a
  resolver change inside the guardrails, and a one-line amendment to the stance definitions in
  PROJECT.md's revision note (§9).
- **(c) Trap synergies.** A root then a spike hits for ×1.5. Today Spike Pit (375 damage)
  dominates the other three groundwork traps, and the trap loadout is "add six" (round 1 D3).
  This is a new resolver rule, so record it in PROJECT.md §11.

### F3. Deterministic plus fully scoutable means every fight is computable, and players will compute it — P1, M (a decision, then tooling)

**Evidence.**
- The candidate's `snapshot.composition` carries every raider's type, merge level, stance, edge
  and start cell, plus the siege: the exact resolver input. My solver rebuilt the party from it,
  fought the 76 shapes offline and predicted **1,731 of 1,731** live outcomes exactly.
- Solver 1 rode 44 trips (most of them five encounters deep) before its first overrun, on
  simulated day 5. Solver 2 rode 65, until day 8. Their logs read "solver predicted caravan_held"
  fight after fight, and the outcome always matched.

**Why it matters.** This is the game working as designed: guardrails 1 and 4 together require it.
But a studio must decide before launch what happens when a fan site or overlay ships the solver,
and in a web game that will take weeks. Once it does:
- the per-fight puzzle is a lookup for anyone who uses it;
- any leaderboard on holds or deliveries is a solver leaderboard;
- what is left of skill is only the future: which menu comes next.

**Proposal.** Keep the per-fight uncertainty out, because guardrails 1 and 4 rightly forbid it,
and **move the tension to what cannot be computed**:
- the trip chain: the next menu, the next condition (F4);
- the population: which parties exist next week;
- volume, not certainty, for the competitive metrics (F9).

Two options to choose between:
- **(i) Ship the computation ourselves** as a paid-for-by-nothing, rate-limited "Rehearse" that
  plays your circle against the scouted party once per encounter (a free, time-gated use, like
  the reroll). Skill is then knowing what to try.
- **(ii) Make the puzzle space big enough** (F2a, F2c) that a naive brute force over a handful of
  shapes is not enough. Then accept that solvers exist and keep them off the competitive metrics.

Option (i) **needs a PROJECT.md amendment** (§11: the fight is still never shown before commit,
but a rehearsal is). I lean to (ii) now and (i) only if the play test shows solver use.

### F4. Bank or push is real for a newcomer, blind for an expert, and worthless at the Coin cap — P0, M

**Evidence.**
- **The tension exists early.**
  - My guest pushed a 5-unit first trip into Sodbusters' Levy. It lost 600 unbanked Coin and
    all 5 units outright in 0:08.
  - On a later trip it pushed to encounter 5 on "Arrange for me" and banked **5,256 Coin**, against
    725 for one encounter. The guide advised "bank" at encounters 3, 4 and 5, and I pushed anyway.
  - That gap between a cautious and a greedy trip is the game's best moment.
  - In the cohort, for players who are not solvers, it is a real trade (days 1–10, Coin
    credited per trip with overruns counted as 0):

    | persona | policy | overrun share of trips | Coin per trip |
    |---|---|---|---|
    | guide ×2 | the guide's advice (banks after 1–2) | 15–21 % | 1,070–1,174 |
    | designer ×2 | pushes to encounter 3 while at 60 % HP | 18–39 % | 1,580–2,628 |
    | naive | banks after 1, scout-blind circle | 30 % | 399 |

    Pushing roughly doubles the Coin and the risk, which is what §12 asks for. The problems are
    at the two ends.
- **The push is made blind.** After a hold you see "Encounter 2 if you push: Worth 808 Coin …
  searched 15 Reputation above your own". You do not see the three parties until after you push,
  and once you have pushed you cannot go back (`trip/return` is only for an empty pool).
  - On simulated day 5 my solver, at Reputation 1,598 (band 5) with 8 units (L5, L5, L4, L4, L3,
    L3, L2, L2) at 98 % HP, pushed, and found **three candidates it predicted it would lose to**.
  - It lost both L5s, both L4s and four more units outright at encounter 2: about 70,000 Coin at
    `scripts/balance/model.ts`'s rebuild values (an L5 is 22,787), or about four days of that
    player's capped play, in one fight. Its next five days were a slide to six L1 units (F10).
  - **The way out is time, not judgment.** The menu's reroll is free and unlimited, 180 s apart.
    The two smart solvers waited out one reroll (my bot's limit, not the game's) whenever all
    three candidates were predicted losses. At bands 3–5 that always found a winnable card: no
    overrun in their first ~70 trips each.
  - Deeper, at about 1,850 Reputation, one reroll was not always enough. Smart solver 2 then had
    to fight a fight it knew it would lose. That happened three times, twice at **encounter 1**,
    because once a trip has started there is no turning back until the pool is empty.
  - So the push is a blind gamble for a human, and a wait of 3-minute rerolls for anyone who can
    evaluate a menu. Neither is the decision §12 describes.
- **Encounter 1 is a false signal.** Encounter 1 is searched 150 below the caravan
  (`FIRST_ENCOUNTER_CENTRE_OFFSET`) and encounter 2 at +15, so the step from 1 to 2 is 165
  Reputation. Every escalation after that is only +15. When solver 1 first reached the frontier,
  its overruns came at encounter 2, right after a comfortable encounter 1: 11 of its 14 overruns in
  days 1–10.
- **At the cap a push pays nothing.**
  - Skilled players reach `COIN_STORAGE_CAP` (50,000) by day 3. Solver logs end trips with "BANK 0
    (discarded 8565)".
  - The smart solver that never crashed credited 143,983 Coin from trips in 10 days, and
    discarded 384,532 at the cap: 73 % of everything it earned.
  - The naive casual, who banks after one fight and never merges, discarded 119,540.
  - With Coin worthless, the only things a push buys are Reputation (+8) and ladder points, which
    cap at rung 20.
  - BALANCE-LOG's own EV table agrees from the other side: at the L4 frontier every bank point is
    negative.
  - So the late-game optimum is "bank after encounter 1, forever". The outer loop (the trip chain)
    degenerates into single fights.

**Proposal.**
- **(a) Scout the trail ahead.** After a hold, the bank-or-push screen shows the next encounter's
  three scout cards (searched now, stored, and served if you push). The decision becomes "can what
  I have left beat one of these?", a read rather than a coin toss. The free time-gated reroll
  stays the only way to change them. This **needs a PROJECT.md amendment** (§2 step 4 and §12:
  the next menu is drawn before the decision). It strengthens guardrail 4.
- **(b) Smooth the escalation.** Encounter 1 at −50, then +40 per encounter. The step 1→2 should
  not be the biggest one. Tunables only.
- **(b′) One reroll per encounter, taken on the decision screen.** With (a) the player rerolls the
  next menu once, still free, before choosing bank or push, and not after. Waiting out rerolls
  stops being the expert's escape hatch. Guardrail 2 holds: it is free and the same for everyone.
  It **needs a §17 amendment**, because today the reroll is unlimited.
- **(c) Pay depth in something that does not cap.** A delivery streak (consecutive banked trips of
  three or more encounters) and trail trophies, both cosmetic and season-ranked (F6, F9). Coin
  cannot be the only reward for pushing when skilled players sit at the cap. This **needs a
  PROJECT.md amendment** (§14/§16: new cosmetic sources).

### The dominant strategies today

| side | dominant strategy | evidence |
|---|---|---|
| defense, the pick | the fewest raiders and lowest HP on the menu; it pays the same | F1; 76–86 % of bot picks |
| defense, the circle | open the main side or pinhole it; every post on `guard`, clustered at the gap or in front of the core; traps on the lane | F2; the top 8 single layouts are all `guard` |
| defense, the outfit | pack the two sturdiest types, the best fence tier, 6 traps (free), all 8 slots once the roster allows | traps and fence cost nothing to pack; round 1 D3 |
| defense, the trip | early: push while unhurt. At the frontier, or at the cap: bank after encounter 1 | F4 |
| offense | all units `core`, any edges, three siege pieces | F8: all-core is held 0 / 32 at L5 and 3 % at L2; `core`-heavy authored parties are held 69 % against 90 % |
| offense, the economy | a small, weak-looking party: it is picked most and paid for depth even when it loses | F7 |
| region | Mountain. The free starter Grizzly (offense 115, defense 150, 1,300 HP) is top in both roles (chunk 03 QA N6, chunk 11 QA) | content table |

---

## 2. Replayability

### F5. Run 500 differs from run 5 only by which other players are in the pool — P0, L

**What varies today.**
- **Matchmaking.** It draws from the live pool plus 12 authored outfits per band.
  - In my 10-player pool the guide players met 24 distinct parties in 147 fights. Their most
    frequent opponent appeared 23 times.
  - A large pool helps. But live parties converge on the defaults ("Raise my party") and then on
    the meta (F8), so a big pool is many copies of a few shapes.
    - Round 4 D2 found every live unit on `north`/`nearest` before the raise was varied.
    - In my pool every raised party was `nearest`/`traps` from two starter edges, 3 units.
- **Content.** A caravan only ever fields its own region's 8 living types, 7 at ladder cap
  (F6), over 6 traps, 4 fence tiers and 5 siege pieces.
  - Within a pool there is one strictly-best choice per slot, except where siege counters bite:
    Spike Pit over the other groundwork traps, the highest fence tier, and the two sturdiest
    types.
  - Regions vary the roster, but once chosen there is no build to change.
  - The web's one real choice is which node to leave out at cap (30 points against 35). Merging
    then rewards stacking the sturdiest types, and the slot cap of 8 ends the build at "8 × L5 of
    the best two". PHASE-2 §37's carried notes already say healers are the weakest archetype in
    full fights. When last measured (RESOLVER_VERSION 5), abilities flipped 29 of 1,024 matchups.
    Abilities flavour the fight; they do not change the build.
- **The battlefield.** It never varies. Every fight is on the same 32 × 32 flat square with the
  same 28-position square ring, the same 3 × 3 core and the same four entry bands.
- **Run-level choices.** The only ones are the pick and bank-or-push. Packing is "everything
  sturdy, the best fence, six traps".

**What it lacks, measured against the infinitely replayable games this resembles.**
- No modifiers or mutators: no per-encounter conditions, no weekly rule of the trail.
- No procedural events between encounters. §12's "no repair, no resupply" is respected by
  everything below.
- No rotating rules and no seasonal content. Group B, chunks 39–41, was scoped out.
- No collection goals beyond the web, and no mastery tracks.
- No boss content: no authored set-piece outfit you build toward.
- No asymmetric objectives. Every fight is "kill them or they touch the core".

**Proposal, in order of value per effort.**
- **(a) Trail conditions** (F2a): the single biggest multiplier on distinct puzzles.
- **(b) Weekly "Rule of the Trail".** One published, deterministic mutator a week, the same for
  everyone and previewable a week ahead. Examples: "Powder is wet: powder traps and Blasting
  Crates do half", "Long nights: fights last 120 s; a stalemate pays 50 %", "Stampede: every
  party gets +1 Prairie Wolf". It changes the solved shape every week. This **needs a PROJECT.md
  amendment** (§11/§17); it is a sibling of chunk 40's contracts.
- **(c) Wanted outfits.** A weekly authored "boss" party: 8 named raiders at the top of each band,
  with a story line and a cosmetic trophy for holding against it. It is served at most once per
  trip as an optional fourth card. It is chunk 25's machinery with a cadence (chunk 41).
- **(d) Trail events between encounters**, as choices that are trade-offs, never resupply. For
  example: "Take the short cut: the next party arrives on one fewer edge but +1 raider", or "Burn
  a wagon for a signal fire: −2 fence segments, the next menu has one more candidate". This needs
  an amendment to §2 and §12 ("no route-picking"). I list it last because it bends the most
  design. Do (a)–(c) first.

---

## 3. Progression and long-term goals

### F6. The curve: a fast first week, a sawtooth, then nothing — P0, M

**Evidence: the model** (`curve.py`, live tunables; ladder +25 a hold, +10 an overrun; rung n at
⌊100·n^1.5⌋; 30 unlock points per pool at cap; the living web's paid nodes cost 35):

| profile | ladder capped (rung 20) | living web | 8 × L5 affordable (no de-merges) |
|---|---|---|---|
| casual: 2 trips a day, banks after 1–2 | day ≈ 127 | 5 / 8 nodes by day 30, 6 / 8 by day 60 | day ≈ 34 |
| mid: 5 trips a day, banks after 2 | day ≈ 38 | 7 / 8 by day 30, then never 8 | day ≈ 18 |
| hardcore: 12 trips a day, pushes to 4 | day ≈ 8 | 7 / 8 by day 7 | day ≈ 3 (cap-limited) |

**Evidence: the live cohort** (the real server; Reputation, rung, Coin, the top merge levels):

| player | day 3 | day 10 | day 20 |
|---|---|---|---|
| solver 1 (Mountain) | 993 · r10 · 50,000 · L5 L5 L4 L4 L3 L3 | 1,749 · r17 · 1,581 · L1 ×6 | 1,622 · **r20** · 1,019 · L2 L1 ×7 |
| solver 2 (Badlands) | 935 · r10 · 50,000 · L5 L5 L4 L4 L3 L3 | 1,535 · r18 · 1,702 · L1 ×5 | 1,577 · **r20** · 1,405 · L2 L1 ×7 |
| guide 1 (Desert) | 608 · r5 · 15,269 · L2 ×6 L1 L1 | 703 · r10 · 2,274 · L2 L1 ×7 | 826 · r16 · 37,643 · L2 L2 L1 ×6 |
| guide 2 (High Plains) | 589 · r4 · 8,602 · L3 L3 L3 L2 … | 686 · r10 · 5,338 · L3 L3 L3 L2 … | 721 · r15 · 2,378 · L2 ×4 L1 ×4 |
| designer 1 (Desert) | 608 · r6 · 3,390 · L2 ×5 L1 ×3 | 726 · r12 · 4,242 · L2 L2 L1 ×6 | 762 · r19 · 2,591 · L1 ×6 |
| designer 2 (Badlands) | 598 · r5 · 10,714 · L3 ×5 L2 L2 L1 | 866 · r11 · 12,299 · L3 L3 L3 L2 … | 992 · r17 · 10,376 · L2 L2 L1 ×6 |
| naive (High Plains, 1 session a day) | 404 · r1 · 14,387 · L1 ×6 | 438 · r3 · **50,000** · L1 ×8 | 538 · r5 · **50,000** · L1 ×6 |

**The two smart solvers** bank whenever the menu they just faced held a predicted loss, and wait
out a free reroll when all three cards are losses. Day 10, against the same columns:
- **Smart solver 1** (Mountain): 1,792 · r17 · 50,000 · L5 L5 L4 L4 L3 L3 L3 L3, after 90 trips
  and **no overrun**.
  - It is the best a player can do. It sits at band 5 with the Coin cap full, because 73 % of its
    trip Coin was discarded.
  - Its only purchase left is more merge levels on the same 8 slots, which the frontier's held
    fights keep taking back.
  - It is 3 rungs from the end of the ladder.
- **Smart solver 2** (Badlands): 1,756 · r18 · 840 · L2 L1 ×6.
  - It held two L5s until day 7 and an L5 until day 8. Its Coin was at the cap until day 6.
  - At about 1,850 Reputation, held fights began de-merging it, and one reroll stopped being
    enough (F4). By day 10, 7 overruns later, it had 840 Coin and its best unit was L2.
  - Two equally skilled, equally careful players, one region apart: one ended rich and idle, the
    other ruined.

**Every player that merged finished day 20 weaker than it was on day 3.** The two original solvers
reached rung 20, the end of every permanent track, on day 15. They spent days 15–20 at band 5 with
L1–L2 rosters, re-merging what each overrun took. Nothing in the game is left for them to earn.

- **Merges do not stick** (20 days, ledger):

  | player | Coin on merges | Coin on mercenaries | units lost outright (levels) | de-merges |
  |---|---|---|---|---|
  | guide 1 | 116,800 | 247,800 | 205 (360) | 182 |
  | guide 2 | 88,450 | 258,000 | 270 (433) | 134 |
  | solver 1 | 211,850 | 283,800 | 221 (391), 11 of them L4–L5 | 360 |
  | designer 1 | 70,150 | 270,000 | 399 (570) | 344 |

  - The money goes round: 340,000–500,000 Coin per engaged account in 20 days, mostly spent
    replacing what overruns destroyed.
  - Round 4's D5, "a week of steady play ends about where it started", is confirmed over three
    weeks. It is worse at the top.
- **The only permanent track caps.**
  - Rungs climb steadily: r10–r18 by day 10. They are the only number that never goes down.
  - At rung 20 they stop. The living web then sits at 7 of 8 for good, because 30 points buy 30
    of 35. The doc calls this "a choice, not a checklist". To a collector it reads as a slot that
    can never be filled, with no respec.
- **Coin stops meaning anything.**
  - Skilled players sit at the cap from day 3.
  - The naive casual who never merges reached 50,000 by day 10 with nothing to buy. 77 % of the
    Coin it kept over 20 days was passive.
  - Coin's only sinks are merges and mercenaries, which F10 destroys, and refugee rerolls. With
    the store off there is no other use.
  - At the frontier Coin is maintenance: even held fights de-merge. A smart solver's held
    encounter 2 at 1,849 Reputation de-merged six units, an L5 → L4 among them, and the next town
    visit spent 9,500 + 900 + 250 + 250 Coin re-buying them. That is a treadmill, not progress.
- **There is nothing after the cap.** Group B (seasons, contracts, content cadence, records,
  multiple parties) and group C (prestige) are out of scope. After about day 40 for a mid-core
  player, the only moving number is Reputation, a rating without a leaderboard.

**Proposal: what fills prestige's role in v1 without prestige.**
- **(a) Mastery tracks per unit type** (and per trap and siege piece). XP comes from fights the
  type took part in. Rewards are cosmetic: skin tiers, a veteran's mark on the card, titles.
  Mastery is never lost on death: it is the permanence the merge loop lacks. Guardrails 2 and 3:
  cosmetic only. This **needs a PROJECT.md amendment**: a new cosmetic source in §16.
- **(b) A Trail Legend account level** fed by every ladder point after rung 20 (ladders keep
  counting). Cosmetic milestones every few levels. This keeps §5's ladders meaningful past the
  cap without new unlock points.
- **(c) The outfit log.** A collection of every authored outfit and Wanted outfit (F5c) you have
  held against, per band, with a stamp per condition (F2a). Collection goals that the content
  cadence (chunk 41) extends.
- **(d) Seasons and contracts** (chunks 39 and 40) as written. Their amendments are already
  drafted in PHASE-2.md.
- **(e) Coin sinks that are not power**, so the cap is not the ceiling of meaning: town building
  (decorations already exist as a cosmetic kind) bought with Coin, and the Wanted posters of F7.
  This needs an amendment to §14 (a new sink); it does not touch guardrail 2.

---

## 4. The passive side (the raid party)

### F7. The passive hook rewards looking weak, and the owner has nothing to tune with — P0, M

**Evidence (the ledger after 20 days; "passive Coin" is loot + party wins + unbanked Coin
transferred from overrun caravans):**

| owner | party | times served | overran | passive Coin | active Coin (encounters + banks) |
|---|---|---|---|---|---|
| guide 2 | 3 raised units | **338** | 26 (8 %) | 191,593 | 161,815 |
| guide 1 | 3 raised units | 311 | 50 (16 %) | 211,026 | 201,036 |
| naive | 3 raised units | 256 | 36 (14 %) | 50,244 | 15,225 (+119,540 discarded at the cap) |
| my guest | 2–3 raised units | 214 | **0** | 38,946, all loot from losing | 8,854 |
| designer 2 | 8 units, half `core`, 2 edges | 79 | 21 (27 %) | 42,156 | 272,489 |
| all-core designer (10 days) | up to 8 units, all `core`, 4 edges | 55 | 17 (31 %) | 40,814 | 141,581 |
| smart solver 1 (10 days) | 8 of its strongest (L3–L5), 3 after its merges | **10** | 5 (50 %) | 1,802 | 143,983 (+384,532 discarded) |

- **A caveat on scale.** In a 10-player pool every live party is served into everyone's trips,
  so the absolute passive Coin per party is higher than a large pool will give. The finding is
  the ratio between weak and strong parties. That ratio comes from the pick-from-three rule, not
  from pool size.
- **Party strength is anti-correlated with being served.** The parties that overran 27–50 % of
  the caravans that faced them were chosen 8–79 times. The 3-unit raised parties that
  overran 8–16 % were chosen 256–338 times, and earned 4–5 times the passive Coin.
- **Losing pays.** Most of the passive Coin is depth loot from fights the party lost
  (`trip/loot.ts`: a held fight pays the owner `full × depth^1.5`, minted).
  - My guest's party never won a fight in 214 serves and earned 38,946 Coin, over four times
    what the guest earned by playing.
  - The engaged guide players earned as much passively as actively.
- About 35 minutes in, my guest had been overrun on both of its trips and had banked nothing. It
  held 9,193 Coin, all of it from its two-unit party being driven off.
- One of my players' inboxes after an hour of wall-clock: "Your party struck 72 caravans … 18
  overrun by your party · 51 held out … Earned 39493 Coin".
- The owner's tools are a form (stance, edge, column, depth, three siege slots) and a feed of
  "driven off · 607 Coin" lines. There is no way to test a party, no rate or summary (chosen
  share, overrun rate, mean depth), and no hint why it was stopped. There is one party slot
  (`PARTIES_PER_ACCOUNT` 1).

**Why it matters.** §1's King of Thieves hook is "designing a hard-to-beat raiding party" and the
tension of checking where it struck. Today the best passive income comes from a party that looks
harmless and loses deep. There is nothing to design and nothing to check except a Coin total.

**Proposal.**
- **(a) Bounty pricing (F1) pays the owner too.** A party chosen as the menu's "dangerous" card
  earns ×2 on a win and on depth. A party offered and passed over earns a small "feared" ladder
  credit (D3 option a). This rewards the strong party for existing.
- **(b) A Wanted poster.** Each overrun raises the party's bounty, shown on its scout card. The
  caravan that finally holds against it collects the bounty, and the owner's feed says who did:
  "Juniper Drovers' bounty of 4,200 was claimed by Lost Spring Packers". It is a rivalry object,
  and a reason to open the app to see whether your poster still stands. Coin within the cap; it
  **needs a PROJECT.md amendment** (§10, §14).
- **(c) The proving ground.** Run your party against six fixed benchmark circles (authored, one
  per stance family), and see held or overrun and the depth, before you save. This is a
  deterministic simulation on the offense side only. It does not touch the defender's puzzle,
  because the circles are fixed, and the owner risks nothing anyway (§10). It **needs a PROJECT.md
  amendment** (§10: the owner may preview the party against reference circles).
- **(d) A party report.** Chosen share when offered, overrun rate, mean depth, the edge that held
  most often, and the three circles that stopped it (links to owner replays).
- **(e) Two or three saved parties** (chunk 43), one active, switchable for free.

### F8. From the mid game up, the targeting stance alone decides the fight — P0, M

**Evidence** (`endgame.mts`, 8 maxed circles across all regions × 24 meta parties, best of 76
layouts):

| 8 × L5 party shape (3 siege) | held, best layout | held, Arrange for me |
|---|---|---|
| all `core`, 4 edges | **0 %** | 0 % |
| all `core`, 1 edge | **0 %** | 0 % |
| half `core`, half `nearest`, 4 edges | 13 % | 0 % |
| all `nearest`, 4 edges | **100 %** | 88 % |
| all `nearest`, 2 edges | 100 % | 81 % |
| all `traps`, 4 edges | 100 % | 81 % |

The defender's region and roster made no difference (50–54 % for every circle). The attacker's
region made no difference (50–54 %). Two replicates agree:
- **Mixed-composition maxed circles** (healers and shooters included) hold all-`core` 0 / 16,
  and the `nearest` and `traps` shapes 16 / 16.
- **In the mid game** (`midgame.mts`: 8 × L2 parties of web tier ≤ 1 against band-2 and band-3
  typical circles), all-`core` is held 3 %, half-`core` 59 %, and all-`nearest` or all-`traps`
  100 %.

One field of one form decides the fight from band 2 up. The authored set shows the same at lower
levels: `core`-heavy outfits are held 69 % against 90 %. It avoids the problem by authoring, not
by mechanics: pass 8 limits each band to one `core`-heavy outfit, and the guide's raise turns dash
types to `nearest`. BALANCE-LOG has carried "core-stance dominance from band 3 up" as an open
telemetry item since pass 1. Live owners will find it within a week.

**Why it matters.**
- Once owners learn it, the top bands become unwinnable for the circles that face those parties.
- Because defenders pick from three, the `core` parties are then passed over (F7), so they win
  big when chosen and are rarely chosen.
- The `traps` stance is a strictly worse raider: `traps`-heavy authored outfits overrun 0 % of
  best-layout circles at their band and 17 % of guided ones (`read-value`).
- PROJECT.md §10's three stances are one real choice and two traps.

**Proposal.** A resolver change and a RESOLVER_VERSION bump, within the guardrails. The breach
timer and the disarm **amend PROJECT.md §11** (its end condition and its trap rule).
- A core runner commits:
  - it does not attack while running;
  - it takes +25 % damage;
  - reaching the core starts a 3-second "breach", during which a post in reach interrupts it.
- A `traps`-stance raider **disarms** the first trap it reaches: the trap is spent without
  springing, as a nullified one is today but without needing the matching siege. Each disarm
  adds a flat amount to the owner's loot. The stance becomes "clear the way for the others",
  which is a job.
- Re-run `endgame.mts` and the sweep until no stance shape is held above 85 % or below 15 % by the
  best layout at the top.

---

## 5. Social and competitive

### F9. There is no social or competitive layer at all — P0 (push and rivals) / P1 (the rest), M–L

**Evidence.**
- No friends, rivals, guilds or posses.
- No leaderboards or seasons.
- No revenge, and no way to find the party that overran you again.
- No replay sharing, no spectating, no party records.
- No device push: "Notices appear here only: nothing is sent to your phone or browser yet."

A grep for these terms across `apps/web/src` and `apps/server/src` finds no such feature, only a
comment that season events wait for group B.
Opponents are generated caravan names ("Red Mesa Wagon Co.") with no profile behind them.

**What the genre leans on that is missing, ranked for retention.**
- **Push notifications** (chunk 34's web push). For D1 and D7 this is the biggest single lever: the
  passive side's whole value is "come back and see". Without push it only works for players who
  already came back. P0, M.
- **Revenge and rivals.** After an overrun, "Post a bounty on Juniper Drovers": that party joins
  one of your next three menus as the dangerous card at bounty ×2 (F1, F7b). Owners see "Lost
  Spring Packers posted a bounty on you". This is the genre's strongest D7 loop, and it fits the
  inverted polarity cleanly. P0, S–M. It **needs a PROJECT.md amendment** (§17: a targeted
  candidate).
- **Replay sharing and party records** (chunk 42). Share a replay by link; pin your party's best
  overrun. Cheap, viral, and exactly the King of Thieves "look what my party did". P1, S.
- **Seasons with two boards** (chunk 39): deliveries for the caravan side and strikes for the party
  side, rewarding volume and streaks (F4c), because a "fewest losses" board is a solver board (F3).
  P1, M.
- **A light posse.** 5–20 players, a shared weekly Wanted outfit to beat together, and a posse
  banner. PHASE-2 §42 rejects clans for their moderation cost. I would keep chat out and still
  ship the posse: a shared goal with no free text has almost no moderation cost, and D30 in this
  genre is carried by groups. It **needs a PROJECT.md amendment.** P1, M.

---

## 6. Fairness and frustration

### F10. One overrun can erase days of progress, and the rating does not catch a falling player — P0, M

**Evidence.**
- **By hand.** My guest's second encounter: 5 L1 units lost in 0:08. A later trip: 7 units lost in
  0:21 with **none of them dead**: "Lost outright (alive when the caravan fell): Well Digger ·
  Level 1 … De-merged one level, not destroyed: None". The worst outcome comes from the fight where
  your army barely engaged.
- **Death spirals in the cohort.**
  - Solver 1: two L5s on day 4, six L1s on day 10, and still at L1–L2 on day 20.
  - Designer 1: roster 0 on day 4.
  - Guide 2: back to 5 L1 units on days 6, 8 and 9.
- **The rating holds a losing player at their frontier.** An overrun costs −20 scaled by the gap,
  and the loss multiplier is floored at 0.5 (`REPUTATION_GAP_MULT_MIN_LOSS`), so losing to a
  stronger party costs about −10. A hold against a party slightly above you earns about +9.
  - Solver 1 kept a comfortable encounter 1 and an overrun at encounter 2 each trip, and drifted
    *up* from 1,598 to 1,756 while its roster went from L5 to L1.
- **L1 routs are free and merged routs are ruinous** (round 4 D4): the stake falls on exactly the
  investment the merge loop asks for.
- **Casual and hardcore, side by side.**
  - The cautious casual (bank after encounter 1, never merge) was overrun on 9 of its first 30
    trips. It lost only L1 units, which its passive Coin replaced, and it hoarded the rest of
    the Coin.
  - The hardcore player who does everything the game asks (merge, push, climb) is the one who
    gets wiped.
  - The harshness lands on the most engaged players, the opposite of what a long-running game
    wants.

**Proposal.**
- **(a) Scatter, not slaughter.** When the caravan is overrun, units still standing scatter: each
  loses **one** merge level (an L1 is lost). Units that died in the final fight lose one level as
  now. Unbanked Coin is still lost in full, which keeps the bank-or-push stake sharp, and a trip
  still risks only what was packed. This **changes PROJECT.md §13** ("units still alive at the
  moment the caravan is overrun are lost completely") and needs an explicit amendment. It does not
  touch a guardrail: the stake stays bounded and foreseeable.
- **(b) If (a) is too soft for the design owner, a veteran floor:** a unit that has reached L3
  can scatter but is never lost outright. Same amendment.
- **(c) A rating cool-off.** Two overruns in a row lower the next trip's search centre by one
  band (shown on the outfit screen). It is a matchmaking rule, so it **needs a §17 amendment**;
  the rating itself (§5) is untouched.
- **(d) A threat readout on the scout** (F11).
- **(e) Turn back before encounter 1.** If the first menu holds nothing the player wants to
  fight, they may turn back. The trip-cap use is spent and nothing is earned or lost. Today a
  started trip must fight one of the three, and smart solver 2 fought two encounter-1 fights it
  knew it would lose. This **needs a §2 amendment** (a trip may also end by turning back before
  its first fight). It is no better than not riding out, so it is not an exploit.

### F11. The numbers are visible, but what they mean is not — P1, S

**Evidence.** The fight in which I lost 7 standing units had a readable cause that the screen never
showed:
- The scout listed the three Well Digger raiders as offense 50, defense 150, 1,100 HP, `core`.
- My four Well Digger posts deal 50² / (50 + 150) = 12.5 a hit every 1.4 s: about 9 DPS each
  against them.
- So my posts needed about two minutes per raider, and the raiders reached the core in 21 s.

Guardrail 4 says an overrun "must always be a foreseeable consequence". It is foreseeable to
someone who does the arithmetic.

**Proposal.** On the scout card, per raider against the circle as arranged:
- "Your posts in reach kill it in ~X s";
- "it reaches the core in ~Y s along its stance's path".

This is plain arithmetic from stats, not a simulation, so it stays inside guardrail 1 and makes
guardrail 4 true in practice. It is within the rules. Keep it an estimate ("~"), and label it.

### F12. The first hour is careful, but it teaches the wrong habit and then a cliff — P1, M

**Evidence.**
- **The welcome is a wall.** The welcome screen is about 240 words before "Begin", and the town
  is a 4,500-px scroll of text panels at 390 wide (`shots/d1/0379171-03-town.png`).
- **The first fight is small.** It is 2 raiders against 5 posts in a placeholder iso scene,
  23 s long. There is no spectacle (chunks 26 and 27 are scoped out), and nothing to tell a friend
  about.
- **The guide does the deciding.** It picks the party, lays the circle in five taps and advises
  bank or push. For the first two banked trips, "Arrange for me" lays the whole circle in one tap.
  - With it I held five encounters in a row and banked 5,256 Coin without arranging a single
    circle myself.
  - Once the caravan has banked twice, live parties arrive and the button is gone (it gates
    itself on the server's `authoredOnlyTrip`). The player has to hand-place 20 fence segments, 6
    traps and 8 posts (about 20–45 taps through the picker) against harder opponents, never having
    done it.
- **The passive side outearns the player in hour one.** My guest banked 0 on its first two trips,
  and held 9,193 Coin from its party. That is a fine safety net. As a lesson it teaches that
  playing badly costs nothing.

**Proposal.**
- **(a) Teach, then hand over.** From trip 2, "Arrange for me" becomes "Draft for me". It lays the
  guided circle, then asks for one change ("move the gap", "change one post to hold") before
  Commit is enabled. Keep the draft button after the authored-only phase, as a starting point.
- **(b) A first-trip set piece.** An authored first fight big enough to read: 6 raiders from two
  sides against a pre-built circle where the player makes **one** decision (which side keeps its
  gap) and sees it matter in the replay.
- **(c) Layout presets** (F14) so the hand-off to manual play is not a cliff.
- **(d) Art and audio** (chunks 26 and 27) before any external marketing beat. The placeholder
  scene was right for a loop test. It will not convert in a store listing.

### F13. Coin is worthless for engaged players, so the store has nothing to sell — P1, M (commercial)

**Evidence.**
- Skilled players sit at the 50,000 cap from day 3 (F4). The naive casual reaches it by day 10.
- The store sells 6,000 / 14,000 / 40,000 Coin plus cosmetics. Its own preview says "Over the cap:
  … 19193 Coin would be discarded at the cap".
- The cosmetics have no art.
- For a player at the cap, the $25 pack is a $25 cosmetic. For a player on the merge treadmill,
  it buys back what the last overrun took. Neither is a pack a studio can build a business on.

**Proposal.**
- Accept that power is not for sale (guardrail 2, correctly) and build a cosmetics-first economy:
  a seasonal cosmetic track (free and paid lines; chunk 39's season plus a pass), and mastery
  skins (F6a).
- Give Coin non-power sinks (F6e), so the free economy has somewhere to go.
- The paid track **needs a PROJECT.md §16 amendment** (a new monetization surface beyond weekly
  packs).

### F14. Hand-arranging every fight will become a chore — P1, S

**Evidence.**
- After the authored-only phase, each encounter is laid by hand: Quick arrange per side, plus the
  picker for each trap and post, plus stance taps. That is about 45 interactions in my scripted
  play.
- "Start from the last arrangement" exists only inside a trip (`encounterIndex > 1`).
- There are no saved layouts. A mid-core player fights 15–25 times a day.

**Proposal.** Three saved layouts per caravan, each stored relative to a main edge and rotated to
the scouted main edge on load. Apply it, then adjust. It is within the rules, and the read becomes
"which preset, and what to change".

### F15. Smaller design notes — P2, S each

- **Packing is not a decision.** Traps and fence cost nothing to pack and are restocked on a bank,
  so every outfit is "six traps, 20 of the best tier" (round 1 D3, still true). A decision would
  be a per-trip loadout weight shared by traps, fence material and units, or a stock of traps
  that an overrun loses. Either needs an amendment to §9 ("locked for the trip" stays true).
- **The merge preview frames a merge as a loss.** "Max HP 5500 → 4125" for 5 → 3 Well Diggers is
  honest, and it is the first thing a merge shows. Lead with the per-slot gain ("this slot: 1100
  → 1375 HP, hits ×1.25"), which is just as honest and is the reason to merge (§7). Within the
  rules.
- **The eighth living node can never be reached** (30 points against 35). Say so on the web
  ("you will reach 7 of these 8: choose") rather than letting a collector find out at rung 20.
- **Encounter 1 overruns on the guided layout after the assist phase.** The guide personas lost
  9–11 % of their trips at encounter 1 (10 of guide 1's 14 overruns in days 1–10), the "how did I
  lose the easy one?" case. The threat readout (F11) and layout presets (F14) are the fix.
- **Opponent identity is thin.** A live party is a generated caravan name. Rivalry (F9) needs a
  face: the owner's chosen banner (cosmetics already define party banners), their record, and a
  "you have met them 4 times" line.

---

## 7. What a studio would add before soft launch

Ranked by combined impact on D1, D7 and D30 retention and on fun. Sizes are PHASE-2's T-shirt
sizes. "Amend" means a PROJECT.md amendment is needed first, and none of these crosses a guardrail.

| # | add | D1 | D7 | D30 | fun | size | rule impact |
|---|---|---|---|---|---|---|---|
| 1 | **Push notifications plus revenge bounties** (F9, F7b). Web push for strikes (chunk 34's PWA push); "Post a bounty" on the party that overran you; Wanted posters on parties | ●●● | ●●● | ●● | ●● | M | Push is chunk 34 as written; revenge and posters amend §10, §14, §17 |
| 2 | **Scatter, not slaughter, plus a rating cool-off** (F10a/c). Survivors of an overrun lose one level instead of everything; two overruns in a row drop the next search one band | ● | ●●● | ●●● | ●● | M | Amend §13, §17 |
| 3 | **Bounty-priced menus** (F1, F7a). Soft, fair and dangerous cards with ×0.6–×2.2 payouts; owners paid more when picked as the dangerous card and credited when feared | · | ●● | ●●● | ●●● | M | Amend §14, §17 |
| 4 | **Fix the stance binary** (F8, F2b). A core runner commits (no attacks, +25 % damage taken, a breach timer); `traps` raiders disarm a trap without siege; hold and reserve get real jobs | · | ●● | ●●● | ●●● | M | Amend §11 (breach timer, disarm); the stance bonuses are tunables; resolver version bump |
| 5 | **Scout the trail ahead plus smoother escalation** (F4a/b/b′). See the next menu, with one free reroll, before pushing; no rerolls after; encounter 1 at −50, then +40 per encounter | ● | ●● | ●● | ●●● | S–M | Amend §2, §12, §17 (escalation is tunables) |
| 6 | **Trail conditions plus the weekly Rule of the Trail** (F2a, F5b). Seeded, scouted terrain and weather per encounter; one published mutator a week | · | ●● | ●●● | ●●● | L | Amend §9, §11, §17; changes the "flat level ground" settled decision |
| 7 | **First-hour rework** (F12). A set-piece first fight, "Draft for me" with one required change, layout presets (F14), the threat readout (F11), and art and audio (chunks 26 and 27) | ●●● | ●● | · | ●● | L (art) / M (rest) | Within the rules (art and audio were scoped out of the play test, not out of v1) |
| 8 | **The owner's workshop** (F7c–e). Proving ground against six benchmark circles, a party report, 2–3 saved parties | · | ●● | ●● | ●● | M | Amend §10 (chunk 43 is already drafted) |
| 9 | **The long tail without prestige** (F6). Unit mastery tracks (cosmetic), Trail Legend levels past rung 20, the outfit log, Coin sinks in town | · | ● | ●●● | ●● | M | Amend §5 (ladders keep counting), §14, §16 |
| 10 | **Seasons, contracts, and two volume-based boards** (F9; chunks 39 and 40 as drafted), designed so a solver gains nothing on them (F3) | · | ● | ●●● | ●● | L | Amend §5, §14, §16 (already drafted in PHASE-2) |

Items 1–5 are the soft-launch blockers. Items 6–10 can follow in the first content beats, but a
soft launch without 6 will read its D30 off a game whose arena never changes.

What I would **not** add before soft launch: multi-caravan (chunk 46), cosmetic prestige (47),
recycling (48) and campaign mode (49). Each is a content multiplier on a loop that has not yet
earned it. Fix the loop first. Campaign mode also keeps its research gate.

**Ship gate I would set for soft launch.**
- In the `read-value` probe, no single stance is optimal in more than 70 % of matchups, and the
  scout-blind fixed circle holds under 40 % from band 3 up.
- In `endgame.mts`, no party shape is held below 15 % or above 85 % at the top.
- In a 20-day cohort replay (this review's `cohort.mjs` with the bounty and scatter rules), the
  median engaged account's day-20 roster is stronger than its day-5 roster.
- A strong standing party earns at least as much as a weak one.

---

## Appendix: numbers and where they came from

- **The cohort** (the real server, real resolver, production config):
  - Days 1–20 for 7 players; days 1–10 for the 3 added later.
  - Total fights: 3,287 by the API players, plus 13 by hand.
  - Trips banked and overrun per player: see `…/studio/logs/bot-*.jsonl` (`ev: trip`).
  - The Coin, loss and party tables above are SQL over `ledger_event` (as the owner role, read
    only).
- **The solver's accuracy:** 1,731 of 1,731 predicted outcomes matched the server, across the
  four solvers.
- **read-value** (1,056 matchups × 76 layouts × 2, 2,012 s at 2 jobs):
  - best of 76: 86.8 %; scout main edge forced to north: 83.0 %;
  - the best single layout: 63.4 % (`openFront/coreFront/guard/lane`); guided: 59.5 %; the best
    naive: 57.3 %; the 3-shape playbook: 77.7 %;
  - restricted to guard only: 86 %; to mixed only: 72 %;
  - 7 layouts cover 95 % of the winnable set, and 25 cover 100 %;
  - `core`-heavy parties held 69 % (n = 164) against 90 % (n = 892).
- **endgame:** 192 matchups × 77 layouts (the table in F8). `endgame2.mts` (mixed maxed circles):
  0 / 16 against all-`core`. `midgame.mts` (8 × L2 parties against b2 and b3 circles): all-`core`
  3 %, all-`nearest` 100 %, all-`traps` 100 %.
- **curve.py:** rung n at ⌊100·n^1.5⌋ (rung 10 at 3,162, rung 20 at 8,944); living web paid
  costs 1, 2, 2, 8, 8, 14 = 35 against 30 points at cap.
- **The hand-played guest (`d1`).** Trips, in order:
  1. Held encounter 1 (guided), pushed, overrun at encounter 2 (5 L1 lost, 0:08).
  2. Held encounter 1 against 4 raiders from four sides (my own circle), pushed, overrun at
     encounter 2 by The Cistern Gang (7 lost, none dead, 0:21).
  3. Rebuilt with relief menus and mercenaries; "Arrange for me" ×5, banked 5,256.
  4. Banked 2,873 after 3.
  5. The first live menu (Dusty Trailhands / Buckskin Company / Cottonwood Wagons, every card
     "Coin earn ×100%"); my own open-front circle held; banked 725.

  Passive Coin over the same hour was 13,275, and 38,946 by the end of the review.
