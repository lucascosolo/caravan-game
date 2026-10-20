# Chunk 51 — Saved layouts

**Depends on:** 50, 08, 15, 24. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first, including §0 on which way round the game runs.

## Goal

The player's last wagon-circle layout loads **automatically** at every encounter,
including the first encounter of a new trip, turned to face the scouted party's main attack
edge, minus whatever the caravan no longer has. The player reads the scout beside it, edits
if they want, and locks in, per encounter, exactly as today. Newer players get gentle,
dismissible hints about the loaded layout against this party; hints never block lock-in,
never change the layout, and fade out with experience.

Today encounter 2+ starts empty with an opt-in "Start from my last arrangement" button
(`apps/web/src/screens/trail/FormationScreen.tsx` ~694, `placement.ts` `carryForward`
~487, `strings.ts` ~370–377), nothing persists across trips, and formations are stored per
(manifest, encounter_index) (`apps/server/src/circle/service.ts` ~187–211, table
`wagon_formation`). Studio review F14 (`roadmap/review/studio-design.md`) measured about 45
interactions per hand-laid fight for a player who fights 15–25 times a day.

Builds on chunk 50: the ring geometry, its side table and its segment order are chunk 50's.
Do not start until 50 is `QA'd`.

## Owner decisions (2026-10-20)

Recorded from the owner's session on 2026-10-20:

- The player's last layout loads **automatically at every encounter, including the first
  encounter of a new trip**. Pieces the caravan no longer has (broken, spent, dead, not
  packed) are left out with a short note. The layout is stored relative to the main
  attack edge and rotated to face the scouted party's main edge on load. The player
  reviews the scouted party beside the loaded layout, may edit, then locks in per
  encounter.
- **Hints, never force.** Owner, verbatim: "give new players little helpful hints like you
  suggested for when the attack direction changed but don't force them to change their
  layout if they don't want to". Hints are gentle and dismissible, never block lock-in,
  never change the layout themselves, and fade out as the player gains experience.
- **Optional, lower priority:** up to 3 named layouts per caravan (studio-design F14),
  inside this chunk if time allows or as a follow-up.

## Design constraints that apply here

- **Legibility (guardrail 4).** The scout stays fully visible before lock-in, next to the
  loaded layout: every unit, stat, ability, stance, siege and entry side, no less than
  chunk 08 shows today. The loaded layout's missing pieces are **shown, never silently
  dropped**: a short note lists each by name and reason ("Barbed wire (north): broken",
  "Powder keg: spent", "Dust Rider: not packed").
- **Caravan-level data (guardrail 5).** A saved layout belongs to the caravan (living units
  are caravan-level; the layout names them). Keyed by `caravan_id`, never `account_id`.
- **Determinism (guardrail 1).** No randomness in loading or rotation. Loading is a pure
  function `loadLayout(saved, survivors, scout) → { formation, leftOut }` in
  `packages/circle`, of the stored layout, the current manifest's survivors and the
  scouted party only. Same inputs, same draft, byte for byte.
- **No Coin path (guardrail 2).** No slot, hint, preset or auto-load behaviour is bought,
  unlocked by a pack, or gated on spend. The named-layout cap is the same for everyone.
- **The formation is still chosen per encounter.** Auto-load produces a **draft**; nothing
  commits without the player's lock-in. PROJECT.md §9's "chosen fresh per encounter" holds:
  the player is shown a starting point, not handed a decision.
- **Gaps are legal strategy** (chunk 07 QA check). A hint may *describe* a gap facing the
  main edge; it must never call it a mistake, and a gap left on purpose as a funnel into
  traps is as legal as any other.
- **Validation stays server-side.** The loaded draft is validated by the existing
  `validateFormation` against the survivors; the client never decides what is legal.

## What is stored

On every lock-in (commit) the committed formation becomes the caravan's **last layout**,
normalised so the encounter's main attack edge is north (quarter turns about the core
centre). One row per caravan for the last layout (proposed table `caravan_layout`,
migration 032 or next free; `slot` 0 = last, 1–3 = named), with:

- the main edge it was normalised from and the scout's per-edge raider counts (for the
  "direction changed" hint);
- **fences** as (normalised ring position, fence type and tier);
- **traps** as (normalised cell, trap type);
- **posts** as (normalised cell, living-unit instance id, stance). Instance ids are
  caravan-level and survive between trips;
- a layout `v` and the `BATTLEFIELD_VERSION` it was saved under. A layout saved under
  another battlefield version is not loaded; the encounter starts empty with a note.

Manifest refs are not stored: they are per trip. Matching back to the current manifest is
by type (fences, traps: survivors of that type in manifest ref order, highest HP first)
and by instance id (posts).

## Loading and rotation

- **Main edge** is the existing `mainEdge` in `packages/circle/src/guideLayout.ts`
  (most raiders), with its tie-break written down if it is not already: equal counts go to
  the first in `ENTRY_EDGES` order (north, east, south, west).
- **Rotation** is the quarter turn that takes north to the scout's main edge, applied to
  every stored cell and ring position. Interior cells and ring cells are symmetric under a
  quarter turn (true of the chunk 50 draft; asserted by a test against the fixture).
- **Wagons are not quarter-turn symmetric** in the draft geometry (six wagons cannot be).
  So a rotated fence can land on a wagon cell. Rule: that fence is left out with the note
  "already walled by a wagon here"; a stored gap that lands on a wagon is simply closed by
  the wagon. No fence is moved to a "nearby" position: that would be the loader choosing a
  layout. If chunk 50's approved geometry turns out symmetric, this rule never fires and
  the test says so.
- **Left out, with a note**: a fence whose type has no surviving material, a spent trap's
  type with none left, a dead or unpacked unit, a cell now occupied or illegal, anything
  past a slot cap or the material budget. Applied in a fixed order (fences, traps, posts,
  each in stored order), the same order `carryForward` uses today, so the result is what
  hand drops could have made.
- **When it loads**: when the player opens an encounter with a chosen candidate and no
  draft yet, the server builds the draft with `loadLayout` and saves it through the
  ordinary draft path, so a reload shows the same draft. An existing draft is never
  overwritten.
- **First trip of a new caravan, or nothing saved**: starts empty, as today, with the
  guide (chunk 24) and "Arrange for me" unchanged. "Arrange for me" and a **Clear** button
  remain available on every encounter and replace the draft only when tapped.
- "Start from my last arrangement" is removed; auto-load subsumes it. Its strings go.

## Hints

Hints are information about the loaded layout against *this* scout. Shown beside the scout
before lock-in, each dismissible, none blocking, none editing anything.

| Hint | When | Wording direction |
|---|---|---|
| Gap faces the main edge | a fence position on the main edge's side is open | "Your gap faces north, where 5 of 7 raiders come from." No "should". |
| Trap on an unused side | a trap's cell is on a side with no raiders | "This trap is on the west side; no raider comes from the west." |
| Direction changed | the scout's set of sides differs from the one the layout was saved against | "This layout was made against raiders from the north only. This party also comes from the east." (Today's `lastAppliedOtherSides` copy is the model.) |
| Pieces left out | `leftOut` is non-empty | The missing-pieces note itself; this one is not a hint and does **not** fade. |

- **Fade-out:** hints show while the caravan has banked fewer than
  `LAYOUT_HINTS_UNTIL_BANKS` trips (voided and overrun trips not counted, as for
  `AUTHORED_ONLY_UNTIL_BANKS`). The missing-pieces note always shows (guardrail 4).
- **Dismissal** hides that hint for that encounter. No client storage (the client stores
  nothing, AGENTS.md): dismissal is page state; an all-hints-off switch, if built, is a
  server-side account preference beside the onboarding state (chunk 24), since it is a UI
  preference, not progress.
- Hints are computed by a pure function in `packages/circle` of the formation and the
  scout, so web and tests agree.

## Named layouts (optional, lower priority)

Up to `SAVED_LAYOUT_SLOTS` named layouts per caravan (slots 1–3), saved from the current
draft with a name, loaded on demand (replacing the draft, with the same rotation and
left-out rules), renamed, overwritten or removed by the player. Auto-load always uses the
last layout, never a named one. If deferred, add a follow-up line to this file and to
INDEX.md rather than a half-built UI.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `LAYOUT_HINTS_UNTIL_BANKS` | 10 banked trips per caravan | When hints stop. TUNABLE; the dashboard (chunk 32) can show hint dismiss rates to tune it. |
| `SAVED_LAYOUT_SLOTS` | 3 named, plus the automatic last layout | TUNABLE; same for every account. |
| `LAYOUT_NAME_MAX_CHARS` | 24 | TUNABLE. Names are player text: same filtering as caravan names. |

## Definition of done

- [ ] On lock-in the committed formation is stored as the caravan's last layout,
      normalised to its main edge, keyed by caravan.
- [ ] Every encounter with no draft yet, including encounter 1 of a new trip, opens with
      the last layout loaded, rotated to the scouted main edge, as a saved draft.
- [ ] `loadLayout` is pure and deterministic: a property test over all four edges and
      random (seeded) layouts and survivors shows identical output on repeat and that a
      layout loaded against its own main edge equals the stored one minus what is missing.
- [ ] Every left-out piece appears in the note with its reason; nothing is dropped
      without one (tested per reason, including "already walled by a wagon here").
- [ ] An existing draft is never overwritten by auto-load; Clear and "Arrange for me"
      still work; "Start from my last arrangement" and its strings are gone.
- [ ] The three hints fire on their conditions, are dismissible, never block lock-in,
      never change the formation (asserted: formation hash unchanged by any hint action),
      and stop at `LAYOUT_HINTS_UNTIL_BANKS`; the missing-pieces note never stops.
- [ ] The scout is fully visible beside the loaded layout on a 393 px-wide phone.
- [ ] A layout saved under another `BATTLEFIELD_VERSION` is not loaded; the note says so.
- [ ] No read of purchase, entitlement or Coin state anywhere in save, load or hints.
- [ ] e2e: bank a trip, start a new one against a party from another side, see the
      layout turned to face it with the left-out note, edit one piece, lock in.
- [ ] `pnpm check` green.

## QA guardrail checks for this chunk

- **Legibility:** is anything removed from the loaded layout without appearing in the
  note? Is any part of the scout hidden or pushed off-screen by the layout or the hints?
- **Hints never force:** can a hint block, delay or alter lock-in, or edit the layout? Is
  any hint worded as a mistake about a gap?
- **Split:** is the layout keyed by caravan? Could another caravan of the same account
  (when multi-caravan arrives) read it?
- **Determinism:** do loading and rotation depend on anything but the stored layout, the
  survivors and the scout (clock, insertion order, client state)? Is the main-edge
  tie-break explicit?
- **No pay-to-win:** is there any Coin, pack or entitlement path to more slots, better
  hints or anything else here?
- **Attrition intact:** does auto-load ever bring back a broken fence, a spent trap or a
  dead unit? It must not; chunk 07's carry-forward is the floor.
- **The decision is still the player's:** does anything commit a loaded layout without a
  lock-in?

## Notes

- **PROJECT.md:** no amendment required. §9's "chosen fresh per encounter" stays true: the
  player still decides and locks in at every encounter; the loaded layout is a starting
  draft. An optional clarifying sentence ("the caravan's last arrangement is offered as a
  starting point, turned to face the scouted party") is the owner's call.
- **Depends on a chunk 50 owner question:** wagon placement that is not quarter-turn
  symmetric is why the "already walled by a wagon here" rule exists. If the owner picks a
  symmetric arrangement, that rule becomes dead code and is dropped.
