# Chunk 17 — Home town: merge board, mine, and hub

**Depends on:** 03, 08, 16. **Status:** built.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

The screen the player sees most: their **home town**, an Old West settlement on the
isometric island. Units sit on a limited grid where they are merged into stronger
copies. The mine ticks away generating Coin. Everything else in the game is reachable
from here — including packing a caravan and riding out.

This is a **standard merge-game home screen**, in an Old West town setting.

**The town is not the wagon circle.** The wagon circle is a formation the caravan
adopts out on the trail, arranged fresh at each encounter (chunks 07–08). The town is
a permanent settlement that **is never attacked by anyone, ever**. Keeping these
distinct in code, art, and copy matters — conflating them is the exact confusion this
design already had to be corrected for once.

## What this screen is — and what it is not

Three distinct places, sharing one isometric renderer (built in chunk 08). Do not
write a second renderer, and do not merge the places.

| Surface | Where | Owner | Units | What the player does |
|---|---|---|---|---|
| **Home town** | the settlement, safe | this chunk | present but **completely static** | merge units, watch the mine, pack a caravan, navigate |
| **Wagon circle** | on the trail, mid-trip | chunk 08 | placed per encounter | arrange fences, traps, posts against a scouted attacker |
| **Battle / replay** | on the trail | chunk 13 | free continuous movement | watches; no input at all |

**Units do not move in town.** There is no wandering, no idle pathing, no
simulation of any kind here. This screen never runs the resolver and never animates
units around the board. They sit where the player put them until the player drags one.

## Design constraints that apply here

- **Presentation reuses the shared isometric renderer** built in chunk 08: 2D
  isometric projection of the square lattice, on a natural island with multiple
  topographical tiers and cliff edges for visual depth. **Reuse it — do not write a
  second one.** The town's *content* is its own (buildings, mine, merge board); only
  the rendering machinery is shared.
- **The active area is flat level ground in the center of the island.** The tiers and
  cliffs are inert scenery with no gameplay meaning. Nothing in town is ever simulated,
  so no scenery here can reach the resolver at all.
- **The grid is visible only while the player is moving a unit** — or anything else
  that snaps to it. It fades in on drag start and out on drop. At rest the screen
  reads as a place, not a board. This is the same rule as every other placement
  surface in the game; it should feel identical everywhere.
- **A limited grid where units can exist.** Board space is finite, which is the
  standard merge-game pressure toward merging rather than hoarding. See the open
  question below — this cap interacts with a hard design guarantee.
- **Merging** happens here, and follows chunk 16's rules exactly: two recipes
  (2 → 1 of the next tier, and 5 → 3 at the better per-unit rate), capped at level 5,
  costs Coin, no branching and no specialization at merge time. **A merged unit is not
  stronger than its components combined — it is more slot-efficient**, and this screen
  is where that benefit is most visible, since the board is where slots are scarce.
- **The mine** is the on-screen home of the **passive Coin trickle** from PROJECT.md
  §14 — the slow accrual up to the storage cap that exists so something is always at
  risk even for players who aren't actively pushing trips. It is a **diegetic
  representation of an existing system, not a new one.** See the open question below.
- The Coin **storage cap** applies here as everywhere; show the player how close they
  are to it, and warn before earnings would be discarded.
- **Legibility:** merge cost and the resulting unit's stats are visible before
  committing. Nothing on this screen commits a resource without a preview.
- The caravan's `in_town` / `on_trip` state is visible — the player should be able to
  see at a glance whether their caravan is home and refitted or currently out.

## Open questions — decide before building, flag if unsure

**1. How does packing a caravan work from here?**
The roster in town is much larger than what a caravan can carry (`DEPLOYMENT_SLOT_CAP`
= 8 living units, plus traps and fence material). Packing is therefore a real loadout
decision made in town before departure, and it is **locked for the whole trip**.
**Proposed default:** a dedicated "outfit the caravan" flow launched from the town,
showing the manifest against its caps, ending in "ride out" which starts the trip.
It is not the merge board and not the wagon circle formation — those are separate.

**2. Does the board cap conflict with the acquisition guarantee?**
PROJECT.md is explicit that **mercenary recruit must always be available for any
unlocked type** — *"no player is ever blocked from getting what they need; they just
pay Coin instead of waiting."* A full merge board would block exactly that. The board
cap must therefore **not** be the acquisition cap.
**Proposed default:** the visible board is a working surface backed by an overflow
inventory (chunk 18's `UNIT_INVENTORY_CAP`, 200). Acquisition always succeeds; units
beyond board capacity land in overflow and the player moves them onto the board when
there's room. This keeps the merge-game pressure without ever blocking acquisition.

**3. Is the mine upgradeable?**
It must not become one. PROJECT.md's passive trickle is a flat rate to a cap. A mine
the player upgrades with Coin would be **a new progression axis outside the unlock
web** — Coin buying a permanently better economy is Coin buying power, not pace.
**Proposed default: the mine is purely presentational.** It visualizes the existing
trickle and its rate is `COIN_TRICKLE_RATE`, full stop. If an upgradeable mine is
wanted later, it is a design change to PROJECT.md §14 and §16, not an implementation
detail — escalate rather than deciding it here.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `BOARD_SLOTS` | 36 (6×6 within the wagon circle) | The visible merge surface. Tight enough to create merge pressure, loose enough not to feel punishing. |
| `OVERFLOW_INVENTORY_CAP` | 200 | From chunk 18. Must never block acquisition in practice. |
| `GRID_VISIBILITY` | visible only during an active drag, fading in and out | Identical to chunks 08 and 09. |
| `MERGE_INTERACTION` | drag one unit onto another of the same type and level | Standard merge-game interaction. The 5 → 3 recipe needs its own explicit affordance, since it can't be expressed by dragging one unit onto one other. |
| `MERGE_COST_BY_TARGET_LEVEL` | L2: 250, L3: 900, L4: 3,000, L5: 9,500 | From chunk 16. Shown before commit. |
| `COIN_TRICKLE_RATE` | 200/hour, ceasing at the storage cap | From chunk 16. The mine visualizes exactly this. |
| `MINE_ANIMATION` | ambient, cosmetic, driven by the lazily-computed balance | Must not imply a per-second tick the server isn't running. |
| `TOUCH_TARGET_MIN` | 44px | Web-first, mobile-shaped. Drag-to-merge must feel good with a thumb. |

## Definition of done

- [ ] Town renders using chunk 08's isometric renderer — one renderer, not two.
- [ ] The town is visibly a settlement, not a wagon circle, and nothing in it implies
      it can be attacked.
- [ ] Packing/outfitting flow: choose the manifest within its caps, then ride out.
- [ ] Units sit on a limited board and **never move on their own**. No idle animation
      that relocates a unit, no simulation, no resolver call from this screen.
- [ ] Grid appears only during an active drag and fades out on drop.
- [ ] Both merge recipes work, with the 5 → 3 recipe given its own clear affordance.
- [ ] Merge cost and resulting stats shown before committing; server re-validates.
- [ ] Slot efficiency is legible — the player can see that a merged unit frees board
      and deployment space.
- [ ] Mine displays the passive trickle and the storage-cap headroom; warns before
      earnings would be discarded.
- [ ] Mine is presentational only — no upgrade path, no Coin sink, no rate change.
- [ ] Acquisition never fails because the board is full; overflow handles it.
- [ ] `in_town` / `on_trip` state is visible and honest.
- [ ] Navigation to every other surface: defense builder, unlock webs, raid party
      builder, the standing raid party builder, acquisition, packs, and the results
      feed for your standing party.
- [ ] Touch-usable throughout: drag-to-merge, pinch-zoom, no hover-dependent affordances.

## QA guardrail checks for this chunk

- **No simulation in town:** confirm nothing here calls the resolver, animates unit
  movement, or runs a tick loop. The town is static by design; a stray idle behaviour
  would be the first step toward a second, divergent movement implementation.
- **The town is never attackable:** confirm no code path, event, or notification can
  put the town under attack. Banked Coin lives here, and §13's promise that banking
  is permanent depends entirely on this being airtight.
- **No pay-to-win — the mine specifically:** is the mine purely presentational? Any
  upgrade path, Coin sink, or rate modifier would make it a progression axis outside
  the unlock web, which is Coin buying a permanently better economy. Check that its
  rate is read from `COIN_TRICKLE_RATE` and cannot be altered by anything the player buys.
- **No pay-to-win — merging:** confirm again at the UI layer that a merged unit is not
  stronger than its components combined. This is the screen where a player forms their
  intuition about what merging does; if the UI implies a power gain the numbers don't
  support, that's a legibility problem even if the math is right.
- **Acquisition is never blocked:** fill the board completely, then acquire via
  mercenary recruit. It must succeed. PROJECT.md guarantees no player is ever blocked
  from getting an unlocked type — a full board must not become a back-door block.
- **Legibility:** are merge costs and resulting stats previewed before commit? Is the
  storage cap and its headroom visible before earnings get discarded?
- **Determinism:** the mine's displayed accrual must match the server's lazily-computed
  balance exactly. A client-side timer that drifts from the ledger will produce visible
  disagreements and support tickets.
- **Grid visibility:** does the grid ever persist at rest, or fail to appear on drag?
  It should behave identically here, in the defense builder, and in the party builder.
- **One renderer:** confirm the town reuses chunk 08's isometric renderer rather than
  reimplementing isometric projection and depth sorting. Two renderers will diverge.

## Build notes (2026-10-11)

**Open questions, decided as proposed:** (1) a dedicated "Outfit the caravan" flow
launched from the town, ending in a real-modal confirm that packs the manifest
(`POST /caravans/:id/manifest`) and shows **"Packed, waiting to ride out."** — opening the
trip itself is chunk 15's; (2) the board is a working surface over the overflow
(`UNIT_INVENTORY_CAP`): acquisition never looks at the board, a unit with no free cell
lands in the overflow; (3) the mine is purely presentational — it renders the server's
`trickle.ratePerHour`, `balance`, `cap`, `room`, with no button, sink or rate change.

**Where it lives** (`apps/web/src`):
- `screens/town/` — `TownScreen.tsx` (loader, caravan state, canvas gestures, navigation),
  `board.ts` (pure board model: layout, moves, merge-drop eligibility, groups, picks,
  product hints), `townScene.ts` (pure scene builder for the shared renderer, the
  settlement's structures, per-viewer board persistence), `BoardPanel.tsx` (the DOM twin:
  board/overflow chips, the merge groups with a button per recipe — the explicit 5 → 3
  affordance), `MergeDialog.tsx`, `MinePanel.tsx`, `RefugeePanel.tsx` + `refugeeModel.ts`,
  `RecruitPanel.tsx`, `OutfitScreen.tsx` + `outfitModel.ts`.
- `screens/party/` — `PartyScreen.tsx` (the standing raid party builder chunk 09 deferred
  here) + `partyModel.ts` (pure config edits).
- `shell/Modal.tsx` — the real-modal chrome generalized from `ConfirmDialog` (portal, inert
  siblings, focus trap, Escape, focus restore); `auth/session.tsx#useApi` lets a screen take
  an injected client in component tests.
- `iso/` — extended, not duplicated: `geometry.fixtures: "town"` (no core, no parked
  wagons), optional `boardUnits` / `structures` / `mine` / `boardCells` in the scene state,
  a `"unit"` hit kind, `"unit"` / `"attacker"` drag ghosts, `selected` on attackers. The
  board cells are outlined only while a unit is dragged; the lattice rule is unchanged.
  The mine wheel is the only ambient motion (`MINE_WHEEL_TURNS_PER_SECOND`, stopped at the
  cap and under reduced motion); it advances no number.
- API: `api/{client,shapes,types}.ts` — economy, merge preview/commit, refugees
  (GET/claim/refresh/reroll), recruit (GET/POST), party (GET/PUT), party feed, each with its
  payload guard. The recruit guard refuses a body claiming a cooldown or daily limit; the
  party guard refuses one whose `rules` are not a template.
- Tunables: `BOARD_SLOTS` 36 and `BOARD_SIDE` 6 in `packages/content/src/tunables.ts`.

**Decisions and assumptions (confirm in QA):**
- **Board positions are presentation**, like a camera: the server holds no board. The
  layout is client-side, persisted per caravan in `localStorage` (a convenience: it may
  come back empty and the board simply re-lays out, deterministically, in id order). A
  unit the player sent to the overflow stays there; new units take the first free cell.
- **Merge interaction:** drag a unit onto one of the same type and level (or tap one, then
  the other) → the preview dialog asks the server; the drop target goes first in
  `instanceIds` so the product lands on its cell. 2 → 1 and 5 → 3 are also offered per
  (type, level) group with the quoted cost (`costPerResultingUnitByLevel × produce`,
  display only; the preview is authoritative). The preview shows cost, balance including
  the pending trickle, unaffordability, slots before/after, the consumed units' COMBINED
  stats beside the produced units' combined stats, the damage multiplier, the unchanged
  ability, and "not stronger than the consumed ones combined". A unit in the standing
  party needs a checkbox before the confirm enables and is sent as `confirmInParty: true`.
  Server refusals (409 `caravan_on_trip`, `insufficient_coin`, …) are shown verbatim.
- **Packed units are not offered for merging** while a manifest is open. The server does
  not refuse that today (it checks only `caravan.state`, and packing does not move the
  state — chunk 15 does): flagged for chunk 15/16.
- **Refugee timer:** a one-second display clock counts down from the server's
  `msUntilFreeRefresh` between reads; at zero the panel re-reads (GET never writes) and
  shows the server's `freeRefreshDue`, with "Take the free menu now" (`POST refresh`). A
  reroll is not offered while a free menu is due (`blockedByFreeRefresh`); its cost
  (150 / 300 / 600 from the server's schedule) is on the button and confirmed in a modal.
  Duplicate slots are collapsed ("offered 2×"). Every write names `sequence` /
  `fromSequence` from the last GET.
- **Recruit** lists every `recruitable` type with its cost and every `locked` type as "Not
  for sale — reach it in the Webs" with a link to the Webs. Each confirm carries a fresh
  `requestId` (a retry of the same POST replays).
- **Coin forecast** (mine and outfit) is the server's `overflow.message` for the shortest
  trip (`encounterSchedule[0] + bankedTripBonus`, both server numbers).
- **Outfit caps** are measured, not enforced: the meters read `DEPLOYMENT_SLOT_CAP`,
  `TRAP_SLOT_CAP`, `FENCE_MATERIAL_BUDGET` and warn when a draft is over; the server's
  packer decides and its issue list is shown. Trap types and fence tiers offered are the
  reached nodes of the trap web.
- **Party builder** draws the party's units as attackers on the wagon-circle geometry they
  will attack (the shared renderer), shows all four entry bands while dragging and the used
  ones at rest; drops off a band change nothing. Stance per unit from `rules.stances`, edge
  buttons re-snap into the band, siege checkboxes with counters and the exact target types
  (locked siege disabled). Saved via `PUT /me/party`; a 400 shows every issue. The scouting
  preview (`party.scout`) reuses the trail's `ScoutPanel`; the feed pages with `before`.
- **Cross-chunk drift NOT fixed here (owned by the chunk 08 fixer, QA-08 B1):** the web
  candidate-menu guard still expects `owner.accountId` / `usedAuthoredFallback`, which the
  server dropped / renamed (chunk 14 QA N4/N5, chunk 25), so `e2e/formation.spec.ts` fails
  with `bad_payload` on this branch exactly as it does on `roadmap/phase-2-spec`. The menu
  and choice guards are untouched. The e2e specs click tabs inside the Main navigation
  (the town's own navigation buttons share their names).
- **Adopted from chunk 08 QA (coordinator instruction):** Town, Party and Trail are
  `React.lazy` chunks (PixiJS lives in the `IsoCanvas` chunk, not the login/index chunk);
  canvas hit radius never below `MIN_HIT_RADIUS_PX` 22 px on screen (`hitTest` takes a
  radius, `IsoCanvas` derives it from the camera); `touch-action: pan-y` on every town /
  party / outfit chip (none of them is a drag source — the canvas is); the party builder
  has a DOM alternative to dragging (edge buttons + "position along the edge" and "how far
  in" selects, `partyModel.cellOnEdge`); server issue refs are shown by name
  (`shell/issues.ts#humanizeIssue`, used by the party and outfit issue lists), no issue
  codes, raw ids, ISO timestamps or chunk numbers in town/party/outfit copy. Radii are not
  drawn by any chunk 17 screen (the √2 fix in `scene.ts` is the chunk 08 fixer's B2).
- Guards for chunk 17's routes (economy, merge, refugees, recruit, party, party feed) were
  checked against the server on `roadmap/phase-2-spec` (merged into this branch at
  `1ed535b`): none of those routes changed shape; the e2e runs them against the real
  merged server. No store/cosmetics guard was added (no store screen in this chunk).
- `.dialog` now scrolls inside itself at 360×640 with sticky actions (the merge preview is
  taller than a small phone).

**Tests:** component/model tests for the board model, the scene (no core, no attackers,
units static during a drag), merge preview → confirm (incl. the in-party confirm and a
verbatim refusal, the 5 → 3 button), the refugee timer states (counting / stale → re-read /
due), duplicates collapsed, reroll confirm, recruit list (unlocked with cost, locked
"reach it in the Webs"), the party builder (issues shown, drag to a band, off-band refused,
save sends exactly the config, refused save lists every issue), outfit caps and pack, and
the payload guards against the fixtures. Playwright `e2e/town.spec.ts` at 360×640: sign in
→ claim a refugee → recruit a second copy → drag one onto the other on the real canvas →
preview → confirm → party (add, stance, drag onto the east band, save; server agrees) →
outfit (unit, trap, fence) → ride out → "Packed, waiting to ride out."; asserts no
horizontal scroll and every visible button ≥ 44px tall. The party step in the e2e drags on the canvas; the list selects are covered by the component test.

**Not built:** the store screen (packs) — the town lists it as not built; trip start
(chunk 15); a packs/cosmetics surface; board positions on the server.
