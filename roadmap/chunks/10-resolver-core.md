# Chunk 10 — Resolver core: tick loop & movement

**Depends on:** 03, 07. **Status:** built.
Read `/roadmap/GUARDRAILS.md` in full first.

> **This is the highest-risk chunk in the project.** Build and test it in complete
> isolation — no database, no clock, no network, no framework — before anything
> depends on it. Everything downstream inherits its determinism or its bugs.

## Goal

The deterministic simulation core: given an attacking party and a wagon circle formation,
step the battle forward at a fixed timestep while units move **freely and
continuously** toward their stance targets, pathing around fences and chipping
through them. Combat and abilities are chunks 11–12; end conditions and the replay
log are chunk 13. This chunk is the skeleton those hang on.

## The simulation model

This is the part most likely to be built wrong, so it is stated first.

- **The grid is a placement lattice, not a movement grid.** It positions fences,
  traps, unit posts, and attacker start positions. It is also the graph the
  coarse pathfinder routes on. It does **not** constrain movement.
- **Units move continuously in fixed-point space.** They are **not locked to cells
  and the battle is not turn-based.** A unit advances a sub-cell distance every tick
  along its current path. The reference feel is a Clash of Clans attack: units stream
  toward their targets, flow around obstacles, and attack on cooldowns.
- **Continuous is not the same as unticked.** Resolution is still a fixed-timestep
  discrete pass, exactly as the design specifies — just a high tick rate with
  sub-cell movement per tick, rather than one cell per tick. "Not turn-based"
  describes the player's experience, not the engine.
- **Units do not collide with one another** — they overlap freely. Only fence
  segments and the map bounds obstruct movement. This removes a large class of
  nondeterminism, jitter, and deadlock, and matches the reference game.

## Design constraints that apply here

- **Fully deterministic. Runs once, server-side, as an internal tick pass — never
  shown live to either player.** Identical inputs always produce identical results.
- The resolver is a **pure function**: `(attacking party, formation) → outcome`.
  No I/O, no clock, no RNG, no ambient state, no dependency injection that could
  smuggle any of those in. It must be importable and runnable with zero setup.
- **There is no live/interactive combat for either player.** Nothing in the tick loop
  reads player input. Stances were locked before the fight; abilities fire on their
  own cooldowns; the player never intervenes.
- **Ticking happens once, instantly, per resolution call** — not continuously. Do not
  build a game loop or a scheduler.
- Every surviving attacker unit **paths toward its current stance target**, respecting
  fence collisions — moving through a gap if its route leads there, or chipping an
  intact segment's HP down if breaking through is the better route. Siege equipment
  accelerates or bypasses this against its countered fence category (values are
  chunk 11; the hook belongs here).
- The three stances determine the target: **nearest enemy**, **prioritize traps**, or
  **beeline for the caravan core**. Retargeting when a target dies or is spent must
  be defined explicitly and deterministically.

## Determinism requirements specific to this chunk

- **No floating-point arithmetic anywhere.** All positions, velocities, and distances
  are **fixed-point integers** at `FIXED_POINT_SCALE` (1/1024 cell, defined in chunk
  07). Continuous movement is precisely where float drift has historically destroyed
  deterministic RTS engines — this is not a stylistic preference.
- **Compare squared distances; never call `sqrt`** in a comparison. Where a magnitude
  is genuinely needed, use a deterministic integer square root.
- **`sin`, `cos`, `atan2`, `exp`, and `pow` are banned.** They are not correctly
  rounded and vary across platforms and engine versions. Movement along a path is
  computed by scaling an integer direction vector, not by trigonometry.
- **Explicit, stable tie-break rules**, documented in-file. Where two units could act
  in either order, where two paths are equally short, where two targets are equally
  near — resolution is fixed by a total ordering (ascending unit id is the design's
  stated fallback). "It never happens in practice" is not a tie-break rule.
- **No iteration over unordered collections.** Every loop that can affect outcome
  iterates a sorted, explicit sequence.
- Phase order within a tick is fixed and written down at the top of the file.
- Fixed-point division must have a documented rounding mode (floor toward negative
  infinity is the safest default) applied consistently.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `TICK_RATE` | 20 ticks/second | Fine enough that continuous movement looks smooth on playback, coarse enough to keep logs small. Fixed forever once golden logs exist — changing it invalidates every stored replay. |
| `BATTLE_LENGTH_CAP_SECONDS` | 180 seconds | Stalemate threshold, expressed in seconds because that is what a player experiences. |
| `TICK_CAP` | `BATTLE_LENGTH_CAP_SECONDS × TICK_RATE` = 3,600 | Derived, never authored separately. Reaching it favors the caravan (chunk 13). |
| `FIXED_POINT_SCALE` | 1/1024 cell | From chunk 07. Defined once, used everywhere. |
| `MOVE_SPEED_DEFAULT` | 1.5 cells/second → 76.8 units/tick at scale 1024 | Per-type override from chunk 03. The resolver converts cells/second to per-tick displacement once, at setup. |
| `PATHING` | coarse A* on the placement lattice, then continuous steering along the smoothed route | The Clash of Clans approach. Lattice A* keeps pathing cheap and deterministic; smoothing keeps movement from looking gridded. |
| `PATH_TIE_BREAK` | equal-cost lattice cells ordered by (lower row, then lower column) | Total ordering, documented. |
| `PATH_RECOMPUTE_INTERVAL` | every 10 ticks (0.5s), and immediately on target change or on a fence segment breaking | Not every tick — expensive and unnecessary. Must be a fixed interval, never event-timing-dependent. |
| `PATH_SMOOTHING` | string-pulling / line-of-sight shortcut across the lattice route | Deterministic integer line-of-sight test. |
| `FENCE_BLOCKS_PATHING` | intact segments are impassable to the pathfinder; breaking through is modeled as a traversable edge with a cost equal to the ticks needed to destroy it | Lets the pathfinder decide "break through" vs. "walk around" as a single cost comparison, rather than a hand-tuned threshold. |
| `RETARGET_RULE` | re-evaluate the stance target only when the current target becomes invalid (dead, spent, unreachable) | Prevents oscillation. Deterministic either way. |
| `TICK_PHASE_ORDER` | 1. retarget → 2. path recompute (if due) → 3. movement → 4. trap triggers → 5. posted-unit aggro/leash update → 6. attack cooldowns and damage → 7. ability cooldowns and effects → 8. death resolution | Chunks 11–12 fill phases 4–7. Fix the order now. |
| `UNIT_COLLISION` | none — units overlap | Only fences and bounds obstruct. |
| `UNIT_RADIUS` | 0.35 cells | Used for attack-range and ability-radius checks, not for collision. |

## Definition of done

- [ ] Resolver lives in an isolated package with **no** I/O, clock, RNG, or framework
      dependencies. A lint rule or dependency check enforces this, and a second rule
      bans float literals and the banned math functions inside the package.
- [ ] Fixed-point arithmetic helpers with a documented rounding mode; every position
      and distance goes through them.
- [ ] Fixed-timestep tick loop with the documented phase order.
- [ ] Coarse lattice A* plus continuous steering along the smoothed route; units move
      sub-cell distances per tick and are never snapped back to cell centers.
- [ ] All three stances produce correct target selection and pathing.
- [ ] Units route through deliberate gaps when that's the cheaper path, and chip
      intact segments when breaking through is cheaper. Fence HP decrements and
      segments break, which invalidates affected paths.
- [ ] A siege hook exists on fence damage for chunk 11 to fill.
- [ ] Every tie-break rule is documented in-file and covered by a test that would
      fail if the ordering changed.
- [ ] **Determinism harness (start it here, complete it in chunk 13):** the same input
      resolved 100× produces byte-identical tick logs; and resolving in a separate
      process produces the same result.
- [ ] A shuffled-input test: reorder the input arrays arbitrarily and assert the
      outcome is unchanged (or that ordering is explicitly part of the input contract
      and normalized on entry).
- [ ] Synthetic fixture layouts and loadouts exist for testing without a database.
- [ ] Tick cap terminates the loop (the *meaning* of hitting it is chunk 13).

## QA guardrail checks for this chunk

- **Determinism — the central check of the whole project:**
  - Re-run the same resolution 100× and byte-compare tick logs. Then across processes.
  - Grep the resolver package for `random`, `Date`, `now`, `performance`, `uuid`,
    `Set` / `Map` iteration, `Object.keys` on a dynamic object, `sort` without a
    comparator, and any async/parallel step. Each hit is a finding until disproven.
  - **Grep for float literals, `/` on non-fixed-point values, `Math.sqrt`, `Math.sin`,
    `Math.cos`, `Math.atan2`, `Math.pow`, `Math.hypot`.** Any hit inside the sim is a
    finding. This is the highest-yield check in this chunk.
  - Is fixed-point division rounding consistent everywhere, including for negatives?
- **The two spaces stayed separate:** are units ever snapped to cell centers during
  movement, or restricted to cell-to-cell steps? That would silently turn the battle
  back into a tactics grid and change what the player is watching.
- **Path recompute is time-driven, not event-timing-driven:** anything that
  recomputes paths at a variable cadence is a determinism hazard.
- **Tick-resolution edge cases:** ties in the deterministic tie-break rules — two
  equidistant targets, two units at identical positions, a unit exactly on a decision
  boundary, a fence breaking on the same tick a unit reaches it. Construct these
  deliberately; they will not appear by accident.
- **No live input:** confirm nothing in the tick loop reads player state, config, or
  anything outside its two arguments.
- **No pay-to-win:** confirm the resolver cannot see account, purchase, or entitlement
  state at all. If it can reach billing data even without using it, that boundary is a
  finding — resolution logic must be identical for paying and non-paying players.
- **Gaps work:** a layout with a deliberate gap must be routable through it. If the
  pathfinder treats a gap as a wall, the core defensive tradeoff is broken.
- **No deadlock:** with no unit-unit collision, units should never jam. Confirm a
  fully-enclosed core with no gap still terminates (by breaking through or by tick cap).
