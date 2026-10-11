# Caravan Vaults — Implementation Roadmap

Master ordering. An orchestrating session reads this file first to decide what to
hand out next. Every Maker and QA session also reads
[GUARDRAILS.md](GUARDRAILS.md) in full, every time.

**Status values:** `not started` → `in progress` → `built` → `QA'd` → `done`
(`built` = Maker says it works; `QA'd` = adversarial review passed; `done` = findings
from QA are closed out.)

**Handoff rule:** after each chunk reaches `built`, hand off to QA before starting
any chunk that depends on it. Independent chunks may proceed in parallel.

**Which way round the game runs.** The active experience is **defense**: the player
escorts a caravan on a trip and arranges their wagon circle against each scouted
attacking party. The passive layer is **offense**: a standing raiding party, configured
in town, served as an encounter in other players' trips. The home town is never
attacked. PROJECT.md was corrected for this — see its revision note — and
[GUARDRAILS.md §0](GUARDRAILS.md) states it in full. Read that before anything else;
building the mirror image of this game is the easiest mistake available.

**Settled decisions** (not in PROJECT.md; agreed during roadmap planning):

- TypeScript monorepo with a pure, dependency-free fixed-point resolver package.
  Web-first, mobile-shaped.
- **Presentation:** 2D isometric, on a natural island with decorative topographical
  tiers and cliff edges. The play area is **flat level ground in the center**; the
  tiers are inert scenery the resolver never sees. The grid is shown **only while
  something is being dragged onto it**, on every surface.
- **Battles** are continuous free movement with attacks and abilities on automatic
  cooldowns — one ability per unit type, from six archetypes. A healer archetype
  exists deliberately, bounded by finite non-regenerating charges so attrition
  still bites.
- **Three distinct places, one renderer**: the home town (static, merging, chunk 17),
  the wagon circle on the trail (per-encounter arrangement, chunk 08), and the battle
  replay (continuous, chunk 13). The isometric renderer is built once in chunk 08 and
  reused; the places themselves are never merged.

---

## Chunk list

| # | Chunk | One-line summary | Depends on | Status |
|---|-------|------------------|------------|--------|
| 01 | [Data model & auth scaffolding](chunks/01-data-model-and-auth.md) | Account/caravan schema with the load-bearing progress split, plus minimal auth. | — | done |
| 02 | [Event ledger & job queue](chunks/02-ledger-and-job-queue.md) | Append-only event log for Coin/Reputation/outcomes, and the one-shot resolution job queue. | 01 | done |
| 03 | [Content data & tunables registry](chunks/03-content-data-and-tunables.md) | Living units (per region), traps, siege, abilities, affinity matrix — all balance numbers in one tunables file. | 01 | done |
| 04 | [Ladders & Reputation](chunks/04-ladders-and-reputation.md) | Per-pool use-driven ladders granting permanent unlock points; separate volatile Reputation number. | 01, 02 | done |
| 05 | [Unlock webs (data + spend)](chunks/05-unlock-webs.md) | Three visible non-random webs; spending granted points to gain *access* (not instances). | 03, 04 | built |
| 06 | [Unlock web UI](chunks/06-unlock-web-ui.md) | Browsable web view for all three pools with costs visible before spending. | 05 | not started |
| 07 | [Wagon circle model](chunks/07-wagon-circle-model.md) | Trip-locked manifest vs. per-encounter formation; fence segments with HP and forced gaps, trap and post placement, carry-forward attrition. | 03 | built |
| 08 | [Encounter formation UI](chunks/08-encounter-formation-ui.md) | **The primary gameplay screen.** Scout the incoming party, arrange the circle against it, commit. Also builds the shared isometric renderer. | 07, 05, 14 | not started |
| 09 | [Standing raid party](chunks/09-standing-raid-party.md) | The passive side: a party configured in town, never consumed, served into other players' trips, plus its results feed. | 03, 05, 07 | not started |
| 10 | [Resolver core: tick loop & movement](chunks/10-resolver-core.md) | Fixed-timestep engine, continuous fixed-point movement, lattice pathing, fence collision. **Highest-risk chunk — build and test in isolation.** | 03, 07 | not started |
| 11 | [Resolver combat: damage, traps, posted units](chunks/11-resolver-combat.md) | Cooldown-paced damage + affinity, swept-path trap triggers, posted-unit aggro/leash pursuit, siege counters. | 10 | not started |
| 12 | [Unit abilities](chunks/12-unit-abilities.md) | Six deterministic ability archetypes firing on automatic cooldowns, one per unit type. | 11 | not started |
| 13 | [Resolver outcomes & replay](chunks/13-resolver-outcomes-and-replay.md) | End conditions, depth-scaled loot, the event/waypoint replay log, and the determinism harness. | 12 | not started |
| 14 | [Matchmaking & scouting](chunks/14-matchmaking-and-scouting.md) | Reputation-banded selection of standing parties as encounters; 3 fully-scoutable candidates, free time-gated reroll, escalating difficulty. | 04, 09 | not started |
| 15 | [Trip loop](chunks/15-trip-loop.md) | Encounter chaining, bank/push, carry-forward attrition with no resupply, hourly trip cap. | 07, 13, 14 | not started |
| 16 | [Economy: Coin](chunks/16-economy-coin.md) | Earn/spend/passive trickle/storage cap, and the merge system it pays for. | 02, 03 | done |
| 17 | [Home town](chunks/17-home-town.md) | The safe settlement: static merge board, the mine visualizing passive Coin, outfitting a caravan, and navigation. Never attacked. | 03, 08, 16 | not started |
| 18 | [Unit acquisition](chunks/18-unit-acquisition.md) | Refugee drip (choice of 3, Coin reroll) and mercenary recruit (exact pick, Coin) — both gated by the web. | 05, 16 | built |
| 19 | [Stakes & loss wiring](chunks/19-stakes-and-loss.md) | Per-death merge-level regression, total loss when overrun, unbanked-Coin transfer to the winning party's owner. | 13, 15, 16 | not started |
| 20 | [Monetization packs](chunks/20-monetization-packs.md) | Weekly rotating $5/$10/$25 packs, fixed and previewed contents, sandboxed purchase flow. | 16 | not started |

---

## Notes on the ordering

- **Chunks 10–13 are the spine.** They are the split of PROJECT.md §21's single
  "deterministic tick resolver" item, which was far too large for one sitting —
  more so now that battles are continuous rather than tile-stepped. They must be
  built and tested against synthetic fixture layouts **before** matchmaking (14) or
  the trip loop (15) depend on them.
- **Chunk 12 (abilities) is an addition to PROJECT.md**, agreed during planning.
  Scope is deliberately fixed at one ability per unit type from six archetypes.
  It sits after combat because it is the riskiest thing layered onto the riskiest
  code, and it should not be started until 11 is `QA'd`.
- **Chunk 01 must be right the first time.** The account-vs-caravan split is a
  migration hazard, not a refactor.
- **Chunk 08 is the game.** It is the primary gameplay screen and deserves the most
  design attention of any UI chunk. It depends on 14 because a formation is arranged
  against a *scouted specific attacker* — without matchmaking there is nothing to
  arrange against.
- **Chunk 17 (home town) carries open questions** in its file, including whether the
  mine ever becomes upgradeable. Proposed defaults are given; the mine one is a
  monetization guardrail, not a feature decision.
- **Parallelizable pairs:** 06 with 07; 09 with 10; 16 with 14.
- **Chunk 19 is the last integration chunk** — it wires together the resolver, the
  trip loop, and the economy. Expect it to surface findings in all three.

## Phase 2 — everything after the core (chunks 21–49)

Chunks 01–20 build the core loop. They do not cover onboarding, notifications,
cosmetics as a system, art and audio, store billing, mobile packaging, telemetry,
live-ops tooling, account lifecycle, release QA, or anything that keeps a player going
after the ladders cap. [PHASE-2.md](PHASE-2.md) specs all of that, in three groups:

| Group | Chunks | Design status |
|---|---|---|
| A. Missing v1 engineering | 21–38 | No design change; schedulable now. 21 starts with 01, 26 with 08, 28 before 20. |
| B. Replayability systems | 39–45 | Each needs a short PROJECT.md amendment first. |
| C. The deferred list | 46–49 | Multi-caravan, prestige, recycling, campaign (research-gated). After A is `done`. |

Status notes: **21** (build, CI, deploy pipeline) — `done` 2026-10-11 — verified by the live workflow runs on this branch (runs 2–5 green; run 6 red on the known chunk 16/03 ordering issue, fixed in 0b1d787). Deploy step deferred until a hosting target is chosen.

Status for these chunks is tracked in PHASE-2.md until a chunk is assigned, at which
point it gets its own `chunks/NN-*.md` brief and a row in the table above.

## Deferred — do not build in Phase 1

Multi-caravan, prestige/reset, duplicate recycling, campaign mode. Schema in chunk 01
must *accommodate* multi-caravan; nothing else may anticipate these. They are specced
as group C in [PHASE-2.md](PHASE-2.md) and stay out of scope until that phase.
