# Caravan Vaults — Implementation Roadmap

Master ordering. An orchestrating session reads this file first to decide what to
hand out next. Every Maker and QA session also reads
[GUARDRAILS.md](GUARDRAILS.md) in full, every time.

**Status values:** `not started` → `in progress` → `built` → `QA'd` → `done`
(`built` = Maker says it works; `QA'd` = adversarial review passed; `done` = findings
from QA are closed out.)

**Handoff rule:** after each chunk reaches `built`, hand off to QA before starting
any chunk that depends on it. Independent chunks may proceed in parallel.

---

## Chunk list

| # | Chunk | One-line summary | Depends on | Status |
|---|-------|------------------|------------|--------|
| 01 | [Data model & auth scaffolding](chunks/01-data-model-and-auth.md) | Account/caravan schema with the load-bearing progress split, plus minimal auth. | — | not started |
| 02 | [Event ledger & job queue](chunks/02-ledger-and-job-queue.md) | Append-only event log for Coin/Reputation/outcomes, and the one-shot resolution job queue. | 01 | not started |
| 03 | [Content data & tunables registry](chunks/03-content-data-and-tunables.md) | Living units (per region), traps, siege pieces, affinity matrix — all balance numbers in one tunables file. | 01 | not started |
| 04 | [Ladders & Reputation](chunks/04-ladders-and-reputation.md) | Per-pool use-driven ladders granting permanent unlock points; separate volatile Reputation number. | 01, 02 | not started |
| 05 | [Unlock webs (data + spend)](chunks/05-unlock-webs.md) | Three visible non-random webs; spending granted points to gain *access* (not instances). | 03, 04 | not started |
| 06 | [Unlock web UI](chunks/06-unlock-web-ui.md) | Browsable web view for all three pools with costs visible before spending. | 05 | not started |
| 07 | [Camp layout model](chunks/07-camp-layout-model.md) | Grid, fence segments with HP and deliberate gaps, trap/garrison placement rules and validation. | 03 | not started |
| 08 | [Camp builder UI](chunks/08-camp-builder-ui.md) | Defense configuration screen; persists until edited; produces the scoutable layout. | 07, 05 | not started |
| 09 | [Raid party builder](chunks/09-raid-party-builder.md) | Trip-locked composition + per-unit stance; per-stop approach edge and start positions. | 03, 07 | not started |
| 10 | [Resolver core: tick loop & pathing](chunks/10-resolver-core.md) | Deterministic tick engine, stance-driven pathing, fence collision and chipping. **Highest-risk chunk — build and test in isolation.** | 03, 07 | not started |
| 11 | [Resolver combat: damage, traps, garrison](chunks/11-resolver-combat.md) | Damage formula + affinity layer, single-trigger traps, aggro/leash pursuit, siege counters. | 10 | not started |
| 12 | [Resolver outcomes & replay](chunks/12-resolver-outcomes-and-replay.md) | End conditions, depth-scaled loot, the tick log as replay, and the determinism test harness. | 11 | not started |
| 13 | [Matchmaking & scouting](chunks/13-matchmaking-and-scouting.md) | Reputation-banded target selection, 3 candidates, free time-gated reroll, post-raid shield, away-caravans excluded. | 04, 08 | not started |
| 14 | [Trip loop](chunks/14-trip-loop.md) | Stop chaining, bank/push, cross-stop attrition, untargetable-while-away, hourly trip cap. | 09, 12, 13 | not started |
| 15 | [Economy: Coin](chunks/15-economy-coin.md) | Earn/spend/passive trickle/storage cap, and the merge system it pays for. | 02, 03 | not started |
| 16 | [Unit acquisition](chunks/16-unit-acquisition.md) | Refugee drip (choice of 3, Coin reroll) and mercenary recruit (exact pick, Coin) — both gated by the web. | 05, 15 | not started |
| 17 | [Stakes & loss wiring](chunks/17-stakes-and-loss.md) | Per-death merge-level regression, full loss on wipe, unbanked-Coin transfer capped by defender storage. | 12, 14, 15 | not started |
| 18 | [Monetization packs](chunks/18-monetization-packs.md) | Weekly rotating $5/$10/$25 packs, fixed and previewed contents, sandboxed purchase flow. | 15 | not started |

---

## Notes on the ordering

- **Chunks 10–12 are the spine.** They are the split of PROJECT.md §21's single
  "deterministic tick resolver" item, which was too large for one sitting. They must
  be built and tested against a synthetic fixture layout **before** matchmaking (13)
  or the trip loop (14) depend on them.
- **Chunk 01 must be right the first time.** The account-vs-caravan split is a
  migration hazard, not a refactor.
- **Parallelizable pairs:** 06 with 07; 09 with 10; 15 with 13.
- **Chunk 17 is the last integration chunk** — it wires together the resolver,
  the trip loop, and the economy. Expect it to surface findings in all three.

## Deferred — do not build

Multi-caravan, prestige/reset, duplicate recycling, campaign mode. Schema in chunk 01
must *accommodate* multi-caravan; nothing else may anticipate these.
