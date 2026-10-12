# Final play-test review: fun and playability

Reviewer: independent adversarial play-tester (fun and playability only; guardrail and technical
probes are a separate review). Build: `roadmap/phase-2-spec` at f4db20b (balance pass merged),
RESOLVER_VERSION 8, real resolver in-process (no `CARAVAN_TEST_RESOLVER`). Date: 2026-10-12.

## Verdict: NOT READY

The core loop does work, and it reads the right way round. The welcome screen states the inverted
polarity clearly. The guided first fight held against a real party. The bank-or-push screen
itemises the stakes better than most shipped games do. A stranger's standing party was served into
my second account's trip, and its owner got an inbox strike with a replay that plays. But in the
first hour a tester can fall into a **roster-wipe death spiral**. One overrun destroys every unit
that was packed, and the guide tells a new player to pack the whole roster. Rebuilding takes hours:
one refugee every 90 minutes, a 600-Coin mercenary against a 200 Coin/hour mine. A rebuilt caravan
of 1 or 2 units is overrun again at once by the 3-raider floor parties. 5 of my 12 fresh accounts
had zero units within three trips. On top of that, the standing party (the passive side and the
main reason to come back) **silently stops being served** after the first overrun or merge, and
nothing tells the player. Arranging the circle by hand from encounter 2 on is a 60-tap chore, and
the accessible picker has a bug that makes it worse. The sandbox store hands out 60,000 Coin a week
for $0, so the play test's economy data would be noise. Each of these is fixable in a session or
two. Fix the S items below and the build is worth putting in front of testers.

## How I played (so the evidence can be reproduced)

- **Setup:** `pnpm build`; created `caravan_dev_final1`; `pnpm db:reset && pnpm db:seed` (owner
  role / `caravan_app`); `node apps/server/dist/index.js` on :3961 with `DATABASE_URL` as
  `caravan_app`; `vite preview` of `apps/web/dist` on :4961 proxying `/api` to :3961. Driven with
  Playwright Chromium (`/opt/pw-browsers`) as a touch phone at 360×740 and 320×568. Screenshots are
  in the session scratchpad, `…/scratchpad/shots/` (full path:
  `/tmp/claude-0/-home-user-caravan-game/edcaf182-6a4d-5af1-b736-5ca8113d60f8/scratchpad/shots/`;
  `shots/NN-*.png` below is relative to it).
- **Player A** (guest, Desert, 360×740): played entirely through the UI. Welcome, then the guide,
  the guided encounter 1 (held), push, a hand-arranged encounter 2 (overrun), raising the party,
  the inbox, the webs.
- **Player B** (guest, Mountain, 320×568): the guide. Encounter 1 was against **A's standing
  party** ("Unnamed drifter"), held, then banked. Afterwards A's inbox showed the strike and its
  replay played.
- **Returning-player week:** B, a third guest C (High Plains, guide skipped) and a cohort of 9
  fresh guests (h1–h9, all four regions). After the first UI trips, these trips ran through the
  same HTTP API the client uses, with an in-page "reasonable player" script. That script picks the
  least threatening of the three scouted parties and copies the guide's shape: fence the main
  side, leave a gap in the middle, post everyone just inside the gap, a trap in the gap. It plays
  worse than the balance sweep's best-of-76 layouts and about as well as a first-week human. I
  also merged and unlocked a web node in the UI (h5, h8), bought a sandbox pack (h8), linked a
  guest to a username (h3), and signed in at 320×568.
- **Time travel (stated):** for B and h3 only, I reset the trip cap's `tat_ms` and aged the
  refugee menus by 91 minutes as the owner role (script `scratchpad/tt.sql`; the guard trigger
  was disabled and then re-enabled). I did **not** fake Coin: mine income below is computed from
  the tunables (200/h), not simulated.

Raw results of the scripted trips (encounter outcome, units killed / alive afterwards):

| player | trip 1 | trip 2 | trip 3 | end |
|---|---|---|---|---|
| A (UI, then script) | held, pushed, **overrun** (3 lost) | held, pushed, **overrun** (4 lost) | — | **0 units** |
| B | held (vs A's party), banked | **overrun at e1, 7 alive → all lost** | rebuilt to 2 (refugee + mercenary): **overrun at e1** | **0 units, 167 Coin** |
| C (High Plains) | held, pushed, overrun (5 died, kept) | **overrun at e1, 6 alive → all lost** | — | **0 units** |
| h1–h5 (bank after e1) | 4 held, 1 overrun | 5 held | 4 held, **1 overrun with 7 alive (h2 → 0 units)** | 4 of 5 healthy, 1 wiped |
| h6–h9 (push once) | 4 held at e1; e2: 2 held, 2 overrun | e1: 3 held, 1 overrun; e2: 2 held | e1: 3 held; e2: 1 held, 2 overrun | h7 **wiped**, h6 down to 3, h8/h9 thriving (4,974 / 3,316 Coin) |

Across the scripted trips, encounter 1 held about 85 % of the time (consistent with BALANCE-LOG's
81 % guided). A pushed encounter 2 held only **5 of 9**. Every overrun in which the posts were
still standing destroyed the whole packed roster.

---

## Punch list

Tags: **S**: blocks the external play test. **D**: design question for the orchestrator.
**N**: polish. Each item fits in one session.

### S1. [client parts closed: fixplay-client; server parts with the server agent] One overrun can wipe the whole roster, and recovery is a multi-hour dead end

- **Evidence:** the table above. 5 of 12 fresh accounts (A, B, C, h2, h7) had **0 units** within
  three trips. B's empty town: `shots/41-b-empty-town.png` ("0 of 36 board slots used · No units
  yet"). B rebuilt to 2 units (the free refugee menu after time travel, plus one 600-Coin
  mercenary, which left 167 Coin). That 2-unit caravan was overrun at encounter 1 by a band-floor
  3-raider party, and both units were lost. C: `shots/43-c-ovr-3.png`, `shots/43-c-ovr-4.png`. A
  single Homesteader (offense 45) breaks one Brush Pile on the far side and walks to the core
  while six guards stand at the gap. "Killed 0", and six units are destroyed.
- **Why it blocks the test:** the guide says "Tick the units to take…" and its own e2e packs
  everything. The starting roster (6 plus 1 refugee = 7) is *smaller* than the 8 deployment slots,
  so every new player risks 100 % of their units on every trip. That breaks the premise of
  PROJECT.md §12a/§13 that "the roster is much larger than what a caravan can carry" and "a
  catastrophic trip costs a slot's worth of units, never a whole collection". Recovery is not
  "generous in practice" (§21's fun check): from zero, it is about one unit per 90 minutes from
  refugees plus one per 3 hours of mine income. A caravan below about 5 units cannot hold against
  the floor parties, so a tester who loses once in the first hour cannot play again that day.
- **Observed vs expected:** observed, a total wipe in trip 2 or 3 for about 40 % of new accounts
  and no way back the same session. Expected, a bounded loss that leaves enough to keep playing.
- **Fix proposal (one session; pick one and record it as a D decision):**
  (a) A tunable `ROSTER_RELIEF_FLOOR` (proposed 6): while a caravan's living roster is below the
  floor, the refugee timer is waived. A free menu, drawn only from already-unlocked types, is
  available each time the player is in town, until the roster is back at the floor. This keeps
  the unlock-web gate and the "no grants" rule (the player still chooses from the ordinary
  menu), and it ends the dead end.
  (b) And, in the same session: on the outfit screen and in the ride-out dialog, when the
  manifest holds ≥ 75 % of the roster, show "You are packing N of your M units. If the caravan is
  overrun, every one still standing is lost."
  (c) Optionally, matchmaking at band 0 never serves a party with more raiders than the caravan
  packed living units, so a 1–2 unit rebuild can win its way back.

### S2. The standing party silently stops being served after a merge or an overrun

- **Evidence:** after B's trip-2 overrun, `GET /me/party` → `valid: false`, with 7 ×
  `unknown_ref` ("party unit #0 is not in your roster (it may have been lost on a trip or
  consumed by a merge)") (`shots/42-b-party-after-wipe.png`). A's party went invalid the same way
  (the Party screen lists "A unit no longer in the roster · L0"). A merge does the same: h5's merge
  dialog warns that "The party will stop resolving until you edit it" (`shots/50-merge-dialog.png`).
  The **inbox gets no notice** in either case: `GET /me/inbox` → `items: []`. Matchmaking's passes
  then show `live: 0` (B's encounter-1 search after A's party broke).
- **Why it blocks the test:** the passive side is half the game and the main reason to come back
  tomorrow (the strike inbox). With a few hundred testers who wipe or merge in their first hour,
  most players' parties go dark without them knowing, and the live pool shrinks to authored
  parties. The two-account interaction worked exactly once in my session, before either party
  broke.
- **Fix proposal:** make the party self-healing. On read and at serve time, drop refs that are no
  longer in the roster, and while the party is below `PARTY_SLOT_CAP` and roster units are free,
  backfill with the roster's highest-level units (same edge and stance as the slot they replace).
  If nothing is left, add an inbox notice "Your standing party is down: no units to send", plus a
  Town banner. A merge should carry the party slot over to the merged unit, not invalidate it.

### S3. [closed: fixplay-client] Hand-arranging the circle is a ~60-tap chore, and the DOM picker moves the last segment instead of placing a new one

- **Evidence:** A's encounter 2 ("No list this time… arrange the circle yourself",
  `shots/18-enc2.png`). The ring starts empty every encounter (`shots/19-enc2-formation.png`,
  "0 of 19 segments placed"), and each segment needs select, tap ring cell, done.
  - **Canvas:** at the default zoom the 28 ring cells are about 16×8 CSS px. 1 of 6 taps aimed at
    the visible ring landed (`shots/21-tap-fence.png`: "was not placed: A fence segment goes on
    one of the 28 ring positions (bad_segment)"). I needed a scan to find a tappable point.
  - **Picker:** select "Next segment", choose "Ring position 21", tap Place. The selection stays on
    the segment just placed, so choosing "Ring position 22" and tapping Place **moves** that segment
    from 21 to 22. Nineteen "ok" placements left the budget at "2 of 19 segments placed"
    (formation PUT bodies show `f1` re-targeted each time).
  - At 320×568 the default camera frames the whole island, and the ring is about 60 px across in a
    288 px canvas (`shots/55-320-formation.png`).
- **Why it blocks the test:** arranging the circle *is* the game (GUARDRAILS §0). If the second
  thing a tester does is fight the controls, the play test measures the controls, not the loop.
- **Fix proposal:** (1) The picker auto-advances: after "Place here" with a fence selected, select
  the next unplaced segment (and the next unposted unit or unlaid trap for the other kinds).
  (2) Add two buttons on the formation screen: "Fence this side" (fills the side the selected
  ring cell is on), and "Start from my last arrangement" (re-applies the previous encounter's
  layout, skipping destroyed segments and spent traps). (3) Default camera: frame the ring plus
  the entry bands, not the island. Zoom out to the island only on demand.

### S4. [closed: fixplay-client] The fight is not shown: the result arrives as an itemised list and the replay is opt-in

- **Evidence:** commit, then `encounter-results` appeared in 408 ms: "The caravan held. … Killed /
  Damaged / Unhurt" (`shots/14-result.png`). The fight itself is behind a "Watch the fight" button
  below the fold. The replay opens paused at 0:00 (`shots/16-replay-open.png`) and needs another
  tap on Play. On the overrun, the end-of-fight card covers the field at the decisive moment
  (`shots/25-enc2-replay-b.png`, `shots/43-c-ovr-4.png`), so "how did they get in?" goes
  unanswered unless the player scrubs back.
- **Why it blocks the test:** the reference feel is "a Clash of Clans attack that runs to
  completion before anyone sees it". If testers never see it, they judge a spreadsheet, and the
  play test cannot answer "is the fight fun and legible".
- **Fix proposal:** after commit, open the replay player automatically and playing (2×, with skip
  always available), and show the itemised result after it or on skip. Delay the end card about
  1.5 s after the last event and pin the camera on the unit that reached the core. On an overrun,
  add a "How they got in" key moment: the breach segment or gap and the raider's path.

### S5. The sandbox store gives testers 60,000 free Coin a week

- **Evidence:** `#/packs` (`shots/53-packs.png`): "SANDBOX: NO REAL MONEY MOVES … charged $0". On
  h8, Pack 1 → "6000 Coin stored. You now hold 10986 Coin" in two taps. Pack 3 is 40,000 Coin
  (66 mercenaries).
- **Why it blocks the test:** in an external test, every tester who has a bad trip will tap
  "Buy (sandbox, $0)". This (a) turns S1's wipe into a free instant rebuild, so the test never
  measures the free path, (b) corrupts chunk 32's grind-wall and free-vs-paid panels, which are
  exactly what the play test is for (PHASE-2 §37 sign-offs), and (c) teaches testers that Coin
  is the way out of a loss, which is the pay-to-win *feel* §16 forbids, even though it is pace
  only on paper.
- **Fix proposal:** add a server flag `STORE_PURCHASES_ENABLED` (default off in the play-test
  deploy). With it off, the Packs screen still previews everything ("not on sale during the play
  test") and `POST /me/store/purchase` answers 403 `store_closed`. If you want paid-path data,
  enable it only for a labelled cohort and split the dashboards by that cohort.

### D1. [copy line added: fixplay-client] At level 1, dying is free and surviving is total loss

At the L1 floor a death costs nothing ("stays L1 (level 1 is the floor)"), but a unit still
standing when the caravan falls is destroyed. h1's trip 1 was an overrun with 7 killed: the roster
was intact. B's trip 2 and C's trip 2 were overruns with 0 killed: the roster was gone
(`shots/40-b-overrun-b.png`). For a new player that inverts §13's "greed vs caution" intent: they
are better off if their posts die. "My units were all standing there and I lost all of them" will
read as unfair. **Question:** keep total loss for survivors, or (a) convert "alive at the
collapse" into "de-merged one level, and lost only if already L1 *and* the caravan had more than
`PACK_FLOOR` units", or (b) lose the survivors only from the encounter's breached side?
Re-measure trip EV either way.

### D2. [copy added: fixplay-client] Merging weakens a week-1 caravan

The merge preview is honest: 2 × L1 (1,240 HP, reference hit 100) → 1 × L2 (775 HP, 62)
(`shots/50-merge-dialog.png`). But a new player's roster (7) is below the 8 slots, so the only
benefit, slot efficiency, is worth nothing until the roster exceeds 8. Yet the Town offers "Merge
2 → 1 for 250 Coin" on every pair from minute one, and merging also breaks the standing party
(S2). **Question:** hide or de-emphasise merge until roster > deployment slots ("Merging pays off
once you have more units than the caravan can carry"), or raise the early-game roster so slots
bind sooner?

### D3. Traps cost nothing to pack, so the trap loadout is not a decision

The outfit screen lets you pack 6 Spike Pits for free every trip ("6 packed",
`shots/06-outfit-full.png`), and they are refitted on bank. The guide packs and lays one.
**Question:** give traps a stock or a Coin restock cost, or drop the trap slots from the outfit
decision and say "traps are free; pack all six"?

### D4. In week 1, bank-or-push is not a real decision

With the whole roster at stake (S1), pushing for +808 Coin is a bad bet: the pushed encounter 2
held 5 of 9 in my runs. The guide itself said "The guide suggests banking this time" after A's
encounter 1, even though the welcome promised "face two encounters, then bank". **Question:**
after S1's fix, re-measure. If the push is still clearly wrong at k = 1 for fresh rosters, scale
the encounter-2 reward or the delivery bonus at band 0–1.

### D5. Some passive-side progress needs siege the guide never adds

A's strike reported "+0 ladder". The siege ladder only grows when the party carries siege, and
the guide's "Raise my party from my roster" adds none, although Battering Wagon is free
(`shots/52-node-detail.png` text: Siege web, tier 0 reached). **Question:** should "Raise my
party" include the free siege piece, so that the passive side progresses by default?

### D6. A beaten party lowers its owner's own trip band

A's inbox: "Earned 67 Coin · −15 Reputation". Reputation is one number per caravan, so other
players beating A's party lowers A's encounter bands. That is defensible (§13: raids shift it),
but it couples passive results to active difficulty in a way testers will not expect.
**Question:** intended? If yes, say so in the strike notice ("your caravan's Reputation −15").

### D7. Return hooks are mostly off by default

Inbox preferences: `refugees_arrived`, `trip_cap_refilled`, `mine_near_cap` and `packs_rotated`
all `enabled: false` by default. Only party strikes are on, and S2 silences those. With device
push deferred, a tester has no prompt to come back. **Question:** default `refugees_arrived` and
`trip_cap_refilled` on for the play test?

### D8. Week-1 unlock variety

h8's six holds gave 150 living-ladder points, rung 1 and 1 unlock point (a tier-1 node). The rungs
are at 100 / 282 / 519 / 800 / 1,118; a tier-2 node costs 4 points, so rung 5 needs about 45 holds
(at about 25 points a hold). That is roughly a full week's play for the first tier-2 unit. So in
week 1 a tester sees 2 starter types plus one tier-1 type. **Question:** is that the variety the
play test should judge "collection growth" on (§1 hook 2)?

### N1. [closed] The guide contradicts itself on the first trip's plan
The welcome says "face two encounters, then bank" (`shots/02-welcome.png`). The bank-or-push
advice after A's encounter 1 says to bank now (`shots/17-bankpush.png`). **Fix:** change the
welcome to "face at least one encounter, then bank or push: the guide will say what it would do".

### N2. [closed] Guide cards appear off-screen after an action
After "Take Dust Rider", the page stays scrolled at y = 2235 while the next guide card ("Pack the
caravan and ride out") renders at the top (`shots/05-after-refugee.png`). **Fix:** scroll the new
guide card into view on every step change.

### N3. [closed] The guest save prompt arrives before any play, and recurs
"Save your progress" sits under the very first guide card (`shots/03-town.png`), and it reappears
on later Town visits (h8). **Fix:** show it first after the first banked trip, and after "Not now"
not again for 24 h or until something valuable happens (first unlock, first purchase).

### N4. [closed] Region choice is blind
The permanent region picker lists four names with no description (`shots/01-launch.png`).
**Fix:** one line per region (its two starter units and their affinities).

### N5. [closed, except the "vs your packed fence and traps" part] The scouting report is a 7,000 px wall
Three candidates × full stat blocks (page height 7,139 px at 360 wide, `shots/09-candidates.png`,
`shots/10b-scoutcard.png`). **Fix:** a one-row summary per candidate (raiders by stance icon,
total HP, siege counter vs *your* packed fence and traps, approach mini-map) with the full block
collapsed under "Scouting report". Keep everything one tap away (Legibility §4).

### N6. [closed] Search copy says "within your Reputation band" when it is not
"Your caravan: 400 Reputation (band 400–699) · Search … centred on 250" and all three offers are
"band 100–399" (`shots/10-scoutcard.png`). **Fix:** "Three parties near 250 Reputation (encounter
1 is searched 150 below your caravan)".

### N7. [closed] "Owner loot: 0 Coin" on an overrun reads as if the Coin vanished
A's overrun: "Unbanked Coin lost: 600", while the replay says "Loot reported for the raiding
party's owner: 0 Coin" (`shots/25-enc2-replay-b.png`). **Fix:** for authored parties, "This was
an authored outfit: it keeps nothing; your 600 unbanked Coin was lost to the trail".

### N8. [client part closed; server display open] Guest parties are shown as "Unnamed drifter"
B saw A's party as "Unnamed drifter" (`shots/32-unnamed.png`). **Fix:** give every caravan a
generated name at creation (as the guest flow already allows `caravanName`) and use it.

### N9. [closed] You can pack with no trip available, and then you are stuck packed
h3 at 0 of 3 trips: outfit, then "Pack and ride out" leaves the units "Packed, waiting to ride
out … The next one returns in 13:09" with no unpack (`shots/55-320-state.png`). **Fix:** disable
"Pack and ride out" when 0 trips are available (show the countdown), or offer "Unpack" while not
yet ridden out.

### N10. [autosave closed; the 404s are server-side, open] Console noise on every edit and screen
Every formation edit fires `PUT …/formation` → 400 `unit_not_posted` until every unit is posted
(about 20 in A's encounter 2). Every Town and Trail load logs a 404 for `GET …/trip` or
`…/candidates`. **Fix:** skip the autosave PUT while the client knows units are unposted (it
already shows the notice); answer 200 `{trip: null}` instead of 404 for "no trip yet". This also
keeps chunk 32's crash panel clean.

### N11. [fast-forward closed; the leash label is open] Some fights are 90 seconds of nothing
A's encounter 1 lasted 1:46. From 0:12 to 1:36 a lone Bounty Hunter (range 4) shot posts across
the fence while the five guards stood still: "Dead or Alive … 83 damage" × 8 (replay text;
`shots/16-replay-14.png`). **Fix (presentation):** fast-forward automatically at 4× through
stretches with no position change and only one attacker acting, and label it "Your posts cannot
reach it from here (outside their leash)". Track as a balance note too: ranged versus guard leash.

### N12. [closed] Party editor: the sticky map covers the unit cards
At 360 wide the sticky iso map overlaps the top of each unit card ("…roster · L0" half hidden,
`shots/56-party-editor.png`). **Fix:** do not make the map sticky below 480 px height, or reserve
its height.

### N13. [closed] 320 px header crowding
When signed in, the "Inbox / Account / Sign out" row runs to the screen edge and the username
badge drops out (`shots/55-320-formation.png`). **Fix:** move "Sign out" into the Account screen
only.

### N14. [closed] The commit dialog is a 28-line list
It lists every fence segment line by line (`shots/13-commit-dialog.png`). **Fix:** a summary
("20 segments: N 7, E 7, W 6; open: W #24 + 7 S"), with the full list behind a disclosure.

---

## Judgement against PROJECT.md §21 and the brief's questions

- **Is the inverted loop clear?** Yes. The welcome screen (`shots/02-welcome.png`), the Town copy
  ("never attacked"), the scout ("its owner is not there") and the strike inbox all say it the
  right way round. I found no "base/camp" slip.
- **Are the decisions meaningful?** Scouting and choosing the party mattered: the least threatening
  pick usually held, and the core and siege picks were the dangerous ones. Arranging the circle
  matters a lot, perhaps too much, given S1's all-or-nothing stakes. Bank-or-push is not yet a real
  decision in week 1 (D4). Traps and early merges are false decisions (D2, D3).
- **Are fights fair and legible?** The replay is good once you open it (`shots/16-replay-2.png`):
  readable unit tags, stance marks, key moments. Not watched by default (S4), overruns are hard to
  read (the end card), and "0 killed, all lost" feels unfair (D1).
- **Is there a reason to come back tomorrow?** Today it is weak. Party strikes stop when the party
  breaks (S2), the other hooks are off (D7), and a wiped player has nothing to do for hours (S1).
- **Numbers:** first-fight hold matched the balance log (about 85 %). Encounter 1 pays 600 plus 125
  delivery; the mine pays 200/h (4,800 a day). For a cautious new player the mine out-earns trips
  until about three banked trips an hour. A mercenary costs 600 and a merge 250. These are fine
  once S1 bounds the losses.
- **Pay-to-win:** nothing purchasable touches a fight. The packs screen is admirably explicit. But
  with S1 in place, a $5 pack (10 mercenaries) is the only fast exit from a wipe, which is the
  pay-to-skip feel §16 warns about. S5 keeps it out of the play test, and S1 removes the pressure.
- **Two accounts interacting:** it worked. A's party was served into B's encounter 1, B held, and
  A's inbox showed "Your party struck a caravan · 1 held out · Earned 67 Coin". "Watch the fight"
  played the owner's view (`shots/36-a-inbox.png`, `shots/37-a-watch-6s.png`).

## What a tester hits in their first hour (in order)

1. A blind permanent region pick (N4). 2. A guide card plus a save nag before playing (N3).
3. A guide card that scrolls away after the refugee (N2). 4. A wall of numbers to scout (N5).
5. A guided encounter 1 that probably holds; the result is a list, not a fight (S4).
6. Guide copy that disagrees about pushing (N1). 7. Encounter 2 by hand: tiny ring cells and a
picker that moves segments (S3). 8. A real chance of losing every unit on trip 2 or 3 (S1), and
then a party that quietly stops working (S2). 9. A free $0 store that "fixes" it (S5).

## Orchestrator decisions (2026-10-12)

The anchor is PROJECT.md §13: a wipe is meant to cost "a slot's worth of units, never a whole collection", and the person playing is the one with something at risk. The raid party's owner "risks nothing" (§10, line 115).

- **S1: restore the bounded blast radius without softening the overrun rule.** The §13 rule stays: units still alive at an overrun are lost.
  - **Packing.**
    - The guide packs at most `roster − GUIDE_RESERVE` (tunable, default 2), so it always leaves a reserve in town.
    - The Pack screen warns, without blocking, whenever the whole roster is being packed: "everything you pack can be lost".
  - **Recovery.**
    - While a caravan in town has fewer than `REFUGEE_ROSTER_FLOOR` units (tunable, default 3), its refugee menu is ready at once instead of waiting for the drip timer.
    - This is a tuning of §15's free timer, not a new source: it still offers 3 unlocked types and grants nothing locked.
    - Record it as a PROJECT.md §15 amendment line, with a reason.
  - **Matchmaking.** In band 0 only, never serve a party with more raiders than the caravan packed units. This is a cold-start fairness rule in the same family as the nearest-N authored fill. It is a tunable that the balance harness re-checks.
- **S2: the standing party repairs itself.**
  - A merge re-points the party's reference to the merged unit. A destroyed unit is dropped.
  - Either change posts an inbox notice, "your standing party changed", saying what changed. An empty party gets a notice too.
  - The party is never silently `valid: false`.
- **S3: arranging is fast.**
  - Fix the picker's auto-advance bug.
  - Add "Fence this side" and "Start from my last arrangement", which pre-fills from the previous encounter's formation filtered to the survivors.
  - Frame the camera on the ring by default.
  - Target: a sensible arrangement in about 10 taps.
- **S4:** after a commit, the result screen opens the replay already playing at 2×, with "Skip to result" one tap away. The end card is a bottom sheet that never covers the decisive moment.
- **S5:** closed by the guardrail fix round, which sets `STORE_MODE=off` in production.
- **D1: no change.** It is the deliberate §13 tension. Add one line of copy on the bank-or-push and pack screens: "units that die lose a level; units still standing when the caravan falls are lost".
- **D2:** while the roster is below the slot cap, the merge preview says merging lowers the count of units you can pack. Copy only.
- **D3, D4: no change before the play test.** Add them to BALANCE-LOG.md as telemetry questions.
- **D5:** "Raise my party" includes the owner's unlocked siege, so the siege ladder can grow.
- **D6: fix, per PROJECT.md §10.** A raid party that is held or stalemated never lowers its owner's Reputation; only a success raises it. The defender's Reputation rules are unchanged. Re-run the balance harness's equilibrium check afterwards and record it.
- **D7:** "Refugees ready" and "Trip cap refilled" become on by default. Mine-near-cap and packs stay off.
- **D8:** tune unlock-web costs so that the first tier-2 unlock arrives in about 2–3 days of normal play, measured with the balance harness's week model. Record it in BALANCE-LOG.md.
- **Every N item is in scope.**

## Client fix round (branch `fixplay-client`, 2026-10-12)

Scope: the client parts of S1, all of S3 and S4, the D1 and D2 copy, and every client-side N
item, as the orchestrator decided above. The edits are in `apps/web`, plus one delimited
`GUIDE_RESERVE` block in `packages/content/src/tunables.ts` for the server agent to reconcile.
"Start from my last arrangement" reads the previous encounter's committed formation through the
existing `GET /caravans/:id/encounters/:n/formation`, so there is no server change. New tests:
`apps/web/src/screens/trail/quickArrange.test.ts` and `playtestFixes.test.ts`. The unit tests
and e2e specs whose pins the new behaviour moves were updated to match. Re-played on a phone
viewport against the built server with the real resolver (fresh DB `caravan_dev_fixplay`).
Screenshots are `scratchpad/shots/f*.png`.

| item | what changed | evidence |
|---|---|---|
| S1 (client) | **Guide reserve.** While the guide is on the outfit step, the Pack screen pre-ticks at most roster − `GUIDE_RESERVE` (2) units, highest level first, and says so. **Whole-roster warning.** Whenever every unit is ticked, the Pack screen and the ride-out dialog warn: "You are packing all N of your units. Everything you pack can be lost…". Neither blocks the pack. | `f05-outfit-reserve.png` ("ticked 5 … left 2 in town"), `f13-whole-roster.png`. In the replay, the guided first fight with 5 packed units was overrun; the 2 in town survived (`f12-result.png`). |
| S3 | **Picker auto-advance.** Placing a new item moves the selection to the next one of its kind (the next segment, the next unposted unit, the next unlaid trap), so "Place here" and canvas taps no longer move the item just placed. **Ring snap.** A tap within one cell of the ring snaps to the nearest ring position when a fence is selected. **Quick arrange.** "Fence North/East/South/West (n raiders)" buttons, and from encounter 2 "Start from my last arrangement": the previous formation minus broken segments, spent traps and dead units, stances kept, every item re-validated. **Camera.** It opens framed on the ring plus 3 cells. | `f08-formation-open.png` (ring framed), `f14-quick.png`, `f17-start-from-last.png` → `f18-carried.png` ("19 segments, 2 traps, 6 posts"). Encounter 1 by hand: 3 side taps + 1 + 6 unit taps + 1 + 3 trap taps = 14 taps on the canvas (23 through the DOM picker, 2 per item). Encounter 2+: 1 tap plus adjustments. |
| S4 | **Autoplay.** A just-committed fight's replay opens at once at 2×, playing, with a primary "Skip to result" action. Opening it later from "Watch the fight" plays paused, as before. An overrun that ends the trip autoplays from the summary. **End card.** It is a sheet below the field, not over it. | `f10-autoplay.png` (0:06 of 0:22, "Skip to result"), `f11-endcard.png` (the raider at the core stays visible above the card). |
| D1 | One line on the Pack screen, in the ride-out dialog and on bank-or-push: "Units that die lose a level; units still standing when the caravan falls are lost." | `f06-rideout-dialog` text, `f16-bankpush-stakes.png` |
| D2 | While the roster is below `DEPLOYMENT_SLOT_CAP`, the merge preview says "merging lowers the number of units you can pack: 7 → 6. Merging pays off once you own more units than the caravan can carry." | MergeDialog (`merge-below-slots`) |
| N1 | The welcome copy now reads "face at least one encounter, then bank if you are still standing or push on. The guide says what it would do". | `f02-welcome.png` |
| N2 | Each new guide card scrolls itself into view (`block: nearest`). | After the refugee claim, `scrollY` was 72 and the outfit card was visible (`f04-after-refugee.png`). |
| N3 | The town save prompt waits until the guide is finished or skipped. "Not now" snoozes it for 24 h on this device (a per-viewer key under `caravan.viewer.`, cleared on sign-out). | No prompt during the guide; shown after skipping. |
| N4 | The region picker says "Starts with: Dust Rider (Beast), Well Digger (Grit)." from content. | `f01-launch.png`, `f20-320-launch.png` |
| N5 | Each candidate leads with a summary: raiders by stance (◆ core / ◉ nearest / ▼ traps), total HP, the siege and what it counters, and sides. The full report is collapsed under "Full scouting report", and the guide copy says so. Candidates page height at 360 px: 7,139 → 2,177 px. **Open:** comparing the siege with *your* packed fence and traps needs the manifest on the candidates screen. | `f07-candidates.png` |
| N6 | "Searched near 250 Reputation: encounter 1 is searched 150 below your caravan's 400." The intro no longer says "within your band". | `f07-candidates.png` |
| N7 | On an overrun with no owner loot: "The raiding party's owner took no loot from this fight. Any unbanked Coin your caravan lost is itemized under what it settled: an authored outfit keeps nothing…" | `f11-endcard.png` |
| N8 (client) | A guest caravan gets a generated name ("Copper Haulers", …) at creation. **Open (server):** a guest's party is still shown as `GUEST_OWNER_DISPLAY_NAME` "Unnamed drifter". `ownerDisplay` should use the caravan's name when there is no username. | AccountScreen test |
| N9 | With 0 trips available, "Pack and ride out" is disabled and shows "Next trip in mm:ss", so nothing locks. | OutfitScreen test |
| N10 (client) | No autosave PUT while a living unit is unposted; the client lists the unposted units itself. **Open (server):** answer `GET …/trip` and `…/candidates` "nothing yet" without a 404. | FormationScreen tests |
| N11 | **Quiet stretch.** With no key moment for more than 8 s ahead, the replay plays at 8× and says "Nothing decisive for a while: fast-forwarding to the next key moment." The thresholds are presentation tunables. **Open:** the "outside their leash" explanation needs the resolver's reasons in the log. | ReplayPlayer N11 test |
| N12 | Below 760 px of height, the party editor's map scrolls with the page instead of pinning over the cards. | CSS |
| N13 | Sign-out is on the Account screen only; the 320 px header fits. | `f22-320-formation.png` |
| N14 | The commit dialog leads with "By side: North 7 fenced, 0 open · …". The one-by-one list sits under "Every item, one by one (26)". | `f09-commit-dialog.png` |

**For the orchestrator.**
1. The guided first fight was measured at 81 % with all 7 units packed (BALANCE-LOG target 1). With
   the reserve it rides with 5, and my one replay of it was overrun. The balance harness's
   `first-trip.ts` should be re-run with `roster − GUIDE_RESERVE` packed before the play test.
   If the hold rate falls below the 70 % target, the lever is the server agent's band-0 party-size cap.
2. `GUIDE_RESERVE` is added in a delimited block in `packages/content/src/tunables.ts`, for
   reconciling with the server agent's copy.
