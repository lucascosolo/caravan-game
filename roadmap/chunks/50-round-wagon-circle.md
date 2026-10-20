# Chunk 50 — Round wagon circle

**Depends on:** 07, 08, 10–13, 22, 24, 25, 37. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first, including §0 on which way round the game runs.

## Goal

Replace the square fence ring with a **round wagon circle**: a ring that reads as a circle
in the 2:1 isometric view, with about six wagons spread around it as permanent,
unbreakable wall pieces (a laager) and fence segments filling the spaces between. This is
a change to the **game**, not only to the art: the ring geometry lives in the resolver, so
fights, formations, balance and every surface that draws the camp change with it. In the
same chunk, draw everything about 20% smaller so the whole camp is visible by default on a
phone.

PROJECT.md §9 already calls this a "wagon circle". The square ring with a wagon parked on
each corner (chunk 07 QA D2) was an implementation shortcut; this chunk moves the
implementation toward the design.

## Owner decisions (2026-10-20)

Recorded from the owner's session on 2026-10-20:

- **Round wagon circle, replacing the square ring.** "The owner dislikes the square fence
  ring with wagons parked on its four corners." Change the game, not just the art, to a
  round wagon circle: a ring that reads as a circle in the 2:1 isometric view, with about 6
  wagons spread naturally around it as permanent, unbreakable wall pieces, fence segments
  filling the spaces between, each segment still placed or left as a gap; 4-connected
  closure preserved.
- **The geometry comes from the owner-approved look-test mock-up**
  (https://claude.ai/artifact/EGHs2F88GqNcDEN2xh3hgy), written to
  `~/.cache/caravan/looktest/round-ring.json`. It is not invented by the Maker.
- **The whole camp is visible by default on a phone.** The owner chose to draw everything
  about 20% smaller: ground tile 40 × 20 instead of 48 × 24, sprite footprints scaled to
  match, whole-pixel art per `docs/art/STYLE-GUIDE.md`; the opening camera frames the whole
  camp on a 393-CSS-px-wide phone.

## Where the geometry comes from — do not invent cells

At the start of the chunk, copy the **owner-approved** `round-ring.json` into the repo as a
fixture (proposed: `packages/resolver/geometry/round-ring.json`, plus a short provenance
note naming the artifact URL and the approval date). Translate its look-test coordinates
to the 32 × 32 lattice exactly as its `notes` field says (look-test core centre (5,5) →
game core centre (16,16), offset (+11,+11)). The resolver's ring constants are **generated
from or checked against that fixture by a test**; nobody edits cells by hand afterwards.

If the file on disk is not yet marked approved by the owner, or it changes after the chunk
starts, stop and ask. The draft present on 2026-10-20 has 28 ring cells, 6 two-cell wagons
(12 cells), 16 fence positions, an outer diameter of 11 cells and 52 interior post cells
(the square has 40). Those figures are context, not the spec; use whatever the approved
file says.

## Design constraints that apply here

- **Closure under 4-connected pathing.** `PATH_CONNECTIVITY` stays 4. The ring is a thin,
  closed, 8-connected curve, so it seals the core only because diagonals are not steps.
  With every fence placed the core is sealed from every entry edge; leaving any single fence
  position open, or breaking it, opens the ring. Removing any one wagon cell would open it
  too, which is why wagons are never breakable. All three are tests.
- **Continuous movement must agree with the lattice.** The ring has diagonal steps, so a
  fence and a wagon (or two fence cells) can touch only at a corner. The fight is
  continuous; a unit must never slip through the shared corner of two intact ring cells.
  `path.ts` already treats a segment through a cell corner as touching all three cells
  beyond it; this chunk adds fight-level tests at every diagonal step of the new ring,
  including with the movement margin, and fixes collision if any fails.
- **Wagons are walls, not fences.** Permanent, impassable, unbreakable, never a gap, never
  bought, never counted against `FENCE_MATERIAL_BUDGET`, never targeted for damage. They
  replace `RING_ANCHORS`. Each carries the fixture's `facing` for drawing only; the resolver
  sees cells.
- **Gaps stay legal and forced.** `FENCE_MATERIAL_BUDGET` stays strictly below
  `PERIMETER_SEGMENTS` (the existing load-time check in `packages/circle/src/lattice.ts`
  keeps failing otherwise). PROJECT.md §9: "a full ring costs more material than most
  loadouts can sustain". With far more of the ring now permanent wall (draft: 12 of 28
  cells, against 4 of 32 today), the budget is re-derived, not carried over.
- **"Inside the ring" is redefined.** The `reserve` stance (chunk 07 QA D1) wakes when an
  attacker is inside the ring, today "Chebyshev distance < `PERIMETER_RING_RADIUS` from the
  core centre". It becomes membership of the fixture's interior cell set (core and
  interior post cells). `PERIMETER_RING_RADIUS` goes away or is kept only as a derived
  value no rule reads.
- **Posts and traps** may be placed on any interior post cell from the fixture, plus
  whatever outside-the-ring placement chunk 07's rules already allow; ring and wagon cells
  are never placeable for anything but fences.
- **Each fence position has a side.** Quick arrange's "Fence north / east / south / west"
  and the guide's `sideSegments` / `gapSegment` need every fence position assigned to
  exactly one entry edge. The assignment is a fixed table derived from the fixture (by the
  sign of the dominant axis from the core centre; a position on an exact diagonal goes to
  the next edge clockwise). Written down once, in the fixture or beside it.
- **Segment order** is clockwise along the fixture's `ring_order`, fence positions only,
  starting from the first fence position clockwise of due north. Documented in
  `battlefield.ts` where the square's order is documented today.
- **Determinism (guardrail 1).** Integer cells and fixed-point only; the fixture is data,
  read at build time or embedded as a constant, never at resolve time from disk (the
  resolver stays I/O-free; `pnpm lint` / `pnpm test:boundary` must stay green).
- **The playfield stays flat.** Wagons are walls on lattice cells, not cover, elevation
  or terrain. No new resolver input field may carry scenery.
- **One renderer.** The trail placement screen, the town's outfit view and the replay all
  draw the ring through `apps/web/src/iso`; no second ring drawer.

## What changes, by package

| Where | Change |
|---|---|
| `packages/resolver/src/battlefield.ts`, `input.ts`, `path.ts`, `posted.ts` | Ring cells, wagon cells, segment order and interior set from the fixture; `RING_ANCHORS` → wagon cells; `BATTLEFIELD_VERSION` 2 → 3; input validation checks the new geometry exactly. |
| `packages/resolver/src/version.ts` | `RESOLVER_VERSION` 9 → 10. |
| `packages/resolver/golden/` | Golden logs and `work-counters.json` regenerated with `UPDATE_GOLDEN=1`; every changed golden carries version 10 (the determinism harness refuses anything else). The 72-fight corpus's layouts are rebuilt on the new ring, not index-copied. |
| `packages/content/src/tunables.ts` | Registry mirror: `PERIMETER_SEGMENTS`, `RING_ANCHOR_CELLS` (→ wagon count/cells), `PERIMETER_RING_RADIUS`, `FENCE_MATERIAL_BUDGET`; the mirror check in `lattice.ts` updated to the new shape (its "8 × radius − anchors" message no longer holds). |
| `packages/circle` | `lattice.ts` (ring/wagon/interior sets), `formation.ts` (segment index range; formation `v` 2 → 3 so a v2 snapshot never parses as v3), `guideLayout.ts` (side table, gap choice, posts near the gap), `guide.ts` ("Arrange for me"), `resolverInput.ts`. |
| `apps/server` | Upgrade migration (below); `matchmaking/authored.ts` and `authoredOutfits.ts` re-checked; the balance scripts re-run. |
| `apps/web/src/iso/projection.ts` | `TILE_W` 48 → 40 (`TILE_H` follows as `TILE_W / 2` = 20); opening camera. |
| `apps/web/src/screens/trail` (`placement.ts`, `FormationScreen.tsx`, quick arrange), `screens/town/outfitModel.ts`, `screens/replay/replayModel.ts` | Draw and edit the round ring; read the geometry from the shared constants, never a copy. |
| `docs/art/STYLE-GUIDE.md` | Footprint table rescaled (below). |

## Open trips, stored formations and old replays

Stored formations name segment indices, and every index changes meaning. Nothing is
converted by index or by angle: a gap chosen against the square's north side is not "the
same gap" on a ring with wagons in different places, and a remapped formation would be a
layout the player never chose.

- **Committed, unresolved encounters** are already handled: the in-process worker parks
  every job of another `RESOLVER_VERSION` and voids its trip through the void path (final
  guardrail review r3 S1, migration 029). Nothing new, but this chunk's tests exercise it
  with a real version-9 job.
- **Open trips whose next encounter is uncommitted** (drafts on `wagon_formation`, or no
  draft yet) are voided too, through the same void path, by the upgrade (migration 031 or
  a boot step beside the park call; the Maker picks and says which). Banked as of the last
  survived encounter, the trip cap use not refunded unless the void path already refunds
  it. No caravan is left `on_trip` with a manifest it cannot arrange.
- **Menus** drawn under version 9 already answer 409 `menu_stale` (migration 030); no
  change beyond a test.
- **Town outfit state** that packs more fence material than the new budget allows is
  clamped to the budget on read, with no error.
- **Old replays.** `replayModel.ts` draws the ring from the current constants, so a
  version-9 log would be drawn on the wrong ring. A fight resolved under
  `BATTLEFIELD_VERSION` 2 answers `renderable: false` with a reason ("resolved on the old
  square camp"), using the existing non-renderable path. Its post-fight summary stays
  readable. Rejected: shipping both geometries in the client; old logs are pruned by the
  retention rule anyway, and two ring drawers would break the one-renderer rule.
- `docs/PLAYTEST-HOSTING.md` step 12 (drain first) is followed for the deploy; add a note
  that this upgrade also voids open uncommitted trips.

## The smaller draw scale

- `TILE_W` = **40**, `TILE_H` = 20: every on-screen footprint × 5/6.
- **Whole pixels.** The style guide draws every asset 1.5 times finer than its footprint.
  The new drawing sizes are the old ones × 5/6, rounded to whole art pixels: ground tile
  72 × 36 → **60 × 30**, character 36 × 48 → **30 × 40**, wagon 126 × 93 → **105 × 78**
  (105 × 77.5 rounded up; computed with `python3 -c`). Existing pixel art is **redrawn or
  regenerated** at the new grid, never resampled by a non-integer factor (§8's mixed-pixel
  ban). Update the footprint table in `docs/art/STYLE-GUIDE.md` in the same commit.
- **Opening camera.** On a 393 × 852 CSS px viewport the first frame of the trail screen,
  the town outfit view and the replay shows the whole camp: every ring and wagon cell, the
  core, and every placed piece, inside a 16 px gutter and clear of the bottom tab bar and
  any fixed controls. For scale: an 11-cell-wide circle spans about 311 CSS px across at
  `TILE_W` 40 and about 373 px at 48 (`2 × 5.5 × √2 × TILE_W / 2`), against 361 px of
  usable width; sprite overhang is what the 48 px version could not fit. Raiders' entry
  bands need not be in frame at rest; pan and pinch stay available.
- Touch targets do not shrink with the art: the hit area for placing on a cell stays at
  least the size chunk 08 set, even where the drawn tile is smaller.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| Ring geometry | from the approved fixture | Not tunable by hand; a geometry change is a new fixture, a `BATTLEFIELD_VERSION` and a `RESOLVER_VERSION` bump. |
| `PERIMETER_SEGMENTS` | fence positions in the fixture (16 in the draft) | Derived, checked against the fixture. |
| `FENCE_MATERIAL_BUDGET` | `floor(PERIMETER_SEGMENTS × 20 / 28)`: today's 20 of 28 ratio; **11** for the draft's 16 (16 × 20 / 28 = 11.43) | Must stay `< PERIMETER_SEGMENTS`. A starting point only: the wagons now cover far more of the ring, so the sweep decides. If it shows the ring closes too cheaply, the next candidate is `PERIMETER_SEGMENTS − 8` (8 for the draft), which keeps today's 8 forced open positions. Mark TUNABLE. |
| `FENCE_SEGMENT_HP_DEFAULT` and tiers | unchanged (400; T1 300 … T4 1000) | Re-checked by the sweep, not retuned up front. |
| `TILE_W` | 40 (was 48) | Presentation only; the resolver never sees it. |
| Opening camera fit | whole camp inside a 16 px gutter at 393 CSS px wide | Asserted by an e2e screenshot bound check. |

## Balance re-run (chunk 37)

Fence count and wagon cover both change what a fight is, so the balance evidence is
re-taken, not assumed:

- Re-run `scripts/balance/matchup-sweep.ts` (full, not `--quick`, before the chunk is
  `built`), `first-trip.ts`, `probes.ts`, `measured-ev.ts` and `trip-ev.ts`; record a new
  pass in `BALANCE-LOG.md` with the before and after numbers side by side.
- Re-check the 96 authored cold-start parties (chunk 25) band by band against the new
  ring: each band still serves three candidates and the first-trip hold rate (chunk 24 D1)
  stays inside its target. Re-tune `authoredOutfits.ts` and the parties only through the
  existing versioned seed.
- Re-check PROJECT.md §9's "a full ring costs more material than most loadouts can
  sustain": with the new `FENCE_MATERIAL_BUDGET` a full ring must still be unaffordable,
  and the sweep must show gap placement still changes outcomes against a scouted party
  (if every gap choice gives the same result, the core read is gone).
- `apps/server/test/balance-sweep.test.ts` (the CI slice) is updated to the new corpus.

## Definition of done

- [ ] The approved `round-ring.json` is in the repo with provenance; a test derives or
      checks every resolver ring constant against it.
- [ ] All fences placed seals the core from every edge; any single fence gap or break
      opens it; any one wagon cell removed would open it (tested on the geometry).
- [ ] No unit passes through the shared corner of two intact ring cells in a real fight,
      at every diagonal step of the ring (fight-level tests).
- [ ] Wagons are impassable, unbreakable, untargetable and never placeable or buyable.
- [ ] `reserve` wakes on the interior-cell set; tested at the ring's diagonal steps.
- [ ] Every fence position has exactly one side; quick arrange and "Arrange for me" use
      it, and the guide's arrangement validates on the new ring.
- [ ] `RESOLVER_VERSION` 10, `BATTLEFIELD_VERSION` 3, formation `v` 3; `pnpm determinism`
      and `pnpm perf:resolver` pass with regenerated goldens and work counters.
- [ ] An open trip with an uncommitted encounter and one with a committed version-9 job
      are both voided cleanly by the upgrade; no caravan stays `on_trip`.
- [ ] A version-9 replay answers `renderable: false` with the reason; its summary renders.
- [ ] `TILE_W` 40; the new drawing sizes are in the style guide; no asset is resampled by
      a non-integer factor.
- [ ] On a 393 px-wide viewport the trail, outfit and replay views open with the whole
      camp in frame (Playwright, with a screenshot kept as evidence).
- [ ] Full matchup sweep, authored-party check and §9 affordability check recorded in
      `BALANCE-LOG.md`; budget and any retuned numbers marked TUNABLE.
- [ ] `pnpm check` green.

## QA guardrail checks for this chunk

- **Cells came from the owner.** Diff the repo fixture against the approved file. Any
  hand-edited cell is a finding.
- **Closure is real in continuous space**, not only on the lattice: try to walk a unit
  through every diagonal touch point of the ring, with and without margin.
- **Gaps are still forced and still matter** (chunk 07's check, re-asked): is the budget
  below the fence count, and does the sweep show the gap's side changing outcomes?
- **Nothing stranded.** Start trips on version 9 in every state (in town packed,
  uncommitted draft, committed and queued, committed and leased), upgrade, and confirm
  each caravan ends in town with the void path's accounting.
- **No silent remap.** No code converts a v2 formation's segment indices onto the new
  ring.
- **Determinism:** goldens regenerated only with the version bump; three-process sha256
  comparison still passes.
- **Scenery has not leaked into the sim:** wagon `facing` and sprite sizes never reach
  the resolver input.
- **One renderer:** trail, town and replay all draw the ring from the same constants
  through `apps/web/src/iso`.
- **Legibility:** with the smaller scale, is every scouted raider, trap and gap still
  readable at the opening zoom on a phone? Smaller must not mean unreadable.

## Notes

- **PROJECT.md amendment: recommended, not required.** §9 already says "wagon circle"
  and "fence perimeter with per-segment HP", and says nothing about a square. What it does
  not say is that a large share of the ring is now permanent wagon wall. Because that
  changes the material puzzle §9 describes, a one-sentence amendment is proposed for the
  owner: "The ring is a laager: about six wagons stand in it as permanent, unbreakable
  wall pieces, and fence segments fill the spaces between them." The Maker does not edit
  PROJECT.md.
- **Open for the owner, affects chunk 51.** In the draft the ring cells are symmetric
  under a quarter turn but the wagons are not (they are irregular, and six wagons cannot
  be placed with quarter-turn symmetry at all). Chunk 51 rotates saved layouts by quarter
  turns, so a rotated fence can land on a wagon. Chunk 51 handles that with a fixed rule,
  but a quarter-turn-symmetric arrangement (four or eight wagons) would make rotation
  exact. That is the owner's trade-off between the look and clean rotation; ask before the
  fixture is frozen.
