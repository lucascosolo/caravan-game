# Chunk 24 — QA punch list (reviewed at roadmap/phase-2-spec @ f1fb74c)

Probes (not committed):
- **Walkthrough.** A Playwright spec drove a brand-new player through the first session at 360×740
  (desert) and 320×568 (badlands). It ran against the built server on `caravan_dev_qa24`
  **without** `CARAVAN_TEST_RESOLVER`, and screenshots were taken at every step.
- **Hold-rate script.** For each fresh account it went register → refugee claim → pack (the
  unit, Spike Pit, 20 Brush Pile) → ride out → search → the guide's own pick →
  `arrangeGuide.ts`'s five "do it for me" edits → commit. Every fight was resolved by the
  production handlers (`DEFAULT_HANDLERS` + `TRIP_SETTLE_HOOKS`). It ran on a freshly reset and
  seeded `caravan_test_qa24`, where only the 96 authored parties and `dev` exist.
- **API and role probes.** Direct requests against the onboarding routes, and statements run as
  `caravan_app`.

Baseline: `pnpm build` passes ("battlefield.ts, fixed.ts, replay.ts"). `pnpm e2e` passed 8/8
(caravan_dev_qa24, E2E_PORT 3983, E2E_WEB_PORT 4283; onboarding spec 31.9 s). The web onboarding
suites passed 20/20.

**Jobs do not drain without the test double.** Nothing in `apps/server/src` runs a worker loop
outside `scheduleInlineDrain` (dev/testResolver.ts:70). After a commit on the plain built server,
the job sat at `status=queued, attempts=0` for 45 s and the Trail showed "resolving" the whole
time. To walk the real-resolver path I ran an out-of-process `drain` loop with the production
handlers. So a real-resolver player cannot get past encounter 1 on today's server at all.
Deployment needs a worker process; this is not chunk 24's to fix, but every real-resolver
statement below assumes one exists.

The guide is sound plumbing. Steps are forward-only on the server, it is fail-open, and it uses
no storage. It edits the circle through the formation screen's own model, and it grants nothing.
But it teaches a first trip that does not happen. With the real resolver, **no** guided first
fight held: 0 of 120. Most players end the tutorial with an empty roster, so they never raise the
passive party it builds up to. The copy then misstates what was lost. A merge also broke every
style rule the guide has.

Checked and fine:
- **No grants.** I walked the server route for every step and compared the ledger: no Coin, unit,
  unlock point or access is granted. The guide's only unit is the ordinary refugee claim, which is
  inside the starting nodes (guardrail 3). `prefillParty` skips locked roster units and stops at
  the slot cap.
- **Forward-only through UPDATE.** As `caravan_app`, `UPDATE … SET step='welcome'` on a finished
  row raises "onboarding step cannot move back (done -> welcome)". See N1 for DELETE.
- **The first screen cannot be skipped through `/skip`.** It answers 409 `onboarding_first_screen`.
  `canSkip` is false and no Skip button is rendered (see N1 for `/advance`).
- **Reload mid-guide.** It re-reads the server row and the Trail re-derives the step from its own
  state.
- **Two tabs.** A stale tab's `reach` gets the server's further step back and adopts it
  (OnboardingProvider.tsx:61-64).
- **Returning account.** Finished or skipped accounts see nothing, the backfill marks existing
  accounts done, and the e2e reload re-check passes.
- **No storage.** No storage API in `src/onboarding`.
- **Copy location.** Every player-facing string is in `STRINGS.guide`. There is no "base" or
  "camp" in it, and nothing in it says the player attacks.
- **Phone layout.** No horizontal scroll at 320 or 360 on any guide step. No guide control is
  under 44 px; the only small hits were the formation screen's own 20×20 checkboxes inside larger
  labels.

---

## Design / balance (decide before the chunk is `done`)

D1. **The guided first fight is never held: 0 of 120 with the real resolver.** A fresh account
holds REPUTATION_START 1000 (tunables.ts:118). Encounter 1 is searched at 1000 +
FIRST_ENCOUNTER_CENTRE_OFFSET (−150) = 850, which is display band **2**, not band 0
(band.ts `bandOf`: ⌊(850−100)/300⌋). All 48 chosen rows in the first run have `band = 2`.

What a fresh account is actually served is six band-2 authored outfits:
| outfit | raiders | siege pieces | total HP |
|---|---|---|---|
| Tumbleweed Syndicate | 5 | 3 | 3,625 |
| Saguaro Toll Company | 5 | 0 | 4,345 |
| Cougar Ridge Outfit | 5 | 3 | 6,049 |
| Powder Thief Outfit | 6 | 2 | 3,673 |
| Drover's Rest Outfit | 6 | 2 | 4,365 |
| Rail Bull Gang | 6 | 3 | 3,555 |

Results (one L1 refugee, all eight starting types across four regions, the full guided layout,
20 Brush Pile):
| party chosen | traps packed | fights | survived |
|---|---|---|---|
| the guide's pick | 1 | 48 | 0 |
| the guide's pick | 6 (slot cap) | 24 | 0 |
| menu slot 0 | 1 | 16 | 0 |
| menu slot 1 | 1 | 16 | 0 |
| menu slot 2 | 1 | 16 | 0 |

Every fight ended at depth 1024.

Consequences:
- **No player completes the designed first trip** (guide → push → encounter 2 → bank). §24's DoD
  ("five fresh testers each complete the first trip") cannot be met.
- **Most players have nothing to raise a party with.** On an overrun, a unit alive at the wipe is
  lost outright. 86 of the 120 probe caravans that rode out ended with an **empty roster**: "Raise my party" answers
  `partyEmpty`. The next free refugee menu is 90 min away (REFUGEE_REFRESH_INTERVAL_MINUTES), and
  a reroll costs 150 Coin against a balance of 0. So "the passive side is live from minute six"
  (§24) fails for most players, and the first session ends at an empty town.
- **The build note understates this.** It says "overrun at band 0 far more often than not". The
  band is 2, and the rate is 100 %.

This is 13-punchlist D2 at its sharpest. The fix is a §24/PROJECT.md decision before chunk 37:
1. a tunable starting-roster grant (§24 allows one only with a decision), or
2. a new caravan's encounter 1 searched at band 0/1 (e.g. FIRST_ENCOUNTER_CENTRE_OFFSET scaled
   by trips taken), or
3. band-2 outfits re-authored.

**Acceptance:** a probe like this one, kept as `scripts/balance/first-trip.ts`, shows a target
hold rate (say ≥ 50 %) for the guided layout on a fresh account.

D2. **The guide tells the player to push, whatever their state.** decide1Body (strings.ts:1196)
says "This first trip pushes once, then banks", and it shows unchanged whatever the survivors
are.

Observed at 360 px: encounter 1 held against a 1-raider player party (depth 87 %). The only unit
was left at **74 of 1100 HP**, and the trap was spent. The guide said push. Encounter 2 overran
the caravan and the 1,000 unbanked Coin was lost.

The stakes screen itemizes all of this, so guardrail 4 holds on paper. But the tutorial's voice
contradicts the stakes screen at exactly the moment it is teaching bank versus push. §24 says
"the player banks after two". It does not say the guide should prescribe a push into a likely
loss.

Decide one of:
- make the card conditional (e.g. advise banking when any packed unit is under half HP or no
  trap is left; say plainly that pushing risks the 1,000), or
- explain both options and prescribe neither.

**Test:** a component test with a 74/1100 survivor shows no "pushes once" line.

---

## Should-fix

S1. **A merge left a rule unclosed, so no guide CSS applies.** theme.css:938 opens
`.inbox-actions {` (chunk 29) and never closes it. The chunk-24 block from line 943 to the end of
the file (1015) is parsed as nested rules; brace depth at EOF is 1. The built CSS confirms it:
`.inbox-actions{display:flex;…;.guide{border:2px dashed …}`.

So none of `.guide`, `.guide__label`, `.guide__list`, `.guide__mark`, `.guide__skip` or
`.welcome__side*` match anything:
- **No dashed border.** The guide cards have none, which removes the "not by colour alone" marker
  the Build notes promise. They read as plain screen content (screenshots: roster, result,
  decide).
- **Double list markers.** The arrangement list shows both the `<ol>` numbers and the ○ marks
  ("1. ○").
- **No side borders.** The first screen's three sides lose their left borders.
- **Skip is the loudest control.** "Skip the guide" renders as a full-width solid button. On the
  town step it is the only control in the card, sitting above the Town heading.

Fix: close the rule. Add a CSS brace-balance check (or a stylelint parse) to `pnpm lint`, and a
web test that asserts a computed `border-style: dashed` on `.guide`.

S2. **The overrun card says "what you packed is lost", which is false for units that died
earlier.** overrunBody (strings.ts:1194) is shown for every overrun (ShellGuide.tsx:193-198).

The roster rule is:
- units that died during the fight are de-merged, floored at L1, and **kept**;
- only units alive at the wipe are lost.

Two observed cases:
- 320 px, badlands: the guide card says "what you packed is lost". The trip summary directly
  below it says "Lost outright: None · Gunslinger · stays L1", and "Raise my party" then put that
  Gunslinger in the party.
- 360 px: "Lost outright: None · Well Digger · stays L1".

In the probe, 34 of 120 caravans kept their unit after an overrun. Fix: say what the summary
says. Read the ended trip's losses (they are already in the trip view) or word it generically:
"units still standing when the caravan fell are lost; units that fell earlier come home a level
lower". Also drop "the stakes were itemized before each choice" (partyOverrun, strings.ts:1205)
for an encounter-1 overrun, where the player made no stake choice.

S3. **After an overrun, the party card's title reads as a raid on the player's caravan while
they were away.** ShellGuide.tsx:173 puts partyTitle "While you were out, someone else's party
met a caravan" first, and "Your caravan was overrun" right under it (screenshot
320-13-party-card-overrun). A new player reads: while I was out, someone's party hit my caravan.

That is the misreading guardrail 0 forbids: "there is no asynchronous raid against a player's
caravan". It is also the misreading the welcome screen spends three paragraphs preventing. It is
the common case (D1). Fix:
- show the overrun block first, under its own heading, then the passive-side card with its title;
  or
- make the title say whose party and whose caravan ("Your party works the same way: while you
  are out, it meets other players' caravans").

Test: the overrun card's first heading is the overrun.

S4. **The guided steps edit a circle the player cannot see.** At 360×740 the canvas ends at
y = 386. The arrangement card starts at 507 and is 1,477 px tall; Commit is at y = 4,130. At 320
the card starts at 442 and is 1,555 px tall.

Every "Place the North fence" / "Post … at (x, y)" / "Lay … at (x, y)" button sits one to three
screens below the canvas. A tap changes the circle off-screen, and the only feedback is a ✓.
"Place this fence, leave this gap… now scout why" is meant to be watched. The cell coordinates
in the copy ("(15, 11)") mean nothing without the lattice in view.

Fix (presentation only):
- put the next undone step, compact, directly under the canvas, with the rest collapsed;
- or keep the canvas sticky while the guide list scrolls;
- after an apply, scroll the canvas into view and select the placed thing.

Measure in the e2e that the canvas is in the viewport when a `guide-do-*` button is tapped.

S5. **The e2e covers only the double, which never produces the common path.** onboarding.spec.ts
runs on `CARAVAN_TEST_RESOLVER=double`: every encounter is held. The path 100 % of real first
trips take is never run end to end:

    overrun → summary → overrun party card → raise (empty or a de-merged survivor) → finish

That path includes S2, S3 and the empty-roster branch. The component test (Onboarding.test.tsx:207)
covers it with an empty roster only, and with no check of the loss wording.

Also:
- The copy check (spec:45-50) scans only `.guide` and the welcome screen. It misses
  `confirmUnposted` ("Every living unit is at the camp", strings.ts:342), which the first trip's
  free encounter 2 shows whenever a unit is left unposted (N4).
- Nothing in any suite would have caught S1.

Add:
- a double plan (or a second double, e.g. `CARAVAN_TEST_RESOLVER=double-overrun`) that overruns
  encounter 1, and an e2e branch through the overrun with a survivor and without one;
- a copy scan over `main`, not just `.guide`;
- the computed-style assertion from S1.

---

## Nits

N1. **Server rules have side doors** (low stakes: the row grants nothing):
- (a) `POST /me/onboarding/advance {"step":"done"}` from `welcome` answers 200
  `{step:"done", completed:true, skipped:false}`, while `/skip` refuses there with 409
  (service.ts:73 vs :86). So the "not skippable on the first screen" rule exists only in the
  client, and a skip-at-welcome is recorded as a genuine *completion*, which corrupts any
  completion-rate telemetry (chunk 32). Refuse `advance` to `done` unless the current step is
  `party`, or record it as skipped.
- (b) As `caravan_app`, `DELETE FROM account_onboarding …` then
  `INSERT … (account_id, step) VALUES (…,'welcome')` succeeds. A finished guide reopens, despite
  "a finished guide is permanent" (migration 017:34). Add a BEFORE DELETE guard like
  `trip_encounter_guard_delete`, or document that only UPDATE is guarded.

N2. **The "smallest party" ordering is easy to skew, and it ignores siege**
(TrailGuide.tsx:289-297: fewest raiders, then HP):
- **Raider count beats HP.** Cougar Ridge (5 raiders, 3 siege, 6,049 HP) ranks "smaller" than
  Powder Thief (6 raiders, 2 siege, 3,673 HP), and both are served to fresh accounts.
- **Owners can steer it.** Any owner can make their party the guide's pick for every new player
  in the band by fielding one raider of any merge level. In the dev world, every walk's pick was
  a 1-unit player party.
- **Siege is ignored.** Siege counters exactly the fence and trap the guide is about to teach,
  and 70 of the 120 fought parties carried three siege pieces.

Nothing is gained at encounter 1 (unbanked Coin is 0), so this is not exploitable for Coin, but
the hint is misleading. Rank by total HP, then siege count, then raiders. Add a guideModel test
with exactly that pair.

N3. **Agreement and number in the arrangement copy.**
- `why` (strings.ts:1185) renders "The raider from the North meet a fence" for one raider.
- arrangeBody renders "1 of the 1 raiders start".
- Edge names arrive capitalized mid-sentence ("the North side").

N4. **`confirmUnposted` calls the wagon circle "the camp"** (strings.ts:342, chunk 23:
"Every living unit is at the camp and needs a post"). The commit dialog shows it in the first
trip's free encounter 2. This is guardrail 0 naming. It is not chunk 24's string, but it is on
chunk 24's path, and the e2e's copy check misses it (S5).

N5. **A voided first trip gets the generic party card.** `lastEnd === "voided"` has no copy
(ShellGuide.tsx:169-199), and partyBody says "The parties you just faced". A trip voided at
encounter 1 has faced none. One line is needed: "Your first trip could not be resolved; nothing
was lost, and the trip did not count against your hourly cap" (or whatever chunk 15's void
actually refunds).

N6. **Fail-open never retries.** OnboardingProvider.tsx:40-47 reads the state once per sign-in
and swallows the error. One transient 5xx on a brand-new account's first `GET /me/onboarding`
means no first screen for that entire session. It is the one screen §24 says must be seen.
Retry with backoff (2–3 attempts) before going quiet.

N7. **During the first screen the tab bar stays live but does nothing.** App.tsx:70-74 swaps the
screen for `WelcomeScreen`, but AppShell still renders the four tabs (observed: Town, Trail,
Party, Webs). Tapping Trail highlights Trail and still shows the welcome screen. Either hide or
disable the tabs on the first screen, or let them leave it (it is not skippable, so hide them).

N8. **Raising the party lands mid-page.** `navigate("party")` after `saveParty`
(ShellGuide.tsx:122) keeps the Trail's scroll offset. At 320×568 the viewport opened on the
Party screen's roster and siege list, with the "Your standing party is up" status and the
guide's Finish button scrolled off above. Scroll to top on that navigation.

N9. **"Hold two encounters, bank. About five minutes."** (welcomePlan, strings.ts:1142) is a
promise of a hold that the strings' own header (strings.ts:1117) says the guide must not make.
Given D1, word it as a plan: "face two encounters, then bank if you are still standing".

## Orchestrator decisions (2026-10-11)

- **D1: a starting roster for every caravan, and a first trip that is winnable. The balance pass is accountable for the numbers.** 0 holds in 120 guided first fights means the first session teaches only loss. That breaks §24's done criterion and the promise that the passive side is "live from minute six".
  - **Starting roster (mechanism, chunk 24 fixer).** Every new caravan starts with a starting roster defined by a tunable `STARTING_ROSTER`: by default one level-1 unit of each of its region's starter types. The grant applies at caravan creation for every caravan, not as a tutorial-only gift, so it is part of the normal rules. It is the "starting roster" §24 already names. It grants no Coin and no unlock-web access beyond the starters every caravan already has. It goes through the ledger like any other unit grant.
  - **First-trip difficulty (numbers, balance pass).** The balance pass tunes `STARTING_ROSTER`, `FIRST_ENCOUNTER_CENTRE_OFFSET`, the starting Reputation and the low-band authored outfits together. With the real resolver, the guided first layout must hold most guided first fights against what a fresh account is actually served (target: at least 70 %). A sensible free layout must hold encounter 2 more often than not. It must also confirm that a fresh account's first searches are served the bands intended for it.
  - **Rejected:** a tutorial-only scripted or easier fight, which would break "nothing is simulated differently". Also rejected: a Coin grant, which §24 forbids.
- **D2: the guide recommends from the state; it never insists on pushing.** The bank-or-push card reads the server's preview. When the circle is badly hurt (any posted unit under half HP, or the preview's risk is high), the guide recommends banking and explains why. Otherwise it suggests one push to see escalation. Remove "this first trip pushes once". The guide's flow continues to the party step after either choice.
- **S1** is fixed on main (commit 8679d87, an unclosed CSS rule from the chunk 24/29 merge). The fixer adds a check that would catch it: a CSS parse check in the web build, or a test asserting a guide rule applies.
- **S2–S5 and every nit are in scope.** S5: add an e2e path that ends in an overrun, using a per-encounter script in the test double. For S4, the active guide step sits next to the canvas, and "do it for me" scrolls or keeps the circle visible.
- The "never resolves without the test flag" observation is closed. Chunk 13's fix round added the in-process worker on main after this review's base.
