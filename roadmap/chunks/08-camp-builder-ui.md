# Chunk 08 — Camp builder UI

**Depends on:** 07, 05. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

The screen where a defender configures their camp: place fence segments, traps, and
garrison units on the grid, see the costs and tradeoffs, and save. The output is the
layout that raiders will scout.

**This chunk also builds the shared isometric camp scene renderer** — the wagon circle
on its island — which the home screen (chunk 17), the scout view (chunk 14), and the
battle replay (chunk 13) all reuse. Build it once, here, as a reusable component.
There must never be a second implementation of isometric projection or depth sorting.

**Scope boundary:** this is the *defense configuration* surface. It is **not** the home
screen. The home screen (chunk 17) is the parked, stationary view where units sit
statically on a merge board and the mine generates Coin — same wagon circle, different
mode, different chunk. Merging does not happen here.

## Design constraints that apply here

**Presentation — 2D isometric on a natural island.** The camp is drawn in isometric
projection, sitting on an island with multiple topographical tiers and visible cliff
edges. The tiers exist for **visual interest and depth only**.

- **The play area is flat level ground in the center of the island.** The wagon circle
  always sits on it. Everything the player places goes there.
- **The tiers, cliffs, and coastline are scenery around the play area.** They are not
  playable, not placeable, and carry **no gameplay meaning whatsoever** — no cover, no
  height advantage, no blocked approach. The layout model and the resolver never see
  them (chunk 07).
- Isometric is a **rendering projection of the same square lattice**. The lattice is
  unchanged; it is drawn rotated and vertically compressed. Multi-tier scenery means
  the renderer needs **depth sorting** — that's the real work in this chunk.
- Because scenery is inert, it can **vary freely per region** with no balance concern.
  Take that variety; it's free visual identity.
- **Approach edges must read as walkable** — open ground, shallow banks, trails.
  Attackers may come from any side, so dramatic cliffs belong behind and between the
  approach angles. Terrain that *looks* impassable where it isn't will make players
  misjudge which approaches are viable, which is a legibility failure even though the
  geometry is fair.

**Grid visibility — the intended feel.** The camp reads as a place, not a board. The
placement lattice is **shown only while the player is actively placing or dragging
something that snaps to it**, and fades out otherwise. The reference is the merge-game
home screen: grid-based topography you don't see until a unit is mid-drag. Do not
render a persistent visible grid over the camp.

**Battles are continuous.** Units are not tile-locked when the fight runs — they move
freely and attack on cooldowns. So aggro and leash overlays are **circles at
continuous radii**, not cell highlights, and coverage is an area, not a set of tiles.

- Thematically: preparing camp for the night, Old West — a wagon train circling.
  **Configured asynchronously; persists until the player edits it.** No nightly
  re-setup ritual, no expiry.
- **Fence perimeter with per-segment HP; fences are breakable, not permanent walls.**
  Show segment HP per tier so the player understands what they're buying.
- **Gaps are a legitimate, first-class choice, not an error state.** The design
  intends a resource-allocation puzzle: a full ring costs more unlock investment
  than most builds sustain early; gaps save budget but expose that approach angle.
  The UI must never auto-complete the ring, warn about gaps as if they were mistakes,
  or block saving a gapped layout. Surfacing *which approach angle* a gap exposes is
  good; calling it invalid is wrong.
- **Traps** are single-trigger — fire once on contact and are spent. Say so in the UI.
- **Garrison units** have an aggro radius and a leash distance, and are mobile within
  that leash. **Visualize both radii** — a defender cannot reason about coverage
  otherwise, and coverage reasoning is the whole puzzle.
- The player must see that living units carry **two distinct stat profiles** — a
  unit's defense rating is what matters here, and it is not equal to its offense
  rating. The best raider isn't automatically the best guard, and the UI should make
  that legible rather than showing one blended power number.
- **Attackers may approach from any side or split across sides.** Show the approach
  edges so the defender understands what they're defending against.
- Only unlocked types are placeable, and the server re-validates on save.
- **What the defender sees here is what raiders will scout.** There is no hidden
  layer. If the builder shows something the scout view won't, that's a legibility bug.

## Tunables this chunk needs (defaults proposed — all tunable)

All layout constants come from chunk 07 (`GRID_WIDTH`, `PERIMETER_SEGMENTS`,
`DEPLOYMENT_SLOT_CAP` = 8, `TRAP_SLOT_CAP` = 6, aggro/leash defaults). Add:

| Name | Default | Note |
|---|---|---|
| `PROJECTION` | 2:1 isometric (a cell renders twice as wide as tall) | The standard iso ratio; keeps art authoring predictable. |
| `SCENERY_TIERS` | 3 elevation tiers around the flat play area | Purely decorative. Authored per region as art, not as data the sim reads. |
| `PLAY_AREA_ELEVATION` | flat, single level | Non-negotiable — the wagon circle is always on level ground. |
| `DEPTH_SORT` | painter's algorithm over (row + column), with scenery layered behind and in front of the play area by tier | The main rendering complexity multi-tier iso introduces. |
| `GRID_VISIBILITY` | visible only during an active place/drag, fading in and out | Never persistently visible. |
| `SHOW_AGGRO_LEASH_OVERLAY` | on by default, toggleable | Coverage visualization, drawn as continuous circles. |
| `TOUCH_TARGET_MIN` | 44px | Web-first but mobile-shaped: every placement control must be usable with a thumb. |
| `SHOW_COVERAGE_GAPS` | informational overlay, never blocking | Marks which approach edges have no fence and no garrison coverage. |
| `EDIT_WHILE_AWAY` | allowed | Editing the camp while on a trip is harmless — the camp isn't targetable anyway. Saved layout applies on return. |

## Definition of done

- [ ] **A reusable isometric camp scene component**: projection, island scenery with
      its decorative tiers, depth sorting, pan and zoom. Exported for chunks 13, 14,
      and 17 to reuse rather than reimplement.
- [ ] Place, move, and remove fence segments (with tier choice), traps, and garrison units.
- [ ] A deliberately gapped perimeter saves cleanly with no warning framing it as an error.
- [ ] Aggro radius and leash distance are visualized per garrison unit, as continuous
      circles at their true radii.
- [ ] The lattice appears only during an active placement drag and is otherwise hidden.
- [ ] Units show offense and defense ratings separately; defense is emphasized here.
- [ ] Each unit's ability is shown with its effect and cooldown — a defender choosing
      a garrison is choosing an ability as much as a stat line.
- [ ] Layout is touch-usable: drag-to-place, pinch-zoom, no hover-dependent affordances.
- [ ] Trap single-trigger behavior is stated in the UI.
- [ ] Slot caps and unlock access enforced in the UI **and** re-validated server-side.
- [ ] Approach edges shown.
- [ ] Saved layout persists indefinitely until the next edit.
- [ ] A preview of the layout exactly as a scouting raider will see it, reachable
      from this screen.
- [ ] Units currently away on a trip cannot be garrisoned, with a clear reason shown.

## QA guardrail checks for this chunk

- **Legibility, both directions:** does the scout view show exactly what the builder
  shows? Any discrepancy is a bug in favor of hidden information, which the design
  forbids. Camp layout is meant to be readable by an attacker before they commit.
- **Gaps:** does anything in the UI — validation, a warning, an auto-fill, a "fix
  this" prompt — treat a gap as a mistake? That deletes a core strategic choice.
- **Two stat profiles:** does the UI show a single blended power number anywhere?
  That collapses the offense/defense asymmetry the design is built on.
- **Access gate:** can an un-unlocked type be placed by bypassing the UI? Server must refuse.
- **Bounded stakes:** `DEPLOYMENT_SLOT_CAP` enforced server-side, not just visually.
- **No pay-to-win:** does any surface offer to buy a better fence, more slots, or a
  stronger camp with Coin? There must be none.
