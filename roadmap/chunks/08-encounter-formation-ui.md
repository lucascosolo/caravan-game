# Chunk 08 — Encounter formation UI

**Depends on:** 07, 05, 14. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first, including §0 on which way round the game runs.

> **This is the game's primary gameplay screen.** Everything else in the project
> supports what happens here. It deserves the most design attention of any UI chunk.

## Goal

The screen where the player, mid-trip and facing a specific scouted attacking party,
arranges their wagon circle: places fence segments, lays traps, posts units and sets
their stances, sees the tradeoffs, and commits. Then watches it resolve.

## Orientation

**The active experience is defense.** The player is the caravan. They scout the party
bearing down on them and answer it with an arrangement. This is the analog of choosing
where to drop troops in a Clash of Clans attack — the moment of play — with the
polarity reversed.

**Scope boundaries.** This is not the home town (chunk 17), which is the safe
settlement with the roster, merge board, and mine. It is not the standing raid party
builder (chunk 09), which is the passive offense configured back in town. Merging does
not happen here, and no unit is recruited here.

**This chunk also builds the shared isometric scene renderer** — projection, depth
sorting, pan and zoom — reused by the town (17), the party scout view (14), and the
battle replay (13). Build it once, here. There must never be a second implementation.

## Design constraints that apply here

- **The player scouts the attacking party first, then arranges.** Every unit in it,
  its stats, its ability, its stance, its siege, and which edges it will enter from
  must be visible **before** the player commits. Reading the incoming force and
  countering it **is** the skill expression; hiding any of it to create surprise
  breaks the game's central legibility promise.
- **Two lifetimes, and the UI must make both legible** (chunk 07):
  - The **manifest** — what was packed — is fixed for the trip and shown as a
    constraint, with what has been lost or spent so far clearly marked.
  - The **formation** — the arrangement — is chosen fresh here, every encounter.
- **What survives is what you have.** Damage, destroyed fence segments, spent traps,
  and dead units carry forward. The UI must show the caravan's true current state, not
  a fresh loadout. A player who thinks they still have a trap they spent two
  encounters ago has been misled by the interface.
- **Gaps are a first-class choice, not an error.** The material budget is deliberately
  below a full ring, so the player *must* leave gaps. The UI must never auto-complete
  the ring, warn about gaps as mistakes, or block committing a gapped formation.
  Showing *which* approach angle a gap exposes — against this specific attacker's
  known entry edges — is exactly the help the player wants.
- **Fences are breakable, not walls.** Show per-segment HP and tier so the player
  understands what a segment buys against this attacker's siege.
- **Traps are single-trigger** and do not re-arm within a trip. Say so plainly.
- **Posted units have aggro radius and leash**, and are mobile within that leash.
  **Visualize both as continuous circles** — a player cannot reason about coverage
  otherwise, and coverage reasoning is the puzzle.
- **Units show offense and defense ratings separately**, with defense emphasized here.
  Never a single blended power number; that collapses the asymmetry the design rests on.
- Each unit's **ability** — effect, radius, cooldown — is visible. A posted healer's
  finite charges must be shown, since charge count is what bounds it.
- **Attackers may approach from any side or split across sides.** Show their entry
  edges, since that is the single most important input to the arrangement.
- Only unlocked types, and only manifest contents, are placeable; server re-validates.

## Tunables this chunk needs (defaults proposed — all tunable)

Layout constants come from chunk 07 (`GRID_WIDTH`, `PERIMETER_SEGMENTS`,
`DEPLOYMENT_SLOT_CAP` 8, `TRAP_SLOT_CAP` 6, `FENCE_MATERIAL_BUDGET` 24). Add:

| Name | Default | Note |
|---|---|---|
| `PROJECTION` | 2:1 isometric | Standard iso ratio; keeps art authoring predictable. |
| `DEPTH_SORT` | painter's algorithm over (row + column) | Main rendering complexity. |
| `GRID_VISIBILITY` | visible only during an active place/drag, fading in and out | Never persistently visible. Identical rule in chunks 09 and 17. |
| `SHOW_AGGRO_LEASH_OVERLAY` | on by default, toggleable | Continuous circles at true radii. |
| `SHOW_THREAT_OVERLAY` | on | Marks which entry edges this attacker will use, and which are uncovered by fence or post. Informational, never blocking. |
| `FORMATION_PRESETS` | save and recall named arrangements | Quality of life across many encounters; must not bypass validation. |
| `TOUCH_TARGET_MIN` | 44px | Web-first, mobile-shaped. |

## Definition of done

- [ ] **A reusable isometric scene component**: projection, depth sorting, pan, zoom.
      Exported for chunks 13, 14, and 17 rather than reimplemented.
- [ ] Full scout view of the incoming party, shown before any arrangement is committed.
- [ ] Place, move, and remove fence segments (with tier), traps, and posted units;
      assign stances.
- [ ] Manifest constraints shown live — what was packed, what has been lost or spent.
- [ ] Carry-forward state shown truthfully: damaged units at real HP, spent traps
      unavailable, destroyed fence material gone.
- [ ] A deliberately gapped perimeter commits cleanly with no error framing.
- [ ] Threat overlay showing this attacker's entry edges against current coverage.
- [ ] Aggro and leash visualized as continuous circles per posted unit.
- [ ] Offense and defense ratings shown separately; abilities and healer charges shown.
- [ ] The lattice appears only during an active drag.
- [ ] Slot caps, material budget, manifest membership, and unlock access enforced in
      the UI **and** re-validated server-side.
- [ ] Commit → resolution → replay handoff works end to end.
- [ ] Touch-usable: drag-to-place, pinch-zoom, no hover-dependent affordances.

## QA guardrail checks for this chunk

- **Legibility — the highest-stakes check here:** can the player see *everything*
  about the incoming party before committing? Compare the scout payload field by field
  against the party model. Anything present in the model but absent from the scout view
  is a legibility bug, and in this game it is close to a design-breaking one — the
  entire active loop is reading the attacker and answering it.
- **Which way round:** has this drifted into a set-and-forget base editor? It must be a
  per-encounter decision made against a known opponent. If a player can arrange once
  and coast, the active loop has collapsed into the passive one.
- **Carry-forward shown truthfully:** spend a trap, break a fence, wound a unit, then
  push. Does the next encounter's UI reflect all three? A UI that quietly shows a fresh
  loadout would hide the attrition that makes bank-or-push meaningful.
- **Gaps:** does anything treat a gap as a mistake — a warning, an auto-fill, a "fix
  this" prompt? Is the material budget genuinely below a full ring? If a player can
  close the circle, the central decision is gone.
- **Two stat profiles:** is a blended power number shown anywhere?
- **Bounded stakes:** slot caps enforced server-side, not just visually.
- **Access gate:** can an un-unlocked or un-packed type be placed by bypassing the UI?
- **No pay-to-win:** does any surface offer to buy fence material, extra slots, a
  repair, a resupply, or a re-arrange with Coin? There must be none — any of them
  would sell power or erase attrition.
