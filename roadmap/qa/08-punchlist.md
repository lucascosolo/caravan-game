# Chunk 08 — QA punch list (commit f603925, merged fb10e99 + b3c59c9; reviewed at fcbf36d)

Probes: scratchpad/qa08 (setup.mjs, lib.mjs, pNN_*.mjs/ts).

## Blockers
B1. **[closed]** Trail unusable on HEAD: every real menu is `bad_payload`. shapes.ts:242 requires `owner.accountId` (removed by chunk 14 N4), :256 requires `usedAuthoredFallback` (replaced by `authoredOutsideBand`, `authoredShare`, `authoredServed` in chunks 14/25). Realign types and guards; show `authoredOutsideBand`/`authoredShare` honestly. **Add a contract test (see D4).**
   → Guards/types match the final chunk 14/25 view: `owner {displayName, authored, flavor}`, `reputation.gapBeyondBand`, `authoredOutsideBand`, `authoredShare`, `authoredServed`; the candidates screen says each as reported (and shows `flavor`). Contract test added (D4).
B2. **[closed]** Aggro/leash/range circles drawn at 1/√2 of true radius (scene.ts:276,285): multiply by √2 (or draw the projected world circle); include UNIT_RADIUS ("reach"); pure test.
   → `radiusEllipse(r)` (projection.ts) draws the projected world circle (×√2); radii are the resolver's reach from `toBattlefield` + `resolverTunables().unitRadius` (`postReach`, placement.ts). Pure tests in gestures.test.ts / placement.test.ts; probe p06 after: normalised radius² 1.000 (was 2.000).
B3. **[closed]** A pinch whose first finger lands on a post moves the post (IsoCanvas.tsx:192-205): a second pointer during a drag cancels the drag (restore item) and starts the pinch.
   → Gesture rules moved to pure `iso/gestures.ts`: a second pointer cancels a begun drag (`dragCancel`, item stays) and pinches; the settling finger neither pans nor taps. Pure test + e2e CDP pinch on a post; probe p05 after: post unmoved, zoom changed.
B4. **[closed]** Vertical swipe over the tray places a unit (theme.css:588 `touch-action: none`; FormationScreen.tsx:202-237): `touch-action: pan-y` on chips; start a tray drag only after long-press or a move that ends over the canvas; never drop on a pointer-up the browser turned into a scroll.
   → Chips `touch-action: pan-y`; pure `trayGesture.ts`: touch drags start only after a 350 ms long press or a sideways move; vertical travel is a scroll; drop only on pointer-up over the canvas; pointercancel cancels. Component test + e2e swipe; probe p04 after: the tray scrolls (924→1059), nothing placed.

## Decisions (orchestrator)
D1. **[closed]** Commit → resolution → replay handoff completes in chunk 23 (trip client flow) once 13/15/22 exist. Record as deferred in the chunk 08 file; the DoD line moves to chunk 23.
   → Recorded: chunk 08 DoD line marked deferred; PHASE-2 §23's definition of done carries the handoff.
D2. **[closed]** FORMATION_PRESETS deferred post-v1 (drafts are re-savable). Record.
   → Recorded in the chunk 08 tunables table and Build notes.
D3. **[closed]** Add a DOM placement picker (keyboard and screen reader): for the selected tray item, a list of legal ring positions / cells grouped by edge, with the same refusal codes; PHASE-2 §35.
   → `PlacementPicker.tsx` + pure `pickerOptions`: every ring position (taken ones disabled with circle's code) or every legal cell, grouped by side, "Place here" = the same `dropAt`.
D4. **[closed]** CI gains a contract test: a server test writes real JSON for every client-consumed route (menu, choice, manifest, formation, unlocks, progression, me, economy, party, refugees, recruit, store, cosmetics) to `apps/web/src/test/contract/*.json`; a web test runs each through its guard. Both run in `pnpm test`, so CI catches drift. Also run `pnpm e2e` in CI (it is stable).
   → `apps/server/test/contract.test.ts` records 23 routes on a real account (deterministic ids via a sequence-backed uuid default, frozen clock, ordered arrays, renamed ids/timestamps) into `apps/web/src/test/contract/*.json` and runs the client guards in-process; `src/test/contract/contract.test.ts` runs every file through its guard (`routes.ts`); store and cosmetics have no client guard yet and are skipped and listed. `pnpm e2e` was already the last CI step; it now builds a VITE_ISO_DEBUG client for itself (N5).
D5. **[closed]** Yes: tap-to-place mode counts as "being placed"; show the lattice while a chip is selected.
   → `IsoSceneState.placing`: a selected unplaced tray item shows the lattice (and the ring targets for a fence). Component test + e2e.

## Should-fix
S1. **[closed]** Show merge-scaled damage per hit (or the multiplier) in scout and post cards (packages/circle party.ts scout view + defenderCard).
   → `ScoutUnit.damagePerHitMult` (circle party.ts, = MERGE_STAT_MULT_BY_LEVEL at the merge level); scout and post cards show "Damage per hit ×m (merge level n)". The client guard fills content's value for menus stored before the field existed.
S2. **[closed]** Drag is script-bound (68.8 ms/move at 4× CPU): keep scene nodes and update positions; memo panels; rAF-throttle drag state.
   → Scene keeps nodes across updates (rebuild only on a visual change; a move repositions), threat layer redrawn only when it changes, ghost repositioned; drag moves rAF-coalesced (canvas and tray); ScoutPanel/ManifestTray/PlacementPicker memoised. Probe p12 at 4× CPU: script 60.5 → 29.7 ms/move.
S3. **[closed]** Lazy-load the iso module and Trail (and Town) with `lazy()` so PixiJS is not in the login chunk.
   → Already done by chunk 17 (lazy Town/Party/Trail; PixiJS is in a shared lazy chunk, not the login chunk) — verified in the build.
S4. **[closed]** Reroll countdown from server `retryAfterSeconds` / `availableAtMs − searchedAtMs` anchored at receipt; gate on `reroll.available`.
   → Countdown = `available ? 0 : availableAtMs − searchedAtMs`, counted on the monotonic clock from receipt (an upper bound for a menu read later); a 409 restarts it from `retryAfterSeconds`. Test with the device clock 10 min fast.
S5. **[closed]** Delete trail's ErrorBox; use shell/ErrorBox with onRetry + heading.
   → Trail's ErrorBox deleted; shell ErrorBox with heading + Retry.
S6. **[closed]** Commit modal focus: callbacks in refs, capture opener once; on success focus the committed notice, on refusal the issues box.
   → Commit dialog is the shell `Modal` (callbacks in a ref, opener captured once); success focuses the committed notice, refusal the issues box.
S7. **[closed]** Commit dialog lists unposted living units (and blocks commit with the server's message if any), held-back traps by name, remaining fence material.
   → The dialog names unposted living units, held-back traps and remaining fence material, and opens with a server check (PUT): if refused, its issues show and Commit stays disabled.
S8. **[closed]** Map `issue.subject` refs to tray item names; highlight chip + marker.
   → Issues humanized with shell/issues.ts `humanizeIssue` over `manifestNames`; flagged chips (`chip--issue`) and a Show button that selects the item.
S9. **[closed]** Refused drops show the reason with the server's codes; reuse @caravan/circle's per-entry check instead of re-implementing rules.
   → `dropRefusal` runs circle's `validateFormation` over the hypothetical drop and keeps the dropped entry's issue; the refusal (player wording + circle's code) is shown.
S10. **[closed]** Canvas hit radius ≥ 22 px in screen space; zoom to the ring when a chip is selected.
   → `hitTestScreen`: a ≥22 px circle on screen in every direction (chunk 17 had a world-radius approximation); `focusCamera` zooms to the ring (zoom-in only) when a tray item is selected.
S11. **[closed]** Label radii by line style, not inner/outer.
   → Line styles: aggro reach thick + shading, leash thin, attack reach dotted; legend says so.
S12. **[closed]** Native non-passive wheel listener with preventDefault.
   → Native `wheel` listener `{ passive: false }` with preventDefault. e2e: scrollY stays 0.
S13. **[closed]** Autosave the draft (server PUT, debounced) so tab switches don't lose work.
   → Debounced autosave PUT (1.2 s); a refused autosave is a polite status listing the server's needs; the arrangement is kept in memory per encounter so a tab switch keeps it.
S14. **[closed]** Tapping an attacker selects it and scrolls to its scout card.
   → Tapping an attacker marks its scouting card, opens the report, scrolls to and focuses the card; marker highlighted.
S15. **[closed]** Externalize stats.ts and placement.ts strings; no raw ids or ISO timestamps or "(chunk 15)" developer copy in player text.
   → stats.ts/placement.ts strings in strings.ts; segments by number, no raw refs; timestamps via `formatWhen`; developer copy removed.

## Nits
N1. **[closed]** Scout open by default above the "Face X" button.
   → Candidate scouting reports open by default, above "Face …".
N2. **[closed]** Chip aria-label must not override content.
   → Chip aria-label removed.
N3. **[closed]** Disable PixiJS AccessibilitySystem.
   → The renderer's AccessibilitySystem is torn down after init (it is re-added by Pixi's browser extensions, so `extensions.remove` before init is not enough); e2e presses Tab and asserts it is inactive.
N4. **[closed]** Guards: scout cell ≤ grid, unknown typeId refused, `chosen.candidateId` must be in the list.
   → Scout cell within the lattice, unknown unit/siege type refused, `chosen.candidateId` must be in the menu.
N5. **[closed]** `window.__isoDebug` only in dev/test builds.
   → `ISO_DEBUG` = dev, test or VITE_ISO_DEBUG=1; the production bundle has no `__isoDebug` (checked); `pnpm e2e` builds `apps/web/dist-e2e` with the flag.
N6. **[closed]** MIN_POST_DISTANCE applies to posts only.
   → Refusals come from circle's rules: MIN_POST_DISTANCE binds posts only (test).
N7. **[closed]** Destroyed fences get their own heading.
   → Destroyed segments under their own heading.
N8. **[closed]** Confirm before "Clear the ground".
   → "Clear the ground" asks first (shell Modal).
N9. **[closed]** Move speed with unit.
   → Speed shown as "n cells/s".
N10. **[closed]** Draw the dashed attacker ring the skin seam promises.
   → Attackers carry a dashed ring under the marker.
N11. **[closed]** edgeReports: reserve posts not "in reach" before release; include UNIT_RADIUS; radii from the server view, not client content.
   → edgeReports measure reach from `toBattlefield` + UNIT_RADIUS; reserve counted by its attack reach (chunk 11 QA D1: it strikes what comes into reach before release), guard by aggro reach. Stance copy updated to match D1.
