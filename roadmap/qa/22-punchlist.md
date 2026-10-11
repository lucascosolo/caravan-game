# Chunk 22 — QA punch list (reviewed at roadmap/phase-2-spec @ 691d5d1)

Probes (not committed): a throwaway Vite harness page that opens `WatchFight` with a fake api
serving the recorded real-resolver bodies (`src/test/contract/replay*.json`) or any golden log
wrapped as the route wraps it. It was driven by Playwright (Chromium, SwiftShader WebGL, touch,
DPR 2) at 320×568, 360×740 and 390×844, with screenshots of the stage at chosen ticks. Also used:
a vitest probe over the golden corpus, two bundle-check bypass builds, and rAF / WebGL-context
counters across repeated open/close.
Baseline: web 27 files / 298 tests pass; `pnpm build` passes ("battlefield.ts, fixed.ts,
replay.ts"); `pnpm e2e` 6/6 pass (caravan_dev_qa22, E2E_PORT 3991, E2E_WEB_PORT 4291).

The player is faithful, but it is hard to read. Every drawn frame equals the reader's frame. The
end always shows the recorded outcome. Nothing simulates. On a phone, though, a player cannot
tell from the replay why they won or lost. The fight is drawn at ~8 px per unit. The feed is
never on screen with the scene. Hits leave no mark. The deciding moment is under the end card.

Checked and fine:
- **Fidelity.** `model.scene(t)` equals `readReplay(log).frame(t)` (ids, positions, HP fraction)
  at every tick of every golden: 22,650 ticks, 0 mismatches. Lerp is presentation only.
- **Playback.** 1× advanced ~1 fight-second per second. "Watch again" restarts at 0:00.
- **Bundle check.** It caught `new Worker(new URL("./w.ts"))` importing `resolve` and caught
  `?worker&inline` (the worker's map is still emitted). Dynamic chunks are covered because every
  `.js.map` is read. Dropping source maps fails the build. The only bypass left is copying
  simulation code outside `packages/resolver/src`.
- **One renderer.** `pixi.js` is imported only in `src/iso/{scene.ts,IsoCanvas.tsx}`.
- **Phone layout.** No storage APIs in the replay path. No horizontal scroll at 320/360/390 and
  no control under 44 px.
- **Leaks.** 25 open/play/close cycles left 0 canvases, no "too many WebGL contexts" warning, and
  the canvas still rendered. With everything closed, 0 rAF/s.
- **Error states.** 409 / 410 / 500 / a garbage log each show their own state; the garbage log
  is refused with the reader's reason and is never drawn.
- **Account ids.** Neither viewer's body carries the other side's account id.

Not counted (known, chunk 13 fixer): the whole-log seal, sha256 verification of the stored log,
and depth measured from the ring line (including `qa12-dash-over-trap-onto-core`: held at depth
1024). Also known: loot paid on held fights (13 S2), 500 on an undecodable row (13 N1), parked
jobs answering 409 forever (13 N2), and `readReplay` on every GET (13 N3).

## Should-fix

S1. **The end card covers the moment that decided the fight.** `atEnd` (tick ≥ ticks − 1) mounts
`.replay__end` absolutely over the stage (ReplayPlayer.tsx:206-219; theme.css:844-851, inset
0.5 rem on three sides). At 360 px it hides ~90 % of the 311 px stage (screenshots). In **60 of
the 72 goldens** the deciding row (the last `unit_died`, or `core_reached`) is on the final tick.
The contract fight is the same: the last raider dies at tick 790 = endTick. That row's mark
starts at age 0 on a frame that is already covered, and the log ends before it can fade
(replayModel.ts:255,281). Failure scenario: a player watches 39 s at 1×. The last raider simply
vanishes as the card slides over the field. The kill, and the full-load overrun's core arrival,
are never seen. Fix: put the end card under the stage, not over it, or show it only after a short
post-roll hold. Let marks of final-tick rows play out in that hold: the scene clamps at the last
frame, so this is presentation only. Test: at the last tick the stage is uncovered and
`scene(last + ε).marks` contains the final row's mark.

S2. **At phone width the fight is too small to read.** ReplayPlayer.tsx:205 passes no `frame`, so
IsoCanvas fits the whole 32×32 lattice (IsoCanvas.tsx:207-209). At 360×740 the stage is
326×311 px. The wagon circle is ~110 px across, and each unit is ~8 CSS px with a two-letter code
and a hair-thin HP bar (stage screenshots, contract fight and `combat-full-load-16v8v28`). At
320 px it is smaller still. The town already opens on a framed rectangle (QA-17 S1, `frame`
prop). The canvas also has `touch-action: none` (theme.css:459), so a vertical swipe over 42 vh
of the dialog pans the camera instead of scrolling the dialog. Fix: open on a `frame` around the
ring plus the raiders' spawn points (from the `spawn` rows) at the iso minimum cell size. Let a
vertical one-finger swipe scroll the dialog in the replay; pan only with two fingers or after
zooming. Assert in the e2e that one cell is at least N px at 360 px.

S3. **The ticker is never beside the scene** (PHASE-2 §22: "an event ticker beside the scene").
Measured inside the dialog, at 360×740: the stage starts 617 px down, below the intro and the
summary card. The first screen shows no fight at all. The feed starts at 1348 px, 376 px below
the stage's bottom edge, and the viewport is 740 px. At 390×844 the gap is the same. At 320×568
the stage starts at 682 and the feed at 1349, in a 566 px viewport. The replay also overrides the
iso canvas to `position: relative` (theme.css:841-843), so the scene scrolls away when the
player scrolls to the feed. The feed defaults to "Everything" (ReplayPlayer.tsx:156), so its
first lines are hits. Failure scenario: the player can watch the field or read the feed, never
both, and the field alone does not explain the fight (S4). Fix: stage first and sticky at the
top of the dialog. Put a compact strip of the last 2–3 key-moment lines directly under it, and
collapse the summary under the controls. Default the feed to Key moments.

S4. **Hits are invisible in the scene.** Hit rows become feed lines but never marks
(replayModel.ts:254 excludes `hit`). The HP bar is quantized to 20 steps (scene.ts:503), so a
17-damage hit on a 1232-HP raider (full-load feed at 0:04) moves nothing. There is no
attacker→target line, so a ranged post firing looks idle. Fence damage (`fence_hit` rows) is
neither marked nor in the feed. Only the break shows. Failure scenario: two blobs sit next to
each other for 20 s and one disappears. Who hit whom is only in a feed the player cannot see
(S3). Fix: a short shape-coded mark per `hit` / `fence_hit` row, such as a line from the
attacker's position to the target's at that tick, or a flash on the target. Both come from the
row and the reader's frame, so the renderer still decides nothing. Test: a hit row at t yields a
mark at the attacker's and the target's frame positions.

S5. **Marks are drawn underneath the units.** Marks are painted into `overlays`, which sits below
`entities` (scene.ts:129, 332). The ability star is centred on the caster, so the caster's sprite
covers it. The death cross is covered by whatever stands there. Observed: the contract fight's
first death (tick 422) is a cross mostly hidden behind the core wagon. The fence-break square uses
`PALETTE.attacker`, the raiders' own orange, among raiders (scene.ts:348-349). Marks last 0.75 s of
fight time (replayModel.ts:76), which is 0.19 s at 4×. Fix: draw marks in a layer above
`entities`. Size them to at least a unit's footprint. Make the fade duration wall-clock, not
fight-time (presentation). Give the fence break a colour of its own.

S6. **A held fight can say "The raiders reached your core."** The depth percentage is
`Math.round(depth*100/1024)` (ReplayPlayer.tsx:115, 214). `T.depth` says "reached your core"
whenever it is ≥ 100 (strings.ts:974), so a depth of 1019–1023 reads as reaching the core.
Observed on golden `qa12-dash-over-trap-tick-cap` (caravan_held, depth 1021). Both the summary
and the end card read "Your caravan held. / The raiders reached your core.", while the tally (from
the rows) has no "The core was reached." The end card contradicts itself. Fix: say "reached the
core" only when a `core_reached` row exists (or the outcome is an overrun). Otherwise floor the
percentage and cap it at 99. The same rounding sits in EncounterResult.tsx:52 (chunk 23's file;
apply it there too). Not counted: the depth-1024-while-held case belongs to the chunk 13 depth
fix.

S7. **No viewer is told what stopped the party or why the caravan fell.** PHASE-2 §22: the owner
sees "where it entered, how far it got, **what stopped it**". The summary is counts only
(ReplayPlayer.tsx:135-145). The death line is "X fell." (strings.ts:1015) with no cause. The cause
is already in the log: the hit / trap_fired / ability row that took that unit to hp 0, just
before its `unit_died`. Failure scenario: the owner reads "Your raiders down: 2 of 2" and learns
nothing to change in their party. Fix: one line per raider, from rows only. For example: "your
Dust Rider: fell to the caravan's Well Digger at 0:26", "reached the core at 0:06", "still
standing when time ran out". The caravan gets the same for its posts. Name the killer on the death
feed line. Test against the contract fight for both viewers.

S8. **The caravan's summary is not itemized as §22 requires.** §22 lists "Coin moved, units killed
and de-merged, Reputation change, ladder progress". The caravan's summary has the owner's loot,
plus "Your own Coin from this encounter is in its results" (strings.ts:976). Those results are
covered by the full-viewport modal. EncounterResult itself carries Coin and killed / damaged
units, but no Reputation, no ladder and no de-merge. The owner gets `settled`; the caravan gets
nothing equivalent (EncounterResult.tsx:43 passes no settled). Fix: pass the caravan's settled
figures for that encounter into `WatchFight`, as the Party feed does, and list them in the
summary. If per-encounter Reputation / ladder are not served to the caravan, that is D3.

S9. **The guardrail-1 check is tautological, and no test can see a frozen canvas.**
- `goldenView` builds `outcome` from `log.outcome` (test/replayFixtures.ts, `outcome: { kind:
  log.outcome.kind, depth: log.outcome.depth, endTick: … }`). For 72 of the 73 fights, the
  "displayed outcome vs the ledger" check therefore compares the log with itself. Only the one
  contract fight compares a server-recorded outcome, and no test reads a ledger event.
- Every component test mocks `IsoCanvas`. The e2e asserts only that `iso-canvas` is visible
  (trip.spec.ts:180). A canvas stuck on its first frame passes everything; N9 shows that this
  happens in dev.

Fix: a server test that resolves ≥ 100 real-resolver encounters (strong and weak circles, several
authored bands). For each one, GET the replay, `readReplay` it, and assert that its ending equals
the `encounter_resolved` event's outcome and the job result. In the e2e, screenshot `.replay__stage`
at two ticks and assert the images differ.

## Decisions (orchestrator)

D1. **Siege pieces and post stances are not drawn** (Build notes "known gaps"), yet the feed says
"…the party's siege made it harmless" about a piece that is nowhere on screen. Guardrail 4 is
about scouting, but the replay is where a player learns what beat the circle. Options: (a) the
route adds siege and stance to `labels` from the job's party and formation snapshots, with no
log-format bump; (b) log v2 carries them. Recommendation: (a).

D2. **The caravan's player can only watch the current trip.** The entry points are the decide-phase
result (TrailScreen.tsx:348) and TripSummary's encounters until the caravan repacks
(TripSummary.tsx:83). The owner has a paged feed. The DoD says "any encounter they were part of".
Either add a trip-history list to the Trail (or defer it to chunk 42 and amend the DoD), or accept
"until repacked" and say so.

D3. **Reputation and ladder for the caravan.** Do they belong in the replay summary (S8)? Does the
server serve them per encounter? Recommendation: show what the trip status already carries, and
name anything else as a server hand-off.

D4. **Default speed.** 1× is real time. The contract fight takes 39.5 s, a 180 s stalemate takes
3 min, and the golden median is ~9 s. Recommendation: default to 2× for fights over 30 s,
remembered for the session only (no storage). Chunk 37 playtests can tune it.

## Nits

N1. "Previous keyframe" / "Next keyframe" (strings.ts:995-996) is engine vocabulary. Use "Back 5 s"
/ "Forward 5 s": the interval is the log's `keyframeInterval`, so read the figure from it.

N2. Scrubbing does not pause playback (ReplayPlayer.tsx:250 only seeks). In the probe, with the
pointer held still on the thumb during 4× play, the value wandered 685–690. Playback carries on
the moment the thumb is released. Pause on pointerdown on the scrub and resume on release if it
was playing.

N3. Two tally lines mislead. "Traps sprung" counts siege-nullified traps (replayModel.ts:217): the
full-load fight reads "6 of 6" when 3 of them did nothing. "Your posted units down: 0 of 0" is shown
with no posts (ReplayPlayer.tsx:140). Split out "made harmless", and hide a 0-of-0 line.

N4. Owner point of view: `trapNullified` says "the party's siege made it harmless" (strings.ts:1018).
To the owner it is "your party's siege".

N5. The feed numbers units ("the raiders' Dust Rider 11", "Deepest: … Dust Rider 13"), but the sprite
badge shows the merge level, so a line cannot be matched to a sprite. While paused, show the
ordinal on the sprite, or highlight the unit when its feed line is tapped.

N6. Error-state copy:
- 409 says the replay "appears once the server has resolved it" but offers no Retry
  (ReplayPlayer.tsx:80-87).
- 410 says "The outcome stays on record" (strings.ts:943) but shows no outcome.
- The reader's raw message is shown to the player ("Reason: replay refused: resolverVersion must
  be an integer in 0..1000000"). Keep it, but under a plain sentence.

N7. `openReplay` checks each label's `side` only (replayModel.ts:192). A label with a different
`typeId` was accepted and named the wrong unit in the feed (probe). It also never checks
`view.jobId` / `encounterIndex` against the job requested: the e2e itself serves another job's body
and it plays (trip.spec.ts:175). Both are cheap equality checks.

N8. `DEPTH_ONE = 1024` is hard-coded (ReplayPlayer.tsx:35). EncounterResult uses `FIXED_ONE` from
`@caravan/content`; import the same.

N9. Iso lifecycle (chunk 08's code, reached through the replay modal):
- The Pixi ticker renders at ~54 rAF/s while the replay is paused (measured). Stop it when nothing
  is changing.
- Under React StrictMode (`pnpm dev:web`) the replay canvas freezes on its first frame with
  "WebGL: uniformMatrix3fv: location is not from the associated program" (observed).
  `IsoScene.destroy()` is a no-op until `await app.init` has set `this.app` (scene.ts:133-156,
  178-182), so the first Application is never destroyed and keeps drawing its stale state on the
  shared canvas.
- In production, 12 rapid open/close cycles orphaned nothing (0 rAF/s, 0 canvases afterwards). A
  close during init on a slow phone would still leak a ticker.

Fix: record `disposed` in the scene, and destroy the app when `mount` resolves after it.

N10. Data minimisation: the party owner's body carries the caravan's `tripId` (it is also inside
`jobId`), the caravan's unit instance refs (`labels.units[].ref`, `outcome.units[].ref`) and
`stored` hashes. None of these is an account id. Consider omitting refs and `stored` for
`viewer: "party_owner"`.

## Orchestrator decisions (2026-10-11)

- **D1: draw siege pieces and post stances, sourced by the server.** The replay body gains siege and stance labels taken from the job's formation and party snapshots, which are already stored with the job. This needs no change to the resolver or the log format. Until the labels exist, the feed must not mention siege the player cannot see.
- **D2: any encounter within retention.** The caravan's player can open any of their caravan's fights still kept by the replay retention rule, not only the current trip's. Add a "Recent fights" list, newest first, served by a small server read (for example `GET /me/encounters`, capped at the retention count). The party owner reaches theirs through the Party feed, and through the inbox once chunk 29 lands.
- **D3: itemize from the ledger.** The caravan's summary lists Coin moved, de-merges and destroyed units, and the Reputation and ladder change. The server serves these per encounter from the ledger events caused by that job, so the client shows only what the ledger recorded and computes nothing itself.
- **D4: default to 2×.** The default speed is 2×, with 1×, 2× and 4× offered. "Skip to end" stays. A stalemate must never force a long watch.
- **S1–S9 and every nit are in scope.** For S1, the end card waits until the final tick has been seen; hold the last frame about a second before showing it, and let the player dismiss it to look at the stage. For S2, frame the camera on the action: the ring and the area the raiders cross, not the whole field. Vertical swipes on the canvas must scroll the dialog. For S9, compare against the server's recorded outcome, not the log's own copy. Add at least one test that fails if the canvas stops updating.
- **Sequencing:** the fixer starts after the chunk 13 fix round merges, because both touch the replay route and the replay body.

## Fix round 1 — closed (2026-10-11, chunk 22 fixer)

- **S1 closed.** The last frame is held END_HOLD_SECONDS (1 s wall) past the final tick; final-tick marks play out in the hold; the end card then shows over the stage with "Look at the field" (dismiss) and "Watch again". Tests: model `scene(last + ε)` keeps the last death's mark; player shows no card on the final tick, card after the hold, dismiss.
- **S2 closed.** The camera opens on `model.frameRect` (ring ± 1, reaching 4 cells toward each entry edge from the spawn rows) with a 32 px minimum cell; the replay canvas uses `touch-action: pan-y` (IsoCanvas `touchScroll`), so a vertical swipe scrolls the dialog and a sideways drag / pinch moves the camera. The e2e asserts zoom ≥ 32/48 at 360 px.
- **S3 closed.** The stage (field, siege line, the 3 latest key moments) is first and sticky at the top of the dialog; controls next; summary collapsed under "How it ended: …"; feed defaults to Key moments. Controls carry a scroll-margin so nothing scrolls under the stage.
- **S4 closed.** Every `hit` is a line mark from the attacker's to the target's reader-frame position; every `fence_hit` a dashed line to the segment and a feed line. Test: hit row at t → mark at both frame positions.
- **S5 closed.** Marks draw in a layer above `entities`, sized ≥ a unit's footprint; fade is wall-clock (mark life scales with speed); fence break has its own colour (`PALETTE.fenceBreak`, Okabe–Ito bluish green).
- **S6 closed.** `depthPercent` (screens/replay/depth.ts): 100 % only with a `core_reached` row or an overrun, else floored and capped at 99; used by the player and by EncounterResult.
- **S7 closed.** "How each fared" / "What stopped your party": one line per fighter from the rows (killer named from the lethal hit / trap / ability row, core reached, still standing); death feed lines name the killer. Tested on the contract fight for both viewers.
- **S8 closed.** The body's `settled` (server, replay/settled.ts) itemizes Coin, unbanked Coin, Coin lost, de-merges, destroyed units, Reputation, ladder and unlock points from the ledger events the job caused; both viewers' summaries list it.
- **S9 closed.** `apps/server/test/replay-ledger.test.ts` fights 104 real-resolver encounters (strong/weak, bands 0/1/3/5, authored and live owners) and asserts the log's ending == the `encounter_resolved` event == job result == body outcome == trip_encounter, and `settled` == the ledger, for both viewers. Golden web bodies now take `outcome` from the golden file's resolver output. The e2e screenshots the field at two ticks (bytes differ) and asserts the renderer's `framesDrawn` counter rises while playing.
- **D1 closed.** `labels.siege` (party snapshot) drawn as siege pieces at the entry edge plus a "Siege with the raiders" line; `labels.units[].stance` (party / formation snapshots) drawn as stance glyphs with a legend; a nullified trap names the countering piece only when one is labelled.
- **D2 closed.** `GET /me/encounters` (retention rule, newest first, capped at min_per_caravan; `replay: log | no_log | pruned`) and a "Recent fights" list on the Trail (in town, packed, trip ended). Tested: listing order, other accounts excluded, retention exclusion.
- **D3 closed.** As S8: the server serves the itemization per encounter from the ledger; the client words it and computes nothing. Unbanked Coin is named as trip state, not a ledger item.
- **D4 closed.** Default 2×; 1×/2×/4× offered; the choice is remembered for the session only (module state, no storage); Skip to end kept.
- **N1 closed.** "Back 5 s" / "Forward 5 s", the figure from the log's keyframeInterval.
- **N2 closed.** Pointerdown on the scrub pauses; pointerup / cancel / blur resumes if it was playing.
- **N3 closed.** "Traps sprung" counts fired traps only; "Traps made harmless by the party's siege: n" is its own line; 0-of-0 lines hidden.
- **N4 closed.** Owner view says "your party's <siege>".
- **N5 closed.** Feed lines that name units are buttons; tapping highlights those units on the field (ring), tapping again clears.
- **N6 closed.** 409 not_resolved has Retry; 409 resolution_unavailable has its own copy; 410 copy points at where the outcome is; the reader's raw reason sits under "Technical detail".
- **N7 closed.** `openReplay` checks each label's side, type and level (fences, traps too) and the body's jobId / encounterIndex against the request; the e2e patches the served body's jobId.
- **N8 closed.** `FIXED_ONE` from @caravan/content (via depth.ts).
- **N9 closed (partly opt-in).** Mounts on one canvas are serialized and a scene destroyed during init destroys its Application without forcing a context loss when another mount is queued (StrictMode). The ticker sleeps when idle only where `sleepWhenIdle` is set (the replay; the e2e asserts `ticking()` is false while paused). With it on for the trail, `e2e/formation.spec.ts`'s wheel step saw the page scrolled after `scrollTo(0, 0)` (reproduced twice, gone with it off); cause not understood, so the trail and town keep the always-running ticker — open follow-up.
- **N10 closed.** The owner's body has `tripId: null`, `stored: null` and an outcome without the caravan's attrition; unit refs remain inside the sealed log (a format change, out of scope).

Observed (this branch, after merging roadmap/phase-2-spec @ cd2b80a): typecheck, lint, test:boundary clean; server 38 files / 664 passed, 1 skipped; web 32 files / 375 passed; `pnpm build` with the bundle check ("battlefield.ts, fixed.ts, replay.ts"); `pnpm e2e` 8/8 (caravan_dev_f22, E2E_PORT 3979). Phone check (Playwright, 360×640 and 320×640, real-resolver body): cells ~32 px, level badges and type initials readable, hit lines visible; the pinned stage takes a little over half the screen at 640 px tall, so controls scroll under it; the end card fills most of the field at 360 px until dismissed.
