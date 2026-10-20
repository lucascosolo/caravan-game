# Confirmation play test (fun and playability)

Reviewer: independent adversarial play-tester, confirmation round. Build: e002854 (balance pass 8,
authored set v7, RESOLVER_VERSION 9), the real resolver in-process. Date: 2026-10-20. A guardrail
confirmation reviewer ran in parallel on port 3939.

## Verdict: READY

Nothing I played at e002854 blocks a tester or spoils their first hours. The changes since round
4 did what they were meant to do, and they broke nothing I could find.
- **Guided trips.** 14 fresh guests in all four regions followed the guide through two trips. All
  14 held encounter 1 of trip 1, and the 12 the guide pushed into encounter 2 all held. Trip 1 was
  delivered 14 of 14 times, and guided trip 2 12 of 13 times.
- **The advice.** The guide's card title now matches its advice at every encounter ("Bank or push"
  / "Bank the trip"). From encounter 2 it states what is at stake (round 4 D1 is fixed).
- **Wipes.** Every wiped caravan was back at 3 units within 10 s through the relief menus, and
  each one banked its next trip.
- **Live parties.** Past 2 banks, the raised parties are varied now: two edges per party and a
  mix of stances (round 4 D2). Two pairs of accounts raided each other, and the owners had the
  strikes in their inboxes with owner-view replays.
- **Accounts and reloads.** Reloads, a reload 0.8 s after an edit, two server restarts, linking,
  a second device and deletion (guest and linked) all worked.

What remains is design and polish:
- **D1.** The live pool is all 3-raider raises at 400 Reputation, and they never win: 46 of 46
  live strikes were driven off. This is the price pass 8 chose (#34).
- **D2.** The advice makes the first trips identical: bank at encounter 2 for 1,658 Coin, every
  time.
- **N1.** Ride-out is not disabled when more units are ticked than the caravan has slots.
- Smaller copy items.

None of these is S.

## How I played

- **Hosting, per `docs/PLAYTEST-HOSTING.md`, single-process mode.**
  - `pnpm install --frozen-lockfile && pnpm build` ("build ok").
  - Step 2's shared-instance option: login roles `caravan_c1pt_owner` (`IN ROLE caravan`,
    `SET role = caravan`) and `caravan_c1pt_app` (`IN ROLE caravan_app`), each with a random
    48-hex password, and the database `caravan_playtest_c1` owned by `caravan`. `sudo` was refused
    in this sandbox, so the roles were created over the local `caravan` superuser login instead of
    `sudo -u postgres`. The SQL is the runbook's.
  - The env file: `NODE_ENV=production`, `SERVE_WEB=1`, `STORE_MODE=off`, `HOST=127.0.0.1`,
    `PORT=3941`. There was no `TRUST_PROXY` (no proxy) and no `CARAVAN_TEST_RESOLVER`.
  - `migrate.js up` applied 30 migrations, and status showed `[x]` on all of them. The `datacl` was
    `{caravan=CTc/caravan,caravan_app=c/caravan}`, with no PUBLIC entry.
  - `seed.js` said "Authored parties (set v7): 96 created … No login accounts were created".
  - The boot lines matched the runbook: "real resolver", "store: off (packs previewed, not sold)",
    "serving the client … source maps not served". `/health` and `/api/health` both answered
    `{"ok":true}`.
- **Restarts, stated.** The server ran 16:17–17:23, 17:23–18:22 and 18:22–19:34 (UTC). All three
  stops were SIGTERM ("shut down cleanly"). Over all three logs there was no level-40/50 line and no
  5xx. The only 4xx were the deliberate 401 after a deletion and the 400 in N1. Players resumed
  through their device cookies with no sign-in.
- **Driving.** Playwright Chromium (`/opt/pw-browsers`) as a touch phone: Pixel 5 UA, `isMobile`,
  `hasTouch`. g8, g9, g12 and g13 played at **320×568**, the rest at 360×740. Every step was a fresh
  browser process restoring the profile's cookies, so each step was also a cold load and a resume.
  - "Following the guide" means the guide's refugee, its ticks, 6 traps, the best fence, its
    pick, its steps (trip 1) or "Arrange for me" (trip 2), and whatever `data-advice` said.
  - From trip 3 a "reasonable player" script took over. It picks the lowest-HP card with no
    all-shooter or core-heavy party, fences the raiders' sides with Quick arrange and posts
    through the picker. Read its hold rates as a floor.
  - Evidence: `/tmp/claude-0/-home-user-caravan-game/edcaf182-6a4d-5af1-b736-5ca8113d60f8/scratchpad/c1/`.
    Logs per player and trip are in `pw/logs/*.log`, the scripts are in `pw/` (`s_trip.mjs`,
    `two.mjs`, `week.mjs`, `age.sql`) and the screenshots are in `shots/<player>/`.
- **Time travel, stated.** I aged only the time caps (`trip_cap.tat_ms` and the refugee menu's
  times, `pw/age.sql`, `session_replication_role = replica`), and only for g7 (linked as
  `c1_week`), 24 h per simulated day. There were ten agings, at 17:24, 17:39, 17:53, 18:05,
  18:11, 18:18, 18:22, 18:40, 19:00 and 19:16. Days 4–6 were aged twice because I re-ran them (see
  the week). The extra agings only refill caps that were already full. **I did not age the mine or the ledger**, so g7's Coin
  under-counts a real week by about 4,800 a day. Because of the aging, some inbox notices carry
  past dates ("Trip starts are back · Oct 17").

## What I played

### Fresh guests, first two trips, following the guide

| player | region / screen | trip 1 | trip 2 |
|---|---|---|---|
| g1 | Desert 360 | held vs Timberline Gang. Advised **bank** (a Dust Rider at 37 / 620 HP and a half-ranged menu): 725 | (not guided: my first script ticked all 7 and hand-arranged) held, push, **overrun** vs Deadfall Crew; all 7 lost |
| g2 | High Plains 360 | held vs Prairie Wolf Pack, push, held vs Deadfall Crew, bank: 1,658 | held vs Windmill Gang; advised bank (2 Prairie Wolves under half HP): 725 |
| g3 | Mountain 360 | held vs Prairie Wolf, push, held vs Sodbusters' Levy, bank: 1,658 | held vs Salt Flat Drifters, push, held vs Sidewinder Crew, bank: 1,658 |
| g4 | Badlands 360 | held vs Prairie Wolf, push, held vs Deadfall, bank: 1,658 | held vs Salt Flat, push, held vs Sidewinder, bank: 1,658 |
| g5 | Desert 360 | held vs Salt Flat, push, held vs Deadfall, bank: 1,658 | held vs Timberline; advised bank: 725 |
| g6 | High Plains 360 | held vs Prairie Wolf, push, held vs Deadfall, bank: 1,658 | held vs Salt Flat; advised bank: 725 |
| g7 | Mountain 360 | held vs Prairie Wolf, push, held vs Sodbusters, bank: 1,658 | held vs Salt Flat, push, held vs Sidewinder, bank: 1,658 |
| g8 | Badlands **320** | held vs Timberline, push, held vs The Cistern Gang, bank: 1,658 | held vs Salt Flat, push, held vs Sidewinder, bank: 1,658 |
| g9 | Desert **320** | held vs Prairie Wolf, push, held vs Cistern, bank: 1,658 | held vs Windmill, push, held vs Deadfall, bank: 1,658 |
| g10 | High Plains 360 | held vs Prairie Wolf; advised bank (a Prairie Wolf at 117 / 360): 725 | **overrun at encounter 1** vs Windmill Gang (4 raiders, 4 edges; "Arrange for me"). Lost 5 L1 outright, no Coin |
| g11 | Mountain 360 | held vs Timberline, push, held vs Deadfall, bank: 1,658 (with reload tests) | held, push, held, bank: 1,658 (with reload tests) |
| g12 | Badlands **320** | held vs Prairie Wolf, push, held vs Deadfall, bank: 1,658 | held vs Windmill, push, held vs Sodbusters, bank: 1,658 |
| g13 | Mountain **320** | held vs Timberline, push, held vs Deadfall, bank: 1,658 | held vs Prairie Wolf, push, held vs Cistern, bank: 1,658 |
| g14 | Desert 360 | held vs Salt Flat, push, held vs Deadfall, bank: 1,658 | held vs Timberline, push, held vs Sidewinder, bank: 1,658 |

- **Trip 1:** encounter 1 held 14 / 14. The pushed encounter 2 held 12 / 12. Delivered 14 / 14.
- **Trip 2 (13 guided, g1 excluded):** encounter 1 held 12 / 13, the pushed encounter 2 held
  9 / 9, delivered 12 / 13.
- This matches BALANCE-LOG pass 8 (95 % / 94 %). The guide always passed over the all-shooter card
  and said so ("It passes over Bounty Board Riders: every raider there shoots from range").
- In trip 2 the outfit starts with nothing ticked once the guide is done. g2–g4 ticked all 7, as a
  player tapping every box would; the others ticked 5 (N3).

### The rest

| what | who | outcome |
|---|---|---|
| Ignore the guide | ig1 (Desert) | Skipped at once ("Skip it"), packed all 7, took the third card, hand-arranged, always pushed. Held encounter 1, then **overrun at encounter 2** by Deadfall Crew: 7 L1 lost, 600 Coin. Trip 2 with its one refugee: overrun at encounter 1 ("0 unbanked Coin was lost", N5). |
| Ignore the guide | ig2 (Mountain) | Skipped, packed all, picked by HP, always pushed. Held ×3 (the bank advice was ignored at encounters 2 and 3), then **overrun at encounter 4** by The Cistern Gang: 7 L1 and 2,498 Coin lost. Trip 2 with 1 unit: held, then overrun at encounter 2 by Dry Gulch Boys. |
| A wipe and its recovery | g1, ig1, g10 | Town: "Your next free menu is ready: take it now (nothing is forfeited)". 0 → 3 units in 9 s (g1); ig1 and g10 1 → 3 in 4 s. g1 then held and banked 525 (the cap: "None fields more raiders than the 3 units you packed"). Past 2 banks it held two live parties and banked 1,458. g10 held two and banked 1,189. |
| Live parties past 2 banks | g1 t4, g2 t3, g3 t3, g4 t3, g5 t3, g6 t3, g7 t3, g8 t3, g9 t3 | Every menu: three player parties, each 3 raiders at 400 Reputation, with different edges and stances ("◉ nearest 1 · ▼ traps 2", "◉ nearest 3" …). All 9 trips banked. g2 pushed to encounter 4 against live parties and banked **4,469**. One process was killed by my script's timeout while arranging encounter 4; the trip resumed on reload at its encounter-4 formation and committed. With the week: **46 live strikes, 46 held.** |
| Two accounts raiding each other | g6 ↔ g8, g6 ↔ g9 | g8 (Mesquite Column) met g6's Silver Spur Outfit at 17:04, and g6 met Mesquite Column at 17:09. g6 met g9's Bitter Creek Drovers at 17:14. Each owner's inbox: "Your party struck 2 caravans · 2 held out · Earned 551 Coin · +20 ladder … vs Silver Spur Outfit, encounter 1 of their trip". The owner-view replay: "It came in from the south and west … Your party lost nothing; it is a template … Your party earned 212 Coin". The key moments name each kill. |
| Reloads | g12 (320), g4, g11 | 12 back-to-back reloads on Town and 6 on the Trail all stayed in the game. **Reload 0.8 s after the last guide step** (g11): the circle came back intact, "20 of 20 segments placed" (round 4 N4 fixed). Reload 450 ms after Commit: the replay opened by itself (round 4 N5). Reload 150 ms after Commit, twice: the result came back but the replay did not open (N2). |
| Link, second device, delete | g11, ig1 | g11 linked as `c1_g11`, then signed in on a second profile with the password: same caravan. g11 was deleted with its password: "Your account has been deleted." A sign-in afterwards got 401, and the second device lands on the start screen. ig1 (guest) was deleted by typing "delete my account". |
| A simulated week | g7 → `c1_week` (Mountain) | See below. |

### The week (g7, `c1_week`, Mountain; `pw/logs/g7-week.log`)

Each simulated day: age the caps 24 h, then a Town visit (inbox, refugee, any affordable unlock,
mercenaries toward 8 while over 1,600 Coin, one merge while the roster is above 8), then two trips
(push at encounter 1, bank at encounter 2, reasonable-player picks).

- **Days 4–6, first pass.** My script ticked all 9 units against the 8-slot cap. The outfit let
  it, and the server refused the manifest with 400 (N1), so those six trips never rode. I re-ran
  days 4–7 after a restart, packing 8.
- **Trips:** 13 rode, 13 banked at 1,658, no overrun. Every menu was three live 3-raider parties at
  400 Reputation. The caravan's own Reputation rose to about 555, so by day 6 they sat about 150
  below it.
- **Coin:** 5,172 at the start of day 1 → 23,598, with the mine not aged. 8 merges were bought for
  3,050.
- **Unlocks:** Hard-Rock Miner and Tripwire Snare (day 1), Jaw Trap (day 3), Mountain Lion (day
  6). Living rung 1 → 3 of 20. On days 4–5 a single living point waited for a node that costs 2,
  as in round 4.
- **Roster at the end:** 9 units. Grizzly L3, Hard-Rock Miner L3 and Trapper L2 stuck, because no
  fight killed them. In round 4 four merges netted one L2.
- **The passive side:** c1_week's party, 3 units all week, struck no one. No one else was riding
  by then, and the party stayed at 3 although the roster held 9 (D1).
- **The ladder:** "200 ladder points to the next rung" on day 6, and trips paid about 100 a day.
  The visible week-on-week growth is still thin (round 4 D5, already open in BALANCE-LOG).

## S items

None.

Checked against what round 4 decided, at this commit:
- **D1 (the advice under a "Bank" card): fixed.** At encounter 1 the card reads "Bank or push"
  when it advises a push and "Bank the trip" when it advises a bank. From encounter 2 it says "You
  have come through encounter 2. At stake if you push: the 1408 unbanked Coin and the 5 units still
  standing … The guide suggests banking now". No "one push shows how encounters escalate" line
  appeared after encounter 1 (`shots/g8/3609598-enc2-decision.png`, `shots/g2/3244108-enc1-decision.png`).
- **D2 (north-edge `nearest` clones): fixed.** All 11 raised parties spread over two edges, for
  example "south/traps south/traps west/nearest" or "west/nearest west/nearest north/nearest".
  Trap-stance units are mixed in.
- **N1 (forecast) fixed:** "banked: 725 Coin".
- **N2 (end card) fixed:** "No unbanked Coin was lost: there was none yet". The summary still
  says "0 … was lost" (N5).
- **N3 fixed:** "until it has banked 2 trips".
- **N4 fixed.**
- **N5 partly fixed** (N2).
- **N6 fixed:** "Your party struck 2 caravans" is one notice. The merge notices in the week came
  one per visit.
- **N8 fixed:** "Since Oct 20, 2026, 5:00 PM".
- **N9 fixed:** "Show me the refugees".
- **N10 fixed** for 0 units (the button is disabled), but not for too many (N1).
- **N11:** 16 distinct names, none a suffix variant of another.

## D items

### D1. The live pool is all 3-raider L1 raises, and they never win
- **Evidence.**
  - Every live menu from trip 3 on (9 trips, 18 menus) showed three parties of 3 raiders at
    exactly 400 Reputation. They differed only in edges and stances.
  - `trip_encounter` by owner at the end of the session: live parties held 46, overran 0.
    Authored outfits held 51 and overran 4 (ig1's rows went with its deletion).
  - In the week the caravan's Reputation rose to about 555. The live parties stayed at 400, because
    a party that never wins never gains Reputation, and they were still the whole menu on day 7.
  - Each owner earned 211–613 Coin and +10 ladder per strike, and every inbox entry read "The
    caravan held; your party was driven off."
  - A 3-unit rebuilt caravan (g1) held two of these parties too. g2 pushed four live encounters
    with my weakest script and banked 4,469, the biggest delivery of the session. The week player
    banked 13 of 13 against them.
  - The raise stops at `SUGGESTED_PARTY_MAX` 3 even for a roster of 9 (g7's party fielded 3 all
    week). Nothing prompts a fill: round 4 N7 was left as is.
- **Why it matters.**
  - §1's King of Thieves hook is designing a hard-to-beat party and checking where it struck.
    Until testers edit their parties, no one ever reads "Your party overran the caravan".
  - The first live encounters are also easier than the authored ones they follow, so the step
    from authored to live reads as "the game got easier and pays the same".
  - This is the trade-off pass 8 #34 made (a raise of 5 was held 0–41 %). It is not a bug, and
    nothing stops a tester. BALANCE-LOG open 4 (round 4 D3) covers part of it.
- **Fix (a decision; one session each):**
  - (a) After the guide, show the Party tab's fill prompt ("Your party fields 3 of 9; add more")
    once the caravan has banked 2 trips, using the raise rule. This revisits round 4 N7 for the
    live phase only.
  - (b) Or let the raise grow with the owner's banks: 3 until 2 banks, 5 after.
  - Either way, add `partyStrikes` overrun share by party size to the play test's watch list next
    to open item 4.

### D2. In the first trips the guide's advice makes every trip the same shape
- **Evidence.**
  - 21 guided trips (trips 1–2) were pushed to encounter 2. All 21 held it, and all 21 were advised
    to bank. Every bank came to exactly 1,658 Coin.
  - The rule pushes only when the circle is unhurt, and a circle is never unhurt after two fights.
    g3: "Your circle has taken losses" for a Grizzly at 1,189 / 1,300 HP and nothing else.
  - The pushes the guide refused were winnable: ig2 held encounter 3, and g2 held encounters 3–4
    against live parties.
- **Why it matters.** Bank-or-push is the game's tension (§12). During the guided phase the guide
  pre-decides it the same way every time, and that phase is most of a tester's first session.
  BALANCE-LOG open 1 already watches Coin per trip. This is the same question seen as fun.
- **Fix / telemetry:**
  - Watch the push rate at encounter 2 for players who have finished the guide, against those who
    have not.
  - If guided testers never push on their own afterwards, let the advice at encounter 2 push when
    no unit is under 75 % and the next menu is not ranged-heavy. That is a tuning of
    `pushAdvice`'s worn test, not a new rule.

## N items

### N1. Ride-out is enabled with more units ticked than the caravan has slots, and the server refuses it
- **Evidence.** g7 (day 4) ticked 9 of 9 units. The outfit showed "1 too many: the server will
  refuse this. Take some off." and the "You are packing all 9" warning, but "Pack and ride out" and
  the confirm stayed enabled. `POST /api/caravans/…/manifest` then answered 400. The button's
  `disabled` (`OutfitScreen.tsx:400`) checks only `busy`, `noTrip` and `meters.noUnits`, not
  `meters.units.over`.
- **Fix.** Also disable the button when `meters.units.over > 0`, as round 4 N10 did for zero
  units.

### N2. A reload during the commit request still loses the replay (round 4 N5, partly fixed)
- **Evidence.** g11 trip 1: two reloads 150 ms after Commit landed on the itemised result, with no
  replay ("no replay dialog" after 90 s). A reload at 450 ms, after the commit returned, opened the
  replay. `rememberCommitted` runs in `onCommitted`, after `commitEncounter` and the formation
  re-read return (`FormationScreen.tsx:629–649`).
- **Fix.** Remember (manifest, encounter) just before `api.commitEncounter`, and forget it if the
  commit fails.

### N3. After the guide, the outfit starts with nothing ticked, so the reserve is one tap from gone
- **Evidence.** From trip 2 the outfit has no prefill (`guidePrefill` runs only while `guiding`).
  g2–g4 ticked every box and packed all 7. g1 and ig1 did the same and lost all 7 in one overrun.
  The warning shows, but only after the tick.
- **Fix.** While the menu is `authoredOnlyTrip`, show the assist's "Tick the guide's 5" (the same
  `guidePrefill`, one tap) next to the reserve hint. It is optional, like "Arrange for me".

### N4. The advice copy overstates small things
- "Your circle has taken losses" for one unit at 91 % HP and nothing spent or broken (g3 trip 1,
  g4, g8 …). **Fix:** "Your circle has taken damage", and name the worst unit, as the detail
  variant already does.
- "mostly raiders that shoot from range" for 2-raider parties with 1 shooter (`isRangedHeavy` is
  "at least half"; g1's Timberline Gang card says "◎ 1 of 2"). **Fix:** "at least half of
  whose raiders shoot from range".

### N5. The trip summary says "0 unbanked Coin was lost."
ig1 and g10 at encounter 1: "Overrun at encounter 1 … 0 unbanked Coin was lost." The end card says
"No unbanked Coin was lost: there was none yet." **Fix:** branch `summaryCoinLost` on 0, as
`overrunCoin` does.

### N6. "Skip the guide" says it will not come back, and then a GUIDE card does
ig1 and ig2 confirmed "Skip the rest of the guide? The guide will not come back on this account."
Both still got cards labelled GUIDE ("The guide's reading … The guide suggests banking now",
`shots/ig2/4188649-enc3-decision.png`) and the scout pick until their second bank. This is by design
(the round-3 assist), but the copy contradicts it. **Fix:** `skipBody`: "The step-by-step guide will
not come back. Until you have banked twice, the Trail still shows its reading of the scout and of
bank or push."

## Not covered

- **`menu_stale` (409, back to a free search).** It needs a resolver or content change between
  choose and commit, and I did not upgrade mid-session. The guardrail reviewer's ground.
- **"No menu can be filled" → Return to town (`pool_empty`).** I could not starve a seeded pool
  through play.
- **An overrun by a live party, with the Coin going to its owner.** It never happened (D1). Round 4
  saw it work at an earlier commit.
- **The admin dashboard.** I did not grant admin or read it.
- **Caddy and HTTPS.** I played over loopback, where Chromium treats `http://127.0.0.1` as a
  secure context, so the `Secure` cookie worked. I did not test the proxy, `TRUST_PROXY` or the
  rate limits behind it.
- **A hand-edited standing party.** No player opened the party editor to build a bigger or
  stranger party. That is what D1 depends on.
- **The 320 px refugee "Show me" button.** I saw the button, but my script took the refugee from
  the panel directly and never tapped it.
