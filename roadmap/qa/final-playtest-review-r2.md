# Final play-test review, round 2: fun and playability

Reviewer: independent adversarial play-tester, round 2 (fun and playability; the guardrail and
technical probes are a separate review on port 3953). Build: `roadmap/phase-2-spec` at fbce432,
RESOLVER_VERSION 8, authored set v5, real resolver in-process. Date: 2026-10-12.

## Verdict: NOT READY

Round 1's five blockers are fixed, and the build now plays like a game. The welcome screen says
the inverted loop plainly. A just-committed fight plays itself at 2×, and the bank-or-push sheet
itemises every stake. A wiped caravan gets three free refugees at once and wins its way back. The
standing party repairs itself and says so in the inbox. Two things still block an external test.
**First, a session bug signs players out.** About nine page loads within five minutes (reloads,
tab restores, a second tab) make every request after `POST /auth/resume` answer 401. The app then
drops to the start screen. There, "Continue the guest caravan" loops back to the start screen,
and the only button that "works" for a guest is "Delete it and start a new caravan". **Second,
ranged starter parties beat the first fight from outside the fence.** As soon as real testers
exist, their standing parties fill band 0, and Mountain's and Badlands' starters are all ranged.
These parties shoot the guided circle's posts from behind the fence for one to two minutes while
the posts stand still. The guide recommends exactly these parties, because they have the least
HP. The guided first fight held 2 of 5 times in my play. A probe through the server's own resolver
path measured 56–72 % against raised ranged parties and 100 % against raised melee ones. Even the
best of 24 skilled layouts held only 66–75 %, so there is no counter a tester can find. One
High Plains guest went 0 for 3 and was left with 2 units. Fix these two and the build is ready.
The D items below are worth deciding before the test, but they do not block it.

## How I played (so the evidence can be reproduced)

- **Hosting, per `docs/PLAYTEST-HOSTING.md`, in single-process mode.** `pnpm build`. The
  instance's `caravan` / `caravan_app` use the repo passwords, so I followed the **shared-instance
  option**. I created `caravan_r2_owner` (IN ROLE caravan, `SET role = caravan`) and
  `caravan_r2_app` (IN ROLE caravan_app), both with `openssl rand -hex 24` passwords, and the
  database `caravan_playtest_r2` owned by caravan. The environment file had `NODE_ENV=production`,
  `SERVE_WEB=1`, `STORE_MODE=off`, `HOST=127.0.0.1` and `PORT=3955`, with no `TRUST_PROXY` (there is
  no proxy) and no test flag. Then `migrate.js up` (26 migrations, all `[x]`), `seed.js` ("set v5:
  96 created … No login accounts were created") and `node apps/server/dist/index.js`. The boot
  lines were as the runbook says: "real resolver", "store: off", "serving the client … source maps
  not served". **HTTPS / Secure cookie:** Chromium treats `http://127.0.0.1` as a secure context,
  so the `Secure; HttpOnly; SameSite=Strict` device cookie was set and honoured. No Caddy was
  needed locally.
- **Server restart mid-session:** the background job hit its 2-hour limit at about 07:12 and I
  restarted it. A trip that was in flight continued after the restart.
- **Driving:** Playwright Chromium (`/opt/pw-browsers`) as a touch phone (isMobile, hasTouch,
  Pixel 5 UA) at 360×740, with g5 at 320×568. I used a long-lived driver that keeps one page per
  player, so the app is not reloaded between steps. That driver exists *because of* S1 below.
  - Screenshots are in `/tmp/claude-0/-home-user-caravan-game/edcaf182-6a4d-5af1-b736-5ca8113d60f8/scratchpad/r2/shots/`,
    cited below as `shots/…`.
  - Every action is logged in `scratchpad/r2/driver-results.log`.
- **Players (all guests through the UI):**
  - **g1:** Desert. Played entirely by hand: guide, push, hand-arranged encounter 2, wipe,
    recovery, mercenary, merge, inbox, owner-view replay.
  - **g2:** High Plains.
  - **g3:** Mountain. Deleted afterwards.
  - **g4:** Badlands. Linked to `r2_badlands_bea`, signed in on a second device at 320×568, and
    then used for the week.
  - **g5:** Desert, at 320×568.
  - **g9:** High Plains. Used for the sign-out repro.
- **Scripted play.** From the second trip on, most trips ran through the UI with an in-page
  "reasonable player" script (`scratchpad/r2/a_tripbot.mjs`). It does this:
  - pack every unit up to 6 and six traps;
  - pick the least-HP party, penalising core-stance raiders;
  - fence the raider sides first, so the gap ends on the far side;
  - lay traps one row inside the gap and post the units two rows in;
  - from encounter 2, tap "Start from my last arrangement";
  - push while nobody has died, up to encounter 3.
  It plays about as well as a first-week human, and worse than a player who reads every scout.
- **Time travel, stated:** only for g4 (`scratchpad/r2/age.sql`). I aged only the time caps: the
  trip cap's `tat_ms` and the refugee menu's `generated_at_ms` / `window_opened_at_ms` /
  `claimed_at_ms`. Each was moved back 24 h, with `session_replication_role = replica` on the
  harness connection, because the guards refuse refunds.
  - I aged 7 times: 06:23, 06:49, 07:13, 07:19, 08:04, 08:16 and 08:29 UTC. That is seven
    simulated days in about 2.5 real hours, with 2–3 trips a day.
  - **I did not age the mine or the ledger.** The 200 Coin/h trickle is therefore *under*-counted
    for g4: a real week would add about 4,800 Coin a day.
  - The inbox shows some notices dated the previous day because of this aging.
- **Probe:** `scratchpad/r2/probe-live-starters.ts`. It uses the balance tools' `sweep.ts`
  (`resolverInputOf` → `resolve`) and runs the guided first fight against parties built from L1
  starter units. Run it with `pnpm --filter @caravan/server exec tsx <path>`, with or without
  `RAISED=1`.

### What the first hour looked like

| player | first (guided) fight | then |
|---|---|---|
| g1 Desert | **held** vs Prairie Wolf Pack (a Homesteader got 87 % deep through the open west side) | Pushed on the guide's nudge. Encounter 2 by hand vs Sodbusters' Levy (4 core raiders): **overrun in 0:08**, 5 units lost outright, 0 killed (`shots/g1-e2-14-replay-1.png`). Relief to 3 units; the rebuilt trip **held**, +525. Mercenary, merge, inbox notices. Signed out once (S1). |
| g2 High Plains | **overrun 1:55** vs Gunslinger's Dozen: one Bounty Hunter shot 5 Homesteaders one by one from 0:12 (`shots/g2-ft-replay.png`, replay text in `driver-results.log`) | Trip 2: **overrun 1:32** vs Dusty Teamsters (another tester's 2 L1 Trappers, outside the north fence; `shots/g2-m0-60.png`). Trip 3: **overrun 0:07** by Prairie Wolf Pack, 5 lost outright. **0 holds in 3 trips; 2 units left, 273 Coin.** |
| g3 Mountain | **overrun 0:23** vs Prairie Wolf Pack: the Homesteader reached the core with 97 HP left; 5 lost outright, none died | Relief to 3 units; rebuilt trip **held**, +525. Deleted. |
| g4 Badlands | **held**, no attacker inside the ring | Pushed and held again vs **g1's standing party**, banked 1,658. Linked. Then the week. |
| g5 Desert (320×568) | **overrun 1:50** vs Dusty Teamsters (g3's 2 L1 Trappers) (`shots/g5-ft-replay.png`, `shots/g5-m0-15.png`) | All 5 died, so they were kept at L1. Trip 2 (7 packed) held twice, banked 1,189. |

### The returning week (g4, Badlands, linked; seven 24-hour time-cap agings)

- **Start:** 7 L1 units and 2,464 Coin.
- **Each simulated day:** take the refugee; spend any unlock point; recruit mercenaries back to 7
  units while more than 1,600 Coin is banked; then 2–3 trips.
- **Overruns:** 6 in about 19 trips. In 5 of them every unit still standing was lost (D1). Each
  time, the roster was rebuilt from refugees plus **15 mercenaries (9,000 Coin)** over the week.
- **Unlocks:** Claim Jumper (tier 1) on day 1, Tripwire Snare and Jaw Trap, then Rattlesnake Den
  (tier 2) on about day 5. That matches BALANCE-LOG D8's "2–3 days", allowing for the losses.
- **Merges:** none, ever (D4).
- **Standing party:** down from day 2 to the end of the week (D2).
- **End:** 7 L1 units, **16,371 Coin** (the mine was not aged, so a real week has more), caravan
  Reputation 510 (band 1).
- **Later trips** were good fun: three holds and a bank of 2,873, with real bank-or-push tension.

---

## Round 1's S items: are they fixed?

### S1 (one overrun wipes the roster; multi-hour recovery): **fixed**
- **Guide reserve.** The outfit screen says "The guide ticked 5 units and left 2 in town as a
  reserve" (`shots/g1-04-outfit.png`). g3's first fight lost 5 outright and left 2 in town, so
  the blast radius is now bounded.
- **Whole-roster warning.** The ride-out dialog warns when the whole roster is packed: "You are
  packing all 3 of your units. Everything you pack can be lost" (g1's recovery).
- **Relief.** After g1's wipe the Town showed "Your next free menu is ready: take it now", and
  the roster went 2 → 3. g3 went the same way (`driver-results.log`, a_relief).
- **Raider cap.** The search line read "None fields more raiders than the 3 units you packed".
  Both rebuilt 3-unit caravans **held** their next fight and banked 525.
- **Caveats.** The relief UI is two taps per unit, and its copy reads wrong (N6). The first-fight
  shortfall is now caused by live parties (new S2).

### S2 (the standing party silently stops after a merge or an overrun): **fixed**
- g1 merged 2 Dust Riders. The inbox said "Your standing party changed · A merge used units from
  your party. 1 slot moved to the merged unit. It now fields 2 units".
- After g2's overrun: "Units from your party were lost on your trip. 5 slots were dropped. It now
  fields 2 units".
- After g4's total wipe: "Your standing party is down: no units to send … It is not served until
  you add a unit".
- The party never read invalid.
- **Caveat:** a downed party stays down after the roster is rebuilt (D2).

### S3 (hand-arranging is a chore; the picker moves the last segment): **fixed, with rough edges**
- "Quick arrange" (Fence North/East/South/West, each with its raider count) and "Start from my
  last arrangement" are there.
- The picker auto-advances ("the next unit is picked for you").
- A sensible circle takes about 11 taps: 3 sides, a unit card plus 5 cells, a trap plus 1 cell.
- Touch drag works: a press-hold-drag posted a Gunslinger exactly where I dropped it.
- **Rough edges:**
  - A canvas tap next to a fence selects the fence instead of placing the selected unit (N7).
  - The camera at 320×568 frames the whole field, so ring cells are about 9×5 CSS px
    (`shots/g5-bot-e1-95740.png`).
  - "Start from my last arrangement" re-applies a layout aimed at the wrong sides (N11).

### S4 (the fight is not shown): **fixed**
- After "Commit" the replay dialog opens already playing at 2×, with "Skip to result" as the
  primary action (`shots/g1-e1-14-replay-0.png`).
- Quiet stretches fast-forward ("Nothing decisive for a while: fast-forwarding to the next key
  moment").
- The end card is a sheet below the field, and the raider at the core stays visible
  (`shots/g1-e2-14-replay-1.png`).
- Owner-view replays from the inbox play with the right wording: "Your Well Digger fell to the
  caravan's Gunslinger 1".
- **Caveat:** raiders that enter at the far edges are off-canvas for the first seconds (N14).

### S5 (the sandbox store hands out Coin): **fixed**
`#/packs` says "PACKS ARE NOT ON SALE DURING THE PLAY TEST … Everything in the game is earned by
playing", and each pack says "Not available during the play test". The previews stay complete.

---

## New punch list

Tags: **S**: blocks the external play test. **D**: design question for the orchestrator.
**N**: polish. Each item fits in one session.

### S1. About nine page loads in five minutes sign the player out, and a guest is steered to delete their caravan

- **Repro (g9, a fresh guest):** reload the page 11 times, about 2 s apart. Loads 1–8 come back
  in the game. Loads 9, 10 and 11 land on the **start screen** ("Start your caravan / Sign in").
  - The server log for each failing load shows `POST /api/auth/resume` **200**, followed at once by
    `GET /api/me`, `/me/onboarding`, `/me/inbox/unread` and `/me/analytics` all **401**. The
    client's automatic re-resume repeats this four times, and then it gives up.
  - Pressing "Start playing" there shows "This device has a guest caravan … Continuing here
    replaces it, and the guest caravan, its roster and its Coin are deleted for good".
  - **"Continue the guest caravan" goes straight back to the start screen.** The only button that
    gets into a game is "Delete it and start a new caravan".
  - It clears by itself after a few minutes, but nothing says so. g1 hit this in normal play.
- **Cause:**
  - `issueSession` (`apps/server/src/auth/sessions.ts:76`) inserts the resumed session, then calls
    `evictDeviceSessionsBeyondCap(db, deviceId, DEVICE_SESSIONS_MAX = 10)`.
  - That query (`apps/server/src/repo/sessions.ts:56–67`) keeps first the sessions "in use",
    meaning `last_used_at > created_at` within the last 5 minutes. The brand-new session has
    `last_used_at = created_at`, so it sorts **after** them and is deleted at `OFFSET 10`. The
    token the client has just received is already dead.
  - The old sessions are never revoked on reload, because the client keeps the token in memory
    only.
- **Why it blocks:** mobile browsers restore tabs by reloading. Testers are told to "reload after
  an upgrade" (runbook §12). People open a second tab. A guest who sees the start screen and taps
  the only working button loses their caravan for good, and they cannot report it as a bug,
  because it looks like being logged out.
- **Fix (one session):**
  - Server: never evict the session being issued. Exclude its id from the eviction subquery, or
    rank a session with `last_used_at = created_at AND created_at > now() - 1 min` first.
  - Also accept `{ previousToken }` on `/auth/resume` and revoke that session, so reloads do not
    pile up sessions.
  - Client: when a resume returns 200 but the next call returns 401, show the existing
    `resume-failed` card ("try again"), never the guest-replacement screen.
  - Add an e2e that reloads 15 times and stays signed in.

### S2. Ranged starter parties raised by testers beat the guided first fight from outside the fence, and the guide recommends them

- **Evidence (play):**
  - Guided first fights held **2 of 5** times (table above). BALANCE-LOG pass 2 claims 73 %, but
    it was measured against authored parties only ("a cold start: no live parties",
    `scripts/balance/first-trip.ts` header).
  - Three of my losses were to **two L1 ranged raiders** standing outside the fence:
    - g2 vs Gunslinger's Dozen: the Bounty Hunter shot Homesteaders for 27 a hit from 0:12 to
      1:55 (`shots/g2-ft-replay.png`).
    - g2 vs Dusty Teamsters: 2 Trappers by the north wagon, 1:32 (`shots/g2-m0-60.png`).
    - g5 vs Dusty Teamsters: 2 Trappers, 1:50 (`shots/g5-m0-15.png`).
  - In each one, five guards stand inside the ring and never engage, while the trap at the gap
    waits for raiders that never come.
  - Dusty Teamsters is **g3's own standing party**: the two Trappers left after its first-fight
    wipe, raised by the guide. Mountain's starters (Grizzly, **Trapper** range 4) and Badlands'
    (**Gunslinger** 3.5, **Bounty Hunter** 4) are all or half ranged. So every Mountain or Badlands
    tester's first party is a ranged band-0 party, and the guide puts it on the north edge at
    `nearest`.
  - The guide's scout pick is "fewest raiders, then least total HP" (`guidePick`). Ranged L1
    starters have the least HP (2 Trappers 900, 2 Gunslingers 760), so **the guide recommends
    these parties first**. The band-0 raider cap does not exclude them, because 2 raiders is fewer
    than 5 packed units.
- **Evidence (probe, the server's own resolver path):**
  - **Fights:** the 8 band-0 two-raider templates × each region's fresh guided roster (reserve 2,
    1 Spike Pit, full Brush Pile). That is 64 fights per row.
  - **Parties:** "raised" means the way the guide raises a party: north edge, `nearest`, Battering
    Wagon.

  | raised party (2 × L1) | guided held | best of 24 skilled layouts |
  |---|---|---|
  | any melee pair (Dust Rider, Well Digger, Homesteader, Prairie Wolf, Grizzly) | **100 %** | 100 % |
  | Grizzly + Trapper | 78 % | 100 % |
  | Trapper + Trapper | **72 %** | 75 % |
  | Bounty Hunter + Bounty Hunter | **66 %** | 75 % |
  | Gunslinger + Bounty Hunter | **63 %** | 66 % |
  | Gunslinger + Gunslinger | **56 %** | 69 % |

  Even the skilled search cannot answer them. This is not a reading the player failed to make: no
  layout in the set counters it.
- **Why it blocks:**
  - It is the first fight of two of the four regions' testers' first sessions. It loses to the
    party the guide picked, and it looks like a bug: "my guys just stood there for two minutes".
  - GUARDRAILS §4: a loss must be "a foreseeable consequence, never bad luck". The scout shows
    "Range 4 cells" and "Chases up to 6 cells", but nothing connects the two. No arrangement the
    player can find fixes it.
  - g2 shows the spiral that follows: 0 holds in 3 trips.
- **Fix (one session, pick the smallest):**
  - (a) **Guide pick:** score a candidate by its raiders' total HP *and* by ranged raiders
    (`attackRange > 1.5`), and steer the first fight away from ranged-only parties. The guided
    arrangement against a ranged party should open the gap toward the shooters' side and post the
    posts within leash of it. Recheck with the probe above.
  - (b) **Matchmaking:** for a caravan's first trip only (encounter 1 of trip 1), serve authored
    parties alone. The cold-start rule already exists, so this is a one-line condition plus a
    tunable.
  - (c) **Harness:** add "raised starter parties of every region" to `first-trip.ts`, so the
    ≥ 70 % gate covers the pool that testers will actually create.
  - The deeper cause is ranged versus leash (round 1 N11, BALANCE-LOG open item 9). It needs the
    D1 decision or a resolver change, and it is not required to unblock this test once (a)–(c)
    are in.

### D1. Fast core and trap runners delete the whole packed roster in 7–18 seconds, and in week 1 that is most overruns
- **Evidence:**
  - g1 encounter 2: one Prairie Wolf with Lope ran past five posts, 0:08, **5 lost outright, 0
    killed**.
  - g2 trip 3: 0:07, 5 lost outright.
  - g4's week: 6 overruns, and in **5 of them every unit still standing was lost** (3, 4, 4, 6 and
    2 units), mostly within 8–18 s and with 0 killed.
  - Over the simulated week g4 bought **15 mercenaries (9,000 Coin)** to rebuild. It **never
    merged**, because the roster never exceeded the 8 slots. Its Reputation stayed between 360
    and 495, all in band 1.
  - The replay explains each loss well ("Prairie Wolf 2 used Lope: dashed 3 cells … reached the
    core"), so this is legible. What it is not is a decision. Round 1's D1 kept total loss for
    survivors. With this evidence, it is the main thing that will decide whether week-1 testers
    stay.
- **Question:** keep it as is, or soften it for low bands? Options:
  - lose survivors only when the caravan packed more than N units;
  - survivors de-merge one level instead of being lost while the caravan's Reputation is in bands
    0–1;
  - give core and trap stances a time or depth cost (BALANCE-LOG open item 2).

  Measure the outcome with `measured-ev.ts` and with g4's week script.

### D2. A standing party that went down stays down after the roster is rebuilt
- **Evidence:** g4's party was "down: no units to send" from simulated day 2 (07:09). It stayed
  empty for the rest of the week (`standing_party.composition.units = []`), while the roster went
  back to 5–7 units and Coin climbed to 14,353. So no strikes came in and the passive side was
  dead for five days. The inbox notice is easy to miss, and the Town shows no banner (round 1 S2's
  note).
- **Question:** when a down party's owner gains units, refill it automatically, the way the guide's
  raise does (the same edge, stance and siege rules) and with an inbox line? Or add a Town banner
  "Your standing party is down — raise it", with one-tap raise?

### D3. Relief menus can be refreshed for free without limit
- **Evidence:** in relief (roster below 3), g3's Town showed "Take the free menu now". Each tap drew
  a new menu: "The next free menu is due. Taking it forfeits this one's offers". I tapped it 4
  times in a row, and each tap was a fresh free draw. That is an unlimited free reroll, while the
  same thing costs 150, 300 or 600 Coin outside relief.
- **Question:** intended? If not, in relief offer only "Take <type>". The next menu should appear
  only after a pick (the amendment's "each pick brings the next menu").

### D4. Week-1 Coin has nothing to buy; the merge hook never appears
- **Evidence:** g4 ended the seventh simulated day with **14,353 Coin** (16,371 after one more trip), 7 units, all L1, and 4 unlocks (Claim
  Jumper, Rattlesnake Den, Tripwire Snare, Jaw Trap). Merging only pays once you own more than 8
  units (the dialog says so honestly: "merging lowers the number of units you can pack: 3 → 2").
  Overruns keep the roster under 8, so the PROJECT.md §1 "merge/loadout" hook never shows up. The
  only Coin sink is mercenaries.
- **Question:** is that the week-1 experience the play test should judge? Options:
  - a larger starting roster or a higher refugee floor, so the slots bind sooner;
  - a cheaper first merge;
  - or accept it, and measure the merge spend panel.

### N1. Raw error codes are shown to players
- Linking with "ab" shows "username must be 3-32 characters of a-z, 0-9 or _ **400 invalid_username**".
- The formation issue list shows "living unit Well Digger 2 has no post **unit_not_posted**".
- A wrong password on deletion shows "that password is not this account's **403 wrong_password**".
- **Fix:** hide the code behind the existing "Technical detail" disclosure.

### N2. "While you were out, someone else's party met a caravan" shows after the player's own trip
- It is the guide's heading after g4 banked its first trip (`shots/g4-d2-17-after-bank.png`). The
  player was not out: they just played.
- **Fix:** "The parties you just fought belong to other players" (or "… were authored outfits").

### N3. An empty party says "The party stands: this is what defenders will scout"
- It shows on g5's Party screen with "0 of 8 unit slots".
- **Fix:** with 0 units, say "Your party is not standing: add a unit and it will be served".

### N4. Generated caravan names collide
- 2 of 6 accounts were "Dusty Teamsters" (`caravan.name`), so the inbox, the scout and strikes
  cannot tell them apart.
- **Fix:** widen the name lists, or make a name unique within an active window (re-roll on
  collision).

### N5. The outfit starts empty on every trip
- After the guide, every trip opens with 0 units ticked, "No fence" and 0 traps. That means
  re-ticking units, choosing a fence tier, and six taps of "Add Spike Pit" (traps are free).
- **Fix:** a "Pack the same as last trip" button, and the fence tier and trap count remembered.

### N6. The relief flow is two taps per unit, and its copy contradicts the relief rule
- It reads "Take the free menu now", then "Take <type>", while the screen says "Taking it forfeits
  this one's offers".
- **Fix:** in relief, show the offers directly with "Free while your roster is below 3". See D3.

### N7. A canvas tap next to a fence selects the fence instead of placing the selected unit
- With a Gunslinger selected, a tap one cell inside the north ring selected "Segment 13 (Brush
  Pile) · ring position 4, North" (`shots/g4-tapcell.png`).
- A tap on a reserved core cell does nothing and gives no feedback.
- Cells are about 20×10 CSS px at 360 wide, and about 9×5 at 320, where the camera frames the
  whole field.
- **Fix:**
  - While a placeable item is selected, hit-test empty cells before other objects.
  - Flash "can't place here (core)" on a reserved cell.
  - Zoom the ring to fill the canvas while placing, and frame the whole field only for the
    approach overlay.

### N8. "All steps (1 of 5 done)" shows before any step is done
- It shows on the guided encounter 1, before the first tap (`shots/g1-10-formation.png`). The
  "gap" step counts as done because every position starts open.
- **Fix:** count the gap step only once the fence step is done.

### N9. The sticky canvas covers the "Selected" panel's header and buttons
- At 360×740, the map overlaps "Selected" and the top of "Take back" / "Done"
  (`shots/g4-tap-after.png`).
- **Fix:** reserve the canvas height above the panel, or make the panel's header sticky below the
  map.

### N10. 4xx noise on every formation open and every cold start
- `GET /api/caravans/{id}/encounters/{n}/formation` returned **404 47 times** in my session: there
  is no draft yet.
- Every cold load logs 401s for `/me`, `/me/onboarding`, `/me/inbox/unread` and `/me/analytics`
  before the resume completes.
- Both pollute the crash and screen-flow panels.
- **Fix:** answer 200 `{ formation: null }`, as round 1 N10 did for the manifest and the
  candidates, and do not fire the authed reads until the resume has settled.

### N11. "Start from my last arrangement" re-aims at the wrong sides without a word
- g4's encounter-1 layout faced west. Re-applied against Sidewinder Crew (east 2, south 1) and The
  Cistern Gang (east 3), it was **overrun in 0:10 and 0:08**.
- **Fix:** when the new scout's approach sides differ from the last encounter's, label the button
  "Start from my last arrangement (it faced West; this party comes from East)", or offer a mirrored
  version.

### N12. Countdowns read as clock times
- "The next trip returns in 4:48" and "Next free menu in 1:29:58" are easy to misread as a time of
  day.
- **Fix:** "in 4 min 48 s", "in 1 h 30 min".

### N13. The Town is about 4,900 CSS px tall at 360 wide
- Merge board, merge, mine, refugees, mercenaries, locked types, then "Elsewhere in town", all in
  one scroll (`shots/g1-02-town.png`, 9,738 px at 2×).
- **Fix:** put the refugee panel (the thing that changes) near the top, and collapse the mine and
  the locked-types list.

### N14. Raiders that start on the far edges are off-canvas at the start of a replay
- In g1's encounter-1 replay, the south Homesteader is not visible until about 0:12, and the
  Prairie Wolf sits at the canvas edge (`shots/g1-rw1-open.png`).
- **Fix:** frame the replay's opening on the ring plus the entry bands, then follow the action.

### N15. A deleted opponent reads "vs someone (someone)"
- After g4's deletion, g1's and g5's strike entries all read "vs someone (someone), encounter 2 of
  their trip".
- **Fix:** "vs a caravan that has since left the trail". A live guest still reads "vs someone
  (Caravan name)".

### N16. A linked player's party is served under their username, a guest's under the caravan name
- g5's menus listed g4's party as "**r2_badlands_bea**", while guests' parties show their caravan
  name ("Juniper Teamsters", "Iron Rail Train").
- This is inconsistent, and it shows a sign-in name to strangers. The inbox already says "vs
  r2_badlands_bea (Lone Pine Wagon Co.)".
- **Fix:** serve every party under its caravan's name, and show the username only where the owner
  chose to.

---

## Judgement against PROJECT.md §21 and the brief

- **Is the inverted loop clear?** Yes. The welcome screen ("You play defense, live / Your raid
  party works while you are away / Your town is never raided"), the outfit copy ("What rides out
  is all that can be lost") and the owner-view replay all read the right way round. I saw no
  "base/camp" slip.
- **Are the decisions meaningful?**
  - Scouting is the strongest decision. The candidate summary (stance icons, total HP, "counters
    20 of your packed fence segments") lets you choose in seconds.
  - Arranging matters, and Quick arrange makes it fast.
  - Bank-or-push is real once a roster is healthy. g4's later trips banked 2,873 after three holds,
    against 725 after one.
  - Week-1 merges and trap packing are not decisions (D3/D4 from round 1, D4 here).
- **Are fights fair and legible, and does the autoplayed replay explain them?**
  - Legible: key moments, stance marks, "reached the core" and the end sheet tell you what
    happened every time.
  - Not fair in two cases: ranged parties shooting over the fence at posts that never react (S2),
    and 7–10 s core or trap runs that cost the whole pack with zero kills (D1).
- **Is there a reason to return?**
  - The inbox is good. Grouped strikes ("Your party struck 2 caravans · 2 held out · +20 ladder"),
    party-change notices, and refugee and trip-cap notices are all on by default.
  - The week loop works for a player who survives: g4 went from 1,789 to 14,353 Coin over the last
    three simulated days, and unlocked a tier-2 unit on about day 5.
  - But a downed party stays down (D2), and Coin has nothing to buy (D4).
- **Dead ends:** S1, the sign-out loop. A 0-unit caravan is no longer a dead end: relief plus
  mercenaries rebuild it.
- **Wrong numbers:**
  - The first-fight hold rate in BALANCE-LOG (73 %) does not survive live parties (S2).
  - The weekly free-earn estimate (55,000) is plausible for a surviving player (about 2,800 per
    3-encounter trip), and far above a struggling one (g2: 273 Coin after three trips).
- **Pay-to-win:** nothing is sold (`STORE_MODE=off`), and nothing purchasable touches a fight or
  an unlock. But in week 1 the only way back from a wipe besides refugees is 600-Coin
  mercenaries. If packs are ever sold, a $5 pack becomes a 10-unit rebuild. Settle D1 before
  enabling the store.
- **Two accounts raiding each other:**
  - g4's caravan met **g1's** standing party three times (encounters 2 and 3).
  - g1's inbox showed "Your party struck a caravan · 1 held out · Earned 47 Coin · +10 ladder · vs
    r2_badlands_bea (Lone Pine Wagon Co.)". "Watch the fight" played the owner's view.
  - **g2's** party met g4 and g5. g2's inbox grouped them: "Your party struck 2 caravans".
  - The reverse, g1's caravan meeting g4's party, never happened. g1 rebuilt to 3 units, so the
    band-0 raider cap excluded g4's 5-unit party, and g4's party was then down for days (D2).
  - **A full two-way pair: g4 ↔ g5.**
    - After I re-raised g4's party, g5 searched four times. g4's party was in every menu,
      **served under the username "r2_badlands_bea"** rather than its caravan name (N16).
    - g5 faced it and was overrun. g4's inbox then said "Your party struck a caravan · 1 overrun by
      your party · Earned 300 Coin · +24 Reputation · +30 ladder".
    - g4 then faced g5's party ("Iron Rail Train", 6 units) and held. g5's inbox said "1 held out ·
      Earned 212 Coin · 0 Reputation · +10 ladder · vs r2_badlands_bea (Lone Pine Wagon Co.)".
    - Both replays open from the inbox.
- **Linking a guest:**
  - g4 → `r2_badlands_bea`: "Signed in as r2_badlands_bea", with the same caravan and Coin.
  - Signing in on a second, 320×568 device showed the same town (1,683 Coin, 7 units), with no
    horizontal scroll.
  - The invalid-username path shows a raw code (N1).
- **Account deletion:**
  - g3 (guest): Account → type "delete my account" → "Delete my account for good" → "Your account
    has been deleted", back on the start screen.
  - g3's party had been served to g2 and g5. Their recent-fights lists still show those fights
    ("Encounter 1 · overrun"). The caravan-side replay never names the opponent, so there was no
    name left to strip.
  - **g4 (linked):** a wrong password is refused ("that password is not this account's 403
    wrong_password", N1). The right one gives "Your account has been deleted".
  - Afterwards, g1's six and g5's one strike entries against g4 read "**vs someone (someone)**",
    so the name is removed, but the copy is clumsy (N15). The fights stay in their history.

## Orchestrator decisions (2026-10-12)

- **S1 (sign-outs):**
  - Never evict the session being issued.
  - A resume revokes the session it replaces instead of minting an extra one. The client reuses its live session while it is valid.
  - Any resume failure other than a definite "no such device" shows the existing retry screen, never the start screen.
  - Add a test that reloads 50 times in a minute and stays signed in.
  - "Continue the guest caravan" must work from every state that offers it.
- **S2 (ranged first fights): first-trip fairness without simulating anything differently.**
  - Matchmaking serves only authored parties for every encounter of a caravan's first trip. This is a cold-start rule in the same family as the nearest-N authored fill.
  - The guide's pick also avoids ranged-only parties whenever another candidate exists.
  - `first-trip.ts` and its CI slice add raised starter parties for every region, ranged pairs included, as a second gate for the second trip. Target: the guided layout holds at least 60 % against them, and the best skilled layout at least 70 %.
  - If ranged kiting still blocks that target, the balance lever is a tunable only. Content stats, or a post's engagement range if it is already a tunable, are allowed. A resolver behaviour change is not, before the play test. Record the outcome in BALANCE-LOG.md.
- **D1 (fast runners take everything): no rule change, per PROJECT.md §13.** Look for a content-only lever on core-stance runners: trap trigger, the low-band authored mix, runner speed per unit type. Accept one only if targets 1–3 in BALANCE-LOG hold. Otherwise record it as the top telemetry question.
- **D2 (a party that goes down stays down):** no automatic refill, because the template is the owner's choice. Add a Town banner, "Your standing party is down", with one-tap "Raise from my roster" using the server's suggested party, plus the existing inbox notice.
- **D3:** already closed. The round-2 guardrail fixes (S1) owe one free menu at a time and rate-limit the refugee routes. Re-verify it.
- **D4 (Coin with nothing to buy): no change before the play test.** Record it in BALANCE-LOG as a telemetry question, with the observation.
- **Every N item is in scope.** N for the linked player's party served under their username: show the caravan name, as for guests.

## Server fix round (branch `fixr2p-server`, 2026-10-12)

The client half is on main (merged here). Payload changes are additive: `replacedPrevious` on the
resume, `authoredOnlyTrip` on a menu, `defender.departed` in the feed and inbox, and `?ifNone=null`
on the formation read. Migration **028** (`028_caravan_names`).

- **S1, server: closed.**
  - The session being issued is never evicted: `evictDeviceSessionsBeyondCap` /
    `evictSessionsBeyondCap` take its id and leave it out of the candidates (the others are cut to
    cap − 1). That was the round-2 cause.
  - `POST /auth/resume` replaces the session it is given (`Authorization: Bearer …` or
    `{ previousToken }`) when that is a live session of the same account on the same device;
    anything else is ignored, never an error. The response carries `replacedPrevious`.
  - Tests (`account-lifecycle.test.ts`):
    - 50 resumes passing the previous token: each new token answers `/me`, `/me/onboarding`,
      `/me/inbox/unread` and `/me/analytics` with 200, the replaced one answers 401, and 1 session
      is left;
    - 50 cold resumes with no token: all 200, and 10 sessions are left;
    - foreign, junk and over-long previous tokens are ignored.
  - e2e `apps/web/e2e/reloads.spec.ts`: a guest reloads **50 times in under a minute** and is back
    in town each time, as the same account, with no 401 from the API. It passed (12.5 s). With the
    old `auth/sessions.ts` and `repo/sessions.ts` swapped back in, it failed at **reload 11**, where
    the round-2 reviewer saw it.
- **S2, server: closed.**
  - `TUNABLES.AUTHORED_ONLY_FIRST_TRIPS` (1): every encounter of a caravan's first trip is drawn
    from authored outfits only. The rule runs before the seeded draw and is stored as
    `draw_rules.authoredOnlyTrip`, so the menu replays.
  - Tests (`matchmaking.test.ts`): trip 1 is all authored with six live parties at the very centre,
    and its menus replay. Trip 2 serves live parties again.
  - Every test fixture that needs live parties now gives its caravans one finished trip a day
    earlier (`helpers.ts seasonCaravan`).
  - Harness:
    - `sweep.ts guidePick` now follows the client guide, including its ranged rule;
    - `first-trip.ts` is now exactly the production first trip;
    - `first-trip.ts --raised` adds the second-trip gate. Its CI slice is in `balance-sweep.test.ts`.
  - Measured (BALANCE-LOG pass 4):
    - **first trip: guided encounter 1 held 179 / 200 = 90 %** (was 73 %);
    - **second trip against raised starter parties: guided 73 %, best skilled 81 %**, against
      targets of 60 % / 70 %, so no lever was applied.
  - **For the orchestrator:** the aggregate hides a regional gap. Badlands' own raised parties hold
    37 % guided and 44 % skilled, and a whole raised Mountain or Badlands roster (6 raiders) beats a
    5-unit guided circle almost always.
    - The lever was measured but not applied: posts' engagement +1 cell lifts every ranged pair to
      100 %.
    - Applying it would mean editing content for every unit, a RESOLVER_VERSION bump, new goldens
      and a full re-sweep.
- **D1: explored, no content lever accepted** (`scripts/balance/fast-runners.ts`, BALANCE-LOG
  pass 4).
  - A larger trap trigger changes nothing.
  - 15 % slower raiders cut overruns from 51 % to 44 % guided, but every fast overrun still costs
    about 4.6 standing units.
  - Recorded as the top telemetry question.
- **D2, server read: confirmed.** After a total loss the party is empty and `suggested` is null.
  Once the roster is rebuilt, `suggested` carries the new units and the free siege, and one
  `PUT /me/party` makes the party valid and servable again (`party.test.ts`). The client's banner
  (on main) uses it.
- **D3: re-verified.** The round-2 guardrail fix is in force: "500 refreshes below the floor yield
  ONE free menu" passes in `acquisition.test.ts`, and the refugee routes share a per-account limit.
- **D4: recorded** in BALANCE-LOG pass 4 as a telemetry question, with g4's week.
- **N1: no server change needed.** The server already returns the machine code (`error`) and the
  sentence (`message`) separately. Showing only the sentence is client work, which is on main.
- **N4: closed.**
  - The generated-name lists grew from 16 × 16 to 32 × 32 (1,024 names).
  - A generated name re-rolls on a collision. A requested name that another caravan already carries
    (case-insensitive) gets an ordinal, for example "Dusty Teamsters II", cut to fit 40 characters.
    That covers the client's own generated guest names too.
  - Migration 028 adds an index on `lower(name)`.
  - Test: 40 unnamed caravans get 40 distinct names, and three requests for the same name come back
    as base, II and III.
  - The inbox e2e's fixed 40-character name became unique per run. It had collided with itself on
    the second e2e pass of `pnpm check` and was shown with "II".
- **N10, server: closed, additively.** `GET …/formation?ifNone=null` answers 200
  `{ formation: null, encounterIndex }` when no draft exists. Without the parameter it is still the
  404 that current clients expect. The cold-load 401s were the client's (fixed on main); the reload
  e2e now asserts there are none.
- **N15: closed.** A feed or inbox defender whose caravan is the erasure tombstone, or is gone,
  carries `departed: true`, so the client can say "a caravan that has since left the trail".
- **N16: closed.** Every player's party is served under its caravan's name, never the username.
  - Migration 028 also extends erasure to match: `account_erasure_active.names` holds the erased
    account's caravan names. The erasure walk replaces any `displayName` equal to one of them, and
    the cross-account ledger scan looks for them too.
  - The deletion test now asserts that no table, and no decompressed replay, still contains the
    caravan name the party rode under.

