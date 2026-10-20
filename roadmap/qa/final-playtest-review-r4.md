# Final play-test review, round 4: fun and playability

Reviewer: independent adversarial play-tester, round 4 (fun and playability only; a guardrail
reviewer ran in parallel on port 3943). Build: `roadmap/phase-2-spec` at 91612d0 (balance pass 6,
RESOLVER_VERSION 9, authored set v6), real resolver in-process. Date: 2026-10-20.

## Verdict: READY

Every S item from rounds 1–3 is fixed, and in this round I found nothing that stops a tester or
spoils their first hours. 14 fresh guests across all four regions played their guided first trip
on real fights; 11 of 14 held the first fight. The guide now reads the scout at every encounter, each card
counts its shooters, and the pushed encounter 2 held 8 of 9 times. Every wiped caravan was back at 3
units within a minute through the free relief menus, and g1 banked again on its next trip. Accounts
past two banks met each other's standing parties, both ways round (g8's party overran g4, g4's
party was driven off by g8), and each owner had the strike in the inbox with an owner-view replay.
Reloads, a reload during a resolve, linking, a second device and deletion (guest and linked) all
worked. The loop is clear, the scouting matters, and bank-or-push is a real gamble from encounter
2 on: three caravans that pushed past it banked 2,873–4,469 Coin, and two lost everything. What remains is
design and polish. The biggest items are **D1**, the guide still recommending a push at encounter 2+
under a card titled "Bank the trip", and **D2/D3**, a live pool that is all north-edge `nearest`
clones in which the strongest parties are rarely chosen. D5, a week that ends with idle Coin and no
lasting merge, is the biggest return-hook question. Fix D1's copy and rule before
the test if there is a session to spare, because it is a one-line change. Neither D1 nor D2/D3 stops a
tester, and D2/D3 are exactly what the play test's telemetry should measure.

## How I played (so the evidence can be reproduced)

- **Hosting, per `docs/PLAYTEST-HOSTING.md`, single-process mode.**
  - `pnpm install --frozen-lockfile && pnpm build`.
  - Step 2's shared-instance option: roles `caravan_r4pt_owner` (`IN ROLE caravan`, `SET role =
    caravan`) and `caravan_r4pt_app` (`IN ROLE caravan_app`) with random passwords, and the database
    `caravan_playtest_r4` owned by `caravan`.
  - The env file: `NODE_ENV=production`, `SERVE_WEB=1`, `STORE_MODE=off`, `HOST=127.0.0.1`,
    `PORT=3945`. No `TRUST_PROXY` (no proxy), no `CARAVAN_TEST_RESOLVER`.
  - `migrate.js up` (29 migrations), `seed.js` ("Authored parties (set v6): 96 created … No login
    accounts were created"), then `node apps/server/dist/index.js`. The boot lines matched the
    runbook: "real resolver", "store: off (packs previewed, not sold)", "serving the client …
    source maps not served".
  - Chromium treats `http://127.0.0.1` as a secure context, so the `Secure` device cookie works
    without Caddy.
  - **Restart, stated:** the server ran 10:19–12:07 UTC. I stopped it with SIGTERM before the
    2-hour background limit. The log said "shut down cleanly" and showed no level-40/50 lines. I
    started it again at 12:08 on the same database and env file. Players resumed through their
    device cookies with no sign-in.
- **Driving.** Playwright Chromium (`/opt/pw-browsers`) as a touch phone: Pixel 5 UA, `isMobile`,
  `hasTouch`, 360×740. g10 and g12 played at 320×568. Every step was a fresh browser process
  restoring the profile's cookies, so every step was also a cold load and resume. That is several
  hundred loads in all, none signed out.
  - g1's first trip I played screen by screen and read everything. After that a script followed the guide
    exactly: it took the first refugee, accepted the guide's ticks, added traps, the best fence,
    took the guide's pick and every guide step, and did what `data-advice` recommended.
  - Once the guide was done, a "reasonable player" script took over. It skips parties that are all
    core stance or all shooters, picks by HP, fences the raiders' sides first with Quick arrange,
    and posts and lays through the picker on the raider sides. Its circles are worse than a careful
    human's, so read its later hold rates as a floor.
  - Evidence: `/tmp/claude-0/-home-user-caravan-game/edcaf182-6a4d-5af1-b736-5ca8113d60f8/scratchpad/pw/`
    (`logs/*.log` per player and trip; scripts `run.mjs`, `s_trip.mjs`, `s_manage.mjs`,
    `week.mjs`, `age.sql`). Screenshots are in `…/scratchpad/shots/<player>/`, cited below as
    `shots/…`.
- **Time travel, stated.** Only for g9 (linked as `r4_week`), and only the time caps:
  `trip_cap.tat_ms` and the refugee menu's `generated_at_ms` / `window_opened_at_ms` /
  `claimed_at_ms`, each moved back 24 h by `pw/age.sql` (`session_replication_role = replica`).
  - The agings ran at 11:00, 11:16, 11:32, 11:49, 12:06, 12:24 and 12:41 UTC. The day-5 aging ran
    once, before the restart; the driver logs a "skipped (already aged)" line for it after.
  - **I did not age the mine or the ledger.** g9's Coin therefore under-counts a real week by
    about 4,800 Coin per simulated day (200/h).

### The first trips (14 fresh guests, all through the UI, following the guide)

| player | region | encounter 1 (guide's pick) | then | first trip |
|---|---|---|---|---|
| g1 | Desert | held vs Salt Flat Drifters | push (advised); **overrun 0:08** vs Sodbusters' Levy (4 core, Bridging Planks) | lost 5 outright, 600 Coin |
| g2 | High Plains | held vs Prairie Wolf Pack | push; held vs Deadfall Crew; **push advised again**; overrun vs Sodbusters' Levy | lost 3 outright, 1,408 Coin |
| g3 | Mountain | held vs Prairie Wolf Pack | push; held ×2 (Deadfall, Sodbusters); **push advised twice**; overrun vs Buffalo Wallow Crew | lost 5 outright, 2,498 Coin |
| g4 | Badlands | held vs Prairie Wolf Pack | push; held vs Hardrock Hirelings; bank (ranged-menu advice) | banked 1,658 |
| g5 | Desert | **overrun** vs Prairie Wolf Pack | — | lost 5 outright |
| g6 | High Plains | held vs Prairie Wolf Pack | push ×3 (all advised); held vs Cistern, Sidewinder, Deadfall; bank (hurt) | banked **4,469** |
| g7 | Mountain | **overrun** vs Prairie Wolf Pack | — | lost 5 outright |
| g8 | Badlands | held vs Alkali Freighters | push; held vs Deadfall Crew; bank | banked 1,658 |
| g9 | Desert | held vs Prairie Wolf Pack | push; held vs Cistern Gang; bank | banked 1,658 |
| g10 (320) | High Plains | **overrun 0:20** vs Timberline Gang (Grizzly core runner) | — | lost 5 outright |
| g11 | Badlands | held vs Timberline Gang | push ×2; held vs Sodbusters, Deadfall; bank | banked 2,873 |
| g12 (320) | Desert | held vs Salt Flat Drifters | bank (hurt) | banked 725 |
| g13 | Mountain | held vs Timberline Gang | push ×2; held vs Sodbusters, Deadfall; bank | banked 2,873 |
| g14 | High Plains | held vs Alkali Freighters | bank (hurt) | banked 725 |

- Encounter 1, guided: 11 of 14 held (79 %). The three losses are pass 6's open D1: Prairie Wolf Pack
  overran 2 of 7 and Timberline Gang 1 of 3.
- The pushed encounter 2, guided: 8 of 9 held. Round 3's S1 is closed.
- First trips delivered: 8 of 14 (57 %). BALANCE-LOG pass 6 reports 78 %, but it assumes a bank
  after encounter 2. Two of the six failures (g2, g3) came from a push the guide advised **at
  encounter 2 or later** (D1).

### Afterwards

- **Wipes and recovery.** g1, g5 and g7 each had 2 units in town. Each claimed the relief menu
  ("Your next free menu is ready: take it now") and was back to 3 units within a minute. g1's
  3-unit caravan held its next encounter 1 against a capped 2-raider party and banked 525. g1 then
  wiped a second time on a push and was offered relief again.
- **Live parties.** Caravans past 2 banks (g4, g8, g9) met only other testers' parties from trip 3
  on, as named caravans at 400 Reputation, 2 to 7 raiders, under the packed-unit cap. Two accounts
  raided each other:
  - g8's party (Juniper Drovers) overran g4 at 11:47: "Your party overran the caravan. 900 Coin ·
    +27 Reputation".
  - g4's party (Copper Freighters) was driven off by g8 at 11:53. It had overrun g9 at 11:41 for
    900 Coin.
  - Both owners' inboxes itemised the strikes. The owner-view replay said "Your standing party
    was served into someone's trip while you were away. It came in from the north … Your party
    lost nothing; it is a template."
  - g2, g3, g6 and g12 (who never banked twice) also had strikes in their inboxes. Their small
    parties were served into the 2-bank caravans' trips.
- **Reloads.** Twelve back-to-back reloads (g10) stayed in the game. A reload 150 ms after
  Commit (g1, twice) came back to the itemised result or the trip summary, with the fight
  resolved.
- **Accounts.** g9 linked as `r4_week` and g4 as `r4_g4`. g4b signed in on a second "device" with
  the password: same caravan, both devices listed, "Sign out every other device" offered. g7
  (guest) was deleted by typing "delete my account". g5 was linked and then deleted with its password.
  Both landed on the start screen ("Your account has been deleted."), and a sign-in as `r4_g5`
  afterwards was refused (401).
- **The week** (g9, `r4_week`, Desert; `logs/g9-week.log`). Each simulated day, a Town visit read the inbox,
  took the refugee, spent any affordable unlock, recruited toward 8 units while over 1,600 Coin,
  and merged one pair when the roster was above 8. Then two trips: push once, bank at encounter 2.
  - **14 trips in 7 days:** 11 banked at 1,658, 3 overrun at encounter 2 by live 7-raider rosters.
  - **Coin:** 1,746 → 18,169, with the mine not aged.
  - **Unlocks:** Tripwire Snare (day 2), Jaw Trap (day 4), Coyote Pack (day 6). The living ladder
    went from rung 1 to rung 3 of 20. On days 3–5 a lone living point waited for a node that
    costs 2.
  - **Roster:** 2 mercenaries bought, 4 merges. The week ended at 8 units, all L1 except one
    Dust Rider L2.
  - **Where the merges went:** the merged Dust Rider stood at the front and died in most fights,
    held or not. The bank summaries say so ("Died on the trip, de-merged one level on the bank:
    Dust Rider · L3 → L2"), and four merges netted one L2.
  - **The passive side:** g9's party (3 units after the merges) struck no one all week. Only two
    other caravans in this small pool were past 2 banks. That is an artefact of the pool's size,
    but under `AUTHORED_ONLY_UNTIL_BANKS` it is also how the first days of a real cohort will look.
  - (Before the week, g9 merged its way from 7 units to 3 on one visit. That was my script's
    over-eager rule, not the game's. The merge preview had stated each merge's HP drop plainly.)

## Rounds 1–3: S items

### Round 1 S1 (one overrun wipes the roster; recovery takes hours): **fixed**
The guide packs 5 of 7 and leaves 2 at home ("so one bad fight cannot take your whole roster").
The outfit warns when everything is packed: "You are packing all 7 of your units. Everything you
pack can be lost". Relief menus refill a wiped caravan to 3 at once (g1, g5, g7). The band 0–1
packed-unit cap ("None fields more raiders than the 3 units you packed") gave g1's rebuilt caravan
a fight it could win.

### Round 1 S2 (the standing party silently stops after a merge or a loss): **fixed**
g6's inbox: "Your standing party changed … 4 slots were dropped. It now fields 3 units". g5 and
g7: "Your standing party is down: no units to send". g1's Town shows the "Your standing party is
down … Open the party" banner. g9's merges re-pointed slots ("1 slot moved to the merged unit").

### Round 1 S3 (hand-arranging is a chore; the picker moves the last segment): **fixed**
Quick arrange ("Fence North (1 raider)") fences a side in one tap. The picker advances. The guide's
steps place a whole layout in four taps. My script posted every unit through the picker without
a single misplacement.

### Round 1 S4 (the fight is not shown): **fixed**
Every commit opened the replay already playing at 2×, with "Skip to result" pinned
(`shots/g1/1821368-replay-6s.png`). The key-moments feed explains each loss: "0:05 The raiders'
Prairie Wolf 2 crossed your Spike Pit; the party's Bridging Planks made it harmless … 0:08 …
reached the core."

### Round 1 S5 (the sandbox store hands out Coin): **fixed**
`#/packs`: "PACKS ARE NOT ON SALE DURING THE PLAY TEST … nothing can be bought". The boot log says
"store: off".

### Round 2 S1 (page loads sign the player out): **fixed**
Several hundred cold loads and resumes, 12 back-to-back reloads, two reloads mid-resolve and a
server restart: no sign-out, no guest-replacement screen.

### Round 2 S2 (ranged starter parties beat the first fight): **fixed**
First trips meet authored outfits only. The guide passes over all-shooter parties, for example "It
passes over Bounty Board Riders: every raider there shoots from range". No first fight was lost to
shooters.

### Round 3 S1 (the guide's push leads into an encounter 2 lost half the time): **fixed**
The scout reading is shown at every encounter: "Encounter 2: scout before you choose … Of these,
Sodbusters' Levy is the smallest of the parties not made up only of shooters". Every card has a
"Shoot from range" line (◎ / ○ plus words). The guided encounter 2 held 8 of 9. The advice now
banks on a ranged-heavy menu over a hurt circle (g4: "every one of the 3 parties you were just
offered is mostly raiders that shoot from range … The guide suggests banking this time"). What is
left is past encounter 2 (D1).

### Round 3 S2 (trip 2 is served other testers' whole raised rosters): **fixed**
Trips 1 and 2 met authored outfits only, for all 14 guests, g4/g8/g9 included. Live parties
appeared from trip 3, after 2 banks. In bands 0–1 none outnumbered the packed circle. A
5-unit circle was never offered a 7-raider roster. A 7-unit one was (g4b: three 7-raider menus),
as the rule intends. Pass 6's open item 1 tracks how that plays.

## New punch list

Tags: **S** blocks the external play test. **D** is a design question for the orchestrator. **N**
is polish. Each item fits in one session.

No new S items.

### D1. The guide keeps advising a push at encounter 2 and later, under a card titled "Bank the trip"
- **Evidence.**
  - At encounter 2 the guide card reads, top to bottom: "**Bank the trip** — Banking now makes the
    Coin you carried safe in town for good … that ends the first trip. Pushing on is allowed too …
    *Your circle came through in fair shape. One push shows how encounters escalate* … Your call."
    (`shots/g11/4087506-enc2-decision.png`, `data-advice="push"`).
  - The same push line came at encounter 3 for g3 and g6, while the card's own wording promises
    "one push".
  - `@caravan/circle` `pushAdvice` has no encounter index. It says push whenever no unit is under
    half HP and the menu is not ranged-heavy.
  - Of the 5 guests the advice sent past encounter 2, g2 and g3 were overrun: all packed units
    standing were lost (3 and 5 L1), with 1,408 and 2,498 Coin. g6, g11 and g13 banked 4,469,
    2,873 and 2,873.
  - The harness measures the guide only up to encounter 2 (pass 6: "first trip delivered 78 %"
    counts a hold at encounter 2 as delivered). In play it was 8 of 14.
- **Why not S:** the outcome is the push-or-bank gamble the game is built on, and the expected
  value was positive in my sample. The title says Bank, recovery is quick, and nothing is stuck.
  But the tutorial contradicts itself at the moment a new player is most exposed, and the
  measured target does not cover what it says.
- **Fix (one session; decide which):**
  - (a) Make the advice the copy: `pushAdvice(p, menu, encounterIndex)` returns bank from
    encounter 2 of the guided first trip. Advice at encounter 1 is unchanged.
  - (b) Or keep the advice and fix the copy. Use `decideAdvisePush` only at encounter 1. From
    encounter 2 on, title the card "Bank or push", and have `first-trip.ts` and the CI slice follow
    the advice to the end of the trip, with a target on "first trip delivered".
  - Either way, add a CI case that pins the card title to the advice it shows.

### D2. Every live party is a north-edge `nearest` clone, so the scout read collapses to "fence north"
- **Evidence.** All 53 units in the 10 non-empty player parties in the database carry `"edge":
  "north", "stance": "nearest"` (`SELECT … FROM standing_party, jsonb_array_elements(composition->'units')`). That is what "Raise my party from my roster" and the
  party-down banner create, and no tester changed it. From trip 3 every menu showed "◉ nearest N"
  and "Comes from North N" (g4, g8, g9, g4b).
- **Why it matters:** PROJECT.md §9–10 make "where to leave the gap against *this* attacker" the
  core read. §17 wants "a varied trail". With the default raise, every live encounter has one answer.
  At 2–3 trips per tester before they meet live parties, few will ever open the party editor.
- **Fix (pick one):**
  - (a) The raise spreads units over the two edges nearest to the roster's strengths, and gives
    the fastest units `core` and trap-killers `traps`. It must stay deterministic: a fixed
    function of the roster.
  - (b) The guide's party step asks one question ("Where do they come from? Which stance?") with
    three presets.
  - Telemetry: the share of served parties per edge and stance pattern (chunk 32's stance panel
    already has the raw rows).

### D3. The defender picks from three, so a strong party is rarely chosen, and the passive hook rewards looking weak
- **Evidence.** From trip 3 the 7-raider whole rosters (g4, g8, g9, g12's) sat on menus next to
  2–4 raider parties. On every mixed menu, the reasonable pick and the guide's rule from trip 1
  both took the smallest.
  - Strikes in the inboxes: g2's 4-unit party 3, g3's 2-unit 2, g6's 3-unit 2. The 7-unit parties
    had 1–2 each (g4, g8, g12).
  - The 7-unit strikes I can trace came from a menu of three 7-raider parties (g4b) or a pick
    by name (g8 choosing g4's party).
  - §1's King of Thieves hook is "designing a hard-to-beat raiding party". Under a pick-from-three
    menu, a harder-looking party is served but passed over, so it earns less. My sample is small.
    The play test should measure it.
- **Fix:** a design decision, not a number. Options:
  - (a) The owner's results feed counts "scouted and passed over" as a small Reputation or ladder
    credit, so a feared party still progresses.
  - (b) Pay out by depth × the party's relative strength, and give a bonus when a caravan picks a
    party above the menu's median.
  - (c) Record and watch it: chunk 32's served-vs-chosen ratio by party strength.

### D4. At level 1, an overrun where everyone dies costs nothing, so merging is punished by the same fight (round 1 D1, measured again)
- **Evidence.** g4b's 7 L1 posts were all killed at encounter 2: "Lost outright: None", nothing
  de-merged below the floor, the roster intact. g9's day-3 overrun with 8 posts all dead lost
  only its merged levels: "Dust Rider · L2 → L1 · Well Digger · L2 → L1". Those are merge levels it had paid
  250 and 900 Coin for. A g1 overrun with posts alive lost 5 units outright.
- **Why it matters:** in week 1 the cheapest way to lose is to lose badly, and the only thing at
  risk in a total rout is merge investment. That is the opposite of §13's greed-vs-caution design.
- **Fix:** record it as a telemetry question (units lost outright vs de-merged, per overrun, by
  merge level), or decide whether an overrun should cost at least the trip's living-unit ladder
  progress.

### D5. A week of steady play ends about where it started, with 18,000 Coin idle
- **Evidence.** g9's week (above): 14 trips, 11 banks, 3 unlocks. It ended at 8 units, all L1 but
  one, and 18,169 Coin, with the mine not aged (a real week adds about 4,800 a day). Merges did
  not stick: the merged unit dies first, and even a held, banked trip de-merges it. Four merges
  for 1,000 Coin netted one L2. The roster cap is 8 deployment slots, so mercenaries stop being
  useful at 8. With store purchases off, Coin has no other use.
- **Why it matters:** §21 asks whether there is a reason to return and whether progress is
  "generous in practice". The day-to-day hooks (refugees, trips, the inbox) work. The visible
  week-over-week growth is thin: rung 3 of 20 and no lasting merge. This is pass 6's D3 and round 2's
  D4 seen over a full week, not a new mechanic gap. It is the play test's question, so it stays a D.
- **Telemetry to watch:** merge levels lost per week against merge levels bought; Coin balance
  at day 7 by decile; the share of merged units posted at the gap. If the play test confirms it,
  options include a "keep back" hint for merged units in the guide's layout (posts at the
  gap are L1), or a cheaper re-merge of a unit that was de-merged.

### N1. The outfit's Coin forecast ignores the band multiplier
Every fresh caravan at 400 Reputation (band 400–699) reads "Forecast for the shortest trip (one
encounter survived, then banked: 525 Coin)". It then banks 725 (600 + 125). `OutfitScreen.tsx:130`
uses `encounterSchedule[0]`, not `coinForEncounter(1, band)`. **Fix:** ask the server's economy
route for the band-scaled figure, or pass the caravan's band.

### N2. The overrun end card says "Your unbanked Coin was lost" when there was none
g10 at encounter 1: "This was an authored outfit: it keeps nothing. Your unbanked Coin was lost
to the trail" (`shots/g10/3377297-replay-12s.png`). The summary correctly says "No unbanked Coin
was lost: there was none yet". **Fix:** branch on `coinLost === 0`, as the summary does.

### N3. The guide says live parties start "from your next trip", but they start after 2 banks
`strings.ts:1409` (searchBody), `:1492` (partyBody) and `:1503` (partyBodyOne). Since pass 6 #28,
a caravan meets authored outfits until it has banked twice. **Fix:** "Until your caravan has
banked twice, you meet authored outfits only…", read from `TUNABLES.AUTHORED_ONLY_UNTIL_BANKS`.

### N4. A reload within 1.2 s of an edit loses the arrangement
g10: two guide steps, then a reload 0.8 s later. The circle came back empty ("0 of 20 segments",
"Step 1 of 5"). With 8 s between the edit and the reload it came back intact. `AUTOSAVE_DEBOUNCE_MS = 1200` has
no flush on `pagehide`/`visibilitychange`. **Fix:** flush the pending draft with `fetch(…,
{keepalive: true})` on `pagehide`.

### N5. After a reload mid-resolve the replay never opens
A reload right after Commit returns to the itemised result. The fight does not auto-play, as it does
after an ordinary commit (round 1 S4), so a player who reloaded never sees it unless they find "Watch the
fight". **Fix:** open the replay once for an encounter whose result the player has not yet seen
(server-side "seen" flag or the inbox read state).

### N6. One merge visit produces several "Your standing party changed" notices
g9's inbox after one Town visit with four merges: four separate notices at 10:59 ("It now fields
6 units", "…5", "…4", "…3"). **Fix:** coalesce `party_changed` notices within a minute into one,
with the final count.

### N7. A party that shrinks is never refilled
Merges and losses drop slots (g9 7 → 3 in one visit; g6 7 → 3 after a wipe), and new refugees or
mercenaries are never added. The town banner appears only when the party is down to zero.
**Fix:** when the party is below `PARTY_SLOT_CAP` and the roster has unused units, show "Your
party fields 3 of 8; fill it from your roster" on Town and Party (one tap, the raise rule).

### N8. The inbox digest names a window that has not ended
"Between Oct 20, 2026, 11:00 AM and Oct 20, 2026, 12:00 PM", read at 11:10. **Fix:** "Since 11:00
AM" while the hour is open.

### N9. At 320 px the "Take a refugee" step points at a panel below the fold
The guide card fills the first screen (`shots/g10/3242915-town320.png`). The Refugees panel and its
Take buttons start below it, with no link. **Fix:** a "Show me" button that scrolls to
`refugee-panel`, as the arrange steps do for the circle.

### N10. Ride-out with no unit packed reaches the server
With the guide finished, the outfit starts with nothing ticked. The script that tapped "Pack and
ride out" got the confirm dialog ("0 living units") and then a refusal: "a manifest must pack at
least one living unit". **Fix:** disable the ride-out button while no unit is ticked. The hint "Pack
at least one living unit." is already on screen.

### N11. Generated names can read as one caravan
"Red Mesa Wagon Co.", "Red Mesa Wagon Co. II" and "Red Mesa Freighters" were on menus and in
inboxes at the same time (g8 trip 4). **Fix:** draw the second word from a pool that excludes words
already in use by live parties, or add the region.

## Judgement against PROJECT.md §21 and the brief

- **Is the loop clear?** Yes.
  - The welcome screen says it the right way round in three short blocks.
  - Outfit → ride → search → scout → arrange → commit → replay → result → bank or push → summary
    has no dead ends and itemises every stake.
  - I saw no "base" or "camp".
  - The guide finishes on the passive side ("Raise my party"), and the inbox picks it up.
- **Are the decisions meaningful?**
  - Picking among three scouted parties is (the guide's own reading changes outcomes).
  - Arranging is meaningful against mixed-edge parties. The weak spot is the guided layout against
    core runners from a second edge (pass 6 D1).
  - Bank or push is a real gamble from encounter 2 on. Trips paid 725 → 1,658 → 2,873 → 4,469, with
    two total losses among five deep pushes.
  - The live pool undercuts the scouting read (D2).
  - Traps are still free to pack (round 1 D3), so the trap loadout is "add six".
- **Are fights fair and legible?**
  - Legible: the replay plus key moments explained every loss I looked at. Sodbusters' Bridging
    Planks were named before the fight and in the feed.
  - Fair: the pushed encounter 2 is fair now. Encounter 1's core and trap runners (pass 6 D1)
    remain the most common "how did I lose?" case: 3 of 14.
- **Is there a reason to return?**
  - Yes: trips regenerate every 20 minutes, there are refugee menus, and strikes arrive in the
    inbox with owner replays and Coin.
  - Week 1 Coin piles up (g9 passed 10,000 by day 4 with nothing better to buy than mercenaries and merges).
  - Unlocks come slowly (living rung 2 of 20 by day 5; a single point waits for the next tier's 2).
  - These are pass 6's open D3 and round 2 D4, seen over a full week (D5). They are not new.
- **Pay-to-win:** packs are visible and not on sale. Coin buys mercenaries (already unlocked
  types only) and merges, which the preview shows as fewer slots, not more power ("Max HP 1240 →
  775 … not stronger than the consumed ones combined").
- **Grind walls:** none in the first hour or the simulated week.

## Orchestrator decisions (2026-10-20)

Verdict accepted: READY. A final polish round runs before the hand-off, then one short confirmation round on the final commit.

- **D1: fix.** `pushAdvice` takes the encounter index. After encounter 2 the advice never uses the "one push shows how encounters escalate" line. Past encounter 2 it recommends a push only when the circle is unhurt and the next menu is not ranged-heavy. Otherwise it recommends banking, and says what is at stake (the unbanked Coin and the units). The harness measures up to encounter 3 with this rule. This is a change to the shared rule in packages/circle/src/guide.ts, coordinated with the balance agent.
- **D2: fix.** The guide's one-tap raise varies its entry edges and stances deterministically: spread across the caravan's starter edges, and each unit's stance from its role. Live scouting then means something.
- **D3, D5: telemetry questions.** Add them to BALANCE-LOG.
- **D4: no change**, per PROJECT.md §13 (round 1 D1).
- **N1, N2, N4, N5, N6, N8, N9, N10, N11: in scope.** N7 stays as is: a party never refills automatically; the Town banner offers it. N3 was already fixed by the authored-only copy rewrite (2f92d6a); verify it.
