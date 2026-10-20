# Final play-test review, round 3: fun and playability

Reviewer: independent adversarial play-tester, round 3 (fun and playability only; a guardrail
reviewer ran in parallel on port 3949). Build: `roadmap/phase-2-spec` at 6efc311 (balance pass 5,
RESOLVER_VERSION 9, authored set v5), real resolver in-process. Date: 2026-10-20.

## Verdict: NOT READY

Every S item from rounds 1 and 2 is fixed, and it shows. Reloading 25 times in a row never signed
me out. Linking, a second device, deletion, the inbox, owner-view replays and party self-repair
all work. Banking after three held encounters against other testers' parties (2,873 Coin, with real
push-or-bank tension) is genuinely good fun. Two things still spoil the first 20 minutes, and both
come from the parts the earlier fixes did not cover.
**First, the guide's "push" leads into a fight a new player loses about half the time.** After
encounter 1 the guide recommends one push. Encounter 2 gives no scout reading. In 76 % of the
encounter-2 menus the smallest party (the rule the guide has just taught) is ranged-only. Picking
it, the guide's own circle holds 56 %, not the 86 % that BALANCE-LOG pass 5 reports. In play, 5 of
my 6 pushed encounter 2s were overrun.
**Second, a tester's second trip is served other testers' whole raised rosters.** These are 7
raiders against the guide's 5 posts. The cold-start raider cap stops applying once the roster
reaches 7, and authored outfits are held to 30 %. So trip-2 menus are mostly live raised rosters:
g6's held three 7-raider parties. A whole Badlands roster beats every fresh circle in the probe (0 of 16, even
the best of 76 layouts). A whole Mountain roster holds at most 4 of 16.
Each of these is a one-session fix. With both done I would call the build ready.

## How I played (so the evidence can be reproduced)

- **Hosting, per `docs/PLAYTEST-HOSTING.md`, in single-process mode.**
  - I ran `pnpm build`.
  - The shared-instance option of step 2: I created the roles `caravan_r3pt_owner` (`IN ROLE
    caravan`, `SET role = caravan`) and `caravan_r3pt_app` (`IN ROLE caravan_app`), with
    non-default passwords, and the database `caravan_playtest_r3` owned by caravan.
  - The env file held `NODE_ENV=production`, `SERVE_WEB=1`, `STORE_MODE=off`, `HOST=127.0.0.1`
    and `PORT=3951`. There was no `TRUST_PROXY` (no proxy) and no test flag.
  - I ran `migrate.js up` (28 migrations), then `seed.js` ("set v5: 96 created … No login
    accounts were created"), then `node apps/server/dist/index.js`.
  - The boot lines were as the runbook says: "real resolver", "store: off (packs previewed, not
    sold)", "serving the client … source maps not served".
  - Chromium treats `http://127.0.0.1` as a secure context, so the `Secure` device cookie worked
    without Caddy.
- **Driving.** Playwright Chromium (`/opt/pw-browsers`) as a touch phone: isMobile, hasTouch, the
  Pixel 5 UA, 360×740, and 320×568 for g2, g5, g8 and g4's second device. A long-lived driver kept
  one page per player.
  - The first trips of g1 and g2 I played step by step and read every screen. After that I used a
    "reasonable player" script, `r3/h2.mjs myArrange`. It fences the raider sides first, posts
    units two rows inside the raider side, lays traps in front of them, and picks the
    smallest-HP party unless stated otherwise.
  - Evidence is under `/tmp/claude-0/-home-user-caravan-game/edcaf182-6a4d-5af1-b736-5ca8113d60f8/scratchpad/r3/`.
    Screenshots are cited below as `shots/…`. `trips-now.txt` is every trip and encounter the
    server recorded. `probes/` holds the two offline probes and their output.
- **Players (all guests through the UI):**

  | player | region | first trip | then |
  |---|---|---|---|
  | g1 | Desert | held vs Prairie Wolf Pack (guided); pushed; **overrun** vs Rattler Den Gang | Raised a party; merged later (party repair seen) |
  | g2 (320) | High Plains | **overrun 0:20** vs Timberline Gang (guided): 4 lost outright | 3 units left; trip 2 under the raider cap **held**, +525 |
  | g3 | Mountain | held; pushed; **overrun** vs Rattler Den Gang | Trip 2 **overrun** by Red Mesa Teamsters (g8's whole Badlands roster) |
  | g4 | Badlands | held, banked | Linked as `r3_badlands_bea`; trip 2 held ×3 vs live parties (2,873 banked); then the week |
  | g5 (320) | Desert | held; pushed; held vs Cistern Gang (first listed); banked 1,658 | Trip 2 held vs a live 2-raider party |
  | g6 | High Plains | held, banked | Trip 2 menu was **three 7-raider whole rosters**; held vs the Desert one |
  | g7 | Mountain | held; pushed; **overrun** vs Rattler Den Gang (first listed) | — |
  | g8 (320) | Badlands | held; pushed; **overrun** vs Rattler Den Gang | Trip 2 held vs Sagebrush Outfit (g3's whole Mountain roster) by 2 units |
  | g9 | Desert | **overrun** vs Prairie Wolf Pack (guided): 5 lost outright, 0 killed | Relief menu, 3 units; later deleted |
  | g10 | High Plains | **overrun** vs Prairie Wolf Pack (guided) | 2 units; trip 3 held ×3, banked 2,041 |
  | g11 | Badlands | held; pushed; **overrun** vs Claim Jumpers' League | 4 units; two trips held, banked |

- **Time travel, stated.**
  - Only for g4, and only the time caps: `trip_cap.tat_ms` and the refugee menu's
    `generated_at_ms` / `window_opened_at_ms` / `claimed_at_ms` were moved back 24 h each time
    (`r3/age.sql`, `session_replication_role = replica`). **I did not age the mine or the ledger.**
  - My day script failed several times before it worked, so about 17 agings were applied between
    05:16 and 05:52 UTC. Only about 6 of them were followed by played trips. Each one released a
    refugee menu that the script took, so g4's roster grew 7 → 20 L1 units over 11 trips. Read
    g4's numbers as "a player who opens the game every day to take a refugee and plays about 11
    trips in a week", not as a clean simulated week.
- **The session ended early.** Both the server and the driver hit the 2-hour background limit at
  about 05:53 UTC and were stopped. I did not restart them, so the week stops at g4's eleventh trip.
- **Probes (offline, the server's own resolver path through `scripts/balance/sweep.ts`):**
  - `probes/_r3probe.ts`: the first trip as `first-trip.ts` runs it, except that encounter 2 is
    picked the way the client lets a player pick.
  - `probes/_r3probe2.ts`: the second-trip gate (`raisedGate`), with 7-unit whole-roster parties.
  - Run either from `apps/server` with `pnpm exec tsx <path>`, after copying it into
    `scripts/balance/`.

---

## Rounds 1 and 2: S items

### Round 1 S1 (an overrun wipes the roster; recovery takes hours): **fixed**
- **Reserve.** The guide packs 5 and leaves 2 in town: "The guide ticked 5 units and left 2 in town
  as a reserve" (`shots/g1-outfit.png`). g9's guided first fight lost all 5 packed units, and 2
  stayed home.
- **Relief.** g9 was down to 2 units. Town showed "Your next free menu is ready: take it now
  (nothing is forfeited)" (`shots/g9-town-relief.png`), and the pick brought the roster to 3.
- **Pack warning.** "You are packing all 3 of your units. Everything you pack can be lost" (g2).
- **Raider cap.** g2's 3-unit rebuild was told "None fields more raiders than the 3 units you
  packed". It held and banked 525.

### Round 1 S2 (the standing party silently stops after a merge or a loss): **fixed**
g1 merged 2 Dust Riders that were in its party. The inbox said: "Your standing party changed · A
merge used units from your party. 1 slot moved to the merged unit. 1 slot was dropped. It now
fields 6 units".

### Round 1 S3 (hand-arranging is a chore; the picker moves the last segment): **fixed**
- Quick arrange (Fence North/East/South/West, with raider counts) is there, and so is "Start from
  my last arrangement". Its label now names the sides: "(it faced East and South; this party comes
  from North)".
- The picker auto-advances, and a circle takes about 10 taps.
- Two rough edges from round 2 remain: N2 and N3 below.

### Round 1 S4 (the fight is not shown): **fixed**
- Every commit opened the replay already playing at 2×, with "Skip to result" as the primary
  action (`shots/g1-replay-3s.png`).
- Quiet stretches fast-forward.
- The key-moments feed reads well: "0:05 Your Spike Pit sprang on the raiders' Prairie Wolf: 299
  damage."

### Round 1 S5 (the sandbox store hands out Coin): **fixed**
- The boot log says "store: off (packs previewed, not sold)".
- I did not open `#/packs` this round.

### Round 2 S1 (page loads sign the player out): **fixed**
- g1 reloaded 25 times, about 1.3 s apart. All 25 came back in the game, as the same guest.
- A second tab opened in the game too.
- A cold load logs one 401 for `POST /auth/resume` before the cookie resume settles (N10).

### Round 2 S2 (ranged starter parties beat the first fight): **fixed for the first trip; the same failure has moved to encounter 2 and to trip 2**
- Every first-trip menu I saw (11 caravans) was authored only.
- The guide passed over all-ranged parties at encounter 1: "It passes over Bounty Board Riders,
  Gunslinger's Dozen: every raider there shoots from range…" (`shots/g1-candidates.png`).
- Guided encounter 1 held 8 of 11 in play, and 172 of 200 (86 %) in the probe.
- The same failure now hits encounter 2 of that first trip (new S1) and the second trip (new S2).

---

## New punch list

Tags: **S**: blocks the external play test. **D**: design question for the orchestrator.
**N**: polish. Each item fits in one session.

### S1. The guide's "push" leads into an encounter 2 a new player loses about half the time

- **Play.** On every held first fight the guide said: "Your circle came through in fair shape. One
  push shows how encounters escalate…" (`data-advice="push"`). Encounter 2 then says only "No list
  this time. Search, scout the party, then arrange the circle yourself".
  - The cheapest-looking party on that menu was ranged-only every time. The summary card shows
    "4 raiders · ◉ nearest 4 · Total HP 2040 · Siege none", and nothing on it says the raiders
    shoot from 3.5–4 cells.
  - Of the 6 caravans that pushed, **5 were overrun**: 4 by Rattler Den Gang (g1, g3, g7, g8) and
    1 by Claim Jumpers' League (g11). Only g5, which happened to pick The Cistern Gang, held.
    These fights are in `trips-now.txt`.
  - At level 1 the dead come home at level 1, so each loss cost the trip's 600 Coin and the first
    trip's ending, not units. A tester's first session therefore ends "I did what the guide said
    and lost everything I earned".
- **Probe** (`probes/probe1-25.txt`). 200 fresh caravans, the guided encounter 1, then encounter 2
  as the server serves it:

  | encounter-2 pick | guide's shape held | best of 76 skilled layouts |
  |---|---|---|
  | `guidePick`, which passes over ranged-only parties (what pass 5 reports; **the client never shows it at encounter 2**) | 148 / 172 = **86 %** | 154 / 172 = 90 % |
  | the smallest party (the rule the guide just taught) | 97 / 172 = **56 %** | 124 / 172 = 72 % |
  | the first party listed | 98 / 172 = 57 % | — |

  - 130 of 172 encounter-2 menus hold a ranged-only party, and in every one of them it is the
    smallest.
  - By party, guided shape / best skilled:
    - The Cistern Gang: 94 / 94 and 94 / 94.
    - Deadfall Crew: 83 / 85 and 84 / 85.
    - Rattler Den Gang: 68 / 80 and 72 / 80.
    - Sodbusters' Levy: 55 / 86 and 71 / 86.
    - **Claim Jumpers' League: 5 / 79 and 31 / 79.**
    - **Hardrock Hirelings: 0 / 92 and 7 / 92** (D2).
- **Why it blocks.**
  - This is the end of every tester's guided first trip. The guide pushes them into it.
  - BALANCE-LOG's "first trip completed 74 %" assumes a pick the client does not make. The real
    figure is about 0.86 × 0.56 ≈ 48 %.
  - GUARDRAILS §4 asks that a loss be foreseeable. Here the deciding fact (range) is only inside
    "Full scouting report", and the guide has just taught the player to choose by HP.
- **Fix (one session):**
  - **Client:** show the encounter-1 scout reading (`ScoutGuide`: its pick and the ranged
    pass-over note) on the candidate list of **every encounter of the first trip**, not only
    encounter 1 (`TrailGuide` returns `"free"` for `encounterIndex > 1`).
  - **Client:** add a "shoots from range: N of M" line to every candidate summary card, for every
    player (N9).
  - **Harness:** `first-trip.ts` should pick at encounter 2 the way the client does: the guide's
    pick once the reading above is shown there, and the smallest party until then. Report that
    number, and gate the CI slice on it.
  - **Optional:** re-author Claim Jumpers' League and Hardrock Hirelings out of band 1 (D2), or make
    the push advice read the next band's menu.

### S2. A tester's second trip is served other testers' whole raised rosters: 7 raiders against 5 posts

- **Play.**
  - g6 (High Plains, 7 units, packed 5 as the guide had taught) rode out on trip 2. Encounter 1 was
    "Searched near 254 … Every party offered belongs to another player. Authored parties were drawn
    less often this time". The menu: Juniper Wagon Co. (7 raiders, 6,260 HP), Lone Pine Wagon Co.
    (7, 6,550) and Sagebrush Outfit (7, 5,700). All three are the guide's "Raise my party from my
    roster" (`shots/g6-trip2-cands.png`).
  - g8's trip-2 menu was the same kind: Sagebrush Outfit, Juniper Wagon Co. and Lone Pine Wagon
    Co. were all 7-raider rosters. g5's menu held one 7-raider roster next to two smaller live parties. g11's held smaller live parties and one authored outfit.
  - **g3 (Mountain, 5 packed) was overrun by Red Mesa Teamsters**, g8's whole Badlands roster: 7
    Gunslingers and Bounty Hunters, all 5 posts killed in 0:19 (`shots/g3-t2-replay.png`). The same
    party also overran g4 on its next trip.
  - Holds against whole rosters were g6 (vs the Desert one), g8 (vs Mountain, with 2 of 5 posts
    left), and g4 (7 Badlands posts vs Mountain).
- **Why the protection is gone.**
  - `COLD_START_ROSTER_MAX` = 6 turns the raider cap off once the roster holds 7, which is every
    caravan that took its first refugee.
  - The guide's raise puts the **whole** roster in the party. That is 7 units, refugee included.
    Pass 5's gate measured 6.
  - Every new party sits at REPUTATION_START (400), which is inside the trip-2 encounter-1 window
    (254 ± 150).
  - `AUTHORED_PARTY_MAX_SHARE_BP` (30 %) pushes the authored outfits out as soon as a few testers
    exist.
- **Probe** (`probes/_r3probe2.ts`, `raisedGate`; the whole roster raised the guide's way, vs every
  fresh guided 5-post roster):

  | whole raised roster | 6 units (pass 5): guided / best | **7 units (as raised)**: guided / best |
  |---|---|---|
  | Desert | 6/8, 8/8 | 12/16, 16/16 |
  | High Plains | 8/8, 8/8 | 16/16, 16/16 |
  | Mountain | 2/8, 2/8 | **2/16, 4/16** |
  | Badlands | 0/8, 0/8 | **0/16, 0/16** |
  | all | 16/32, 18/32 | **30/64 = 47 %, 36/64 = 56 %** |

  - Half of all regions' testers raise a party that no layout in the search set can hold.
  - BALANCE-LOG pass 5 recorded this as telemetry question 1 ("a whole six-unit ranged roster
    raised as one party"). In play it is not an edge case. It is what trip 2 serves.
- **Why it blocks:** it is the first live encounter of the first-hour trip. That fight is meant to
  be the easy one, searched 150 below the caravan. Against half the pool the best arrangement
  loses, so the skill expression the game is built on is void exactly when testers first meet
  each other.
- **Fix (one session; pick one and re-measure with the probe at 7 units):**
  - (a) **Key the raider cap on what the caravan packed in bands 0–1, whatever the roster size.**
    No party with more raiders than packed units is offered while the search centre is in band 0
    or 1. It relaxes only to fill a menu, as today. This is the pre-pass-3 band rule with the pass-3
    packed-count key kept, and it is stored on the menu row as today, so menus replay.
  - (b) **Or extend `AUTHORED_ONLY_FIRST_TRIPS`** to "until the caravan has banked 2 trips", and
    keep (a) for bands 0–1.
  - In either case, fix the harness: `first-trip.ts --raised` raises 7-unit whole rosters (the
    refugee included), as the guide does.

### D1. Fast core and trap runners still decide 3 of 11 guided first fights (round 2 D1 carried)
- **Evidence:**
  - g2: overrun at 0:20 by Timberline Gang (2 core-stance raiders). The guide picked it as "the
    smallest of the parties that fight up close". 4 units were lost outright
    (`shots/g2-strip.png`: the Grizzly walks to the core while the Homesteaders fight the Trapper).
  - g9 and g10: Prairie Wolf Pack (traps stance, Lope) reached the core. g9 lost 5 outright with 0
    killed.
  - Pass 5 itself records Timberline Gang, the guide's pick, holding 11 of 28.
- **Question:** should the guide's pick also pass over core-stance-only parties when another
  candidate exists, as it does for ranged-only ones? That is a client rule with no simulation
  change. Or should Timberline Gang and Grizzly Creek Trappers leave band 0?

### D2. Hardrock Hirelings is effectively unbeatable for a first-trip caravan, and it is served at encounter 2
- **Evidence:** the probe gives 0 of 92 for the guided shape and 7 of 92 for the best of 76 layouts.
  It is 4 core-stance Mountain raiders, 3,500 HP, at about 400 Reputation. It appeared in at least 2 of my
  encounter-2 menus (g3 and g11).
- **Question:** is a band-1 authored outfit that a fresh 5-post circle beats 8 % of the time at
  best intended? If not, re-author it with 3 raiders, or move it up a band.

### D3. Unlock pace in week 1
- **Evidence:** after g4's 11 trips (9 banked), its living ladder was "rung 1 of 20". It had been
  granted 3 unlock points in all (Claim Jumper and Tripwire Snare bought). The tier-3 living nodes
  cost 8 points each. Its roster was 20 L1 units, it had 9,937 Coin and it had never merged.
- **Question:** the Webs are the only access gate, and in a week a tester sees 2–3 nodes. Is that
  the intended week-1 progression feel? BALANCE-LOG pass 2 D8 measured the first tier-2 node at
  2–3 days. The play test should report the screen-flow share of Webs.

### N1. The Party screen overflows at 320 px
- A party member card is 343 px wide in a 320 px viewport (`scrollWidth` 359). The page scrolls
  sideways, "Take out" and "West" are cut off, and so is the tab bar's "Webs"
  (`shots/g2-party-320.png`).
- **Fix:** `min-width: 0` and wrapping on the stance and edge button rows. Add Party with 7 members
  to the 320 px `fitsPortrait` e2e check.

### N2. "All steps (1 of 5 done)" before any step (round 2 N8, not fixed)
- It shows on the guided encounter 1 before the first tap (`shots/g1-formation-top.png`).
- **Fix:** count the gap step only after the fence step.

### N3. A canvas tap next to a fence selects the fence instead of placing the selected unit (round 2 N7, not fixed)
- With Well Digger 1 selected, taps one cell inside the north fence selected "Segment 11 (Brush
  Pile) · ring position 2, North" (`shots/g1-e2-posted.png`).
- **Fix:** while a placeable item is selected, hit-test empty cells first.

### N4. A raw error code in the commit dialog (round 2 N1, partly fixed)
- "living unit Grizzly 2 has no post **unit_not_posted**" (`shots/g8-commit-disabled.png`).
- **Fix:** show the sentence only. The dialog already says "Not yet posted: Grizzly 2".

### N5. The owner's replay says "loot 0 Coin" while the inbox says 300 Coin for the same fight
- g8's inbox: "vs Sagebrush Outfit … Your party overran the caravan. 300 Coin · +22 Reputation".
- The same fight's replay end card: "Your party's loot from this fight: 0 Coin, as reported"
  (`shots/g8-owner-replay-end.png`).
- **Fix:** show the earned total in the end card, with the transferred loot as its own line.

### N6. The inbox still shows a linked player's username to strangers (round 2 N16, partly fixed)
- g5's inbox reads "vs **r3_badlands_bea** (Copper Train)". Parties are now served under the
  caravan name, but this inbox line was not changed.
- **Fix:** "vs Copper Train".

### N7. Traps can be over-packed past the slot cap
- After "Pack the same as last trip", "Add Spike Pit" stayed enabled. The screen then read "8 of 6
  trap slots · 2 too many: the server will refuse this", and ride-out was refused
  (`shots/g4-ride-fail.png`).
- **Fix:** disable every trap's Add at the cap.

### N8. The page jumps after "Place here"
- Placing from the picker scrolled the page from y 2323 to y 1605 (the "bring the circle into
  view" step). On touch, the next tap lands on whatever moved under the thumb. My driver hit the
  tab bar this way twice.
- **Fix:** scroll only when the circle is off-screen, and never while the picker is open.

### N9. Candidate summary cards hide range
- See S1. Each card lists stance, total HP, siege and sides, but not "shoots from range". Range is
  the property that most decides an early fight.
- **Fix:** add "◎ ranged N" next to the stance glyphs. It should carry a word as well as a glyph,
  per the theme rules.

### N10. 4xx noise on cold loads
- Every cold load logs a 401 on `POST /api/auth/resume` before the cookie resume settles.
- `GET …/encounters/2/formation?ifNone=null` returned **404** for an ended trip's encounter
  (round 2 N10 asked for 200 `{ formation: null }`).
- Both pollute the crash panel.

### N11. A desert starter's only ability does nothing on defense
- Well Digger's "Pick Swing" is a fence-breaker. Posted in the caravan's own circle it never fires,
  yet the tray and the Selected panel present it at length.
- **Fix:** label abilities that only act when raiding: "(raiding only: breaks fences)".

### N12. Replays open on the whole island
- At 360 px the raiders are 6–8 px glyphs for the first seconds (`shots/g3-t2-replay.png`;
  round 2 N14, partly fixed).
- **Fix:** frame the ring plus the occupied entry bands.

### N13. The scout guide card fills the first screen of the candidate list at 360×740
- The three candidates start below the fold (`shots/g1-candidates.png`).
- **Fix:** collapse the body after the first read, and keep the pick sentence and the "passes over"
  note.

---

## Judgement against PROJECT.md §21 and the brief

- **Is the loop clear?**
  - Yes. The welcome screen states the inverted loop plainly, and I saw no "base/camp" slip.
  - The outfit, ride-out, bank-or-push and summary screens itemise every stake.
  - Owner-view replays read the right way round: "Your Trapper 2 fell to the caravan's Bounty
    Hunter 4… Your party lost nothing; it is a template."
- **Are the decisions meaningful?**
  - Arranging the circle is. My full fence on the raiders' side held against whole Desert and
    Mountain rosters (g4, g6, g8), but it lost all four times to Rattler Den Gang. The probe
    says the guide's gap shape holds Rattler Den Gang 68 of 80. The read matters.
  - Bank or push is real from encounter 2 on: g4's 3-encounter trip at 2,498 unbanked, 3 posts
    dead, 1,090 more on offer.
  - The pick among three candidates is where a new player is currently misled (S1, S2).
- **Are fights fair and legible?** Legible, yes: the replay and its key-moments feed explain every
  loss I had. Fair, not yet: S1's encounter-2 menus and S2's whole rosters are fights the player
  cannot read from the card, and in S2's Badlands case cannot win at all.
- **Is there a reason to return?**
  - Yes. The inbox told g3 and g8 where their parties struck (one held off, two overruns, Coin and
    Reputation) with owner replays.
  - Refugees, trip starts and party changes arrive as notices.
  - The weekly unlock pace is slow (D3).
- **Pay-to-win:** nothing purchasable was reachable (store off). Mercenaries and merges are Coin,
  and they are pace only.
- **Grind walls:** none in the first hour.
  - The relief floor and the raider cap rebuilt g2, g9 and g10 within minutes.
  - g10, down to 2 units, went on to bank 2,041 on its third trip.

## Orchestrator decisions (2026-10-20)

The pattern across rounds: a new player's early fights must be fair against what they are actually served, measured the way the client actually behaves. The fixes below close that, and the harness must model the client exactly so the numbers stop drifting from play.

- **S2: two protections, both tunable.**
  - **(a)** A caravan meets authored outfits only until it has banked `AUTHORED_ONLY_UNTIL_BANKS` trips (default 2; this replaces "first trip"). A voided or overrun trip does not count.
  - **(b)** In bands 0–1, the raider cap compares against the caravan's packed units, whatever its roster size, so a whole raised roster is never served against a smaller packed circle at low bands. Above band 1 the roster-based rule stays as it is.
  - Re-measure with 7-unit raised rosters, the size "Raise my party" actually makes.
- **S1: the guide sees what the player needs at every guided encounter.**
  - Show the scout reading at every encounter of the guided trips, not only encounter 1.
  - Every party card shows a ranged count, for example "2 of 3 shoot from range", by shape and word, not by colour alone (closes N9).
  - The guide's pick rule, which passes over ranged-only parties and then takes the smallest, applies at every guided encounter.
  - The bank-or-push advice must not recommend a push when every candidate is ranged-heavy and the circle is hurt.
  - `first-trip.ts` and the CI slice reproduce the client's pick and advice exactly: one shared function, or a test that pins the harness to the client's rule. The 70 % encounter-1 target and a new 60 % pushed-encounter-2 target apply to that real behaviour.
- **D2: re-author outliers.** Any authored party that the best layout of its band's typical roster holds less than 20 % of the time is re-authored (Hardrock Hirelings, for one), keeping the band's difficulty rising. Record it in BALANCE-LOG.
- **D1, D3: no change before the play test.** Both are in BALANCE-LOG as telemetry questions, with this round's numbers.
- **Every N item is in scope.** N6: strangers see the caravan name, never a username.
