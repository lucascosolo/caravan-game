# Chunk 17 — Home town: merge board, mine, and hub

**Depends on:** 03, 08, 16. **Status:** not started.
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
