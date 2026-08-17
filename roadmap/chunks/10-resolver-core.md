# Chunk 10 — Resolver core: tick loop & pathing

**Depends on:** 03, 07. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

> **This is the highest-risk chunk in the project.** Build and test it in complete
> isolation — no database, no clock, no network, no framework — before anything
> depends on it. Everything downstream inherits its determinism or its bugs.

## Goal

The deterministic tick engine: given an attacker loadout and a defender layout, step
the world forward one tick at a time, moving attackers along their stance-driven
paths and resolving fence collisions. Combat, traps, and garrison AI are chunk 11;
end conditions and replay output are chunk 12. This chunk is the skeleton those
hang on.

## Design constraints that apply here

- **Fully deterministic. Runs once, server-side, as an internal tick pass — never
  shown live to either player.** Identical inputs always produce identical results.
- The resolver is a **pure function**: `(attacker loadout, defender layout) → outcome`.
  No I/O, no clock, no RNG, no ambient state, no dependency injection that could
  smuggle any of those in. It must be importable and runnable with zero setup.
- **There is no live/interactive combat for either player.** Nothing in the tick
  loop reads player input. Stances were locked before the fight.
- **Ticking happens once, instantly, per resolution call** — not continuously. Do not
  build a game loop or a scheduler.

Per tick, in a fixed and documented phase order:

- **Every surviving attacker unit paths one step toward its current stance target**,
  respecting fence collisions — walking through a gap if aimed at one, chipping an
  intact segment's HP down if not. Siege equipment accelerates or bypasses this
  against its countered fence category (the effect values are chunk 11; the hook
  belongs here).
- The three stances determine the target: **nearest enemy**, **prioritize traps**,
  or **beeline for the caravan core**. "Current stance target" implies retargeting
  when a target dies or is spent — define that rule explicitly and deterministically.

Determinism requirements specific to this chunk:

- **Explicit, stable tie-break rules**, documented. Where two units could act in
  either order, where two paths are equally short, where two targets are equally
  near — the resolution must be fixed by a total ordering (unit id order is the
  design's stated fallback). "It never happens in practice" is not a tie-break rule.
- **Integer grid, integer distances, one distance metric** (Chebyshev, per chunk 07)
  used everywhere. No floating-point positions. If any float enters, pin the
  arithmetic so it cannot vary by platform.
- **No iteration over unordered collections.** Every loop that can affect outcome
  iterates a sorted, explicit sequence.
- Phase order within a tick is fixed and written down at the top of the file.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `TICK_CAP` | 600 ticks | Stalemate threshold. At 1 tile/tick on a 24×24 grid this is generous; tune down once fights are observed. Reaching it favors the defender (chunk 12). |
| `MOVE_SPEED_DEFAULT` | 1 tile/tick | Integral. Per-type override from chunk 03. If a sub-tile speed is ever needed, use integer accumulator arithmetic, never floats. |
| `PATHING_ALGORITHM` | deterministic A* on the integer grid, ties broken by (lower row, then lower column, then lower direction index) | Any algorithm is fine if the tie-break is total and documented. |
| `FENCE_BLOCKS_PATHING` | intact segments block; the pathfinder may choose to break through when the detour cost exceeds `FENCE_DETOUR_THRESHOLD` | |
| `FENCE_DETOUR_THRESHOLD` | 12 tiles | Above this detour length, a unit chips through instead of walking around. Purely tunable. |
| `RETARGET_RULE` | re-evaluate the stance target only when the current target becomes invalid (dead, spent, unreachable) | Prevents oscillation; must be deterministic either way. |
| `TICK_PHASE_ORDER` | 1. retarget → 2. movement → 3. trap triggers → 4. garrison aggro/leash update → 5. combat damage → 6. death resolution | Chunk 11 fills phases 3–6; fix the order now. |

## Definition of done

- [ ] Resolver lives in an isolated package with **no** I/O, clock, RNG, or framework
      dependencies. A lint rule or dependency check enforces this.
- [ ] Tick loop with the documented phase order; movement and fence collision implemented.
- [ ] All three stances produce correct target selection and pathing.
- [ ] Units path through deliberate gaps when aimed at one, and chip intact segments
      otherwise. Fence HP decrements and segments break.
- [ ] A siege hook exists on fence damage for chunk 11 to fill.
- [ ] Every tie-break rule is documented in-file and covered by a test that would
      fail if the ordering changed.
- [ ] **Determinism harness (start it here, complete it in chunk 12):** the same
      input resolved 100× produces byte-identical tick logs; and resolving in a
      different process produces the same result.
- [ ] A shuffled-input test: reorder the input arrays arbitrarily and assert the
      outcome is unchanged (or that ordering is explicitly part of the input contract
      and normalized on entry).
- [ ] Synthetic fixture layouts and loadouts exist for testing without a database.
- [ ] Tick cap terminates the loop (the *meaning* of hitting it is chunk 12).

## QA guardrail checks for this chunk

- **Determinism — the central check of the whole project:**
  - Re-run the same resolution 100× and byte-compare tick logs. Then across processes.
  - Grep the resolver package for `random`, `Date`, `now`, `performance`, `uuid`,
    `Set` / `Map` iteration, `Object.keys` on a dynamic object, `sort` without a
    comparator, and any async/parallel step. Each hit is a finding until disproven.
  - Any floating-point arithmetic affecting position, distance, or ordering?
- **Tick-resolution edge cases:** ties in the deterministic tie-break rules —
  two equidistant targets, two units with identical positions, a unit at exactly the
  boundary of a decision. Construct these deliberately; they will not appear by accident.
- **No live input:** confirm nothing in the tick loop reads player state, config, or
  anything outside its two arguments.
- **No pay-to-win:** confirm the resolver cannot see account, purchase, or
  entitlement state at all. If it can reach billing data even without using it, that
  boundary is a finding — resolution logic must be identical for paying and
  non-paying players.
- **Gaps work:** a layout with a deliberate gap must be pathable through it. If the
  resolver treats a gap as a wall, the core defensive tradeoff is broken.
