# Studio review: the merged, prioritized picture

Written 2026-10-20 at the end of the cloud session, for the owner and the next session (on the
owner's PC). It merges four sources into one ranked list and names the decisions only the owner
can make. The sources hold the evidence; this file holds the order.

| Source | Reviewer role | Verdict |
|---|---|---|
| `roadmap/qa/confirmation-playtest.md` and `confirmation-guardrails.md` | Adversarial play-test and guardrail confirmation | **READY for the play test** (both, at e002854) |
| `studio-design.md` | Senior game designer, greenlight review | **Not ready for soft launch; greenlight a depth milestone first** |
| `studio-feel.md` | UX and game-feel lead | **A rigorous rules prototype in a settings-app costume**; about 8–12 weeks of polish, art included |
| `studio-liveops.md` | Live-ops and economy lead | **Ready for the closed balance alpha; not ready for soft launch**; economy breaks in week 1 |
| The orchestrator's own pass | Things the reviews touch only in passing | Folded in below, marked "own pass" |

## The verdict in one paragraph

The game is ready for what it was built for: a closed play test that answers "is the loop fun?".
It is not a game a studio would soft-launch yet. All three studio reviewers agree on that.
Separately, they also agree on why:
- the first hour is good, but the long game has nothing to hold it;
- the economy floods and then discards Coin;
- the menu, the circle and the stance each collapse to a dominant choice;
- the passive side rewards looking weak;
- there is no reason to come back on a given day, nor anyone to come back for;
- nothing the player sees or hears feels like a game yet.

None of the fixes crosses a guardrail. Several need a PROJECT.md amendment first, and those are named below.

## Where the reviews converge

When two or three independent reviewers find the same problem from different directions, it is
real. These six themes cover nearly every P0 finding.

| Theme | Design | Feel | Live-ops | Play test | Own pass |
|---|---|---|---|---|---|
| **A. Coin floods, sinks don't hold, progress is a sawtooth** | F4 (cap by day 3, pushing worthless), F5, F6 (all 6 merging accounts weaker on day 20 than on day 3), F13 | — | F1 (cap on day 7 casual, day 3 hardcore; ~80 % of earnings destroyed), F2 (merges don't stick; L4+ loses Coin), F5, F7, F8 | — | L4 EV negative; no Coin sink |
| **B. Every decision has a dominant answer** | F1 (pick the softest of three, 76–86 %), F2 (three shapes, all on `guard`), F3 (solver predicted 1,731/1,731), F8 (the stance alone decides from mid game) | — | — | D2 (every first trip is the same shape: bank at 2 for 1,658) | Core-stance dominance; traps are free to pack; safer advice halves Coin |
| **C. The passive side is backwards** | F7 (weak parties served 256–338 times, earning 4–5× the Coin of strong ones) | — | F4 (passive income is an uncounted faucet), F9 | D1 (live parties never win, 46/46) | — |
| **D. Losing is too expensive, and the rating doesn't catch you** | F10 (one overrun erases days; can't turn back before encounter 1) | — | F10 (≥1 trip in 3 ends in an overrun at equilibrium) | N3 (the reserve is one tap from gone) | Band-2 cliff (100 % → 63 %) |
| **E. No reason to return, no one to return for** | F9 (no social, competitive or push) | — | F11 (no daily or weekly reason, no push), F12 (seasons), F13 (collections) | — | Push deferred; no seasons, contracts or social |
| **F. Nothing feels like a game** | F12 (first hour teaches a habit, then a cliff), F14 (~45 taps per fight) | Top 10: art, audio, replay camera, impacts, rewards, motion, layout, FTUE, contrast (1.1–1.5:1), voice | F14 (cosmetics have no art or render path) | — | — |

Two more themes come from one reviewer each, and both are P0 for a soft launch:
- **G. Operability (live-ops F19, F22, F24).** Nothing can change without a deploy. There are no support tools. The dashboard answers balance questions, not KPI ones. **Own pass:** chunk 31 (anti-abuse) is not built. Free guest accounts make Coin-transfer collusion possible through overruns. No hosting target has been chosen.
- **H. Monetization (live-ops F15, F18).** The store sells the currency players discard. Real payments are not built. The store stays `off` until this is decided.

## The ranked plan

Ranked work for the PC session and after, in order. Each item cites its source finding, and
sizes are PHASE-2's T-shirt sizes.

### Tier 0: before or during the play test (small, no design change)

These make the play test itself better, and none needs a decision.
1. **Play-test nits N1–N6** (confirmation-playtest.md). Each is S:
   - N1: disable "Pack and ride out" when over the slot cap;
   - N2: remember the commit before the request;
   - N3: "Tick the guide's 5";
   - N4: two copy fixes;
   - N5: "0 unbanked Coin";
   - N6: the skip-guide copy.
2. **The feel review's "if only a week" set:** Phase A steps 1, 2, 4, 5 and 7. They need no art:
   - the voice pass and number formatting;
   - sticky action bars and the first-session dead ends;
   - replay bookends;
   - getting prompts off the reward screens;
   - the canvas legibility patch, which fixes the 1.1:1 contrast and the deuteranopia failure.

   ART-PLAN step 2 is the same patch.
3. **Instrument before deciding** (live-ops F10, F24). Add the return-after-overrun panel, cohorts and a KPI export, so the play test measures themes A–D instead of guessing them.

### Tier 1: the depth milestone (the soft-launch blockers)

This tier is the design review's adds 1–5 merged with the live-ops P0 economy fixes. They are ordered so each one makes the next one's measurement meaningful.

| # | Work | Fixes | Size | Needs |
|---|---|---|---|---|
| 1 | **Bounty-priced menus:** soft, fair and dangerous cards at ×0.6–×2.2, with owners paid more when picked as the dangerous card | B (F1), C (F7) | M | Amend §14, §17 |
| 2 | **Stance fix:** a core runner commits (no attacks, takes more damage, a breach timer); `traps` raiders disarm; hold and reserve get real jobs | B (F8, F2b) | M | Amend §11; resolver bump; balance pass |
| 3 | **Scout the trail ahead:** see the next menu before pushing, one free reroll, smoother escalation, depth rewards that don't cap | A, B (F4) | S–M | Amend §2, §12, §17 |
| 4 | **Softer losses:** survivors of an overrun lose one level instead of being destroyed ("scatter, not slaughter"), a rating cool-off, and turning back before encounter 1 | D (F10; live-ops F2a, convalescence, is the alternative) | M | Amend §13, §17; **owner picks scatter or convalescence** |
| 5 | **Economy re-tune:** the mine buffer and near-cap notice, flattened living and trap curves, 8 × L3 made stable, and §14 amended so the trickle's purpose is restated | A (live-ops F1, F2, F5, F7) | M | Tunables plus one amendment; re-run the 90-day model (`models/ninety-day-economy.ts`) |
| 6 | **Web push plus revenge** on the party that overran you; Wanted posters on parties | E, C (design F9, add 1; live-ops F11) | M | Push is chunk 34 (PWA) as written. A Coin bounty is a transfer path, so **chunk 31 comes first** (live-ops F6). A no-Coin "revenge marker" can ship before it. |
| 7 | **Chunk 31 integrity and anti-abuse** | G (own pass) | M | Blocks any Coin transfer between players (bounties, revenge payouts) |

**The ship gate for tier 1** (from the design review, §7). Re-run the design reviewer's probes after the tier and require all of:
- no single stance optimal in more than 70 % of matchups;
- a scout-blind circle holds under 40 % from band 3 up;
- no endgame party shape held below 15 % or above 85 %;
- the median engaged account's day-20 roster is stronger than its day-5 roster;
- a strong standing party earns at least as much as a weak one.

The probes are `read-value`, `endgame.mts` and `cohort.mjs`. They were written in the cloud session's scratchpad and were not committed. Rebuilding them on top of `scripts/balance/sweep.ts` is part of this tier.

### Tier 2: presentation (runs in parallel with tier 1)

The feel review's phases B to D and the art plan run together. Neither touches the resolver,
matchmaking or the ledger: effects read log rows.

1. **Art bible follow-ups** (ART-PLAN step 1):
   - collect the public-domain references;
   - run the palette's contrast and colour-blind checks;
   - write `scripts/art/prompt-lint`.
2. **Phase B feel work:**
   - the camera director (follows the action, punches in on key moments);
   - impact effects from log rows;
   - reward sequences;
   - the minimum audio set, code-synthesised first, plus haptics;
   - the stakes card and results redesign.
3. **Art:**
   - key art via Wiro (about 6 explorations, then lock one);
   - the Desert vertical slice through the `iso/skins.ts` seam, which needs §26 to draw sprites first;
   - **gate:** the slice must read well in a real replay on a phone before credits go on the full roster.
4. **The full roster, the town diorama** (feel #12) and the other three regions (ART-PLAN steps 5–7).
5. **Phase D:**
   - the show-don't-tell first session, including design F12's "Draft for me" with one required change;
   - layout presets (design F14);
   - the threat readout (design F11);
   - navigation, accessibility and an on-device performance pass.

### Tier 3: the long game and operability (before a wider launch)

1. **Live-ops tooling** (live-ops F19, F22, F20):
   - server-driven config and flags for **non-resolver** values only (resolver tunables change only through a RESOLVER_VERSION bump, guardrail 1);
   - an account inspector with suspend and refund;
   - event scheduling.
2. **Trail conditions and a weekly "Rule of the Trail"** (design F2a, F5b, add 6):
   - seeded, scouted terrain and weather for each encounter;
   - **this changes the settled "flat level ground" decision**, so it needs an explicit owner sign-off.
3. **The owner's workshop** (design F7c–e; PHASE-2 chunk 43): a proving ground against benchmark circles, a party report and saved parties.
4. **The long tail without prestige** (design F6, live-ops F8):
   - cosmetic mastery tracks;
   - "Trail Legend" levels past rung 20;
   - the outfit log;
   - **Coin sinks in town** (live-ops F6), the Outfitter and decorative town building.
5. **Seasons, contracts and volume-based boards** (chunks 39 and 40; design F3 says to design them so a solver gains nothing).
6. **Monetization** (live-ops F14, F15, F16, F18):
   - decide the cosmetic-first product (a season pass, direct cosmetics, a founder pack);
   - build the cosmetic render path;
   - choose a web payment provider.

   Until then `STORE_MODE` stays `off`.

### Not before soft launch

These were agreed across the reviews and are already the roadmap's rule:
- no multi-caravan (46), prestige (47), recycling (48) or campaign mode (49);
- no clans or chat;
- no Coin login rewards;
- no upgradeable mine or storage cap;
- nothing sold that touches the trip cap, rerolls, slots or the unlock web.

## Decisions only the owner can make

Each of these changes PROJECT.md or a settled roadmap decision. The reviews recommend an answer;
the owner decides.

1. **Solvability (design F3).**
   - **The issue:** the scout is the exact resolver input, so every fight is computable, and a fan-made solver will exist.
   - **Recommended:** keep full scouting (it is the legibility guardrail). Put uncertainty in what no one can compute, the trip chain and the population, and keep competitive boards volume-based.
   - **Rejected:** hiding information from the scout, which breaks guardrail 4.
2. **Softer losses (design F10 vs live-ops F2a).**
   - **Option 1, "scatter, not slaughter":** survivors lose a level instead of being destroyed. It is simpler and fixes the sawtooth at the root.
   - **Option 2, convalescence:** restore a lost level within 24 hours at 60 % of its cost. It keeps the sting and adds a Coin sink.
   - They can be combined, but only one should ship first, so the play-test data can tell them apart.
3. **Trail conditions (design add 6).** These reverse "flat level ground". They are the biggest single lever on replayability and the biggest balance cost.
4. **What the store sells (live-ops F15).** The recommendation is cosmetic-first: a season pass with no Coin, direct cosmetics and a founder pack. Coin packs stay as the "pace" option. Each is a §16 amendment.
5. **The style board's "Build your town" (ART-PLAN).**
   - **The fit:** live-ops F6 independently proposes decorative town building as a Coin sink, which matches the board's building-upgrade strip.
   - **The rule:** it fits only if it grants nothing and the mine stays excluded.
   - **What the owner decides:** whether the town grows from Coin, from progression, or both.
6. **Hosting target (own pass).** CI has no deploy step until one is chosen. `docs/PLAYTEST-HOSTING.md` covers hosting by hand.

## Open balance questions to read off the play test

These are recorded in `BALANCE-LOG.md` (repo root) and are still open. The play test's telemetry should answer them before tier 1 tunes anything:
- 8 × L4 EV is negative.
- Core-stance dominance.
- The healer turtle holds 44–47 %.
- Traps are free to pack.
- The band-2 cliff (100 % → 63 %).
- The safer advice halves Coin per trip.
- Live parties never win (46/46).
- First trips are uniform (1,658).
- Fast runners.

## Own pass: items no review owns

- **The leash reason is not in the tick log.** When a unit breaks off a chase, the replay cannot say why. It is a legibility gap for the impact effects in tier 2, and adding it is a log-format change, so it needs a resolver bump.
- **Free guest accounts plus overrun transfers** are the obvious collusion path (one player feeds another by losing on purpose). Chunk 31 is the fix, and it must land before any Coin moves between players by design (bounties).
- **Branch hygiene, the owner's call:**
  - `main` is behind `roadmap/phase-2-spec` and can be fast-forwarded;
  - every `origin/wip/*` branch is merged and can be deleted;
  - `origin/wt/t_2e8bcff2` and `origin/wt/t_737ea2f7` are August drafts of chunks 09, 16 and 17 from an earlier session, superseded by the merged chunks and safe to delete.
