# Chunk 07 — Wagon circle model

**Depends on:** 03. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first, including §0 on which way round the game runs.

## Goal

The data model and validation rules for a **wagon circle** — the formation the player
arranges at each encounter on a trip. The playfield, the fence perimeter with
per-segment HP and deliberate gaps, trap placement, and posted units with aggro and
leash. No UI here (that's chunk 08); this is the structure the formation UI edits and
the resolver (10–13) consumes.

## Orientation — read this before anything else

**The wagon circle is the ACTIVE side of the game.** The player is the caravan. They
are attacked; they arrange this formation against a specific scouted attacking party
and watch it resolve. This is the analog of a Clash of Clans attack — the thing the
player actually sits down and plays — with the polarity reversed.

This is **not** a base that sits around being raided asynchronously, and it is **not**
the home town. The town (chunk 17) is a permanent settlement that is never attacked.
The wagon circle only exists out on the trail, during a trip.

## The two lifetimes — the central design of this chunk

| | Lifetime | What it is |
|---|---|---|
| **Manifest** | locked for the whole trip | What the caravan packed: which living units, which traps, how much fence material. Packed in town before departure, never resupplied mid-trail. |
| **Formation** | chosen fresh at every encounter | How it is all arranged: where fence segments go, where traps are laid, where units are posted and with what stance. |

The formation is **the decision the player makes**, informed by scouting that specific
attacker. The manifest is the loadout constraint they make it within. Model these as
two distinct structures — a formation references manifest entries, it does not own them.

Carry-forward matters: damage, destroyed fence segments, spent traps, and dead units
**persist across encounters within a trip**. The manifest at encounter 4 is what
survived encounters 1–3. There is no repair, resupply, or healing until the trip ends.

## Two spaces — keep them distinct

- **The placement lattice.** Discrete integer cells. Everything placed snaps to it:
  fence segments, traps, unit posts, and the attacking party's entry positions. It is
  also the graph the coarse pathfinder routes on. Shown in the UI **only while
  something is being placed**, hidden otherwise.
- **The simulation space (chunks 10–13).** Continuous, fixed-point. During the fight
  units move freely — **not locked to cells, not turn-based** — pathing around
  obstacles and attacking on cooldowns. The reference feel is a Clash of Clans attack.

So a posted unit's **post is a lattice cell**; its position during the fight is a
continuous fixed-point coordinate. Aggro radius and leash are continuous distances in
cells and may be fractional.

**The playfield is flat.** The trail-camp scene may be dressed with scenery, but the
play area is level ground and the model contains **no elevation, no terrain, and no
scenery data**. Decorative geometry that could influence a fight would hand some
players an advantage they never earned through the unlock web — the same failure class
as pay-to-win, arriving through the art pipeline.

## Design constraints that apply here

- **Fence perimeter with per-segment HP.** Fences are **breakable, not permanent
  walls.** Every segment has HP and can be chipped down.
- **The player may deliberately leave gaps.** A full ring costs more material than
  most loadouts can sustain; gaps save budget but expose that approach angle. Since
  the attacker is **scouted first**, choosing *where* to leave the gap against *this*
  party is the core read of the game. Gaps are a legitimate strategy, never an invalid
  or incomplete build.
- **Traps** — single-trigger, fire once on contact, then spent. A trap spent at
  encounter 2 is **still spent** at encounter 3 — it does not re-arm within a trip.
- **Posted living units** — each has an **aggro radius** (how close an attacker must
  get to be noticed) and a **leash distance** (how far it will chase from its post
  before disengaging and returning). Posted units are **mobile within their leash**,
  not static like fences and traps. Each has a **post** — a fixed origin the leash
  measures from — as well as a live position during resolution.
- **Attackers may approach from any side, or split across multiple sides**, so a
  circle is genuinely a circle with no safe rear. Entry edges exist on all sides.
- The camp has a **caravan core** — the objective. An attacker reaching it means the
  caravan is overrun.
- Posted units use their **defense rating**, which is deliberately not equal to their
  offense rating. The best raider isn't automatically the best guard.
- Everything placed must be a type the player **has access to** via the unlock web,
  and must be present in the trip's manifest. Both validated server-side.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `GRID_WIDTH` × `GRID_HEIGHT` | 32 × 32 cells | The placement lattice. |
| `FIXED_POINT_SCALE` | 1/1024 cell | Sub-cell sim resolution. Defined once, used everywhere. Never floats. |
| `PERIMETER_SEGMENTS` | 32 forming the ring | Each independently placed or omitted. |
| `FENCE_SEGMENT_HP_DEFAULT` | 400 | Per tier: T1 300, T2 400, T3 650, T4 1000. |
| `DEPLOYMENT_SLOT_CAP` | 8 | **Living units the caravan can carry on a trip.** This is the blast-radius cap on catastrophic loss — load-bearing, not cosmetic. |
| `TRAP_SLOT_CAP` | 6 | Traps carried per trip, consumed as they fire across encounters. |
| `FENCE_MATERIAL_BUDGET` | 24 of 32 segments | Deliberately below a full ring, so gaps are forced and the placement decision is real. **The most important balance lever in this chunk.** |
| `AGGRO_RADIUS_DEFAULT` | 4.0 cells (per-type override) | Continuous, may be fractional. |
| `LEASH_DISTANCE_DEFAULT` | 6.0 cells from post (per-type override) | Continuous. |
| `CORE_POSITION` | lattice center, 3×3 cells | Fixed, not player-placed, in MVP. |
| `MIN_POST_DISTANCE` | 1 cell apart | Posts don't stack. Units overlap freely during the fight — no unit-unit collision. |
| `DISTANCE_METRIC` | **Euclidean**, compared as squared distance to avoid `sqrt` | One metric everywhere — aggro, leash, attack range, ability radii must agree. |
| `SPAWN_POSITION` | cell center — lattice coordinate × scale + half a cell | How a placed cell becomes a continuous tick-zero position. Define once. |

## Definition of done

- [ ] **Manifest** and **formation** are distinct structures with distinct lifetimes;
      a formation references manifest entries rather than owning units.
- [ ] Manifest is locked at trip start and cannot be added to mid-trip — tested.
- [ ] Formation can be re-arranged freely before each encounter, from what survives.
- [ ] Carry-forward: unit damage/death, destroyed fence segments, and spent traps
      persist across encounters within a trip. A trap spent at encounter 2 is still
      spent at encounter 3 — tested explicitly, since re-arming is an easy accident.
- [ ] Fence ring with per-segment HP and tier, and **explicit gap support**; a gapped
      formation validates as legal, and the material budget makes gaps unavoidable.
- [ ] Posted units carry a post, aggro radius, and leash.
- [ ] Entry edges on all four sides; an attacking party can be split across them.
- [ ] Caravan core present and reachable in principle from every edge.
- [ ] Validation: slot caps, material budget, unlock access, manifest membership,
      no overlaps, no out-of-bounds — all server-side.
- [ ] Formation serializes to a compact, versioned, deterministic form with stable key
      order (this snapshot is stored per encounter and must byte-compare).
- [ ] Placed objects live on integer lattice cells; the lattice-to-continuous
      conversion lives here and is reused by the resolver, not reinvented.
- [ ] Fixed-point or integers throughout; a test asserts no float in the model or its
      serialization.
- [ ] The model contains **no elevation, terrain, or scenery**; a test asserts the
      resolver's input type cannot carry it.

## QA guardrail checks for this chunk

- **Which way round:** does anything here model a persistent, asynchronously-raided
  base? It should not exist. The wagon circle is arranged fresh per encounter during
  an actively-played trip, and the town is never attacked.
- **The two lifetimes stayed separate:** can the manifest be modified mid-trip by any
  path? Can a formation reference a unit that isn't in the manifest, or one that died
  at an earlier encounter? Both would break the attrition the outer loop rests on.
- **Carry-forward is real:** verify spent traps, broken fences, and dead units persist
  between encounters. If any of them silently reset, pushing costs nothing and
  bank-or-push stops being a decision.
- **Gaps are legal and forced:** does validation, a warning, or an auto-fill treat a
  gap as a mistake? Is `FENCE_MATERIAL_BUDGET` genuinely below a full ring? If a
  player can afford to close the circle, the central placement decision disappears.
- **Bounded stakes:** `DEPLOYMENT_SLOT_CAP` enforced server-side. It is what bounds a
  catastrophic trip to a packed loadout rather than the whole roster in town.
- **Access gate:** can a formation be saved containing a type the player hasn't
  unlocked? Try it via the API directly.
- **Determinism:** fixed-point throughout, one distance metric, no iteration-order
  dependence in serialization.
- **Scenery has not leaked into the sim:** no elevation, cover, or terrain value
  reaches the model or resolver.
- **Split correctness:** the manifest and formation are caravan-level, not account-level.
