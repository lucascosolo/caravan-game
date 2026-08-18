# Caravan Vaults — Implementation Roadmap

Master ordering. An orchestrating session reads this file first to decide what to
hand out next. Every Maker and QA session also reads
[GUARDRAILS.md](GUARDRAILS.md) in full, every time.

**Status values:** `not started` → `in progress` → `built` → `QA'd` → `done`
(`built` = Maker says it works; `QA'd` = adversarial review passed; `done` = findings
from QA are closed out.)

**Handoff rule:** after each chunk reaches `built`, hand off to QA before starting
any chunk that depends on it. Independent chunks may proceed in parallel.

**Settled decisions** (not in PROJECT.md; agreed during roadmap planning):
TypeScript monorepo with a pure, dependency-free fixed-point resolver package.
Web-first, mobile-shaped. The grid is a placement lattice only; battles are
continuous free movement with attacks and abilities on automatic cooldowns —
one ability per unit type, from six archetypes.

---

## Chunk list

| # | Chunk | One-line summary | Depends on | Status |
|---|-------|------------------|------------|--------|
| 01 | [Data model & auth scaffolding](chunks/01-data-model-and-auth.md) | Account/caravan schema with the load-bearing progress split, plus minimal auth. | — | not started |
| 02 | [Event ledger & job queue](chunks/02-ledger-and-job-queue.md) | Append-only event log for Coin/Reputation/outcomes, and the one-shot resolution job queue. | 01 | not started |
| 03 | [Content data & tunables registry](chunks/03-content-data-and-tunables.md) | Living units (per region), traps, siege, abilities, affinity matrix — all balance numbers in one tunables file. | 01 | not started |
| 04 | [Ladders & Reputation](chunks/04-ladders-and-reputation.md) | Per-pool use-driven ladders granting permanent unlock points; separate volatile Reputation number. | 01, 02 | not started |
| 05 | [Unlock webs (data + spend)](chunks/05-unlock-webs.md) | Three visible non-random webs; spending granted points to gain *access* (not instances). | 03, 04 | not started |
| 06 | [Unlock web UI](chunks/06-unlock-web-ui.md) | Browsable web view for all three pools with costs visible before spending. | 05 | not started |
| 07 | [Camp layout model](chunks/07-camp-layout-model.md) | Placement lattice, fence segments with HP and deliberate gaps, trap/garrison placement and validation. | 03 | not started |
| 08 | [Camp builder UI](chunks/08-camp-builder-ui.md) | Defense configuration screen; persists until edited; produces the scoutable layout. | 07, 05 | not started |
| 09 | [Raid party builder](chunks/09-raid-party-builder.md) | Trip-locked composition + per-unit stance; per-stop approach edge and start positions. | 03, 07 | not started |
| 10 | [Resolver core: tick loop & movement](chunks/10-resolver-core.md) | Fixed-timestep engine, continuous fixed-point movement, lattice pathing, fence collision. **Highest-risk chunk — build and test in isolation.** | 03, 07 | not started |
| 11 | [Resolver combat: damage, traps, garrison](chunks/11-resolver-combat.md) | Cooldown-paced damage + affinity, swept-path trap triggers, aggro/leash pursuit, siege counters. | 10 | not started |
| 12 | [Unit abilities](chunks/12-unit-abilities.md) | Six deterministic ability archetypes firing on automatic cooldowns, one per unit type. | 11 | not started |
| 13 | [Resolver outcomes & replay](chunks/13-resolver-outcomes-and-replay.md) | End conditions, depth-scaled loot, the event/waypoint replay log, and the determinism harness. | 12 | not started |
| 14 | [Matchmaking & scouting](chunks/14-matchmaking-and-scouting.md) | Reputation-banded target selection, 3 candidates, free time-gated reroll, post-raid shield, away-caravans excluded. | 04, 08 | not started |
| 15 | [Trip loop](chunks/15-trip-loop.md) | Stop chaining, bank/push, cross-stop attrition, untargetable-while-away, hourly trip cap. | 09, 13, 14 | not started |
| 16 | [Economy: Coin](chunks/16-economy-coin.md) | Earn/spend/passive trickle/storage cap, and the merge system it pays for. | 02, 03 | not started |
| 17 | [Unit acquisition](chunks/17-unit-acquisition.md) | Refugee drip (choice of 3, Coin reroll) and mercenary recruit (exact pick, Coin) — both gated by the web. | 05, 16 | not started |
| 18 | [Stakes & loss wiring](chunks/18-stakes-and-loss.md) | Per-death merge-level regression, full loss on wipe, unbanked-Coin transfer capped by defender storage. | 13, 15, 16 | not started |
| 19 | [Monetization packs](chunks/19-monetization-packs.md) | Weekly rotating $5/$10/$25 packs, fixed and previewed contents, sandboxed purchase flow. | 16 | not started |

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
- **Parallelizable pairs:** 06 with 07; 09 with 10; 16 with 14.
- **Chunk 18 is the last integration chunk** — it wires together the resolver, the
  trip loop, and the economy. Expect it to surface findings in all three.

## Deferred — do not build

Multi-caravan, prestige/reset, duplicate recycling, campaign mode. Schema in chunk 01
must *accommodate* multi-caravan; nothing else may anticipate these.
