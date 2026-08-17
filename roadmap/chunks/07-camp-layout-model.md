# Chunk 07 — Camp layout model

**Depends on:** 03. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

The data model and validation rules for a camp: the playfield grid, the fence
perimeter with per-segment HP and deliberate gaps, trap placement, and garrison
placement with aggro/leash. No UI in this chunk — this is the structure the builder
UI (08) edits and the resolver (10–12) consumes.

## Design constraints that apply here

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
| `GRID_WIDTH` × `GRID_HEIGHT` | 24 × 24 tiles | Integer grid — keeps pathing and distance deterministic. Avoid floating-point positions entirely. |
| `PERIMETER_SEGMENTS` | 32 segments forming the ring | Each independently placed or omitted. |
| `FENCE_SEGMENT_HP_DEFAULT` | 400 | Per-tier: T1 300, T2 400, T3 650, T4 1000. |
| `DEPLOYMENT_SLOT_CAP` | 8 | **Units per formation, offense and defense alike.** This number is the blast radius cap on catastrophic loss (§13) — it is load-bearing, not cosmetic. |
| `TRAP_SLOT_CAP` | 6 | Separate from unit slots. |
| `AGGRO_RADIUS_DEFAULT` | 4 tiles (per-type override) | From chunk 03. |
| `LEASH_DISTANCE_DEFAULT` | 6 tiles from post (per-type override) | From chunk 03. |
| `CORE_POSITION` | grid center, 2×2 tiles | Fixed, not player-placed, in MVP. |
| `MIN_GARRISON_POST_DISTANCE` | 1 tile apart | Prevents stacking. |
| `DISTANCE_METRIC` | Chebyshev on the integer grid | Pick one and use it everywhere — aggro, leash, and pathing must agree. |

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
- [ ] All positions and distances are integers; a test asserts no float in the model.
- [ ] `parked` vs `away` state gates targetability (behavior lands in chunk 13/14,
      the flag lives here and in chunk 01).

## QA guardrail checks for this chunk

- **Legibility:** does the stored layout contain everything a scouting raider is
  supposed to see — segment HP, gaps, trap positions and types, garrison units and
  their stats? Is anything stored that is deliberately hidden from scouting? Per the
  design, camp layout is scoutable; hiding it to create surprise is a bug.
- **Determinism:** integer grid throughout? One distance metric used consistently?
  Any float, any iteration-order dependence in serialization?
- **Bounded stakes:** is `DEPLOYMENT_SLOT_CAP` enforced on both offense and defense?
  This cap is what bounds a catastrophic trip to a slot's worth of units rather than
  a whole collection.
- **Access gate:** can a layout be saved containing a unit or trap type the player
  hasn't unlocked? Try it via the API directly.
- **Gaps are legal:** does validation, linting, or the UI treat a deliberate gap as
  an error or auto-fill it? That would delete a core strategic choice.
- **Split correctness:** the camp layout is caravan-level, not account-level.
