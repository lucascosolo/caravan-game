# Caravan Vaults — Phase 2: from v1 chunks to a feature-complete, infinitely replayable mobile game

**Status of this document:** spec. Nothing in it is started. Read
[GUARDRAILS.md](GUARDRAILS.md) in full before any chunk here, exactly as for chunks 01–20.

## Where the project stands

Nothing is implemented. All twenty chunks in [INDEX.md](INDEX.md) are `not started`;
the repo holds the design document, the guardrails, and the chunk briefs. Those twenty
chunks are the correct spine and this document does not reorder or replace them. It
answers a different question: **what else has to exist** for the result to be a
shippable mobile game that people keep playing, rather than a working core loop.

The gaps fall into three groups, and they are handled differently:

| Group | What it is | Design status |
|---|---|---|
| **A. Missing v1 engineering** (chunks 21–38) | Work the game cannot ship without, that no existing chunk owns: onboarding, notifications, cosmetics as a system, art and audio, store billing, mobile packaging, telemetry, live-ops tooling, account lifecycle, release QA. | No design change. Everything here implements PROJECT.md as written. |
| **B. Replayability systems** (chunks 39–45) | What keeps a player going after the ladders cap and the webs are mostly bought: seasons, leaderboards, contracts, content cadence, social surfacing, multiple standing parties. | **Each needs a short amendment to PROJECT.md** before it is built. The proposals below are written to fit the guardrails; the sign-off is a design decision, not an implementation detail. |
| **C. The deferred list** (chunks 46–49) | PROJECT.md §19: multi-caravan, prestige, duplicate recycling, campaign mode. Already designed in outline. | Build only after Phase 1 and group A are `done` and group B has shipped at least seasons. Campaign mode carries a hard research requirement, below. |

Sizes are T-shirt (S = one session, M = two to four, L = a week or more of sessions)
and are relative to the existing chunks, where chunk 10 is L.

## Why the game is replayable at all, and what that depends on

The content engine is **other players' standing parties**. Every encounter is a
human-authored puzzle, arranged freshly against by the player, so the supply of
distinct encounters is as large as the live pool and never needs authored content to
grow. That is the structural claim behind "infinitely replayable", and it holds only if:

1. the pool is populated at every Reputation band, including on day one (chunk 25);
2. the player is pulled back between sessions by the **asynchronous feedback loop**,
   which is silent today because nothing notifies a party's owner that it struck
   (chunk 29);
3. there is a reason to play after ladder rung 20, when unlock points stop arriving
   (group B);
4. balance is tuned from data rather than defaults, so no band degenerates into one
   dominant party shape (chunks 32, 37, and 41).

Everything below serves one of those four conditions or is a shipping requirement.

---

# Group A — missing v1 engineering (no design change)

## 21. Build, CI, and deploy pipeline — **S**, start immediately, parallel with 01

**Status: built** (2026-10-11). CI workflow, resolver boundary test, determinism gate (harness pending chunk 13), hardened resolver lint, `pnpm build`. Staging deploy deferred: no hosting target chosen. See ORCHESTRATION.md.

**Goal.** Make the guardrails mechanically enforced from the first commit, and make
every merge deployable.

**Constraints.**
- A lint rule set scoped to `packages/resolver` that **fails the build** on `Math.random`,
  `Date`, `performance.now`, any `number` literal with a decimal point, `sqrt`, `sin`,
  `cos`, `atan2`, `exp`, `pow`, `Map`/`Set` iteration without an explicit sort, and any
  import from outside the package. Guardrail 1 as code, not as review.
- A dependency-boundary test that proves `packages/resolver` cannot import anything from
  `apps/server` or any billing/entitlement module (chunk 20's DoD asks for this; it
  belongs in CI from day one).
- The chunk 13 determinism harness runs on every pull request; a changed golden log
  fails CI unless the commit is tagged as an intentional resolver version bump.
- Three environments: local, staging, production. Migrations run forward only, with a
  rehearsal against a production snapshot on staging before every release.
- Fill in the `Build / test / run` block in `AGENTS.md`.

**Definition of done.** A pull request that adds `Math.random()` to the resolver is
rejected by CI. A pull request that changes a golden log without a version bump is
rejected. `main` deploys to staging on merge.

**QA checks.** Try to smuggle a float into the resolver through a dependency. Try to
read an environment variable from inside it.

## 22. Replay player and post-fight summary — **M**, after 13 and 08

**Goal.** The client that plays a stored tick log, for both the caravan's player and
the standing party's owner. Chunk 13 defines the log and the "renderer makes no
decisions" rule; chunk 08 builds the isometric renderer. No chunk owns the **player**:
transport controls, seeking, the event ticker, and the results screen.

**Constraints.**
- Play, pause, speed (1×, 2×, 4×), scrub, and seek to any keyframe. Seeking renders the
  keyframe state and interpolates forward; it never re-simulates.
- An event ticker beside the scene: trap fired, fence broke, ability fired, unit died,
  core reached. Every line is a log record, so the ticker is a view, not a derivation.
- A **results summary** before the replay: outcome, depth reached, Coin moved, units
  killed and de-merged (chunk 19), Reputation change, ladder progress. Itemized, so the
  stakes that were previewed (guardrail 4) are shown settled.
- The same player serves the party owner's results feed (chunk 09). The owner sees
  their party from its own side: where it entered, how far it got, what stopped it.
- A truncated or version-mismatched log fails loudly with a message, never renders.

**Definition of done.** Both participants can open any encounter they were part of
from their respective screens and watch it. Scrubbing to the end always shows the
outcome the ledger recorded.

**QA checks.** Guardrail 1: diff the renderer's displayed outcome against the ledger
for 100 replays. Confirm no code path in the player calls into `packages/resolver`.

**Status: QA'd — fix round 1 built** (2026-10-11; S1–S9, D1–D4 and N1–N10 closed, see `roadmap/qa/22-punchlist.md` "Fix round 1"; the Maker's build notes below predate it: the body now also carries `settled`, `labels.siege` and stances, and `GET /me/encounters` exists). Build notes:

- **Where it lives.** `apps/web/src/screens/replay/`: `replayModel.ts` (pure: body → scene at a
  moment, event feed, tally, keyframe seeks), `ReplayPlayer.tsx` (fetch, states, summary,
  canvas, transport, feed, end card), `WatchFight.tsx` (the one entry point: a button that opens
  the player in a full-viewport `Modal size="full"` over the screen it came from). API:
  `api.replay(jobId)` → `GET /me/encounters/:jobId/replay`, guarded by `replayShape`
  (`src/api/replayShapes.ts`, types in `replayTypes.ts`); the `log` passes through the guard
  opaque — `readReplay` is its validator.
- **Reader only, never the simulation.** The client imports `readReplay` from the new subpath
  `@caravan/resolver/replay` (`packages/resolver/package.json` `exports["./replay"]` →
  `src/replay.ts`). The package index would also have tree-shaken, but the subpath makes the
  intent explicit. `apps/web/scripts/check-bundle.mjs` runs after every `vite build` (it is in
  the web `build` script, so `pnpm build` and CI run it): it reads the hidden source maps and
  FAILS the build if any `packages/resolver/src` module other than `replay.ts`, `fixed.ts`,
  `battlefield.ts` is in a client chunk (verified: a probe import of `resolve` failed it with
  tick.ts, combat.ts, resolve.ts … listed). Current build: `battlefield.ts, fixed.ts, replay.ts`.
- **Renderer.** Through `apps/web/src/iso` only. Two OPTIONAL fields added to `IsoSceneState`
  (as chunk 17 did): `replayUnits` (both sides at log positions; attackers keep the dashed ring,
  HP bar per side, level badge, no stance/radii — the log carries neither and the player never
  guesses) and `marks` (short-lived shape-coded markers over a trap spring, death, fence break,
  ability, core arrival). Trail and town scenes are unchanged. `showRadii` false, no drag, so
  the lattice never shows during a replay. Between two ticks the player lerps the reader's
  `frame(t)` and `frame(t+1)` (presentation only).
- **Seeking.** Scrub (native range input: touch drag, keyboard, `aria-valuetext`), previous /
  next keyframe, skip to the end. Every position is `readReplay(log).frame(t)` (the reader seeks
  from the nearest keyframe snapshot and interpolates forward); nothing re-simulates.
- **Outcome = the ledger's.** The summary and the end card show the SERVER's recorded outcome
  (`body.outcome`). `openReplay` refuses (never draws) a log whose kind / depth / endTick
  disagree with it, labels that do not match the log, a body marked `renderable: false`, and
  anything `readReplay` throws on (truncation, edits) — with the reason on screen.
- **Results summary first** (PHASE-2 §22): outcome, depth with `depthExplained` and the
  deepest raider, loot (caravan: "loot reported for the raiding party's owner"; owner: "your
  party's loot … as reported", since chunk 19 credits it separately), the tally from the rows
  (raiders / posted units down, fence segments broken, traps sprung, core reached). The owner
  also sees what the feed says was credited (Coin, Reputation, ladder). The caravan's itemized
  Coin / kills / de-merges remain chunk 23's EncounterResult directly above the button.
- **Both viewers.** Copy per `viewer`: the caravan reads "your Well Digger 2 … the raiders' Dust
  Rider"; the owner reads "your Dust Rider … the caravan's Well Digger", where it came in
  (edges from the spawn rows), and that the party lost nothing. All copy in `STRINGS.replay`.
- **Event feed.** One line per log row of kind hit / death / trap fired / trap nullified / fence
  broken / ability (display name from `labels`, with the row's targets and amounts; a dash's
  amount is distance, a buff's duration is the row's `until`) / core reached; newest first,
  "Key moments" hides hits; a live region only while paused.
- **States.** 409 `not_resolved`, 410 `replay_expired`, 404 each have their own copy; any other
  error has Retry. **Server change:** a job that completed WITHOUT a log (the test double;
  `job.result.replay` is null) used to answer 410 `replay_expired`, which is false. It now
  answers 200 `renderable: false`, `log: null`, `stored: null`, `logFormat: null`,
  `resolverVersion: null`, empty labels and `reason: "no replay log was recorded for this
  fight"` (`NO_LOG_REASON`, routes/replay.ts). A log that existed and was pruned is still 410.
- **Entry points.** Trail: chunk 23's "Watch the fight" in `EncounterResult` is wired (button
  wiring only: `ReplayAffordance` takes `jobId` / `encounterIndex`, `EncounterResult` an
  optional `api` prop; shown when the encounter has a result). Party tab: each results-feed
  entry with a `jobId` has "Watch the fight" (owner view, with the entry's credited numbers).
- **Mobile.** 44 px targets, the scrub is a full-width 44 px row, fits 320 px (e2e asserts no
  sideways scroll and every control ≥ 44 px at 360 and 320); no storage of any kind.
- **Tests.** Server contract (`apps/server/test/contract.test.ts`) now records `replay.json` and
  `replay-owner.json` (a fresh caravan's first encounter fought by the REAL resolver, both
  participants) and `replay-no-log.json` (a double-resolved fight); the normaliser keeps `log`
  and `labels` in server order (positional) and the test asserts the renamed log still reads.
  Web: `replayShapes.test.ts` (4), `replayModel.test.ts` (15: contract fight both sides, frames
  equal the reader's, keyframe seeks, the whole 72-fight golden corpus opens / ends on its final
  keyframe / has one feed line per moment row, truncation / edit / outcome-mismatch / labels /
  not-renderable refusals, lerp, marks), `ReplayPlayer.test.tsx` (16: summary, scrub-to-end =
  recorded outcome, key-moment filter, keyframe buttons, rAF playback at 4×, owner view,
  a golden full-load overrun, no-log / unreadable / truncated / 409 / 410 / 404 / Retry, the
  Trail and Party entry points). E2E (`apps/web/e2e/trip.spec.ts`): at encounter 1's results
  "Watch the fight" opens the player and — the double has no log — asserts the no-log state,
  the recorded outcome, 360 / 320 px fit, Close; then serves the recorded real-resolver body for
  that one request (`page.route`) and plays it on the real canvas at 4×, skips to the end card.
- **For QA.** The guardrail-1 "100 replays vs the ledger" probe: the model test drives all 72
  goldens and the contract fight; the server-side check that `body.outcome` (the job result the
  ledger events were written from) equals the log's ending is enforced client-side by
  `openReplay`. Known gaps: siege pieces are not drawn (the log has no siege labels); posts show
  no stance mark (the log does not carry stances); `TripSummary.tsx`'s header comment still says
  the button is disabled (chunk 23 file, left for its owner). Pre-existing, not chunk 22:
  `e2e/formation.spec.ts`'s no-purchase regex `/pay/` matches the authored party flavor "…when
  the pay stopped." (Rail Bull Gang) whenever the seeded draw serves it.
- **Observed results (this branch).** `pnpm typecheck` clean; `pnpm lint` and `pnpm
  test:boundary` pass; web suite 286 tests / 26 files pass; server suite 604 passed, 1 skipped /
  34 files (contract fixtures stable across reruns); `pnpm build` passes with the bundle check
  ("battlefield.ts, fixed.ts, replay.ts"); `pnpm e2e` — trip.spec (with the replay steps),
  smoke, store, town pass; formation.spec fails on the pre-existing flavor-text match above.

## 23. Trip client flow — **M**, after 15, 17, 19

**Status: done** (2026-10-11; QA'd, roadmap/qa/23-punchlist.md S1–S4, D1–D3, N1–N5 closed: de-merges itemized on bank, overrun and summary from contract-recorded bodies, a stale decision leads on, the e2e banks after three encounters). "Watch the fight" opens chunk 22's replay player. Fights resolve with the real resolver since chunk 13 (`CARAVAN_TEST_RESOLVER=double` for predictable e2e). Losses on overrun shown as the server records them
(`lossesApplied`, chunk 19). See ORCHESTRATION.md.

**Goal.** The screens that wrap the primary gameplay screen: outfitting, candidate
selection, the bank-or-push prompt, and the trip summary. Chunk 15 is the server loop,
chunk 08 is the per-encounter arrangement, chunk 17's open question 1 proposes an
outfitting flow. Nobody owns the connective tissue.

**Constraints.**
- **Outfit the caravan**: roster versus `DEPLOYMENT_SLOT_CAP`, trap and fence material
  budgets, trip-cap uses remaining, and a warning if the trip's expected Coin would
  overflow `COIN_STORAGE_CAP` (chunk 16's `COIN_OVERFLOW_BEHAVIOR`). Ends in "ride out".
- **Choose the next encounter**: the three scouted candidates from chunk 14 with the
  reroll timer visible and no Coin reroll anywhere in the UI.
- **Bank or push**, shown only after surviving: unbanked Coin, each surviving unit with
  its HP and the merge level it would drop to on death, each unit that would be lost
  outright, remaining fence segments and traps, and the next encounter's reward and
  Reputation band. This is the single most important legibility screen in the game.
- **Trip summary** on bank or overrun, feeding into chunk 22's results.
- Touch-usable throughout, 44px targets, portrait-first.

**Definition of done.** A new account can go from the town to a banked three-encounter
trip and back without any screen that was not designed. The bank-or-push prompt
itemizes every stake the design names. **From chunk 08 (QA D1):** the commit →
resolution → replay handoff works end to end — committing a formation on the Trail tab
leads to the resolved encounter (chunk 15's loop, chunk 13's log) and its replay (chunk
22) without leaving the flow. Chunk 08 ships the commit and the locked, committed state;
this chunk completes the handoff once 13, 15 and 22 exist.

**QA checks.** Guardrail 4: is there any resource the prompt does not itemize? Guardrail
2: is there any purchasable thing reachable from this flow?

## 24. Onboarding and the first trip — **M**, after 23, 25

**Goal.** Teach the inverted loop in the first five minutes without a wall of text.
The genre convention is the opposite of this game, so a player who skips onboarding
will try to attack someone and find nothing to attack.

**Constraints.**
- The tutorial **is a real trip** with real stakes, against **authored parties** from
  chunk 25, with a guided arrangement at encounter one (place this fence, leave this
  gap, post this unit here, now scout why) and a free arrangement at encounter two.
  The player banks after two. Nothing is simulated differently; the authored parties
  are ordinary standing parties with a non-player owner.
- Region choice happens before the first trip and is explained as permanent.
- The standing party is introduced **after** the first bank, as "while you were out,
  someone else's party met a caravan," with the player's own party pre-filled from the
  starting roster so the passive side is live from minute six.
- Skippable after the first screen for returning accounts. Progress stored on the
  account, not the caravan, so a future second caravan does not retrigger it.
- No tutorial-only Coin grant that exceeds a normal first trip's earnings; onboarding
  must not be a way to front-load the economy.

**Definition of done.** Five fresh testers each complete the first trip and correctly
explain, unprompted, which side they play actively and which side is passive.

**QA checks.** Guardrail 0: does any tutorial copy call the wagon circle a "base" or the
town a "camp"? Does the player ever "attack" anything? Guardrail 3: can the tutorial grant
a unit type outside the starting nodes?

**Status: QA'd, fix round 1 in** (2026-10-11, chunk 24 fixer; punch list `roadmap/qa/24-punchlist.md`, every
item closed). `done` waits on the balance pass's D1 acceptance (the guided first fight held most of the time
with the real resolver; today two fresh real-resolver walks were both overrun at encounter 1). Fix round 1
supersedes two build notes below: **every caravan now starts with `TUNABLES.STARTING_ROSTER`** (granted at
caravan creation through the ordinary ledgered grant, the region's starters only, no Coin, no backfill), so
the refugee step teaches acquisition rather than supplying the only unit; and the bank-or-push card now
**recommends from the server's stakes preview** instead of saying the trip pushes once. migration 019 guards
`account_onboarding` against DELETE; the e2e double overruns an unfenced encounter 1 so the overrun path is
walked end to end.

Build notes (chunk 24 Maker):

- **What the first session is.** Register (the region field now reads "Permanent: chosen once for
  this caravan and never swapped…") → **the first screen** (`onboarding/WelcomeScreen.tsx`, before
  any tab, not skippable): defense is played live on a trip, the standing raid party works while you
  are away and never loses a unit, the town is never raided, "your caravan rides the Desert … permanent
  for this caravan" → **town**: take one refugee from the ordinary free menu → **outfit**: pack it, a
  trap and a fence, ride out → **encounter 1**: search; the scout card names the smallest served party
  (fewest raiders, then least total HP, then menu order — "a reading of the scout, not a promise"); the
  **guided arrangement** (fence the side most raiders start on, leave its middle position open, post the
  unit just inside the gap, lay the trap between, use the rest of the fence; then "now scout why") →
  the **real, server-resolved result** shown as recorded → bank or push (the guide says this first trip
  pushes once; every stake is chunk 23's itemized screen) → **encounter 2**: a free arrangement, no
  list → **bank** → the trip summary → **"While you were out, someone else's party met a caravan"**:
  "Raise my party from my roster" pre-fills the standing party (every unlocked roster unit up to the
  cap, the builder's own defaults) and saves it through the ordinary `PUT /me/party` → the Party tab →
  "Finish the guide". An overrun at either encounter ends the trip honestly: the party card then says
  the caravan was overrun, what was lost and what never was, and to ride out again.
- **Nothing granted, nothing special-cased.** The guide grants no Coin, unit, unlock point or access
  (no tunable needed: there is no grant). The unit comes from the refugee drip the ordinary way, so the
  tutorial can never reach outside the starting nodes (guardrail 3). The fights are ordinary chosen
  candidates from chunk 14's menu, resolved by the server's resolver like any other; matchmaking and the
  resolver are untouched and cannot see the guide. The scouting pick and the arrangement suggestions are
  read off the scout only (`onboarding/arrangeGuide.ts`), every suggested drop goes through chunk 08's
  `placement.ts` (`dropRefusal` = @caravan/circle's `validateFormation`), and the server re-validates the
  commit as for any arrangement.
- **Decision: the starting roster is the first free refugee claim.** A fresh account has 0 units and 0
  Coin (chunk 01/18), and §24 names no starting-roster grant, so the guide does not add one. The first
  trip is therefore one unit + one trap + up to 20 fence segments, and the standing party is pre-filled
  from that roster after the bank. **Known, deliberate (13-punchlist D2):** with the real resolver a
  fresh roster is overrun at band 0 far more often than not today; the guide does not depend on the
  numbers (it never promises a hold, shows an overrun as an overrun, and continues to the passive side
  either way). The balance pass (chunk 37) decides whether band-0 authored outfits or a starting roster
  change; if a starting-roster grant is wanted it needs a §24/PROJECT.md decision and a tunable.
- **Progress on the account (migration 017; 014–016 are other chunks'; renumber on merge if
  needed).** `account_onboarding` (one row per player account; no caravan column, so a future second
  caravan does not retrigger it): `step` ∈ welcome, roster, outfit, scout, arrange, result, free, bank,
  party, done; `skipped_at`; `completed_at`. CHECKs pin the step list and done ⇔ completed; a trigger makes
  it forward-only and a finished guide permanent (tested against `caravan_app`). Registration enrols the
  account at `welcome`; accounts existing before the migration are backfilled `done` (existing players);
  `seed.ts` marks its pre-equipped dev / e2e accounts `done`. Routes (`routes/onboarding.ts`):
  `GET /me/onboarding`, `POST /me/onboarding/advance {step}` (forward-only; earlier / equal = 200
  `changed: false`; unknown = 400 `invalid_step`), `POST /me/onboarding/skip` (409
  `onboarding_first_screen` on the first screen — PHASE-2 §24 "skippable after the first screen").
  No localStorage / sessionStorage anywhere: the client reads the server row once per sign-in
  (`onboarding/OnboardingProvider.tsx`, fail-open: if it cannot be read the guide stays out of the way).
- **Where it shows.** Cards sit in the normal flow above the screen they guide, never over its controls
  (`GuideCard`: a "Guide" label, dashed border, ✓ / ○ per step, "Skip the guide" behind a confirm). Town
  steps are in `ShellGuide` (rendered by `App.tsx` above every tab); it re-reads `/me` and the trip status
  on each tab change and every 3 s while waiting (`GUIDE_POLL_MS`, presentation), and moves the step on
  only from what the server says (a unit in the roster, a trip out, a trip ended). Trail cards live in
  `TrailGuide.tsx`; `TrailScreen` maps its own state to a step (`stepForMoment`) and renders the card for
  it. `FormationScreen` gained one optional prop, `guide`, a render slot under the circle whose edits go
  through the screen's own `setFormation` (so autosave, the budget meter and the commit checks are the
  ordinary ones). `App.tsx` re-keys the Party screen after the guide saved the party.
- **Files outside the chunk's own:** `services/onboarding.ts` (enrol on register), `app.ts` (route),
  `seed.ts` (fixtures done), `FormationScreen.tsx` (the `guide` slot), `TrailScreen.tsx` (cards + step
  mapping), `App.tsx`, `api/client.ts` (three methods; the two hand-written fake `Api`s gained them),
  `strings.ts` (`STRINGS.guide`, the region hint), `theme.css`, `test/migrations.test.ts` (table list),
  `test/contract.test.ts` (+3 recordings), and the three e2e specs that register fresh accounts for
  other purposes (`smoke`, `store`, `town`) now read past the first screen and skip the guide through
  the real routes.
- **Tests.** Server `test/onboarding.test.ts` (7: step list = migration CHECK + rank function; new account
  at `welcome`, skip refused there, no caravan column; forward-only / no-op / 400; skip finishes for good;
  the trigger against the app role; walking every step leaves Coin, units, unlock points and the ledger
  unchanged; no row reads as done). Contract: `onboarding.json`, `onboarding-advance.json`,
  `onboarding-skip.json`, guarded by `onboarding/shapes.ts` (the guard refuses a body whose step list
  differs from the client's). Web: `arrangeGuide.test.ts` (4: main edge / gap geometry; fence → gap →
  post → trap → rest each legal, the final circle passes circle's `validateFormation`; reopening a fenced
  gap; attrition — dead units, spent traps, destroyed segments skipped), `guideModel.test.ts` (6: Trail
  moment → step, when cards show, town facts → step, the smallest-party pick, the party pre-fill never
  past the cap or a locked type, the recorded body's steps), `Onboarding.test.tsx` (10: first screen
  before any tab with the copy checks and no skip and no storage writes; roster → outfit only on the
  server's roster; skip confirm; done → no guide; unreadable → no guide; the guided arrangement on the
  real FormationScreen; an overrun first trip said plainly, then the passive side, nothing saved for an
  empty roster; a banked trip raising the party through the ordinary save; Trail cards + step advance;
  a finished guide shows nothing). E2E
  `apps/web/e2e/onboarding.spec.ts`: registers a fresh account and walks the whole path above to a bank
  after two encounters and the raised party at 360 and 320 px (44 px targets, no sideways scroll, the
  guardrail 0 copy checks on every card), then asserts through the API: guide `done` (not skipped), the
  trip `banked` with decisions `pushed, banked`, one unit in the roster, a valid one-unit party, no
  `coin_purchased` in the ledger, and after a reload and sign-in no guide.
- **Observed results (this branch, after merging roadmap/phase-2-spec at 7063af6).** `pnpm typecheck`
  clean; `pnpm lint` and `pnpm test:boundary` pass; web suite 330 passed / 33 files; server suite 621
  passed, 1 skipped, 3 failed / 36 files: `qa02-round2` (the known job-queue flake, 2) and `qa15-fixes` S4
  (1), both files 31/31 passed rerun alone; `pnpm build` passes (bundle check: battlefield.ts, fixed.ts,
  replay.ts); `pnpm e2e` 7 passed (onboarding, formation, smoke ×2, store, town, trip). A voided first trip
  (chunk 15 QA D3's ending) also moves the guide on to the party step.
- **For QA.** Guardrail 0: grep `STRINGS.guide` — no "base", "camp", and the player never attacks or
  raids (the e2e and component tests check the rendered cards). Guardrail 3: the only unit the guide
  ever sees is one the refugee route granted. §24 DoD ("five fresh testers explain which side is active")
  is a playtest, not something this branch can observe. Known gaps: the e2e runs on the test double (every
  encounter held), so the real-resolver overrun path is covered by the component test (recorded overrun status) only; the
  first screen briefly shows the town while the guide state loads (fail-open by design).

## 25. Cold-start content: authored standing parties — **M**, after 09, 14

**Goal.** A pool that is never empty. Chunk 14 names an authored fallback; this chunk
authors it. Without this, the first thousand players meet an empty pool and the
content engine never starts.

**Constraints.**
- At least **12 authored parties per Reputation band** across the full `REPUTATION_FLOOR`
  to expected-ceiling range, owned by system accounts that are flagged as non-player in
  the schema but are **the same object type** as any other party. Matchmaking must not
  special-case them, and the resolver must not be able to tell.
- Authored parties cover every stance, every siege piece, every region's roster, and
  every approach-edge pattern, so onboarding and early play show the full mechanical
  vocabulary.
- Coin a caravan loses to an authored party is **destroyed**, not banked to a system
  account; Coin an authored party would "earn" is not minted. Reputation shifts apply
  to the player only.
- Authored parties are **retired by ratio**, not by date: when live parties in a band
  exceed a tunable share, authored ones are weighted down. `AUTHORED_PARTY_MAX_SHARE`
  default 30% of served encounters per band, tunable.
- Authored parties get updated with each content drop (chunk 41) so new siege and units
  appear in the pool before players have built them.

**Definition of done.** A fresh database with zero players serves three distinct, fully
scoutable candidates at every band, and the resolver's inputs for an authored encounter
are indistinguishable in shape from a live one.

**QA checks.** Guardrail 1: is the authored pool selection seeded from stored state? Is
an authored party indistinguishable to the resolver and to matchmaking's draw (same row
type, same snapshot shape, nothing in the resolver input marks it), while being **visibly
labelled to the player** (`owner.authored: true` and the outfit's name on the candidate;
legibility beats disguise — chunk 14 QA D3 amended the original "can a player tell an
authored party from a live one" check to this)?

**Status: built** (2026-10-11). 96 authored parties — 12 per display band, bands 0–7
(`REPUTATION_FLOOR` 100 to `AUTHORED_REPUTATION_CEILING` 2200, both tunables; the band
list is derived, never written down) — owned by `sys_outfit_<slug>` system accounts, each
an ordinary standing party whose types were reached through the unlock web the ordinary
way (ledger rung grants + `spendUnlockPoints`; no bypass). Every region, stance pattern
and 1/2/4-edge split per band; every siege piece and every living type across the set;
merge level, size, tier and siege rising with the band. Named outfits with one-line
flavour (`apps/server/src/matchmaking/authoredOutfits.ts`). Retire-by-ratio in two
stages: chunk 14's draw-pool cap, plus the served-encounter share per band over a
rolling window of chosen candidates (`AUTHORED_SERVED_SHARE_WINDOW` 40,
`AUTHORED_OVER_SHARE_WEIGHT_BP` 2500), counted from `encounter_candidates`, stored on
the menu row, replayable. System accounts: login refused, `is_system` permanent
(migration 011 trigger), prefix reserved at registration, zero Coin, every credit path
refuses (`SystemAccountCreditError` + ledger trigger). `seedAuthoredParties` is
idempotent and versioned (`AUTHORED_SET_VERSION`, `authored_party` table) and updates a
changed party in place. Closes chunk 14 QA B1, B2, S4, S5, N1, N2. See ORCHESTRATION.md.
QA round 1 (`roadmap/qa/25-punchlist.md`) closed: authored parties that FILL a menu come
seeded from the `AUTHORED_FILL_NEAREST_N` (6) nearest the centre (cold-start fairness, D1/D2),
the served-share weight applies to the authored count actually eligible (S3), menus store
their band, draw rules and weighted flag (S4, N2) and only the pool the draw could pick (S5),
authored rosters are ledger events (D3), and no account id reaches the client (D4).

## 26. Art and animation asset pipeline — **L**, parallel with 08, lands before 17

**Goal.** The isometric art the renderer draws. Chunk 08 builds the renderer with
placeholders; nobody owns the assets or how they get into the build.

**Constraints.**
- Asset list, derived from chunk 03's roster: 32 living-unit types × 5 merge levels
  (level shown by a badge and tint, not 160 distinct sprites), 6 traps in laid and
  spent states, 5 siege pieces, 4 fence tiers in intact and broken states, the caravan
  core, 4 regional palettes for units, one island-with-tiers set for the circle, one
  town set with the mine, merge board, and buildings.
- Animations per unit: idle, walk (8 directions, isometric), attack, death, and **one
  ability cue per archetype** (six total, reused across the roster). Ability firing must
  be visibly distinct from an attack, since chunk 12 makes it a beat in the fight.
- Sprite atlases generated by a repeatable script from source files checked into a
  separate assets repo or LFS; the build never hand-edits atlases.
- A **budget**: total first-load payload for the town under 8 MB on a cold cache,
  battle scene under 4 MB additional, enforced in CI.
- Cosmetics (chunk 28) hang off this pipeline as alternate skins; the pipeline must
  support a skin layer from the start, keyed by unit type, that the resolver never sees.
- Indigenous representation: PROJECT.md §20 flags that any such content needs deliberate
  research. v1 unit art stays within settler, outlaw, frontier-industry, and animal
  archetypes unless and until that research is done and reviewed.

**Definition of done.** Every type in `packages/content` has an asset entry, missing
assets fail the build, and the payload budget passes.

## 27. Audio and haptics — **S**, after 26

**Goal.** Fight feedback and ambient sound. A silent mobile game feels broken.

**Constraints.**
- Event-driven from the replay log: trap fires, fence breaks, ability fires, death,
  core reached, bank, overrun. Every cue is triggered by a log record, so audio is a
  view of the log like everything else.
- Ambient loops for town, trail, and battle; distinct per region palette.
- Haptics on mobile for place, merge, and the overrun moment, via the web Vibration
  API under PWA and the native bridge under chunk 34.
- Mute and independent music/effects sliders, persisted on the account.
- Total audio payload under 3 MB, streamed after first paint.

**Definition of done.** A replay watched with sound and without conveys the same
sequence of events.

## 28. Cosmetics as a system — **M**, before 20

**Goal.** Chunk 20 sells "limited-release cosmetics that rotate weekly" and no chunk
defines what a cosmetic is, where ownership lives, or how one is equipped. Build the
system before the storefront that sells into it.

**Constraints.**
- Cosmetic kinds, all purely visual: **unit skins** (per living-unit type, applied to
  all instances of that type), **wagon and core skins**, **fence styles**, **town
  decorations**, and **party banners** shown on the scouting screen and in the results
  feed.
- Ownership is **account-level** (guardrail 5): a skin for a unit type is owned by the
  account and shows on any caravan that has the type.
- Equipping is a client-side preference stored server-side; the formation, manifest,
  party, and resolver input types **cannot carry a cosmetic field**, enforced by a type
  test. Chunk 20's "structurally incapable of affecting stats" is satisfied here.
- A banner or skin must not change silhouette, hitbox-sized footprint, or
  readability of the type, stance, or ability on the scouting screen. Each skin ships
  with a review note confirming the type is identifiable at scouting zoom.
- Rotation catalog: a deterministic weekly schedule of which cosmetics are on offer,
  identical for all players, previewable one week ahead. Retired cosmetics may return;
  the schedule says when.
- No cosmetic is ever earned from a fight outcome in v1. Group B may add cosmetic-only
  rewards for seasons and contracts.

**Definition of done.** Equipping a skin changes nothing in any resolver input or log.
The storefront in chunk 20 reads from this catalog and nothing else.

**Status:** minimal system built in chunk 20 (2026-10-11) — catalog + deterministic rotation in
`packages/content/src/cosmetics.ts`, account-level `cosmetic_ownership` / `cosmetic_equip`
(migration 010), `/me/cosmetics` routes, and the type + runtime test
`packages/circle/test/no-cosmetic-field.test.ts`. Art for each entry is chunk 26's.

**QA checks.** Guardrail 2: grep every resolver input type for any field a cosmetic can
reach. Scout a party with every banner and every skin and confirm nothing is harder to
read.

## 29. Notifications and return hooks — **M**, after 09, 15, 18

**Goal.** Close the asynchronous loop. The passive side's entire feedback is "check
afterward where it struck", and today nothing tells the owner to check.

**Constraints.**
- Server-side event subscriptions on the ledger (chunk 02) for exactly these:
  **your party struck a caravan** (held or overran, with the replay link), **refugees
  arrived** (drip refreshed), **trip cap refilled**, **mine near cap** (trickle about to
  stop), **weekly packs rotated**, and in group B, season and contract events.
- Delivery via web push under PWA and native push under chunk 34, with an in-app inbox
  as the fallback and the record.
- Per-category opt-out, defaulting on for party strikes and off for everything else.
  Nothing here is a Coin sink and nothing sells a faster timer.
- Batched: a party that strikes ten times in an hour sends one notification with a
  count, not ten.
- The notification must not leak the attacked player's identity beyond what the
  results feed already shows.

**Definition of done.** A party owner who has not opened the game learns within a
minute that their party overran a caravan, and one tap lands on the replay.

**Status: done** (2026-10-11; QA'd, roadmap/qa/29-punchlist.md S1–S4, D1–D2, N1–N9 closed: "Mark all read" sends what is on screen, a batch's version follows its late credits, long names wrap at 320 px, the read is 6 queries / ~20 ms for a 25k-strike owner with lines only for the newest 3 batches, the list ends with a pointer to the feed for what it leaves out, and the strike path is tested on the production worker with the settle hooks and the real resolver) — the in-app inbox; device push deferred (below). Build notes:

- **Derived, not stored.** `apps/server/src/inbox/` (`derive.ts` pure, `service.ts` reads, `tunables.ts`).
  Items are computed on every read: **party strikes** from the ledger (`party_served_as_encounter`
  on the owner plus the owner-side events of the same resolution under `<job>`, `progression:<job>`,
  `transfer:<job>` — the results feed's own join; each listed line is read through `listPartyFeed`),
  **refugees arrived** from the current `refugee_menu` row's grid (a free menu is owed), **trip cap
  refilled** from `trip_cap.tat_ms` (every use back), **mine near cap** from `peekTrickle` (read-only;
  balance incl. pending ≥ `INBOX_MINE_NEAR_CAP_PERCENT` = 90% of the storage cap), **packs rotated**
  from `weekIndexAt` (only a week that began after the account existed). A notice therefore cannot
  disagree with the ledger or the timer it reports. Nothing in the module writes the ledger,
  materializes the trickle, bootstraps / takes a refugee menu or touches a trip (a test greps it).
  Season / contract events wait for group B.
- **Migration 015** (`015_inbox`): `inbox_read (account_id, item_key, version)` —
  the only stored state besides `inbox_preference (account_id, category, enabled)`. Read state is UI
  state, deliberately not a ledger event. Each item has a stable KEY and an integer VERSION (strike
  batch: newest seq; refugees / trip cap: the instant; mine: one per stretch between spends, keyed
  by the last spend's seq; packs: per week; QA S2: a strike batch's version is the newest seq among its strikes AND
  the credits / progression they caused, so a late settle re-opens it). Unread = no mark at the item's version. A strike landing
  in an already-read batch makes the batch unread again. Marks only move forward (trigger
  `inbox_read_forward_only`, plus `GREATEST` in the upsert; QA N3: migration 018's `inbox_read_guard_delete` refuses
  DELETE while the account exists); the server stores min(version the client saw, current version), so a stale or
  inflated mark can neither hide nor pre-read a new strike; keys the account's inbox is not showing are skipped and
  listed in `ignored` (QA N4; nothing stored, so no arbitrary rows), and a key sent twice is folded (QA N2). CHECKs on
  key shape, non-negative version and known categories. Proven against `caravan_app`: decrease and key
  change refused, TRUNCATE / DISABLE TRIGGER / DROP TRIGGER denied (42501).
- **Batching** (§29): strikes group into fixed `INBOX_STRIKE_BATCH_WINDOW_MS` (1 h, epoch-aligned)
  windows, ONE item per window with the count, held / overran / stalemate split and the Coin (incl. the
  transferred and cap-discarded parts), Reputation and ladder totals — SQL sums over every strike in
  the window, not just the listed ones. The newest `INBOX_STRIKES_PER_ITEM` (10) are itemized, each
  with its own "Watch the fight"; the rest are counted with a pointer to the results feed. Horizon
  14 days (from a window start, so no batch is split: QA N1), at most 30 batches; past those, `olderStrikes`
  and a closing line point to the results feed (QA D2). QA S4: one statement picks the 30 windows (partial index
  `ledger_event_party_served_at_idx`, migration 018) before joining their credits; only the newest
  `INBOX_ITEMIZED_BATCHES` (3) carry lines, read by time window in one query and built by the feed's own
  `partyFeedEntries`; an older batch fetches its lines from `GET /me/inbox/strikes/:window`. All TUNABLE, in `inbox/tunables.ts` (presentation knobs, not balance —
  same decision as chunk 02's job knobs).
- **No identity leak.** A strike line carries exactly what the results feed shows of the defender —
  username, caravan name, region — picked field by field; not the account id (the ledger payload's
  `defenderAccountId` is never read) and not even the caravan id. The web guard (`inboxShapes.ts`)
  REFUSES a defender with an `accountId`, so a server regression fails loudly, not silently.
- **Per-category opt-out** with the §29 defaults (strikes on, everything else off). An off category is
  not listed and not counted in the badge. Free, instant, server-side.
- **Never nags toward spending.** No item links to the store or a spend; the mine and pack notices
  state facts and have no button; the pack copy says the Coin per tier never changes. The web test
  asserts the whole screen's text has no buy / purchase / spend / deal / offer / sale / store / $ /
  hurry wording and the mine / packs cards have no buttons.
- **Routes:** `GET /me/inbox`, `GET /me/inbox/unread` (the badge; same derivation without the
  per-strike lines), `GET /me/inbox/strikes/:window`, `POST /me/inbox/read` (`{marks: [{key, version}]}`, ≤ 100;
  `{all: true}` is gone — QA S1: "Mark all read" sends the unread items on screen),
  `PUT /me/inbox/preferences` (`{preferences: {<category>: boolean}}`). Registered in `app.ts`.
- **Client.** Header button "✉ Inbox" with the server's unread count as a text badge and in its
  accessible name (`shell/InboxButton.tsx`), polled every `INBOX_POLL_MS` (60 s, TUNABLE) while the
  page is visible, on every route change and on becoming visible; the Inbox screen publishes the
  server's count after a mark or a preference change through an in-memory signal
  (`shell/inboxSignal.ts`). New route `#/inbox` (lazy `screens/inbox/InboxScreen.tsx`; no tab is
  current on it). "Watch the fight" is chunk 22's `WatchFight` (owner view, decided by the replay
  route), and tapping it marks the batch read. Strings in `STRINGS.inbox`; 44 px targets; fits 320 px;
  no storage.
- **Deferred: device push.** §29 asks for web push under a PWA and native push under chunk 34, "with an
  in-app inbox as the fallback and the record". There is no service worker, manifest or VAPID setup
  yet, so this chunk builds the inbox (the record) and the `delivery: "in_app"` field says so; the
  screen tells the player nothing is sent to their device. The DoD's "a party owner who has NOT opened
  the game learns within a minute" therefore holds only for an owner with the app open (60 s poll);
  a closed app learns on next open. Push delivery should hang off `readUnread` / the strike batches
  (the batching and opt-out are already server-side) when the PWA / chunk 34 lands.
- **Tests.** Server `test/inbox.test.ts` (21): pure derivation (batching, unread-by-version, each
  timer), two real double-resolved strikes (held + overran) = one item whose totals equal the feed's,
  per-line Coin equals the feed's per job, no defender account / caravan id anywhere in the body, the
  replay route answers the owner for every listed job, defender's inbox has none, read / re-open /
  stale-mark / clamp, unknown-key and malformed-body refusals, ten strikes → one item counting ten,
  opt-out / opt-in, each timer category (read-only: no menu written, no ledger row), the caravan_app
  guards, a source grep. Contract (`contract.test.ts`): `inbox.json` (the real-resolver strike, owner
  view), `inbox-unread.json`, `inbox-read.json` (mark-all), `inbox-preferences.json` (refugees, trip
  cap, mine on the player's account two hours on); keys / versions renamed by position so reruns are
  byte-identical (verified). Web: `inboxShapes.test.ts` (4, incl. the accountId refusal),
  `InboxScreen.test.tsx` (8: copy, Watch → replay dialog + read mark, mark one / all with the badge
  following, the timers without selling, prefs, Retry, the badge's polling / 99+ / failure / route).
  E2E `e2e/inbox.spec.ts`: a fresh owner with two fixture strikes (ledger rows in the handler's shape,
  inserted as the app role like smoke.spec's grant) sees badge 1, reads the batch, fits 360 / 320 px,
  Watch the fight opens the replay dialog (the fixture job has no stored fight, so the player shows
  its not-found state) and marks it read on the server, opt-out empties and opt-in restores.
- **Observed results (this branch).** `pnpm typecheck` clean; `pnpm lint` and `pnpm test:boundary`
  pass; server suite 625 passed, 1 skipped / 35 files; web suite 314 passed / 29 files; `pnpm build`
  passes (bundle check: battlefield.ts, fixed.ts, replay.ts); `pnpm e2e` 7 passed (inbox, formation,
  smoke ×2, store, town, trip).
- **For QA.** The mine notice's `occurredAt` is presentational (the crossing instant is computed for
  pending trickle, else the last credit). A spend that leaves the balance above the line starts a new
  mine notice (default off). `inbox_read` rows for expired keys are not pruned yet (bounded by the
  14-day horizon's items per account). Small wiring in shared files: `app.ts`, `client.ts`,
  `AppShell.tsx`, `router.tsx`, `App.tsx`, `townFixtures.ts` / `FormationScreen.test.tsx` fake apis,
  `migrations.test.ts` table list, `contract.test.ts` (appended at the end).

## 30. Account lifecycle — **M**, extends 01

**Goal.** Chunk 01 ships a minimal login. A store-listed game needs the rest.

**Constraints.**
- **Guest-first**: an account is created silently on first launch and can be played
  for the whole tutorial without a sign-in. Linking to Apple, Google, or email later
  keeps the same account id; nothing is migrated.
- Sign in with Apple is mandatory for iOS when any third-party sign-in is offered.
- **Deletion** on request, within the platform-required window, deleting the account,
  its caravans, its party, and its purchase records, and **anonymizing** its side of
  encounter logs rather than deleting them, since the other participant owns their
  replay too.
- Data export as JSON on request.
- Session revocation, device list, and rate-limited login.
- Region choice remains one-time per caravan; no account-level path to change it.

**Definition of done.** Guest → linked → deleted round-trips cleanly and leaves the
other participants' replays playable.

**Status: built** (2026-10-11, chunk 30 Maker; play-test cut: username + password is the only
link, no Sign in with Apple / Google until chunk 34). Migration **020** (`020_account_lifecycle`, renumbered from 019 on merge;
018 is chunk 29's; renumber on merge if needed). Build notes:

- **Guest-first.** `account.username` / `password_hash` are nullable *together* (CHECK); a guest is
  an ordinary account row created by `POST /auth/guest {region, caravanName?}` with the same hub rows,
  onboarding marker and first caravan registration makes (`services/onboarding.ts createAccountHub`),
  so the whole chunk 24 tutorial plays as a guest. `POST /me/account/link {username, password}` sets
  both on THAT row: the id never changes, nothing is migrated. `account_guard_identity` makes a linked
  username permanent (no unlink, no rename) and stamps `linked_at` once; a system account can never be
  linked. Registration still exists and is "linked from birth".
- **Decision — the region is on the guest's first screen.** "Created silently" is read as *no sign-in
  prompt*, not *no choices*: the start card asks for the region only (with the permanence hint) and one
  tap makes the account. Rejected: a default region chosen for the player — region is a one-time,
  never-swapped choice per caravan (GUARDRAILS §5), so choosing it silently would take that choice away.
  There is still no account-level path to change a region.
- **Decision — how a guest survives a reload: a server-set HttpOnly device cookie.** Every sign-in
  (guest, register, login) creates a `device` row: 32 random bytes in the cookie `caravan_device`
  (HttpOnly, SameSite=Strict, Path=/, Secure under https / production, Max-Age = `DEVICE_TTL_MS` 180 d,
  sliding), only its sha256 stored. `POST /auth/resume` trades it for a fresh bearer session tied to
  the device (≤ `DEVICE_SESSIONS_MAX` 3 per device, ≤ `DEVICES_PER_ACCOUNT_MAX` 10 per account). The
  page never reads or writes it and nothing goes into localStorage / sessionStorage; the bearer token
  stays in memory. Game routes authenticate by the bearer header only, so the cookie riding along on
  them authorizes nothing (no CSRF surface); it is honoured only by `/auth/resume` and `/auth/logout`.
  The cookie value is not rotated on resume (two tabs resuming at once must not lock a guest out).
  Rejected: browser storage (forbidden for game state); a long-lived bearer in a JS-readable cookie
  (XSS-exfiltrable). A guest's sign-out needs `{abandon: true}` (409 `guest_sign_out` otherwise) and
  revoking a guest's own current device is refused — either would lose the account.
- **Devices / sessions.** `GET /me/devices`, `DELETE /me/devices/:id`, `POST /me/devices/revoke-others`,
  and `GET /me/account` (account, devices, deletion terms). Labels are "Browser on Platform" from the
  User-Agent; no IP is stored. Pre-019 sessions are backfilled one device each; a session inserted
  without a device gets one (`session_ensure_device`, token hash `bare:<id>` no cookie can match).
- **Rate limits** (`src/account/tunables.ts`, TUNABLE, in-memory fixed windows per process; the CURRENT numbers are `TUNABLES.ACCOUNT_RATE_LIMITS` — raised in the QA-30 fix round, and since the final review D2 password failures count per (username, address) with a per-username backstop; the figures below are the original build's): login
  20 / 15 min per IP and 10 / 15 min per username tried; registration and guest creation 10 / h per
  IP; resume 120 / 15 min per IP; link 10 / 15 min, export 5 / h, delete 10 / 15 min per account. 429
  `rate_limited` with `retryAfterMs` + Retry-After. `CARAVAN_RATE_LIMITS=off` (vitest env, `pnpm e2e`)
  is refused under NODE_ENV=production. Hand-off: a multi-instance deploy needs a shared store, and the
  per-IP key needs Fastify `trustProxy` behind a reverse proxy.
- **Export.** `GET /me/export` (attachment): the account, its caravans (progress, units, trips, trip
  encounters), account pools, town, party, onboarding, inbox preferences, purchases, cosmetics, devices,
  the encounters it took part in (job id, role, outcome kind) and its own ledger. Never a password or
  token hash; any `*AccountId` / `*CaravanId` / `*_account_id` value that is not this player's own is
  replaced by `"other_player"`.
- **Deletion: `account_erase(account, bearer_token)`** (SECURITY DEFINER, the one audited path;
  `POST /me/account/delete {confirm: "delete my account", password?}` — the password once linked, 403
  `wrong_password` / `password_required` so a typo never signs anyone out). It deletes the account and
  everything only it owns by the existing cascades — caravans, roster, party, purchases and cosmetics,
  sessions and devices, trips, its unshared jobs and replays, inbox read marks and preferences (chunk 29,
  015/018: `inbox_read`'s delete guard allows exactly the account cascade), the onboarding marker (017)
  — and ANONYMIZES what it shares: a fight it defended against another player's party, and a fight its
  party struck against another player's caravan (any status: a queued fight still resolves and settles,
  against a system owner, so nothing is credited), other accounts' ledger payloads, other players'
  `trip_encounter` rows and stored candidate menus. The rewrite rule (`account_erasure_walk`) maps exact
  string values / keys equal to the account id or its caravan ids to the shared **tombstone** (system
  account `…00d0`, caravan `…00d1`, created lazily with progress rows, no party, never served, no login,
  no Coin) and a menu's `displayName` equal to the username to "Departed outfit". Feeds show such a
  strike with no name. Every erasure writes `account_erasure_audit` (when, guest or not, row counts —
  never the id or username; append-only, not account-scoped, listed in the per-file reset's exempt set).
- **How the guards allow it.** The UPDATE guards of `ledger_event`, `resolution_job`, `encounter_log`,
  `trip_encounter` and `encounter_candidates` gained one first test, `account_erasure_permits(OLD, NEW)`:
  true only while `account_erasure_active` holds a row for `txid_current()` — written only by
  `account_erase`, removed before it returns, not writable by `caravan_app` — AND the new row is exactly
  the rewrite of the old one (whole-row jsonb compare). Otherwise the original body runs unchanged; even
  the owner role cannot edit outside an erasure, and inside one only the exact rewrite passes. The app
  role still has no UPDATE/DELETE on `encounter_log`.
- **What the caller proof does and does not do (corrected in the QA-30 fix round, S1).** `account_erase`
  takes the caller's RAW bearer token and checks a live session of that account with `token_hash =
  sha256(token)`. The server role ISSUES sessions, so no database check can stop a fully compromised
  server from minting a session and erasing with it; the earlier claim that it could was wrong. What the
  check does guarantee: a BUG that passes the wrong account id is refused, because that call carries no
  live token of that account. Since 024 sessions come from one audited path, `session_issue()` (SECURITY
  DEFINER, hashes inside the database); the app role has no INSERT or UPDATE on `session` (UPDATE of
  `last_used_at` only), and no DELETE on `account` / `caravan` (S3), so `account_erase` is the only way an
  account leaves.
- **Decision — the account's own ledger rows are deleted**, by the cascade the append-only guard already
  allows (the owner is gone). Exception: its *non-projecting* record of a shared fight (`encounter_resolved`
  / `party_served_as_encounter` / `stop_resolved` under the kept job's causation) moves to the tombstone,
  rewritten, so the job's events stay contiguous and `verifyJobReplay` still holds on the anonymized input.
  Other accounts' projections fold only their own events, so their balances are untouched (tested:
  `verifyProjection` for every other participant). Not rewritten: trip ids (inside job ids and ledger
  causations) and standing-party ids (inside menus sorted by party id): random ids that name nothing once
  the rows are gone.
- **Decision — the tombstone retention floor.** Kept replays of deleted defenders all live on the one
  tombstone caravan, so LOG_RETENTION's "newest 50 per caravan" floor is shared by every deleted player's
  kept fights; the 30-day floor is unchanged. Accepted: the floor exists for the defender, who is gone.
  **Chunk 36 coordination:** compaction is assumed to keep rows in `encounter_log` (or a sibling keyed by
  `job_id` with the same two account columns); the rewrite is whole-row, so a compacted row is anonymized
  the same way. A new table that copies account ids must be added to `account_erase`'s list; the test
  "no row in any table still names the deleted account" scans every table and fails if one is missed.
  Chunk 32: no analytics table existed on main when this was built; nothing to chase.
- **Client.** `LoginScreen` leads with the guest start card (sign-in and register below, unchanged);
  `SessionProvider` resumes on launch and once more after a 401 (≤ 3 per load; default on with the real
  fetch, off for an injected test fetch unless asked); the header shows "Guest" and an Account button
  (no one-tap sign-out for a guest); `#/account` = `AccountScreen` (link, devices, export download,
  sign-out / leave-guest confirm, delete with typed phrase). Strings in `strings.ts` `auth` / `account`.
  The `account` guard's `guest` is optional so pre-30 fixtures read; the server always sends it.
- **Tests.** Server `test/account-lifecycle.test.ts` (28): guest creation and cookie flags, resume
  (none / forged / expired), device session caps, link (same id, permanence, refusals, DB guards), devices
  and sign-out, labels, rate limits, export, the DoD round trip with the real resolver (both replays render,
  `verifyJobReplay`, `verifyProjection`, feeds, all-tables scan, audit, inbox / onboarding gone), a party
  owner erased with a fight still queued, a never-linked guest, and the app-role guard proofs. Contract:
  `auth-guest`, `auth-resume`, `account-guest`, `account-link`, `account`, `devices`,
  `devices-revoke-others`, `export`, `account-delete`. Web `AccountScreen.test.tsx` (10). e2e
  `e2e/account.spec.ts`: guest first launch → reload → link → reload → sign out → sign in, same id.
  `formation.spec` and `onboarding.spec` signed in again after a reload (v1: a reload signed out); a
  reload now stays signed in, so those two re-sign-ins were removed. The export's store rows are read
  through `src/store/export.ts` (store-guards: only src/store reads the store's tables). The identity
  guard keeps `account.id` immutable only (tests backdate `created_at`).

**QA fix round** (2026-10-11, roadmap/qa/30-punchlist.md; migration **024** `023_account_lifecycle_hardening`,
provisional number):
- **S2 temp-table shadowing (project-wide).** `db/roles.sql` revokes TEMPORARY on the database from PUBLIC and
  `caravan_app`. 024 pins `search_path = pg_catalog, public, pg_temp` on EVERY function in schema public by a
  catalog loop (guards, SECURITY DEFINER writers of 002/016/020/022, helpers), and the two invoker functions
  the guards call read `public.account_erasure_active`. Deviation from "schema-qualify every table each
  reads": with the path pinned and pg_temp last, an unqualified name resolves to `public` before any temp
  object, which is exactly what qualification would buy (the PostgreSQL-documented fix for definers);
  rewriting the bodies of ~50 functions across six migrations would add risk and merge conflicts for no
  further protection. The test enumerates `pg_proc` and fails on any function, present or future, without
  that exact setting, and a behavioural test shadows `account_erasure_active` and `session` (as the owner,
  who can still create temp tables) against the guards, `account_erasure_permits` and `account_erase`.
- **S4 multi-tab / failed resume.** `DEVICE_SESSIONS_MAX` 3 → 10, evicting least recently USED
  (`session.last_used_at`, refreshed at most once a minute; a session used in the last 5 minutes is kept
  first). The client counts parallel 401s on one token once and re-resumes at most 3 times per rolling
  minute; a resume that fails with anything but 401 shows a retry card, never the start screen.
  `/auth/guest`, `/auth/register` and `/auth/login` answer 409 `guest_on_device` when the request carries
  a live guest's device cookie; the client asks ("continue the guest caravan" / "delete it and …"), and
  `replaceGuest: true` ERASES the old guest (reason `guest_replaced`) once the new sign-in succeeded.
- **D1** a non-blocking "Save your progress" card for guests in town and on the end-of-trip summary.
- **D2** "Leave and delete this guest account" erases through `account_erase` (reason `guest_left`), the
  copy says so; `account_erase_expired_guests(limit)` erases guests with no live device or session for
  180 days (reason `guest_expired`; hand-off: chunk 36's scheduled sweep should call it).
- **D3** `TRUST_PROXY` (off; a hop count or proxy addresses/CIDRs; "true" refused); the limits moved to
  `TUNABLES.ACCOUNT_RATE_LIMITS` (100 guest starts and 100 registrations per address per hour, 200 logins per
  address and 10 per username per 15 min, plus 20 per device); limits are per process (AGENTS.md).
- **D4** the export covers every account-owned table (analytics id and client events, manifests,
  formations, refugee menus, trip cap and uses, inbox marks, its own trip menus, replay summaries), redacts
  by an allowlist of the account's own ids (any other UUID, even inside a job id, becomes "other_player"),
  and is refused above `EXPORT_MAX_BYTES` (20 MB, 413 `export_too_large`).
- **D5** the all-tables scan also gunzips every stored replay; the e2e runs guest → linked → deleted; the
  deleted notice is shown; client tests for failed resume, parallel 401s and five tabs.
- Nits: N1 (the dashboard no longer counts the tombstone as authored), N2 (menus narrowed by a GIN index;
  the ledger scan stays — see the punch list), N3, N4, N5, N7 closed; N6, N8, N9 recorded as accepted / hand-offs.

## 31. Integrity and anti-abuse — **M**, after 14, 19

**Goal.** The economy transfers Coin between accounts on an overrun. That is the
single most abusable mechanic in the design, and the roadmap has no chunk for it.

**Constraints.**
- **Alt-feeding**: a player drives their own caravan into an alt's party to transfer
  Coin. Self-exclusion in chunk 14 covers one account. Add device, payment-instrument,
  and network heuristics to a **soft-link score**; linked accounts are excluded from
  each other's matchmaking like self. Never ban on the heuristic alone; exclude and flag.
- **Reputation shaping**: a player edits their standing party to something trivially
  beatable to tank their own Reputation and farm easy encounters. Chunk 04's rating gap
  scaling blunts the reward; add a floor on Coin earned per encounter against parties
  whose Reputation is far below the caravan's, so sandbagging pays less than playing.
- **Client trust**: every placement, merge, purchase, and acquisition is already
  server-validated chunk by chunk. This chunk adds **request rate limits** per route and
  replay-attack protection on purchase and acquisition endpoints.
- **Audit**: an admin view (chunk 33) of Coin flow between any two accounts over time.
- No shadow mechanics. Exclusion and earn floors are visible in the tunables registry
  and are identical for every account.

**Definition of done.** A scripted alt-feeding loop on staging is excluded from
matchmaking within three encounters and nets less Coin than honest play over the same
time. The tunables involved are previewable.

**QA checks.** Guardrail 2: does any integrity rule read purchase state to decide
anything about matchmaking or earnings? It must not.

## 32. Telemetry and balance instrumentation — **M**, before any external playtest

**Status: QA'd — fix round 1 closed** (2026-10-11; `roadmap/qa/32-punchlist.md` S1, S2, D1–D6 and N1–N9 closed as the orchestrator decided; migration `024_telemetry_sessions`, renumber on merge). Build notes (chunk 32 Maker), then the fix round's:

- **Migration 021** (`021_telemetry`; renumbered 018 → 020 → 021 on merges, since main's 018–020 are
  taken — renumber again on merge if needed): `account_admin (account_id, granted_by, granted_at)` — the admin flag, one row or none per
  account, kept off `account` so no `SELECT *` a player route reads can carry it;
  `account_analytics (account_id, analytics_id, opted_out)` — a RANDOM opaque id (never derived from
  the account id; immutable by trigger) and the opt-out; `analytics_client_event (analytics_id, kind,
  screen, error_name, stack_hash, occurred_at, received_at)` — closed vocabularies enforced by CHECK
  (screen `^[a-z_]{1,24}$`, error class `^[A-Za-z]{1,24}$`, stack hash 8 hex, crash ⇔ class + hash,
  never in the future). Rows cascade from the account through `account_analytics`, so chunk 30's
  deletion has nothing to chase. Plus eight indexes for the aggregates (ledger_event (event_type,
  occurred_at) and (account_id, occurred_at), trip (ended_at), trip_encounter (settled_at),
  refugee_menu (created_at), pack_purchase (purchased_at), account (created_at) of players). No
  encounter_candidates (chosen_at) index: it pulled the matchmaker's served-share query off chunk
  25's band index (qa25-scale caught it); the pool-health served query instead walks that band
  index once per band (`generate_series(0, max(band))` × a LATERAL subquery fenced with `OFFSET 0`,
  so the planner keeps the per-band index range rather than a merge join over a full scan).
- **Cascade.** account_admin and account_analytics reference account ON DELETE CASCADE, and
  analytics_client_event references account_analytics (analytics_id) ON DELETE CASCADE, so
  `DELETE FROM account` (main's per-file test reset, chunk 30's deletion) leaves no analytics row;
  `telemetry.test.ts` deletes an account and checks both tables.
- **Admin access.** `db/roles.sql` revokes INSERT/UPDATE/DELETE on `account_admin` from
  `caravan_app` (SELECT only; guarded by `to_regclass` so the script applies below 021), so no route
  — and no bug in one — can grant admin. The flag is set by the operator CLI
  `pnpm --filter @caravan/server admin grant <username> [--by <label>] | revoke <username> | list`
  (`src/admin.ts`, built to `dist/admin.js`), which connects with `MIGRATE_DATABASE_URL` (owner).
  `/admin/*` answers **404** `not_found` to no token, a bad token and a non-admin (never 401/403);
  `GET /admin/dashboard?days=1..120&week=<pack week>` is the only admin route and only reads.
- **Server-side analytics** (`src/analytics/queries.ts`, assembled by `dashboard.ts`): derived from
  the ledger and the tables play already writes; nothing new is tracked server-side. Panels: trip
  length (encounters settled per ended trip × end reason), bank versus push by encounter index (with
  stalemates), overrun rate by the caravan's Reputation band (its living rating at search time, the
  matchmaker's `bandOf`), unit pick and win rates for posted units (win = held) and for raiders in
  served parties (win = overrun; live vs authored), trap and siege usage, posts by stance, slot fill
  (posted / raiders / traps / fence segments per encounter with held rate), fight length against the
  tick cap, ladder rungs now and gained, unlock-node purchases, merge spend per day and per level,
  Coin spent by reason, refugee menus per day (free / reroll / claimed), Coin by source with what the
  cap discarded, storage-cap pressure, trip-cap pressure (starts that took the last use), the
  **grind-wall probe** (free weekly Coin per active-player decile — active = started a trip that
  pack week — against `WEEKLY_PAY_CEILING`, with paid Coin and payers per decile), the pack funnel
  (opened the game → opened the store (screen flow) → reserved / settled per tier), session length
  (screen events split by a 30-minute gap), day-1/7/30 return (cohort = players created in the last
  90 days; a return is one of the account's OWN ledger actions or a screen event in
  [created + N d, created + N+1 d)), screen views, crash reports, and **pool health** (live vs
  authored servable parties per band of the owner's siege Reputation, caravans per band, served
  authored share in the window, and an alarm per band: `empty` below CANDIDATES_PER_SEARCH parties,
  `no_live` authored only, `authored_over_share` above AUTHORED_PARTY_MAX_SHARE_BP). Rates are basis
  points computed in TS; all integers.
- **Bounded cost.** Every windowed query reads through a 020 index; the resolution job and the
  chosen menu are reached by key through `LATERAL … LIMIT 1`, and the settled-encounter CTE is
  `MATERIALIZED` (inlined, the planner walked trip_encounter's whole primary key for a free sort
  order). `test/telemetry-scale.test.ts` writes a two-year synthetic history (3 000 accounts,
  30 000 trips with jobs and menus, 300 000 ledger events, 200 000 client events, refugee menus,
  pack purchases), ANALYZEs and EXPLAINs every exported `*_SQL` over a 30-day window: no Seq Scan
  and no condition-less index scan of any event-shaped table (ledger_event, trip, trip_encounter,
  resolution_job, encounter_candidates, refugee_menu, pack_purchase, analytics_client_event). Only
  the "now" panels (ladder levels, pool health, accounts near the cap, the opted-out set) scan state
  tables of one row per player / party / caravan. The plans are checked in under
  `apps/server/db/explain/analytics/*.txt` (`pnpm --filter @caravan/server explain:analytics`
  rewrites them); the whole dashboard over that history built in ~0.4–1.1 s locally.
- **Client telemetry** (`apps/web/src/telemetry/`): screen flow (the route, or `welcome`) and crash
  reports (window `error` / `unhandledrejection` and the render error boundary) — a crash is a closed
  error class plus an FNV-1a hash of its first three stack frames with URLs stripped, never the
  message. Batched in memory (5 s after the first event, ≤ 25 per request, a failed send is dropped,
  no storage of any kind, no third-party SDK), sent to `POST /me/telemetry` with each event's age.
  The server validates the exact shape (unknown key, screen, class or a malformed hash refuses the
  batch), caps the body at 4 KiB (413) and the batch at 25, rate-limits per account (12 batches a
  minute, in-process fixed window with bounded memory; 429 + Retry-After, checked in `onRequest`
  before the body is read) and keeps at most 1 000 events per analytics id per rolling 24 h. Knobs
  in `src/analytics/tunables.ts` (operational, not balance; the server's screen list is compared with
  the web client's by a test).
- **Opt-out** is an account setting on the server: `GET/PUT /me/analytics { optedOut }`, a toggle
  "Share usage data" inside the Inbox's settings disclosure (the client's one settings place). An
  opted-out account's batches are accepted and dropped (`optedOut: true`, after which the client's
  reporter stops), opting out deletes the client events already kept, and opted-out accounts are left
  out of the return cohort. Ledger-derived balance aggregates (trips, picks, Coin) include every
  player: they are counts over records the game keeps anyway, and dropping accounts would bias the
  very numbers being tuned.
- **One-way.** Nothing in the resolver, matchmaking, economy, acquisition or trip loop reads the
  analytics module or tables (a test greps `src/` and the three packages); the dashboard only reads.
- **Admin page**: `#/admin` (`apps/web/src/screens/admin/AdminScreen.tsx`, a lazy chunk linked from
  nowhere; a 404 shows "Not found." and nothing else). Tables with every number as text, a
  single-hue bar beside each rate, alarms in words; the §20 table at the top with today's registry
  values. Column labels on this operator page are inline English, not `strings.ts` (headings and
  player-facing copy are in `strings.ts` under `admin` / `privacy`).

**PROJECT.md §20 → the panel each number is tuned against** (also `TUNING_MAP` in
`src/analytics/dashboard.ts`, served with the dashboard and rendered at the top of the page):

| # | §20 number | Registry keys | Panel(s) | What to read |
|---|---|---|---|---|
| 1 | Damage formula coefficients and the type/affinity matrix | DAMAGE_FORMULA, AFFINITY_ADVANTAGE_MULT, AFFINITY_DISADVANTAGE_MULT, MERGE_MULT_PER_LEVEL | matchups, mergeLevels, defenderUnits, attackerUnits, overrunByBand | held rate per affinity matchup and per merge level; win rate per type; overrun across bands |
| 2 | Garrison aggro radius and leash | AGGRO_RADIUS_DEFAULT, LEASH_DISTANCE_DEFAULT, LEASH_HYSTERESIS_MULT | stances, defenderUnits | held rate per defensive stance |
| 3 | Deployment slot count | DEPLOYMENT_SLOT_CAP, PARTY_SLOT_CAP, SIEGE_SLOT_CAP | slots | posted / raiders per encounter vs held rate |
| 4 | Fence segment HP and unlock cost | FENCE_SEGMENT_HP_DEFAULT, FENCE_HIT_SEGMENT_CAP, FENCE_MATERIAL_BUDGET | fences, slots (fences), unlockPurchases | segments broken / placed per tier; segments placed vs held rate; fence nodes bought |
| 5 | Trap values and unlock costs | TRAP_DAMAGE_MIN/MAX, TRAP_SLOW_MAGNITUDE_DEFAULT, TRAP_ROOT_DURATION_DEFAULT, TRAP_SLOT_CAP | traps, unlockPurchases | pick and held rate per trap; trap nodes bought |
| 6 | Siege values and unlock costs | SIEGE_FENCE_DAMAGE_MULT, SIEGE_TRAP_NULLIFY, STRUCTURE_BREAKER_MULT_DEFAULT | siege, unlockPurchases | pick and overrun rate per siege; siege nodes bought |
| 7 | Ladder point curves | LADDER_* | ladder | owners per rung now; rungs crossed |
| 8 | Unlock web node counts and structure | LIVING_UNITS_PER_REGION, TRAP_TYPES, SIEGE_TYPES, FENCE_TIERS | unlockPurchases, ladder | nodes bought (and never) vs points granted |
| 9 | Weekly pack Coin per tier and the combined cap | PACK_COIN_BY_TIER, PACK_TIER_PRICES_CENTS, WEEKLY_PAY_CEILING | grindWall, packFunnel | ceiling vs free weekly earn per decile; funnel per tier |
| 10 | Coin storage cap | COIN_STORAGE_CAP | storageCap, earnBySource | players at / near the cap; Coin discarded per source |
| 11 | Coin earn rates | COIN_PER_ENCOUNTER_BASE, COIN_ENCOUNTER_ESCALATION_MULT, COIN_ENCOUNTER_BAND_SCALE_BP, COIN_DELIVERY_PER_ENCOUNTER, COIN_PER_PARTY_WIN, COIN_TRICKLE_RATE_PER_HOUR | earnBySource, grindWall, bankVsPush, tripLength | Coin by source; push rate past encounter 1 |
| 12 | Trips-per-hour cap | TRIPS_PER_HOUR_CAP, TRIP_CAP_REGEN_MS | tripCap, sessionLength | starts that took the last use vs session length |
| 13 | Refugee refresh interval and mercenary cost | REFUGEE_REFRESH_INTERVAL_MINUTES, REFUGEE_REROLL_COST_SCHEDULE, MERCENARY_COST_BASE | refugees, spendByReason | free menus / rerolls / claims per day; reroll and mercenary Coin |
| 14 | Tick cap / stalemate threshold | BATTLE_LENGTH_CAP_SECONDS, TICK_RATE, STALEMATE_LOOT_SHARE | tickCap, bankVsPush | fights at / near the cap by outcome; stalemate share by encounter |

- **Tests.** `apps/server/test/telemetry.test.ts` (30): one seeded history through the real routes
  (four owners, three trips resolved by the double — held→bank, held→push→overrun, stalemate→bank —
  a refugee reroll, merge-shaped spends, a pack purchase, trap ladder and unlock events, two client
  sessions and a crash) and every panel asserted to exact numbers (Coin, ladder and grind-wall
  against an independent fold of the same ledger rows, since real play moves them); retention over
  backdated accounts with an opted-out one; the §20 table against PROJECT.md (14 bullets, real
  registry keys, existing panels); admin 404s, revoke, the app role refused (42501) on
  INSERT/UPDATE/DELETE of `account_admin`, no `src/` file but `analytics/admin.ts` writes it;
  opt-out (kept nothing, deleted what was kept), the opaque id and cascade; ingest refusals, 413,
  429, the daily cap, the limiter's bounded memory; the screen list equals the web's; the one-way
  grep; the contract recording (`analytics`, `analytics-put`, `telemetry`, `admin-dashboard` under
  `apps/web/src/test/contract/`, timestamps normalised). **Guard-test exemptions (narrow):**
  `store-guards` (two greps) and `economy-guards` (one grep) exempt exactly ONE file,
  `src/analytics/queries.ts`, from "no file outside the store / economy names pack_purchase /
  coin_purchased / coin_spent": the funnel and the spend panels must read them. The exemption is
  safe because that file is pure SELECT — `telemetry.test.ts` asserts it contains no INSERT /
  UPDATE / DELETE / appendEvents / appendCoinCredits / spendCoin — and because nothing in play
  imports `src/analytics` (the one-way grep). Every other analytics file stays under the greps. `telemetry-scale.test.ts` (4): the EXPLAIN
  gate above. Web: `AdminScreen.test.tsx` (5), `telemetry/telemetry.test.tsx` (9: batching, caps, no
  message text, opt-out stop, dispose, the hook, the toggle), contract guards for the four routes.
- **Not done here:** device / native crash reporting (chunk 34); per-number target bands (what
  value of each metric is "tuned") — that is chunk 37's sign-off; a scheduled band-emptiness alert
  to a channel (the alarm is on the dashboard; there is no notification target yet).

**Goal.** PROJECT.md §20 lists fourteen numbers that are placeholders. They get tuned
from data or they never get tuned.

**Constraints.**
- Server-side event analytics off the ledger: trip length distribution, bank-versus-push
  rates by encounter index, overrun rate by Reputation band, unit pick and win rates,
  trap and siege usage, merge spend over time, refugee reroll frequency, pack purchase
  funnel, session length, day-1/7/30 return.
- The **grind-wall probe** from the QA checklist as a standing dashboard: free weekly
  Coin earn by active-player decile against `WEEKLY_PAY_CEILING`.
- **Pool health**: live versus authored share per band, and a band-emptiness alarm.
- Client analytics limited to screen flow and crash reports; no third-party ad SDKs.
- Privacy: analytics keyed by an opaque id, opt-out honored, nothing in the payloads
  that chunk 30's deletion would have to chase.

**Definition of done.** Every §20 number has a dashboard panel that shows the metric it
should be tuned against.


**Fix round 1 (chunk 32 QA, 2026-10-11)** — every item is closed in the punch list with a one-line note. In short:
- **Authored outfits are out of every panel (S1).** A keyed `NOT EXISTS` probe on the account, caravan or trip leaves out system accounts other than chunk 30's erasure tombstone (whose rows are erased PLAYERS' history). The test seeds the 96 cold-start parties.
- **Opt-out and ingest serialize (S2)** on `SELECT … FOR UPDATE` of the account's analytics row, each in one transaction; the toggle empties the client queue before its PUT.
- **Sessions are receipt-timed (D2, migration 024):** batches carry `{session, seq}` and are de-duplicated on (analytics id, session, seq, index); `agoMs` is clamped to the 15 s flush window; a `heartbeat` kind about once a minute while the page is visible; a flush when the page goes hidden.
- **New panels (D3):** `matchups` (held rate per posted × raider affinity, from the stored snapshots and `UNIT_AFFINITY`), `mergeLevels`, `fences` (breakage per tier from `result.outcome.fences`). §20 #1 now reads matchups / mergeLevels first and #4 reads fences first; `PANEL_SUBSYSTEMS` and the test require every number's primary panel to read its own subsystem.
- **Funnel (D4):** one population (opted-in accounts with screen flow), nested stages, every buyer only as `allBuyers` outside the funnel.
- **Export (D5):** `analytics: {optedOut, events}` without the analytics id.
- **Bounded (D6):** one READ ONLY transaction with `statement_timeout` (`ANALYTICS_STATEMENT_TIMEOUT_MS` 5000); /admin/* limited to 30 requests a minute per admin, checked after the admin test so a non-admin only sees the 404. The EXPLAIN gate runs at 30 and at 120 days and compares each live plan's scan skeleton (sequential vs keyed scan of each event-shaped table) with the checked-in `*.txt` / `*.120d.txt`. 120 days passes, so `ANALYTICS_MAX_WINDOW_DAYS` stays 120.
- **Nits.** N1: a non-admin's 404 is Fastify's unknown-route body byte for byte. N2: digits-only, bounded `days` / `week`. N3: the over-share alarm uses the matchmaker's own query and window. N4: a `thin` alarm below a menu + self + RECENT_OPPONENT_EXCLUSION. N5: unbought nodes are 0 rows. N6: authored = the served candidate's stored flag. N7: trickle apportioned by its accrual span, with a note on the panel. N8: the client reads the opt-out before its first flush. N9: real merge and unlock routes in the test, recursive package walk.
- **Guard-test exemptions (unchanged, still narrow):** exactly `src/analytics/queries.ts` in `store-guards` (×2) and `economy-guards` (×1); that file has no write verb (asserted).

## 33. Live-ops and admin tooling — **M**, after 03, 20, 32

**Goal.** The tunables registry, pack rotation, and account state need operating
without a deploy.

**Constraints.**
- **Tunables editing with versioning and audit.** A tunables change creates a new
  version; every resolution records the tunables version alongside the resolver version
  (chunk 13), so old replays remain explainable. Resolver-visible tunables changes are
  staged and take effect at a published time, identical for everyone.
- Pack schedule editing (Coin amounts are **not** editable here; they are fixed by
  design and change only through a reviewed release).
- Account tools: view, suspend, restore, refund a purchase, inspect any replay, trace
  Coin between accounts (chunk 31).
- Authored party editor (chunk 25) using the same party builder as players.
- Role-based access and an audit log for every admin action.

**Definition of done.** Rotating next week's cosmetics and raising `COIN_PER_PARTY_WIN`
both happen without a deploy and both leave an audit record.

## 34. Mobile packaging and store billing — **L**, after 20, 28, 30

**Goal.** Ship as an installable PWA first, then as store apps, without a rewrite.

**Constraints.**
- **PWA**: manifest, service worker caching the app shell and atlases, offline landing
  that explains the game needs a connection to resolve fights, install prompt.
- **Native wrap** with Capacitor: iOS and Android shells, native push, haptics, safe-area
  insets, status bar, splash, deep links into replays.
- **Billing**: replace chunk 20's sandbox stub with StoreKit 2 and Google Play Billing
  behind one server-side purchase service. Receipts are **verified server-side** before
  any Coin is granted; the grant writes the same `coin_purchased` ledger event the stub
  wrote. Restore purchases is supported and idempotent. Web keeps the sandbox stub until
  a web payment provider is chosen, which is a separate decision.
- The three pack tiers map to three fixed store products per platform; prices are
  fixed in the store consoles, never computed in the client.
- **Performance budget** on a 2020-era low-end Android device: 60 fps in town, 30 fps
  minimum in replay with twenty entities, first interactive under 5 seconds on 4G.
- App Store and Play Store review checklists: age rating, privacy nutrition labels,
  account deletion, in-app purchase disclosure, no loot box, which this design satisfies
  by construction and the listing should say so.

**Definition of done.** Both store builds pass review on test accounts, a purchase on
each platform credits Coin exactly once, and restore on a second device credits nothing
twice.

**QA checks.** Guardrail 2: with billing real, repeat the entire chunk 20 QA list. Confirm
the purchase service and the resolver share no module.

## 35. Localization and accessibility — **S**, before store submission

**Constraints.**
- All player-facing strings externalized from day one; numbers and dates formatted by
  locale. English only at launch, but no string lives in a component.
- **Affinity categories** (Grit / Powder / Beast) distinguished by icon and shape, never
  by color alone. Scouting must be readable under deuteranopia simulation.
- Text scaling honored up to 150%, reduced-motion preference honored in replay and the
  mine animation, screen-reader labels on every non-canvas control, and a text list
  alternative for the canvas scouting view so the party is legible without the picture.

**Definition of done.** The scouting screen passes a colorblind simulation and a
screen-reader walkthrough can name every unit, stance, and siege piece in the party.

## 36. Performance, storage, and scale — **M**, after 13, 15

**Status: built** (2026-10-11, chunk 36 Maker; the play-test cut: retention compaction, matchmaking indexes with explain plans, a local load test). Build notes:

- **Migration 022_retention_and_scale** (was 021 on the branch; renumbered on merge, after 021 telemetry).
  - `encounter_log_summary`: one row per compacted replay. It holds the outcome (kind, depth, endTick, loot) from the job's immutable result, the end-card tally, and the log's metadata (versions, sizes, sha256, when the log was written). The tally is what the web player shows: raiders and posts fallen, fences broken, traps fired, traps nullified, core reached, deepest raider. The worker writes it into `result.replay.tally` at completion (`replay/summary.ts`, one pass over the rows; a test pins it to the web player's own tally from the reader). Nothing in a summary comes from a caller. The summary is insert-once, there are no updates, and TRUNCATE is refused. Its only path out is a cascade from its caravan or job, so it is account-scoped and the per-file test reset needs no exemption for it. Per-encounter Coin, Reputation and de-merge itemization is NOT copied: the replay route reads it from the ledger, which is permanent.
  - Compaction replaces deletion everywhere:
    - `encounter_log_prune(caravan)` keeps its signature and now compacts.
    - `encounter_log_retention_sweep(limit 1..5000)` is the all-caravan entry point, oldest first.
    - The internal `encounter_log_compact_rows` writes the summary first, then deletes the log. EXECUTE on it is revoked from PUBLIC.
    - The delete guard also refuses any log without a summary, even for the owner role.
  - LOG_SIZE_BUDGET: `encounter_log_retention.size_budget_bytes` = 102400, pinned to `TUNABLES.LOG_SIZE_BUDGET_BYTES` by a test. A log over the budget is compacted at any age. The worker runs the caravan's prune once more after marking the job completed, inside the same transaction, so an over-budget log never outlives its own completion. LOG_RETENTION is unchanged: older than 30 days AND outside the caravan's newest 50.
  - The app role has no INSERT, UPDATE or DELETE on the summary table and cannot call the compactor. `retention.test.ts` proves the refusals as `caravan_app` and as the owner role.
- **Account erasure (chunk 30) composes with compaction, in both orders** (tests for each):
  - Erased, then compacted: `account_erase` has already re-pointed the shared log to the tombstone, and the summary copies those ids.
  - Compacted, then erased: an AFTER UPDATE trigger on `resolution_job` (`encounter_log_summary_follow_erasure`) fires only while an erasure is active. When `account_erase` re-points a kept fight's job, the trigger applies the same closed `account_erasure_rewrite` to that job's summary. The summary's update guard admits exactly that rewrite through `account_erasure_permits`, and nothing else.
  - Covered for a defender erased (the party's owner keeps the archived fight) and for a party owner erased (the defender keeps it). A summary of a fight with no other player goes with the caravan, as its log does. The summary JSON holds no ids and no names.
  - `account_erase`'s audit counts do not include summaries (its function is chunk 30's).
- **Scheduled job.** `jobs/retentionWorker.ts` `LogRetentionLoop` runs in-process like the encounter worker. It starts with the server (`index.ts`, `retentionJob: true`; tests sweep by hand) and repeats hourly. Each run calls the sweep in batches of 500 until a batch comes back short, at most 200 batches per run. Operational constants, not balance.
- **Replay route.** A compacted fight answers **200** with `renderable: false`, `log: null`, `reason: COMPACTED_REASON` and `compacted: {reason, compactedAt, logCreatedAt, tally (deepest with displayName)}`. Outcome, depth, party and `settled` are as before, and `stored` is the caravan side's only. 410 `replay_expired` is now only for a log pruned before §36 with no summary. The edit is additive.
  - Contract case: `replay-compacted` is recorded by the server suite (the owner role lowers the budget for one prune) and checked by the web guard (`compacted` is an optional field).
  - The web player shows "This fight's playback has been archived" with the kept tally.
  - Chunk 22's recent-fights list gains `replay: "compacted"`.
- **Matchmaking indexes and EXPLAIN plans** (`apps/server/db/explain/*.txt`, generated by `pnpm load:explain -- --db … --write`). Data: 50 096 accounts, 50 096 standing parties, 52 000 trips, 156 000 stored chosen menus (648 MB). One veteran account has 2 000 trips; a typical active account has 25. Run after VACUUM ANALYZE on PostgreSQL 16.15, load average 10–15.
  - **Reputation band:** the existing `pool_progress_pool_reputation_idx` and `account_system_idx` drive it, with no sequential scan. ±600 at 1000 returns 15 120 parties in 82–110 ms. **Finding:** the cost grows linearly with the in-band population, because the scan reads the ±600 slice even when the ±150 pass fills. A pass-by-pass scan is the next lever. It is not changed here (it is the draw's replay input).
  - **Linked-account exclusion:** a `<> ALL($1)` filter on the band rows. There is no link table until chunk 31, so nothing to index. The plan shows it with a 25-id list.
  - **Recent-opponent exclusion:** rewritten (`RECENT_OPPONENTS_SQL`) to take the newest N chosen menus by key before expanding any candidate list. The new `encounter_candidates_chosen_recent_idx (trip_id, chosen_at DESC, encounter_index DESC) INCLUDE (search_seq) WHERE chosen_at IS NOT NULL` makes that an index-only scan with 0 heap fetches. Veteran account: pre-§36 query 81.9 ms (12 031 buffers); new query without the index 73.4 ms; new query with the index **10.2 ms (7 300 buffers)**. Typical account: 0.33 ms.
  - Chunk 25's served-share window: 0.47 ms.
- **Resolver budget (100 ms per 180 s fight, CPU).** `budget.test.ts` now times every golden-corpus fight (72) plus the full-load fights. Each fight is timed best of 3–9 CPU runs after a warm-up, with a GC before each (`--expose-gc`), in batches so no synchronous block runs long.
  - The strict 100 ms bound is `pnpm perf:resolver`: the file alone, `RESOLVER_BUDGET_STRICT=1`, a CI step of its own and part of `pnpm ci`. The parallel suite runs the same test with a 2× allowance; the full-length bound was 300 ms before.
  - Measured in the final gate run (load average 4.5): slowest fight c13-full-load-full-length (3 600 ticks, unkillable) **86.8 ms**, a **13 % margin**. Next slowest: c13-stalemate-deep-but-not-in 70.1 ms, combat-full-load-16v8v28 53.7 ms. Corpus mean 8.1 ms. The direct full-length test read 83.1 ms.
  - Under concurrent `pnpm determinism` the same fight read 103–137 ms of CPU. That is why the strict bound runs alone.
  - Across earlier strict runs on this shared machine the heaviest fight read 88–108 ms; one of four runs failed at load average ~6. **The margin is thin on a contended runner.** If CI flakes, the lever is phase 2's A* (`findPath`, 40 % of the profile), not the bound.
- **Load test** (`pnpm load:queue -- --db <load DB>`; resets that database; not in CI).
  - **Assumed launch concurrency:** 100 trips in progress at the launch peak, about 1.1 commits/s. 100× is 10 000 trips and the **target is ≥ 110 resolutions/s** on one 4-core host running server, workers and Postgres together.
  - **Phase A:** 500 real trips commit concurrently over HTTP as the app role while the workers resolve and settle.
  - **Phase B:** the 100× burst, 10 000 encounters enqueued concurrently against ONE standing party (chunk 02's case). Optionally `--burst-parties N`.
  - Checks that passed in every run: every job completed exactly once (attempts = 1), nothing parked, 2 ledger events per job, one log per job, the party row byte-identical afterwards, identical inputs → byte-identical logs (500 input groups).
  - Measured with 4 worker processes × 2 drain loops, other agents running on the machine:

    | Run | Load average | Throughput | Enqueue → resolved | Other |
    |---|---|---|---|---|
    | Phase A, 500 trips | 6.1–6.7 | — | commit → resolved p50 0.6 s, p95 2.0 s | bounded by the 21 commits/s HTTP commit rate |
    | Phase B, one party | 6.1–6.7 | **51 jobs/s** | p50 102 s, p95 159 s | burst; CPU 14.4 ms/job |
    | Phase B, 24 parties | 6.3–10.4 | **88 jobs/s** | p50 49 s, p95 73 s | burst; CPU 11.1 ms/job |

    Stored logs average 2.7–3.2 KB gzip.
  - **Target not met here, and not measurable fairly here.** The host is shared, and the worker CPU (11–14 ms/job) is a small share of the wall time.
  - `--profile` shows the bottleneck is lock waiting, not the resolver. `pg_advisory_xact_lock` waits average 28–39 ms per job, against a 12–18 ms handler. Every job locks its caravan and every account it appends events for, and the one-party case appends a `party_served_as_encounter` event for the same owner each time. **Finding / hand-off:** a single popular standing party serializes on its owner's account lock, which caps that party at about 50 resolutions/s, whatever the worker count. Spreading over 24 parties lifts throughput to 88/s on this machine. Before launch, re-measure on a dedicated host. If the owner's lock binds, take the account lock only for events that move a balance (`party_served_as_encounter` projects nothing).
- **Client.** The battle/replay scene is now lazy: chunk 22 had it statically imported by `WatchFight`, and with it the resolver's replay reader. `ReplayPlayer` is its own chunk, 34.7 KB (12.4 KB gzip), loaded the first time a fight is opened. The iso renderer (PixiJS) was already a lazy chunk (chunk 08 QA S3).
  - **Atlas streaming and memory ceiling: nothing to stream yet.** Art is the iso renderer's placeholder shapes (chunk 26 is out of play-test scope), and there are no textures or atlases.
  - What applies now: one PixiJS canvas per open view, lazily loaded, and `IsoCanvas` creates and destroys its renderer with the view.
  - When chunk 26 lands: atlases must be per region, loaded on entering a region's screens and released on leaving. They need a stated texture-memory ceiling for low-end devices: target ≤ 64 MB of GPU texture on a 2 GB phone, tunable. That ceiling is a proposal, not measured.
- **Tests added:**
  - Server `retention.test.ts` (8): tally parity, compaction by budget and by retention, the sweep, the loop, guards against both roles, cascade, erasure in both orders for both sides, recent fights showing "compacted".
  - Updated: trip-resolver retention (compaction), migrations (table list), contract (`replay-compacted`).
  - Web: replay guard (compacted accepted, drifted summary refused) and ReplayPlayer (archived view).
- **Gates (final run, sequential, after merging roadmap/phase-2-spec):**
  - typecheck, lint, boundary: pass.
  - Suites: content 82, circle 108, resolver 586, server 742 (+1 skipped), web 426 — all pass.
  - determinism, perf:resolver (strict), build: pass.
  - e2e: 11 passed.


**QA fix round (2026-10-12; roadmap/qa/36-punchlist.md).** Migration 025_compaction_erasure_lock (new schema; to be renumbered on merge). Closed: S1–S4, D2, D4, N2, N4, N5, N6, N7. Recorded for launch: D1, D3, D5. Open with a reason: N1, N3.

- **S1: compaction and erasure are serialized per fight** (migration 025). Both take `pg_advisory_xact_lock(36, hashtext(job_id))` (`LOCK_NS_ENCOUNTER_LOG`).
  - The erasure WAITS for the lock: a BEFORE UPDATE trigger on `resolution_job` fires only during an erasure, and only on the rows it re-points. So the follow-erasure trigger rewrites a committed summary.
  - The compactor TRIES the lock, sorted, and skips any fight it cannot take. The hourly sweep or the caravan's next prune picks it up later. The compactor never waits on an erasure. It then locks the fights' caravans FOR KEY SHARE and their logs FOR UPDATE, reads them in a new statement (post-erasure), and re-checks eligibility instead of tripping the delete guard. The try-lock is the sweep's SKIP LOCKED.
  - Tests in `retention.test.ts` use two connections, run both orders for an erased defender and an erased party owner, and hold one transaction open while the other runs. No fight loses its summary, and no summary keeps an erased id.
  - With 025 removed, these tests fail. The first one reproduces QA's "summary lost" case.
- **S2: expired guests.** The hourly `LogRetentionLoop` run now has two independent steps. First the log sweep. Then `account_erase_expired_guests`: 50 per call, at most 20 calls per run. An error in one step is reported and never skips the other. `RetentionRun` reports `guestsErased` and `failed`. Tests cover:
  - a backdated guest with an expired device and session is erased (audit reason `guest_expired`);
  - a guest with a live device is kept;
  - a failing log step still runs the guest step.
- **S3: the resolver budget gate no longer flakes.** `pnpm perf:resolver` is still a CI step of its own and runs three layers:
  1. **Work counters (blocking, exact).** `ResolveOutput.work` counts ticks, unit-ticks, A* searches and cells A* expanded, counted in the resolver and never logged or read by the simulation. The counts are pinned per corpus fight in `packages/resolver/golden/work-counters.json`, a new fixture added under `[resolver-bump]`. It is written by `UPDATE_GOLDEN=1` together with the goldens and carries `resolverVersion`, so the golden gate requires a version bump to change it. A balance pass only needs the usual regeneration and bump.
  2. **Relative time (blocking, generous).** The heaviest fight / an integer reference workload, interleaved in one process, must stay ≤ 12. Calibration read 3.1–5.9; a 2.5× relative slowdown would fail.
  3. **Absolute 100 ms (reported).** Printed as MET / EXCEEDED with the margin. Only `RESOLVER_BUDGET_STRICT=1` asserts it, on a dedicated perf host.
  - The duplicate best-of-5 measurement is gone.
  - Final gate run: work counters equal; ratio 3.10–4.24. The absolute bound read **EXCEEDED** in the solo `perf:resolver` step at load average 3.1: c13-full-load-full-length took 113.8 ms. The same fight read 95.7 ms (MET) a few minutes earlier inside the resolver suite. The ±30 % noise QA measured is real, and the new gate no longer depends on it.
- **S4: a failed replay-chunk download** is shown inside the replay dialog ("Couldn't load the replay", a reload hint, Try again). The screen behind it is never replaced. The chunk's module promise is cleared on rejection, and the lazy component is re-created per opening and per retry, so Retry really imports again. `WatchFight.test.tsx` covers the loading line, a failed import with the trail still visible and no app-level render error, Retry, and reopening after a failure.
- **D2: load test.**
  - Phase A's "settled" check is scoped to its own jobs (one `trip_encounter` per job, with the job's outcome kind).
  - After the burst: every touched account's projected Coin equals the fold of its ledger (Coin only, because the setup seeds Reputation by direct UPDATE), no account is above its cap, and no overrun transfer is credited twice.
  - Retention runs under load: phase B lowers the size budget, so every completion compacts, while a sweep loop runs concurrently.
  - The exit status reflects correctness only. The throughput target prints MET / NOT MET with the load average; `--strict` gates it on a dedicated host. Auth rate limits (chunk 30) are off in the load app.
  - Re-run (10 000-job one-party burst, 500 real trips, 4 × 2 workers, load average 5.8–6.3):

    | Check | Result |
    |---|---|
    | Correctness checks | all pass |
    | Phase A | 500/500 settled; commit → resolved p95 1.7 s |
    | Phase B throughput | **58 jobs/s** |
    | Phase B enqueue → resolved | p95 146 s |
    | Compaction under load | all 10 000 jobs ended compacted; 0 errors |
    | Coin across 524 accounts | consistent |
    | Throughput target | NOT MET (reported) |
- **D4: the post-completion prune runs under a SAVEPOINT.** A failed compaction is rolled back alone, reported through `onHookError` ("compaction") and left to the hourly sweep. The fight's completion always commits.
- **N2.** A size-budget compaction answers `COMPACTED_OVER_BUDGET_REASON`; a retention compaction answers `COMPACTED_REASON`. A log over the budget at write is logged by the server as `anomaly: "replay_log_over_size_budget"` (`onLogOverBudget`).
- **N4.** The account export carries a compacted fight's summary (`replay_compacted`, `compacted_reason`, `compacted_at`, `compacted_summary`, with metadata from the summary).
- **N5.** Migration 022's down refuses while summaries exist (AGENTS.md: `DELETE FROM account` first).
- **N6.** Both triggers on `resolution_job` carry a `WHEN` clause (account or input changed), so leases, heartbeats and completions no longer pay for them.
- **N7.** Web tests cover the Suspense fallback and the failed chunk. The e2e opens and closes the real replay ten times and asserts the canvas count returns to baseline and the iso debug handle is gone.
- **For launch (recorded, not changed):**
  - **D1. The single-party ceiling is the owner's lock at settle.** In a real trip the completion's settle (`TRIP_SETTLE_HOOKS` → `lockAccountsForAppend([defender, owner])`) credits the owner's loot and moves their Reputation, holding the popular owner's account lock until COMMIT. The load test's phase B (no settle) understates this. Dropping the lock for `party_served_as_encounter` would not help.
    - Before launch: run phase B with the settle hooks and real trip ids.
    - Consider crediting the absent owner asynchronously, as its own job keyed by the encounter.
    - Play test: about one commit per second, against a ceiling of about 50/s.
  - **D3. The sweep rescans every old-but-protected log each hour.** QA measured 1.1 s per call with 180 000 protected rows and 0 compacted. Fine at play-test scale. Before launch, choose candidates per caravan (caravans with more than `min_per_caravan` logs), or keep a watermark.
  - **D5. The EXPLAIN plans are snapshots.** Before launch:
    - Add a CI EXPLAIN test for `RECENT_OPPONENTS_SQL` (index-only on `encounter_candidates_chosen_recent_idx`) and for POOL_SQL's linked-account filter, as qa25-scale does.
    - Regenerate the band plan with a skewed Reputation distribution (about 70 % in 0..600), then decide on the pass-by-pass scan. That changes the draw's input, so it needs replay-version care.
- **Open, with reason:**
  - **N1.** Every process sweeps. QA verified this is safe; the try-lock now makes concurrent sweeps skip each other's fights instead of waiting 2–3 s on uncommitted rows. A per-run `pg_try_advisory_lock` comes with D3's rework.
  - **N3.** The tally parity test is a copy of the web tally. Moving the tally into one shared function belongs with chunk 22's next pass on the player model, where both readers can switch together.
- **Gates (QA fix round, sequential):**
  - typecheck, lint, boundary: pass.
  - Suites: content 82, circle 108, resolver 587, server 764 (+1 skipped), web 440 — all pass.
  - determinism: pass; its golden gate accepted the added `work-counters.json` as `[resolver-bump]`.
  - perf:resolver: pass (absolute reported EXCEEDED, see S3).
  - build: pass.
  - e2e: 11 passed.

**Constraints.**
- Resolver budget: one 180-second fight resolves in under 100 ms on the server. Measured
  in CI against the golden corpus.
- Job queue throughput target and a load test at 100× expected launch concurrency,
  including the "one party served into many concurrent encounters" case from chunk 02.
- Log storage: enforce `LOG_SIZE_BUDGET` and `LOG_RETENTION` with a scheduled job;
  logs past retention are **compacted to the results summary** (chunk 22) rather than
  deleted outright, so the feed keeps its history.
- Indexes for the matchmaking query (Reputation band, recent-opponent exclusion, linked
  account exclusion) with an explain plan checked in.
- Client: lazy-load the battle scene, atlas streaming by region, memory ceiling on
  low-end devices.

**Definition of done.** Load test passes and the retention job runs on staging with
real-shaped data.

## 37. Balance harness and playtest program — **L**, after 13, 32

**Goal.** Tune the §20 numbers. Determinism makes a large part of this automatable.

**Constraints.**
- **Matchup sweep**: because resolution is a pure function, generate every authored
  party against a corpus of representative formations at every merge level and compute
  the full outcome matrix offline. Flag any unit, trap, siege piece, or ability whose
  presence predicts the outcome beyond a tunable threshold. Re-run on every content or
  tunables change. This is the single highest-leverage tool the determinism guardrail
  buys, and it runs in CI.
- **Healer stalemate probe** and **structure-breaker stacking probe** from chunk 12's QA
  list become standing sweeps.
- **Closed alpha** of a few hundred players through the PWA, with chunk 32 dashboards,
  for at least four weeks; then an open beta on the stores' test tracks.
- Tuning changes go through chunk 33 with a written rationale per change, kept in a
  `BALANCE-LOG.md` in plain English.
- Explicit sign-off on: the free-versus-paid weekly ratio, the merge cost curve, the
  encounter reward escalation versus difficulty escalation, and the trip cap.

**Balance notes carried in (chunk 11 QA, RESOLVER_VERSION 3 — re-measure on the current version
before acting):**
- Win matrix (level 1, open field, `nearest` attacker vs a `guard` post): the attacker wins
  63.7 %. Range dominates: ranged types top the attacker list and bottom the guard list.
  Grizzly is top in both roles (cf. chunk 03 QA N6). The four healers are weak until chunk
  12's abilities exist.
- Affinity changes 7.1 % of outcomes; every non-neutral pair changes some; stats decide 93 %.
  Revisit ×1.25 / ×0.80 against the 40–120 offense spread.
- Chunk 11 QA round 1 (RESOLVER_VERSION 4) changed three things that move these numbers:
  reserve posts fire back, a breacher ignores posts that cannot reach it, and guards no longer
  chase detours out of aggro or leash. Re-run the matrix before tuning.

**Balance notes carried in (chunk 12 QA, measured at RESOLVER_VERSION 5; version 6 changed
fence breaching and the breaker's first use, so re-measure):**
- Win matrix with abilities: the attacker wins 63.5 % (63.7 % without); abilities flip 29 of
  1024 matchups. Range still dominates (ranged attackers 75.3 % vs melee 58.1 %).
- Healers are the weakest archetype in full fights: 7.5–16 % of post damage healed against 8
  raiders, under the 25–35 % target (they die early). In LIGHT encounters it is the other way
  round: across three survived 2-raider encounters the same healer circle arrives at 82.6–89.9 %
  of full HP with healing and 60.3–70.4 % with healing switched off — healing undoes 56–66 % of
  the attrition there (chunk 12 QA N3 gate, version 6). The heal ceiling keeps it to this
  fight's damage, but the offset is over target when fights are mild.
- Core-stance runners reach the core about 5 s in, before most abilities first fire: hold rate
  is decided by approach coverage, not abilities.
- Version 6 (chunk 12 QA D1/D2): one unit takes at most half a segment's max HP per tick
  (`FENCE_HIT_SEGMENT_CAP`), so every full segment needs two blows. Siege is still ×4; on 300- and
  400-HP timber most siege hits are now clipped to the cap, and a lone segment beside a gap is
  walked around even with siege. The breaker's first use is ×0.25 of its cooldown
  (`STRUCTURE_BREAKER_FIRST_USE_MULT`): breaker firings over the QA corpus went from 3 to 12.
  Revisit the six breakers' multipliers (×4–×5.5) against a cap that now binds most of them.
- Merge ceiling with abilities (one-floor buff): the worst HP × effective DPS step is 1.6402
  (a posted gunslinger against an offense-120 raider at disadvantage, level 3 → 4) against the 5/3 bar; it was
  1.6856 with two floors.

**Bank-versus-push EV (chunk 15 QA D1, chunk 19 QA D2c) — the model and today's table.**
`scripts/balance/trip-ev.ts` (model in `scripts/balance/model.ts`) prints the EV of "push until
k survived, then bank" from the real tunables and earn math, valuing unit losses at rebuild Coin
(a death = one level, V(L) − V(L−1); a unit alive at the collapse = V(L); V(1) = a mercenary,
V(L) = merge cost + 5/3 V(L−1)). Hold rates and deaths are INPUTS: the rows below are guesses
(p1 − 0.05 per encounter, 0.5 deaths per held encounter, half of the units alive at an overrun
die in that fight). This pass reruns it with resolver-measured curves
(`--curve a,b,c --deaths n --levels … --band k`) and tunes `COIN_ENCOUNTER_BAND_SCALE_BP`,
`FIRST_ENCOUNTER_CENTRE_OFFSET`, the schedule and the delivery until, **at each circle's
equilibrium rating, the best bank point has positive EV for L1–L4 circles and is k ≥ 2**
(chunk 19 QA D2c). At the current tunables it does not — merged circles are negative at every
bank point at these guessed rates — which is what this pass is for. Output at commit time:

```
Caravan Vaults — trip EV model at the current tunables (scripts/balance/trip-ev.ts)
COIN_ENCOUNTER_BAND_SCALE_BP 5000, FIRST_ENCOUNTER_CENTRE_OFFSET -150, delivery 125/encounter, ×1.35 per encounter
encounter Coin, band 0: 400, 539, 727, 981, 1323, 1785   bank totals: 525, 1189, 2041, 3147, 4595, 6505
encounter Coin, band 3: 1000, 1347, 1817, 2452, 3307, 4462   bank totals: 1125, 2597, 4539, 7116, 10548, 15135
encounter Coin, band 5: 1400, 1886, 2544, 3433, 4630, 6247   bank totals: 1525, 3536, 6205, 9763, 14518, 20890
unit rebuild value V(L) (mercenary L1, 5→3 amortised): L1 600, L2 1250, L3 2983, L4 7972, L5 22787
rebuild 8 × L5, one type:   67 L1, merge 149600, +mercenaries 189800, refugee drip 100.5 h
rebuild 8 × L5, mixed types: 96 L1, merge 166800, +mercenaries 224400, refugee drip 144 h

EV in Coin of 'push until k survived, then bank' — losses at rebuild value; 0.5 deaths per held encounter;
half of the units alive at an overrun die in that fight (de-merged), the rest are destroyed. Hold rate p1 − 0.05·(j−1).
                                    bank@1  bank@2  bank@3  bank@4  bank@5  bank@6
8×L1 band 3 p1 0.60                   -285    -710   -1165   -1563   -1858   -2046   best k=1  (no bank point is positive)
8×L1 band 3 p1 0.70                     67     -90    -414    -825   -1236   -1585   best k=1
8×L1 band 3 p1 0.80                    420     628     598     348     -63    -549   best k=2
8×L2 band 3 p1 0.60                  -2560   -4409   -5668   -6473   -6952   -7212   best k=1  (no bank point is positive)
8×L2 band 3 p1 0.70                  -1720   -3219   -4461   -5439   -6168   -6675   best k=1  (no bank point is positive)
8×L2 band 3 p1 0.80                   -880   -1842   -2827   -3787   -4678   -5457   best k=1  (no bank point is positive)
8×L3 band 3 p1 0.60                  -7392  -12271  -15246  -16922  -17793  -18209   best k=1  (no bank point is positive)
8×L3 band 3 p1 0.70                  -5479   -9813  -12996  -15180  -16584  -17430   best k=1  (no bank point is positive)
8×L3 band 3 p1 0.80                  -3567   -6966   -9953  -12407  -14309  -15707   best k=1  (no bank point is positive)
8×L4 band 3 p1 0.60                 -21559  -35324  -43328  -47557  -49578  -50448   best k=1  (no bank point is positive)
8×L4 band 3 p1 0.70                 -16512  -29161  -38041  -43761  -47144  -48980   best k=1  (no bank point is positive)
8×L4 band 3 p1 0.80                 -11464  -22024  -30889  -37726  -42595  -45811   best k=1  (no bank point is positive)
8×L5 band 3 p1 0.60                 -63932 -104267 -127312 -139173 -144633 -146863   best k=1  (no bank point is positive)
8×L5 band 3 p1 0.70                 -49520  -87043 -112960 -129256 -138557 -143358   best k=1  (no bank point is positive)
8×L5 band 3 p1 0.80                 -35107  -67095  -93547 -113497 -127244 -135898   best k=1  (no bank point is positive)
8×L1 band 5 p1 0.60                    -45    -401    -890   -1366   -1740   -1986   best k=1  (no bank point is positive)
8×L1 band 5 p1 0.70                    347     338      41    -427    -938   -1391   best k=1
8×L1 band 5 p1 0.80                    740    1192    1298    1071     587     -31   best k=3
8×L2 band 5 p1 0.60                  -2320   -4099   -5393   -6276   -6834   -7152   best k=1  (no bank point is positive)
8×L2 band 5 p1 0.70                  -1440   -2792   -4006   -5042   -5870   -6481   best k=1  (no bank point is positive)
8×L2 band 5 p1 0.80                   -560   -1278   -2127   -3065   -4028   -4938   best k=1  (no bank point is positive)
8×L3 band 5 p1 0.60                  -7152  -11961  -14971  -16726  -17676  -18149   best k=1  (no bank point is positive)
8×L3 band 5 p1 0.70                  -5199   -9386  -12542  -14783  -16286  -17235   best k=1  (no bank point is positive)
8×L3 band 5 p1 0.80                  -3247   -6403   -9254  -11684  -13659  -15189   best k=1  (no bank point is positive)
8×L4 band 5 p1 0.60                 -21319  -35014  -43054  -47360  -49460  -50388   best k=1  (no bank point is positive)
8×L4 band 5 p1 0.70                 -16232  -28734  -37586  -43363  -46846  -48786   best k=1  (no bank point is positive)
8×L4 band 5 p1 0.80                 -11144  -21460  -30189  -37003  -41945  -45293   best k=1  (no bank point is positive)
8×L5 band 5 p1 0.60                 -63692 -103957 -127037 -138976 -144516 -146803   best k=1  (no bank point is positive)
8×L5 band 5 p1 0.70                 -49240  -86616 -112505 -128858 -138259 -143164   best k=1  (no bank point is positive)
8×L5 band 5 p1 0.80                 -34787  -66532  -92847 -112775 -126594 -135379   best k=1  (no bank point is positive)

Weekly free earn (QA D3): full-week trickle + trips × gross Coin per trip, banked at the 8×L1 best-EV point, band 3, decay 0.05
  low  (3 trips/h × 5 h, p1 0.60)                trickle 33600 + 15 × 675 (bank@1) = 43725
  mid  (5 × 1 h sessions, 30 trips, p1 0.65)     trickle 33600 + 30 × 731 (bank@1) = 55538
  high (7 × 1 h sessions, 42 trips, p1 0.70)     trickle 33600 + 42 × 788 (bank@1) = 66675
  FREE_WEEKLY_EARN_ESTIMATE 55000 (mid, rounded down to 1000s: 55000); WEEKLY_PAY_CEILING 60000 = 1.09× (bound 1.5×)
```

**Status: offline harness and first tuning pass built** (2026-10-12, chunk 37 balance pass; the
full record, every change from → to with its reason, and the before/after numbers are in
`BALANCE-LOG.md` at the repo root). Tools: `scripts/balance/matchup-sweep.ts` (every authored party
× 68 defending rosters × the best of 76 skilled layouts, the guided arrangement and 3 naive ones;
outcome matrix, stalemates, fight length, depth, owner income, presence flags within band and
within band × stance, pushed-trip curves, equilibrium bands), `first-trip.ts` (24-QA D1),
`probes.ts` (healer stalemate, breaker stacking), `measured-ev.ts` (trip EV at measured rates);
the CI slice is `apps/server/test/balance-sweep.test.ts` (150 s budget). No resolver change
(RESOLVER_VERSION 8, goldens unchanged); content and tunables only: defense ×1.5, move speed
×0.7, trap damage ×1.5, trap trigger radius 0.75 → 1.25, REPUTATION_START 1000 → 400,
STARTING_ROSTER 1 → 3 copies per starter type, the authored difficulty curve re-authored
(AUTHORED_SET_VERSION 4), two raider offense bumps, and the caravan's Reputation for a hold
+15 → +10 (overrun −20 unchanged: equilibrium hold ≈ 67 %, the orchestrator's choice of lever for
trip EV; total loss on overrun stays).

Results after (full sweep, 6528 matchups):

| target | before | after |
|---|---|---|
| fresh account's encounter 1 band | 2 | 0 |
| guided first fight held (≥ 70 %) | 0 / 64 | 162 / 200 = 81 % |
| encounter 2 held by a sensible free layout (> 50 %) | — | 78 % (guided shape), 80 % (skilled) |
| band-typical roster at its own band, skilled (b0…b7) | 58 38 63 54 54 8 50 54 % | 95 81 97 80 82 61 57 83 % |
| same, naive | 38 29 46 29 25 0 25 29 % | 73 71 81 58 57 28 30 40 % |
| stalemates in the corpus / healer turtle | 1 / 1728 | 0 / 6528; turtle 2 / 96 (bar < 25 %) |
| fight length median, share in 20–90 s | 17.6 s, 42 % | 22.3 s, 59 % |
| features flagged within band × stance (\|Δ\| > 25 pts) | 16 | 3 (Claim Jumper, Drover, posts with heavy strike) |
| equilibrium band, fresh / L1 / L2 / L3 / L4 / L5 | 0 / 0 / 2 / 3 / 2 / 6 | 3 / 3 / 3 / 4 / 7 / 7 (break-even 67 %) |
| trip EV best bank point (skilled, at equilibrium) L1 / L2 / L3 / L4 | +1,189 k=2 / neg / neg / neg | +4,539 k=3 / +3,239 k=3 / +2,327 k=4 / −3,932 |
| owner loot per held fight vs per overrun | 536 vs 1,559 | 505 vs 1,777 (28 %) |
| breaker: worst share of a segment per unit per tick | — | 50.0 % (= cap) |

Not met: positive trip EV for 8 × L4. No Reputation split from +15 to +6 reaches it, because an
L4 circle loses about 1.2 units a HELD band-7 fight (≈ 5,800 Coin of de-merges against 1,925 of
Coin), so it is negative before any overrun (BALANCE-LOG.md target 4). The weekly free earn
derivation is unchanged at 55,000 (1.09× ceiling, bound 1.5×).

Open for the play test's telemetry (chunk 32 dashboards), no mechanic change now: the `core`
targeting stance dominates offense (held 1–40 % in bands 3–7 against 35–100 % for the other
stances — watch the live stance mix and hold rate by stance); healing in a four-healer turtle
offsets 40 % of post damage, over the 25–35 % target (watch the healing share in real circles);
8 × L4 trip EV; and the sweep's band-typical roster assumption.

**Definition of done.** No single type predicts outcomes above threshold in the sweep,
the alpha's bank-versus-push curve shows real decisions at encounters two through five,
and the grind-wall dashboard shows the paid path as optional across deciles.

## 38. Release QA and launch readiness — **M**, last

**Constraints.**
- The full adversarial pass PROJECT.md §21 requires "before declaring MVP-complete":
  every guardrail probe in `GUARDRAILS.md`, run against the integrated game, not chunk
  by chunk.
- Security review: auth, purchase service, admin tooling, every server-validated
  boundary from chunks 05, 07, 09, 18, and 20.
- Legal: privacy policy, terms, age rating questionnaire, regional consent flows.
- Store listings, screenshots from the real build, and a support channel.
- Rollback rehearsal: a bad resolver release must be revertible without invalidating
  logs written in between (resolver version per log makes this possible; rehearse it).

---

# Group B — replayability systems (each needs a PROJECT.md amendment)

The ladders cap at rung 20 and the webs are mostly bought by then. After that point
the only loops left are Reputation, which is a rating rather than a goal, and the
collection, which is finite. These chunks add goals without adding power. **Every
reward in this group is Coin within the storage cap, or a cosmetic. Nothing here
touches a stat, a slot, unlock points, ladder progress, or access.**

## 39. Seasons and Reputation leaderboards — **M**, after 04, 28, 32

**Proposal.** A season is a fixed window, default 6 weeks, tunable. At season end
**Reputation soft-resets** toward `REPUTATION_START` by a tunable fraction. **Ladders,
unlock points, and web nodes are untouched** (guardrail 3 makes this non-negotiable).
Two leaderboards per season: **deliveries** (caravan-side: banked Coin, longest banked
trip) and **strikes** (party-side: overruns, Reputation held). Both are cosmetic-only:
a banner and a town decoration at tiered cutoffs, previewable from the season's first
day. Rank cutoffs are visible; nothing is hidden.

**Why it fits.** Reputation is already described as volatile and contestable. A
periodic pull toward the center keeps matchmaking bands healthy and gives the
post-cap player a recurring reason to climb. The Old West framing writes itself: the
season is a "wanted" cycle, the strikes board is the bounty wall.

**Amendment needed.** PROJECT.md §5 must state that Reputation is seasonal and that
seasons never touch ladders; §16 must list seasonal cosmetics as a cosmetic source
alongside packs.

**QA checks.** Guardrail 3: does the reset touch anything permanent? Guardrail 2: can
Coin buy rank? Guardrail 4: are cutoffs and rewards previewable from day one?

## 40. Contracts (weekly deterministic goals) — **M**, after 15, 19, 28

**Proposal.** A fixed set of contracts per week, identical for all players and
published a week ahead: "bank a trip of 4+ encounters", "hold against a party fielding
two siege pieces", "overrun a caravan with a party using only one region's units".
Rewards are **Coin within the cap** and a rotating cosmetic. No contract may require a
purchase, a specific unlocked type the player lacks, or a trip-cap use beyond the
normal cap. Contracts are generated deterministically from the week number so the
schedule is reproducible and auditable. Daily contracts are deliberately **not**
proposed: the trip cap already paces play, and daily goals would push toward
login-for-the-sake-of-it.

**Amendment needed.** New §14 Coin source. State the weekly Coin from contracts as a
fraction of free weekly earn so chunk 20's ratio stays honest.

## 41. Content cadence and web expansion — **L**, ongoing after launch

**Proposal.** New living-unit types, traps, siege pieces, and fence tiers added on a
published cadence, default every 8 weeks, tunable. Each drop extends a web with new
nodes and **extends the ladder by rungs** that grant the points to reach them, so the
post-cap player gets a new ladder to climb through play, and no existing node's cost
changes. Authored parties (chunk 25) are updated in the same drop so the new content
appears in the pool immediately. Every drop runs the matchup sweep (chunk 37) before
release.

**Rules.** A new node is never purchasable with Coin. A new type's ability is one of
the six archetypes; a seventh archetype is a design decision with its own review. A
new region is a content drop of 8 living-unit types and a palette, and requires no
schema change if chunk 01 was right.

**Amendment needed.** PROJECT.md §5 and §6 must state that ladders and webs grow with
content drops and that growth is never retroactive on earned points.

## 42. Social surfacing: party records and sharing — **S**, after 22, 29

**Proposal.** A public **party record** per account: strikes, overruns, longest stand
against, and a pinned replay chosen by the owner. Replays shareable by link, viewable
without an account. Scouting already exposes everything a party is, so there is no new
information leak; this is about letting a player show off the thing they built, which
is the King of Thieves hook turned outward. Friends list with "watch their replays" and
"see their party" only. **Clans, chat, and gifting are explicitly not proposed**; the
first two add moderation cost the game does not need, and gifting is a Coin transfer
path (chunk 31).

**Amendment needed.** A short §1 note that party records are public by default with an
opt-out.

## 43. Multiple standing parties — **M**, after 09, 39

**Proposal.** Chunk 09 sets `PARTIES_PER_ACCOUNT` to 1 and asks the schema to allow
more. Raise it to 3, with **one active at a time**. Switching is free and instant, like
editing. The point is letting a player keep a counter-build ready for a different
Reputation band after a seasonal reset, not fielding more parties at once; serving
multiple parties from one account would multiply that account's Coin intake from the
passive side and skew the earn ratio.

**Amendment needed.** PROJECT.md §10, one sentence.

## 44. Spectator and scouting ladder — **S**, after 39

**Proposal.** A browsable view of the top-ranked parties of the season, fully scoutable
like any encounter, for study. No action is possible from it; it is a library. This
makes the metagame legible, which is the direction the whole design leans.

## 45. Offline trip planning — **S**, after 23

**Proposal.** Allow outfitting and party editing while offline under the PWA, queued
and validated server-side on reconnect. A fight never resolves offline. This is a
mobile-convenience item, not a mechanic, and needs no amendment; it is listed here
because it depends on the replay and trip screens being settled.

---

# Group C — the deferred list (PROJECT.md §19)

These are designed in outline already. Each should get its own chunk brief when
scheduled, in the shape of the existing chunk files.

## 46. Multi-caravan — **L**, after group A is `done`

A second caravan is a second region, run independently, from the same town. Chunk 01's
schema already supports it. New work: caravan switcher in town, per-caravan trip state,
per-caravan living-unit progress shown separately, and a hard rule that the standing
party (account-level) can draw living units from **one caravan's roster at a time**.
This is the largest single replayability extension because it restarts the living-unit
ladder, web, and collection from zero with a different roster while keeping everything
account-level. Guardrail 5 is what makes this cheap; verify it was honored before
starting.

*Chunk 09 QA D1:* the standing party's living-type access check is today the **union**
over the account's caravans (`partyAccessCheck` in `apps/server/src/party/service.ts`) —
exact with one caravan, an over-approximation with several same-region caravans. When
this lands, tighten it to `access(instance.caravanId)` per unit, which also enforces the
"one caravan's roster at a time" rule above.

## 47. Prestige for maxed units — **M**, after 41

"Reset with a permanent upgrade." The only design that survives guardrail 2 is a
**cosmetic and slot-neutral** prestige: a level-5 unit can be prestiged back to level 1
with a permanent visual mark and a ladder bonus, never a stat. Anything that makes the
prestiged unit stronger than a fresh level 5 breaks the merge guardrail. Propose the
cosmetic version or do not build it.

## 48. Duplicate recycling — **S**, after 18

Recycling excess instances for points toward new instances is acquisition pace within
the unlocked pool, which is exactly what Coin already does. Propose implementing it as
**a fixed Coin refund per instance level**, which keeps it inside the existing economy
with no new currency and no new access path. Guardrail 3 check: recycling must not
produce points spendable on the web.

## 49. Campaign mode — **L**, last, with a research gate

The monthly Oregon-Trail-style permadeath run with its own roster. Mechanically it
reuses the resolver, the circle, and the trip loop with an authored encounter list
instead of matchmaking, and keeps its own ladder and roster separate from the core
loop. **It must not start until the writing and research requirement in PROJECT.md §19
is met**: named, distinct Indigenous groups with real identity, an ongoing relationship
tracked across encounters, branches that differ in kind, a culturally specific trust
token, and tone that carries weight. That is a research and writing deliverable with
its own review before any engineering chunk is opened. The schedule should treat it as
a separate project that shares a codebase.

---

# Proposed sequencing

| Phase | Chunks | Gate to next phase |
|---|---|---|
| **1. Core** | 01–20 as in INDEX.md, with **21** started alongside 01, **26** alongside 08, and **28** before 20 | Every chunk `done`; determinism harness green |
| **2. Shippable** | 22, 23, 24, 25, 29, 30, 32, 36 | A fresh account can be onboarded, play a trip, be struck, and be notified |
| **3. Store-ready** | 27, 31, 33, 34, 35, 37 (alpha), 38 | Store review passed; alpha balance sign-off |
| **4. Replayable** | 39, 40, 41 (first drop), 42, 43 | Each with its PROJECT.md amendment merged first |
| **5. Deep** | 44, 45, 46, 47, 48, then 49 behind its research gate | Design review per item |

**Parallelizable:** 21 with 01; 26 with 08–12; 28 with 16; 30 with 02; 32 with 13; 35
with any UI chunk; 25 with 14.

**Critical path to a storefront build:** 01 → 02 → 03 → 07 → 10 → 11 → 12 → 13 → 14 →
15 → 19 → 23 → 24 → 34 → 38. Everything else hangs off it.

# What this document does not do

It does not change a mechanic, a number, or a guardrail. Where a chunk in group B
proposes something PROJECT.md does not contain, the chunk says so and names the
amendment; nothing in group B is to be built on this document alone. Group A can be
scheduled now.
