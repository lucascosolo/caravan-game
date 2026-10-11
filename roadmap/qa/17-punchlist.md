# Chunk 17 — QA punch list (commit f25eb15, merged at 5d5fb30)

Probes: scratchpad/qa17 (api/p1–p3.mjs, qa1–qa12.mjs, shots/).

## Blocker
B1. A unit packed in an open manifest can be merged away (economy/merge.ts:254-265 preview, :345-347 commit) because the only guard is `caravan.state` and nothing sets `on_trip`. Loss evasion and dangling manifest refs. Fix server-side, independent of caravan state: in preview and in the commit's FOR SHARE transaction, refuse 409 `unit_packed` for any instance id in an open manifest's `packed` or `survivors`; test. The same rule applies to refugee/recruit? (no: they add, never remove) and to party saves? (no: a party may reference a packed unit; it's a template).

## Decisions (orchestrator)
D1. Board positions stay client-side (presentation, like a camera). Key by account id + caravan id; clear on sign-out; accept per-device layouts. Record in the chunk file.
D2. Chunk 15 flips `caravan.state` at trip start/end; the B1 fix must not depend on it. Append a note to roadmap/chunks/15-trip-loop.md.

## Should-fix
S1. Open the town framed on the 6×6 board with each cell ≥ 44 px; the island reachable by pinching out.
S2. Recruit (and reroll/claim) after a lost response: on status 0 keep the dialog with the same `requestId`/sequence and offer "Try again" that replays it; wording "could not confirm", not "refused"; spend-specific ErrorBox copy (not "Nothing was changed").
S3. Render a reload error (ErrorBox + Retry) above the board whenever `loadError` is set, not only before first load.
S4. Party builder: feed Retry reloads only the feed; keep the draft across tab switches (in-memory store) and confirm before discarding unsaved edits.
S5. Refugee panel: claimed + due → "Your next free menu is ready: take it now (nothing is forfeited)"; drop the contradictory line.
S6. Show the lattice and board cells while a unit is selected (tap-to-move), per chunk 08 D5.
S7. Siege toggle labels min-height `var(--tap)`; extend the e2e 44 px check to inputs and their labels.

## Nits
N1. Update drag state only when the cell changes; keep the mine wheel object (no rotation snap).
N2. "including the trickle so far", only when pendingTrickle > 0.
N3. Map feed `outcomeKind` to player wording.
N4. Modal focus restore fallback (port ConfirmDialog's `restoreFocusTo`).
N5. Re-fetch before recruit/reroll confirms that quote the balance.
N6. Copy: "move them onto the board when there is room"; "Pack the caravan" until chunk 15.
N7. Listen for reduced-motion changes; move MINE_WHEEL_TURNS_PER_SECOND into the tunables registry.
