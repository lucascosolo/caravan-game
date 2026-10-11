# Chunk 17 — QA punch list (commit f25eb15, merged at 5d5fb30)

Probes: scratchpad/qa17 (api/p1–p3.mjs, qa1–qa12.mjs, shots/).

## Blocker
B1. [closed] A unit packed in an open manifest can be merged away (economy/merge.ts:254-265 preview, :345-347 commit) because the only guard is `caravan.state` and nothing sets `on_trip`. Loss evasion and dangling manifest refs. Fix server-side, independent of caravan state: in preview and in the commit's FOR SHARE transaction, refuse 409 `unit_packed` for any instance id in an open manifest's `packed` or `survivors`; test. The same rule applies to refugee/recruit? (no: they add, never remove) and to party saves? (no: a party may reference a packed unit; it's a template).
    — `merge.ts` `packedAmong` reads `packed.units[].ref` ∪ `survivors.units[].ref` of every open manifest (`closed_at IS NULL`) of the account's caravans; `assertNotPacked` runs in `previewMerge` and in `performMerge` after the caravan's FOR SHARE (which conflicts with `lockManifest`'s FOR UPDATE, so a pack cannot interleave). 409 `unit_packed` with `packed: [ids]` (route error handler). Never reads `caravan.state`. Tests "B1" in `test/economy.test.ts` (packed pair, packed + unpacked, upper-case ids, state flipped both ways, HTTP body, unpacked units still merge, closed manifest frees them; 6 pack-vs-merge races: exactly one wins). The e2e asserts the same through the API after packing. Probe p2 now: `merge packed preview 409 unit_packed`, `merge packed commit 409 unit_packed`, packed instances still in roster: 2.

## Decisions (orchestrator)
D1. [closed] Board positions stay client-side (presentation, like a camera). Key by account id + caravan id; clear on sign-out; accept per-device layouts. Record in the chunk file.
    — key `caravan.viewer.town.board.<accountId>.<caravanId>` (`townScene.ts#boardStorageKey`); `auth/session.tsx` `signOut` → `resetViewerState()` removes every `caravan.viewer.*` key and drops registered in-memory state. Recorded in the chunk file. Tests "D1" (component) and the e2e (key present, gone after sign-out); probe qa5: `localStorage after sign-out keys: []`.
D2. [closed] Chunk 15 flips `caravan.state` at trip start/end; the B1 fix must not depend on it. Append a note to roadmap/chunks/15-trip-loop.md.
    — appended "Note from chunk 17 QA (B1/D2)".

## Should-fix
S1. [closed] Open the town framed on the 6×6 board with each cell ≥ 44 px; the island reachable by pinching out.
    — `IsoCanvas` optional `frame` prop (`frameCamera`: fit the rectangle, zoom floor `minCellPx / TILE_W`); the town passes the board with `minCellPx` 44 (2 × `MIN_HIT_RADIUS_PX`). "≥ 44 px" is the cell diamond's on-screen width (at 360 px the board fits at ~50 px; the 2:1 axis pitch is ~28 px, and 6 cells at 44 px axis pitch cannot fit a 360 px phone). `ZOOM_MIN` is unchanged, so pinch / wheel reach the whole island. Tests: models "S1" (three viewports), e2e (diamond width ≥ 44, four board corners inside the canvas).
S2. [closed] Recruit (and reroll/claim) after a lost response: on status 0 keep the dialog with the same `requestId`/sequence and offer "Try again" that replays it; wording "could not confirm", not "refused"; spend-specific ErrorBox copy (not "Nothing was changed").
    — `town/SpendError.tsx` (status 0 → "Could not confirm whether this went through… not charged twice"); recruit and reroll confirms stay open with the same `requestId` / `fromSequence` and the primary button becomes "Try again"; a lost claim / refresh shows the same box with Cancel / Try again (same `sequence`). Walking away re-reads the town. A real status still closes and shows the server's message. Replays say "had already gone through; nothing was charged twice". Tests "S2" ×4; probe qa4: one retry → charged 600, units +1, status "That recruit had already gone through".
S3. [closed] Render a reload error (ErrorBox + Retry) above the board whenever `loadError` is set, not only before first load.
    — `town-reload-error` under the balance line ("Could not re-read the town… last good read"). Test "S3".
S4. [closed] Party builder: feed Retry reloads only the feed; keep the draft across tab switches (in-memory store) and confirm before discarding unsaved edits.
    — `loadParty` / `loadFeed` split; `party/draftStore.ts` (in memory, keyed by party id, cleared by `resetViewerState`); "Reload the saved party" asks in a real modal when dirty. Tests "S4" ×3; probe qa9: dirty kept across the tab switch and the feed Retry.
S5. [closed] Refugee panel: claimed + due → "Your next free menu is ready: take it now (nothing is forfeited)"; drop the contradictory line.
    — that copy, and the claimed line drops "The next menu arrives on the timer" while due. Test "S5".
S6. [closed] Show the lattice and board cells while a unit is selected (tap-to-move), per chunk 08 D5.
    — `townSceneState`: a selected unit yields a cell-less `unit` placement ghost, so the renderer shows the lattice and board cells (and dims non-mergeable units) exactly as during a drag; no `iso/` change. Tests: models "S6", component "S6", e2e (tap → lattice > 0, Done → 0).
S7. [closed] Siege toggle labels min-height `var(--tap)`; extend the e2e 44 px check to inputs and their labels.
    — siege labels and the merge in-party label; `fitsPortrait` now checks buttons, selects, summaries, links and checkboxes / radios by their label. Test "S7"; probe qa9 360 px party layout `small: []`.

## Nits
N1. [closed] Update drag state only when the cell changes; keep the mine wheel object (no rotation snap).
    — town and party `updateDrag` return early on the same cell; `IsoScene` keeps the wheel's angle across redraws (`mineWheelAngle`).
N2. [closed] "including the trickle so far", only when pendingTrickle > 0.
    — `previewBalance`. Test "N2".
N3. [closed] Map feed `outcomeKind` to player wording.
    — `party.feedOutcomeKind` (placeholder_unresolved, party_wiped, core_overrun, tick_cap; anything else "Outcome: recorded"). Test "N3".
N4. [closed] Modal focus restore fallback (port ConfirmDialog's `restoreFocusTo`).
    — `Modal` `restoreFocusTo`, then `main`; used by merge (board heading), recruit, reroll, outfit, party discard. `shell/Modal.test.tsx`.
N5. [closed] Re-fetch before recruit/reroll confirms that quote the balance.
    — Recruit re-reads `GET …/recruit`, reroll re-reads `GET …/refugees` before the modal opens; the modal quotes the fresh numbers. Tests "S2 + N5", reroll.
N6. [closed] Copy: "move them onto the board when there is room"; "Pack the caravan" until chunk 15.
    — `boardIntro`, `navOutfitBody`, `outfit.rideOut` / `confirmTitle` / `confirmYes`.
N7. [closed] Listen for reduced-motion changes; move MINE_WHEEL_TURNS_PER_SECOND into the tunables registry.
    — `IsoCanvas` listens to the media query and calls `IsoScene.setReducedMotion`; `TUNABLES.MINE_WHEEL_MS_PER_TURN` 12 500 (an integer: the registry's no-floats test forbids 0.08).
