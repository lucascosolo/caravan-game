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

## 23. Trip client flow — **M**, after 15, 17, 19

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
