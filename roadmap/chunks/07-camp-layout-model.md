# Chunk 07 — Camp layout model

**Depends on:** 03. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

The data model and validation rules for a camp: the playfield grid, the fence
perimeter with per-segment HP and deliberate gaps, trap placement, and garrison
placement with aggro/leash. No UI in this chunk — this is the structure the builder
UI (08) edits and the resolver (10–13) consumes.

## Design constraints that apply here

**Two spaces, and keeping them distinct is the central job of this chunk:**

- **The placement lattice (this chunk's grid).** Discrete integer cells. Everything a
  player *places* snaps to it: fence segments, traps, garrison posts, and the
  attacker's start positions. The lattice is also the graph the coarse pathfinder
  routes on. It is shown in the UI **only while something is being placed or
  snapped**, and hidden otherwise.
- **The simulation space (chunks 10–13).** Continuous, fixed-point. During a battle
  units move freely — they are **not locked to cells and do not take turns**. They
  path around fences, attack on per-unit cooldowns, and fire abilities on their own
  cooldowns. The reference feel is a Clash of Clans attack.

So: **a garrison unit's post is a lattice cell; its position during a fight is a
continuous fixed-point coordinate.** Aggro radius and leash distance are continuous
distances measured in cells, and may be fractional. This chunk owns the lattice and
the initial continuous positions derived from it; the resolver owns everything after
tick zero.

**The playfield is flat. The scenery is not — and it is not this chunk's concern.**

The camp is presented in 2D isometric on a natural-island setting with multiple
topographical tiers and visible cliff edges, for visual interest and depth. **None of
that is playable.** The active area is **level ground in the center of the island**,
and the wagon circle always sits on it. The tiers, cliffs, and coastline are framing
*around* the play area.

This means:

- **There is no elevation in the layout model, and none in the resolver.** No height
  per cell, no ramps, no slope cost, no line-of-sight rules, no cliff collision.
  The playfield is a flat lattice, exactly as if the island weren't there.
- **Decorative terrain lives in a presentation layer** — an art/scenery descriptor
  the client reads and the layout model does not. The resolver must not be able to
  reach it at all, on the same principle that keeps billing state out of the resolver:
  if scenery could influence a fight, one player's island would be worth more than
  another's, and no unlock-web progress would have earned it.
- **Scenery can therefore vary freely per region** with no balance implications,
  because it is not in the play area. That variety is free; take it.
- The isometric view is a **rendering projection of the same square lattice**, not a
  different coordinate system. Nothing about pathing, distance, or determinism changes.

One legibility caveat for whoever builds the art: **attackers may approach from any
side**, so the scenery at the approach edges must read as walkable — open ground,
shallow banks, trails. Dramatic cliffs belong behind and between the approach angles.
If terrain *looks* impassable where it isn't, players will misjudge which approaches
are viable, which is a legibility failure even though the geometry is fair.

Thematically: preparing camp for the night, Old West — a wagon train circling for
defense against raiders. **Configured asynchronously, persists until the player
edits it** — it is not re-configured every "night", and there is no expiry.

- **Fence perimeter with per-segment HP.** Fences are **breakable, not permanent
  walls.** Every segment has HP and can be chipped down.
- **Defenders may deliberately leave gaps.** This is a resource-allocation puzzle:
  a full ring costs more unlock investment than most builds can sustain early; gaps
  save budget but expose that approach angle. **The layout is visible to scouting
  raiders — this is the intended read-the-camp skill expression.** Do not treat gaps
  as an invalid or incomplete build; they are a legitimate strategy.
- **Traps** — single-trigger, fire once on contact. Placement is part of the puzzle.
- **Garrisoned living units** — each has an **aggro radius** (how close an attacker
  must get to be noticed) and a **leash distance** (how far it will chase from its
  post before disengaging and returning). Garrison units are **mobile within their
  leash**, not static like fences and traps. Each garrison unit therefore has a
  **post** — a fixed origin point the leash measures from — as well as a current
  position during resolution.
- **Attackers may approach from any side, or split their party across multiple
  sides.** The layout must have well-defined approach edges on all sides; there is
  no "back" that can't be reached.
- The camp has a **caravan core** — the objective. An attacker reaching it is a full
  clear. Its position is part of the layout.
- Living units used in the garrison are the **same units** as the raid party, drawn
  from the same owned inventory, but scored on their **defense rating** rather than
  their offense rating. A unit cannot be simultaneously garrisoned and out on a trip.
- **The caravan is a single entity serving both roles.** When parked it presents
  this defensive posture and is raidable. When away on a trip it is **not present
  and not targetable at all** — there is genuinely nothing there to raid, not an
  undefended camp free for the taking.
- Everything placed must be a type the player **has access to** via the unlock web,
  validated server-side.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `GRID_WIDTH` × `GRID_HEIGHT` | 32 × 32 cells | The placement lattice. Larger than a pure tile-based design would need, because continuous movement makes sub-cell positioning meaningful and a tight board makes pathing look cramped. |
| `FIXED_POINT_SCALE` | 1/1024 cell | The sim's sub-cell resolution. One number, defined once, used by every system that touches continuous position. Never floats. |
| `PERIMETER_SEGMENTS` | 32 segments forming the ring | Each independently placed or omitted. |
| `FENCE_SEGMENT_HP_DEFAULT` | 400 | Per-tier: T1 300, T2 400, T3 650, T4 1000. |
| `DEPLOYMENT_SLOT_CAP` | 8 | **Units per formation, offense and defense alike.** This number is the blast radius cap on catastrophic loss (§13) — it is load-bearing, not cosmetic. |
| `TRAP_SLOT_CAP` | 6 | Separate from unit slots. |
| `AGGRO_RADIUS_DEFAULT` | 4.0 cells (per-type override) | From chunk 03. Continuous, may be fractional. |
| `LEASH_DISTANCE_DEFAULT` | 6.0 cells from post (per-type override) | From chunk 03. Continuous. |
| `CORE_POSITION` | lattice center, 3×3 cells | Fixed, not player-placed, in MVP. |
| `MIN_GARRISON_POST_DISTANCE` | 1 cell apart | Posts don't stack. Units themselves overlap freely during the fight — there is no unit-unit collision. |
| `DISTANCE_METRIC` | **Euclidean**, compared as squared distance to avoid `sqrt` | Continuous movement makes Chebyshev look wrong. One metric everywhere — aggro, leash, attack range, and ability radii must all agree. |
| `SPAWN_POSITION` | cell center, i.e. lattice coordinate × scale + half a cell | How a placed lattice cell becomes a continuous tick-zero position. Define once. |

## Definition of done

- [ ] Layout serializes to a compact, versioned, deterministic form (stable key
      order — this snapshot is stored per raid and must byte-compare).
- [ ] Fence ring with per-segment HP, per-segment tier, and **explicit gap support**;
      a gapped layout validates as legal.
- [ ] Traps placed with type and position; single-trigger state (`armed`/`spent`)
      modeled but reset per raid — a trap spent in one raid is armed for the next.
- [ ] Garrison units placed with a **post**, plus per-unit aggro radius and leash.
- [ ] Approach edges defined on all four sides; a party can be split across them.
- [ ] Caravan core present and reachable in principle from every edge.
- [ ] Validation: slot caps, access checks against the unlock web, no overlaps, no
      out-of-bounds, no unit that is currently away on a trip.
- [ ] Layout persists until edited; no expiry, no nightly reset.
- [ ] Placed objects live on integer lattice cells; the conversion from a lattice
      cell to a continuous fixed-point tick-zero position exists here and is used by
      the resolver rather than reinvented there.
- [ ] All positions and distances are integers or fixed-point; a test asserts no
      float anywhere in the model or its serialization.
- [ ] `FIXED_POINT_SCALE` is defined exactly once and exported for every downstream
      chunk to use.
- [ ] The layout model contains **no elevation, no scenery, and no terrain data**.
      Decorative island geometry is referenced only by an opaque scenery id that the
      client resolves; a test asserts the resolver's input type cannot carry it.
- [ ] `parked` vs `away` state gates targetability (behavior lands in chunk 14/15,
      the flag lives here and in chunk 01).

## QA guardrail checks for this chunk

- **Legibility:** does the stored layout contain everything a scouting raider is
  supposed to see — segment HP, gaps, trap positions and types, garrison units and
  their stats? Is anything stored that is deliberately hidden from scouting? Per the
  design, camp layout is scoutable; hiding it to create surprise is a bug.
- **Determinism:** fixed-point throughout, with no floats in the model or its
  serialization? One distance metric used consistently? Any iteration-order
  dependence in serialization?
- **Scenery has not leaked into the sim:** confirm no elevation, cliff, ramp, or
  terrain value reaches the layout model or the resolver. Decorative island geometry
  that could influence a fight would hand some players a defensive advantage they
  never earned through the unlock web — the same failure class as pay-to-win, arriving
  through the art pipeline instead of the store.
- **The two spaces stayed separate:** does anything in the layout model assume units
  will be locked to cells during a fight, or encode a movement rule? Placement is
  discrete; the battle is continuous. A model that bakes in tile-locked movement
  would force the resolver to fight it.
- **Bounded stakes:** is `DEPLOYMENT_SLOT_CAP` enforced on both offense and defense?
  This cap is what bounds a catastrophic trip to a slot's worth of units rather than
  a whole collection.
- **Access gate:** can a layout be saved containing a unit or trap type the player
  hasn't unlocked? Try it via the API directly.
- **Gaps are legal:** does validation, linting, or the UI treat a deliberate gap as
  an error or auto-fill it? That would delete a core strategic choice.
- **Split correctness:** the camp layout is caravan-level, not account-level.
