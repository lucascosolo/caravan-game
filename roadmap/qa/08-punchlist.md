# Chunk 08 — QA punch list (commit f603925, merged fb10e99 + b3c59c9; reviewed at fcbf36d)

Probes: scratchpad/qa08 (setup.mjs, lib.mjs, pNN_*.mjs/ts).

## Blockers
B1. Trail unusable on HEAD: every real menu is `bad_payload`. shapes.ts:242 requires `owner.accountId` (removed by chunk 14 N4), :256 requires `usedAuthoredFallback` (replaced by `authoredOutsideBand`, `authoredShare`, `authoredServed` in chunks 14/25). Realign types and guards; show `authoredOutsideBand`/`authoredShare` honestly. **Add a contract test (see D4).**
B2. Aggro/leash/range circles drawn at 1/√2 of true radius (scene.ts:276,285): multiply by √2 (or draw the projected world circle); include UNIT_RADIUS ("reach"); pure test.
B3. A pinch whose first finger lands on a post moves the post (IsoCanvas.tsx:192-205): a second pointer during a drag cancels the drag (restore item) and starts the pinch.
B4. Vertical swipe over the tray places a unit (theme.css:588 `touch-action: none`; FormationScreen.tsx:202-237): `touch-action: pan-y` on chips; start a tray drag only after long-press or a move that ends over the canvas; never drop on a pointer-up the browser turned into a scroll.

## Decisions (orchestrator)
D1. Commit → resolution → replay handoff completes in chunk 23 (trip client flow) once 13/15/22 exist. Record as deferred in the chunk 08 file; the DoD line moves to chunk 23.
D2. FORMATION_PRESETS deferred post-v1 (drafts are re-savable). Record.
D3. Add a DOM placement picker (keyboard and screen reader): for the selected tray item, a list of legal ring positions / cells grouped by edge, with the same refusal codes; PHASE-2 §35.
D4. CI gains a contract test: a server test writes real JSON for every client-consumed route (menu, choice, manifest, formation, unlocks, progression, me, economy, party, refugees, recruit, store, cosmetics) to `apps/web/src/test/contract/*.json`; a web test runs each through its guard. Both run in `pnpm test`, so CI catches drift. Also run `pnpm e2e` in CI (it is stable).
D5. Yes: tap-to-place mode counts as "being placed"; show the lattice while a chip is selected.

## Should-fix
S1. Show merge-scaled damage per hit (or the multiplier) in scout and post cards (packages/circle party.ts scout view + defenderCard).
S2. Drag is script-bound (68.8 ms/move at 4× CPU): keep scene nodes and update positions; memo panels; rAF-throttle drag state.
S3. Lazy-load the iso module and Trail (and Town) with `lazy()` so PixiJS is not in the login chunk.
S4. Reroll countdown from server `retryAfterSeconds` / `availableAtMs − searchedAtMs` anchored at receipt; gate on `reroll.available`.
S5. Delete trail's ErrorBox; use shell/ErrorBox with onRetry + heading.
S6. Commit modal focus: callbacks in refs, capture opener once; on success focus the committed notice, on refusal the issues box.
S7. Commit dialog lists unposted living units (and blocks commit with the server's message if any), held-back traps by name, remaining fence material.
S8. Map `issue.subject` refs to tray item names; highlight chip + marker.
S9. Refused drops show the reason with the server's codes; reuse @caravan/circle's per-entry check instead of re-implementing rules.
S10. Canvas hit radius ≥ 22 px in screen space; zoom to the ring when a chip is selected.
S11. Label radii by line style, not inner/outer.
S12. Native non-passive wheel listener with preventDefault.
S13. Autosave the draft (server PUT, debounced) so tab switches don't lose work.
S14. Tapping an attacker selects it and scrolls to its scout card.
S15. Externalize stats.ts and placement.ts strings; no raw ids or ISO timestamps or "(chunk 15)" developer copy in player text.

## Nits
N1. Scout open by default above the "Face X" button. N2. Chip aria-label must not override content. N3. Disable PixiJS AccessibilitySystem. N4. Guards: scout cell ≤ grid, unknown typeId refused, `chosen.candidateId` must be in the list. N5. `window.__isoDebug` only in dev/test builds. N6. MIN_POST_DISTANCE applies to posts only. N7. Destroyed fences get their own heading. N8. Confirm before "Clear the ground". N9. Move speed with unit. N10. Draw the dashed attacker ring the skin seam promises. N11. edgeReports: reserve posts not "in reach" before release; include UNIT_RADIUS; radii from the server view, not client content.
