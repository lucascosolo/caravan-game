# Chunk 08 — Encounter formation UI

**Depends on:** 07, 05, 14. **Status:** built (2026-10-11; see "Build notes" at the end).
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
| `FORMATION_PRESETS` | save and recall named arrangements | Quality of life across many encounters; must not bypass validation. **Deferred post-v1 (QA D2):** a draft is re-savable and autosaved, which covers the per-encounter case. |
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
- [ ] The lattice appears only during an active drag — or while a tray item is selected for tap-to-place, which counts as "being placed" (QA D5).
- [ ] Slot caps, material budget, manifest membership, and unlock access enforced in
      the UI **and** re-validated server-side.
- [ ] Commit → resolution → replay handoff works end to end. **Deferred to chunk 23** (QA D1; PHASE-2 §23's definition of done now carries it): chunk 08 ships the commit and the locked state.
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

## Build notes (Maker, 2026-10-11)

**Where it lives.** `apps/web/src/iso/` is the shared isometric renderer; `apps/web/src/screens/trail/`
is the Trail tab (candidates → formation). Strings in `src/strings.ts` (`trail.*`), styles in
`src/theme.css` (rem sizes; the 44px target is `--tap` = 2.75rem).

**The renderer (`src/iso`, PixiJS 8.6.6, reused by chunks 17 and 22 — never reimplemented):**
- `projection.ts` — pure: 2:1 projection (`TILE_W` 48 / `TILE_H` 24), `unproject` (exact
  inverse), `cellToWorld` (cell centre), `fixedToWorld` (the chunk 10 log's fixed-point
  positions → world; the replay hook for chunk 22), `snapToCell` (floor), `depthKey`
  (painter's order over row + column, with a layer tie-break), the camera (`fitCamera`,
  `panCamera`, `zoomCameraAbout`, `pinchCamera`, `clampCamera`; `ZOOM_MIN` 0.12 so a 360px
  phone fits the lattice). `hit.ts` — pure hit test (posts > traps > fences > attackers).
- `scene.ts` — the one PixiJS scene: the island (three inert decorative tiers with cliff
  faces and fixed scrub, water under it; the resolver never sees any of it), the flat 32×32
  play area, the lattice overlay (alpha 0 unless `state.drag` is set; fades at 6/s, instant
  under `prefers-reduced-motion`), the core, the four anchors as parked wagons, entity
  layers in `zIndex = depthKey` order, overlays: aggro/leash/attack-range as true-radius
  ellipses (hold → attack range only; reserve → aggro + leash + range), the attacker's entry
  bands tinted, open ring positions as soft lattice-coloured outlines (never a warning
  colour), ring positions highlighted while a fence is dragged. Entity positions are WORLD
  points, not cells, so a replay feeds interpolated positions straight in.
- `skins.ts` — the skin seam: `SkinRegistry` keyed by type id; chunk 08 ships
  `PLACEHOLDER_SKINS` (affinity = shape, Okabe–Ito fills, initials glyph, HP bar, merge
  badge, stance mark). `SpriteSkin` is reserved for chunk 26; the scene refuses it until then.
- `IsoCanvas.tsx` — React wrapper: pan (one pointer), pinch (two), wheel zoom, entity drag
  (`onDragBegin/Move/End` as snapped cells), tap on entity/cell (the no-drag placement
  path: select a chip, tap a cell). `touch-action: none`, pointer events only, no hover.
  Imperative handle `clientToCell` / `cellToClient` for drags that start in the DOM tray;
  the same handle is published as `window.__isoDebug` (the e2e aims drops with it).
  `onUnavailable` fires if WebGL is missing and the DOM lists carry on.

**The screen (`src/screens/trail`):**
- `TrailScreen.tsx` — manifest (chunk 07) → `GET …/candidates` (chunk 14): 404
  `no_open_manifest` = in town; 404 `no_trip` = packed but the trip is not open (chunk 15
  opens it); 404 `no_search` = the Search button; menu unchosen = `CandidatesScreen`; menu
  chosen = `FormationScreen` against that candidate's `scout`.
- `CandidatesScreen.tsx` — the three candidates with owner, band, gap, earn multiplier, a
  full `ScoutPanel` each, "Face …"; the reroll button shows a live countdown to
  `reroll.availableAtMs` and is disabled until then; a 409 `reroll_cooldown` is shown with
  its exact message and `availableAtMs`. No Coin anywhere (tested).
- `ScoutPanel.tsx` — every field of the server's `PartyScoutView` (@caravan/circle
  `scoutParty`): per unit type, affinity, merge level, HP, targeting stance, edge, exact
  start cell, offense and defense as two numbers (offense emphasized — the rating in use),
  speed, range, cooldown, the one ability with cooldown and a healer's finite charges; per
  siege piece what it counters, accelerates/bypasses, the multiplier, the exact tiers/traps
  affected; edges used; slots used. DOM, so it is the text alternative to the canvas.
- `ManifestTray.tsx` — survivors as the constraint: units at real HP (dead marked, not
  draggable), traps (spent marked; "fires once; does not re-arm"), fence material as
  remaining / on the ring / destroyed / packed with "next segment" (healthiest first) and
  the damaged ones listed so the player can put them where it matters least.
- `placement.ts` — pure edits over chunk 07's `Formation`: place/move/remove fence (ring
  position), trap, post; stance; `canDropAt` (ring/anchor/core/entry band/occupancy/
  MIN_POST_DISTANCE — a UI affordance only); `fenceBudget`; `edgeReports` (attackers per
  edge, open positions per side, posts whose reach touches that side); `itemize` /
  `fenceRuns` for the commit confirmation. **There is deliberately no local
  `validateFormation` call**: legality is the server's to decide (chunk 06 QA convention);
  `PUT …/formation` and `…/commit` return the issue list and the screen shows it verbatim.
- `FormationScreen.tsx` — the sticky canvas, radii/threat toggles, budget meter + open
  positions + per-edge approach-vs-coverage lines (information, never a verdict), selection
  panel with the three-stance picker (QA D1) and "take back", the tray, the scouting report
  (open by default, above the commit controls), server issues, save draft, commit through
  a real modal (`CommitDialog.tsx`: portal into `<body>`, shell `inert`, focus trapped,
  Escape, focus restored to the opener, `aria-describedby`) that itemizes every placed
  thing, fence runs, the open-position count, traps held back and each post's stance.
- `guards.ts` — every payload shape-checked at the boundary → `ApiError(0, "bad_payload")`.
- `scoutFixture.ts` — three fixture parties run through `scoutParty`, **component tests
  only** (nothing outside `*.test.*` imports it).

**Tunables used as proposed:** PROJECTION 2:1, DEPTH_SORT row+column painter's, GRID_VISIBILITY
drag-only with fade, SHOW_AGGRO_LEASH_OVERLAY on + toggle, SHOW_THREAT_OVERLAY on + toggle,
TOUCH_TARGET_MIN 44px. **Not built:** FORMATION_PRESETS (save/recall named arrangements) —
deferred; a draft is re-savable, which covers the per-encounter case. The lattice/ring
geometry comes from the resolver via @caravan/circle, never re-declared.

**Tests.** `pnpm --filter @caravan/web test`: 8 files, 47 tests — projection/depth/snap/
camera/hit (pure), placement model, ScoutPanel (field-by-field against the fixture
views), FormationScreen (carry-forward shown truthfully, tap-to-place, stance, take back,
server issues verbatim, modal commit → save then commit, bad_payload), TrailScreen (search
→ three candidates → reroll gate → choose → formation; 409 reroll_cooldown; no_trip state;
bad menu). `pnpm e2e`: `formation.spec.ts` on the real server and WebGL canvas (search,
scout each candidate, countdown visible, choose, drag a fence to ring 0 and a rider to
(13,13), Hold, tap-place the second rider, save, commit a 27-gap circle, server agrees,
reload shows it locked). `scripts/e2e.mjs` seeds a run-unique account, packs via the API
and opens the trip with chunk 14's `createTrip` SQL (the trip route is chunk 15's).

**Decisions / flags for QA.**
- Posted-unit defense is shown UNSCALED (`type.defense`), matching what chunk 07's
  `toBattlefield` hands the resolver since chunk 09's QA X1: ratings never merge-scale, only
  HP and damage output do (chunk 03 QA B1). HP is the manifest's, already at merge level.
  Attacker ratings are the view's. (Integration fix at merge; `stats.test.ts` pins it.)
- The canvas is `position: sticky` so a drag from the tray always has the ground in view;
  everything in the screen has `scroll-margin-top` so focus/scroll-into-view lands below it.
- Siege has no cell in the model; the scene draws it beside the party's first entry edge.
- `pnpm e2e` leaves one `e2e_formation_<base36>` account per run in the e2e database.

### QA round 1 (Maker, 2026-10-11) — `roadmap/qa/08-punchlist.md`, every item closed

**Decisions recorded.** D1: the commit → resolution → replay handoff is **deferred to chunk
23** (PHASE-2 §23's definition of done now carries it; this chunk ships the commit and the
locked state). D2: `FORMATION_PRESETS` **deferred post-v1** (drafts are re-savable and now
autosaved). D5: a tray item selected for tap-to-place counts as "being placed" — the lattice
shows (`IsoSceneState.placing`).

**What changed, where.**
- *Payload shape (B1, N4).* Guards match the chunk 14/25 client view (owner `{displayName,
  authored, flavor}`, `gapBeyondBand`, `authoredOutsideBand`, `authoredShare`,
  `authoredServed`); scout cells on the lattice, unknown types refused, `chosen` must be in
  the menu. **Contract test (D4):** `apps/server/test/contract.test.ts` →
  `apps/web/src/test/contract/*.json` → `contract.test.ts` (see apps/web/README.md).
- *Renderer (`src/iso`).* `gestures.ts` — the pure gesture machine (B3: a second finger
  cancels a begun drag, then pinches). `hitTestScreen` — a ≥ 22 px circle on screen (S10).
  `radiusEllipse` — true radii (B2). `focusCamera` — zoom to the ring on selection (S10).
  Native non-passive wheel (S12). Drag moves rAF-coalesced; the scene keeps its nodes and
  repositions them, rebuilding only on a visual change (S2). Circles by line style (S11),
  dashed attacker ring (N10), PixiJS's AccessibilitySystem torn down after init (N3),
  `window.__isoDebug` only in dev/test/`VITE_ISO_DEBUG=1` builds (N5).
- *Trail.* `placement.ts`: `dropRefusal` = circle's `validateFormation` over the
  hypothetical drop (S9, N6); `postReach` from `toBattlefield` + UNIT_RADIUS (B2, N11);
  `pickerOptions` for the DOM placement picker (`PlacementPicker.tsx`, D3).
  `trayGesture.ts`: touch drags from the tray only after a long press or a sideways move
  (B4). `FormationScreen`: autosave (S13), commit through the shell `Modal` with a server
  check first and the unposted / held-back / remaining lists (S6, S7), humanized issues
  with Show buttons and flagged chips (S8), refusals with codes (S9), attacker tap → scout
  card (S14), clear confirm (N8), shell ErrorBox (S5). `CandidatesScreen`: scouting open
  above "Face …" (N1), countdown independent of the device clock (S4), authored facts
  as reported (B1). `ScoutPanel` / `stats.ts`: damage per hit at merge level (S1, from
  `ScoutUnit.damagePerHitMult` in @caravan/circle), speed with its unit (N9), strings
  externalized (S15).
- *Stance copy (chunk 11 QA D1).* A reserve post "holds its post and strikes only what
  comes into attack reach until an attacker breaches the ring; then joins the fight like a
  guard". The threat overlay counts a reserve post by its attack reach.
- *S3* was already done by chunk 17 (Trail, Town and Party are lazy; PixiJS is not in the
  login chunk).

**Flags.** Adding `damagePerHitMult` to `ScoutUnit` changed two key-list assertions
(`packages/circle/test/party.test.ts`, `apps/server/test/party.test.ts`); menus stored
before it lack the field and the client guard fills content's multiplier for that level.
The server keeps a draft only once every living unit is posted, so until then the
autosaved arrangement lives in memory for the page load (a tab switch keeps it; a reload
does not).
