# Chunk 23 — QA punch list (reviewed at roadmap/phase-2-spec @ 15303fb)

Probes (not committed): scratchpad/trip5.mjs (rides one trip N encounters over the real routes
with `CARAVAN_TEST_RESOLVER=double`), a guard probe (`stakesPreviewShape` / `bankResultShape`
fed the server's real `DeMergedUnit` shape), and a Playwright probe spec against the built
server on caravan_dev_qa23 (E2E_PORT 3997, E2E_WEB_PORT 4297) at 360×640 and 320×568.
Baseline: web 23 files / 248 tests pass; `pnpm e2e` 6/6 pass; server `trip-client` + `contract`
7/7 pass. The bugs below sit in a path that no fixture covers: **a unit dies and the caravan
still holds**. Every recorded preview and bank body has empty de-merge lists.

Checked and fine: no Coin reroll, no store link, no buy/purchase/pay copy anywhere in the
trip flow (GUARDRAILS §2). The trip cap is time-gated only and its countdown runs on server
time. No trip state goes into local/sessionStorage: the only key is chunk 17's board-viewer
key. A double tap on Bank sends one POST (the server log shows a single `/trip/bank`). At
320 px there is no horizontal scroll and no target under 44 px on bank-or-push or the summary.

## Should-fix

S1. **Bank-or-push breaks as soon as a unit has died but the caravan held.** The server sends
`ifOverrun.unitsDeMergedNotDestroyed` as `DeMergedUnit` `{ref, typeId, fromLevel, toLevel,
diedAtEncounter}` (apps/server/src/trip/stakes.ts:98-104, service.ts:698,777). The client
guard requires `{mergeLevel, mergeLevelAfter}` (apps/web/src/api/tripShapes.ts:164;
tripTypes.ts:164), so the preview throws `bad_payload`. Observed on the real server: dev account,
two Dust Riders pushed to encounter 5 (double: −150 HP per encounter, so both die at 5 and the
caravan holds). The Trail shows "Could not load what is at stake … bad_payload · GET …/trip/preview
ifOverrun.unitsDeMergedNotDestroyed[0].mergeLevel: expected integer >= 1 <= 5, got undefined".
Both buttons are gone and Retry fails the same way. **The trip cannot be banked or pushed from
the client.** It is stuck at the one screen GUARDRAILS §4 most cares about, at the moment losses
first appear. Fix: type and guard the list as `{ref, typeId, fromLevel, toLevel, diedAtEncounter}`
and render `fromLevel → toLevel` (BankOrPushScreen.tsx:109-112). Add a contract recording of a
preview with a dead unit, which the double can produce by pushing, or by a plan with `kill`.

S2. **Banking's de-merges are not shown before the bank, in the confirm, or after it.**
- Before: `bankNow.unitsDeMerged` (service.ts:684-685,771; this is chunk 15 QA S7, now landed)
  is neither typed nor rendered. The "Bank now" card (BankOrPushScreen.tsx:74-80) quotes only
  Coin.
- Confirm: the bank modal says "Everything packed comes home and is fully refitted in town"
  (strings.ts:471, BankOrPushScreen.tsx:313-314). For a dead L3 unit that line is false: banking
  drops it to L2.
- After: the summary reads `restored.deMergePending` (TripSummary.tsx:40; tripShapes.ts:83 with
  `orEmpty`; tripTypes.ts:67). The server replaced that field with `restored.deMerged`
  (service.ts:432,440). `orEmpty` turns the missing field into `[]` without an error, so the
  "Died on the trip" line never renders. Probe: a bank body with `restored.deMerged:[…]` parses
  to `deMergePending: []`.

Failure scenario: a player banks after their L4 unit died, believing the modal ("fully
refitted"), and finds an L3 unit in town that no screen ever mentioned. A count is not
enough either. The fix is to itemize each unit with its level change: "Sand Sharpshooter · L4 → L3"
in the Bank card, a one-line restatement in the bank confirm ("N units that died lose a merge
level"), and the same list in the banked summary from `restored.deMerged`. Drop
`deMergePending` from the types and guards.

S3. **A decision closed elsewhere leaves a dead end.** Scenario (observed at 320×568): tab A is
on bank-or-push for encounter 1, and tab B (or a lost answer that did go through) pushes.
In tab A, "Bank and go home" opens a modal that quotes 525 Coin and "Everything packed comes
home…", then says "This decision is no longer open", with Bank it disabled. After cancelling,
the screen shows "This decision is no longer open" with both buttons disabled. Nothing leads
to the encounter 2 search, which is now the trip's real state; the player has to know to tap
another tab and come back. Code: BankOrPushScreen.tsx:226-229 (a non-zero error sets
`error` and re-reads only the preview), :265-269 (the closed banner has no action), and
TrailScreen only reloads through `onDecided`. Fix: when the preview says
`!decisionOpen || decisionFor !== encounterIndex || tripId !== tripId`, or a decision
returns 409, call the Trail's `load()` (pass an `onStale` callback). Failing that, show a
"Back to the trail" button that does. TripFlow.test.tsx:214 asserts only the banner; extend it
to assert the way forward.

S4. **The unit test enshrines the wrong wire shape.** TripFlow.test.tsx:260-278 builds
`unitsDeMergedNotDestroyed: [{…, mergeLevel, mergeLevelAfter}]` by hand and renders `<Stakes>`
directly, which bypasses the guard. That is why S1 and S2 passed CI. Fix: build dead-unit
previews by mutating a recorded contract body and parsing it through `stakesPreviewShape`, as
the other TripFlow tests do through `tripFixtures.ts`. Add a guard test that a recorded body
with non-empty `bankNow.unitsDeMerged`, `ifOverrun.unitsDeMergedNotDestroyed` and
`restored.deMerged` parses and renders every item.

## Decisions (orchestrator)

D1. **Where de-merge-on-bank sits on the screen.** Banking is not free once anything has died.
Today the only signal is the "Your units" card ("Dead since encounter N · Loses a merge level:
3 → 2"), which reads as though it applies only to an overrun. Recommendation: the Bank card
and the overrun card each carry their own unit list (bank: `bankNow.unitsDeMerged`; overrun:
lost outright plus de-merged), so the two choices compare side by side.

D2. **Overrun nuance the server sends but the client drops.**
- `ifOverrun.coinGoesTo: "overrunning_party_owner_capped"` is not shown. The player sees "Lose
  all X Coin" but not that it goes to the party's owner (or is destroyed for an authored party).
- `unitDyingInTheFinalFight: "de_merged_not_destroyed"` is not shown either, so "Lost outright
  (alive now)" overstates the loss (BankOrPushScreen.tsx:100-102, strings.ts:448).

Decide whether either belongs on the prompt. Recommendation: one hint line each (copy only).

D3. **The DoD says "a banked three-encounter trip".** trip.spec.ts rides two encounters (push
once, then bank). The double cannot produce an overrun or a death that the caravan survives
within the e2e's depth, so the e2e never exercises the overrun summary or any de-merge. Either
extend the e2e to three encounters (and, after S1, a fourth or fifth with a death the caravan
survives), or amend the DoD.

## Nits

N1. The intro copy is wrong: "staying out earns nothing but the next encounter's Coin"
(strings.ts:429). Pushing also raises the delivery bonus (125 × encounters, chunk 15 QA D1), and
`nextEncounter.bankTotalIfSurvived` includes it. Reword, e.g. "…earns the next encounter's Coin
and a bigger delivery bonus, nothing else".

N2. If the confirm's fresh re-read fails, the modal stays on "Loading…" forever with the confirm
disabled (BankOrPushScreen.tsx:210-211,298,307). The error renders behind the modal. Show the
error, with Retry, inside the modal.

N3. On a re-login, the summary shows "Your last trip" without the town balance after the bank
(`lastBank` is session state, TrailScreen.tsx:82,246). This is harmless, but the summary could read
the balance from `/me/economy` so a returning player sees the same screen.

N4. The push confirm counts living units ("2 living units stay at risk") but does not name the
already-dead units that an overrun would de-merge (BankOrPushScreen.tsx:318). After S1, add
"and N dead units lose a level" when the list is non-empty.

N5. Production code imports test code: `apps/server/src/dev/testResolver.ts` imports
`../../test/trip-double.js`, so the test double is bundled into `apps/server/dist/index.js`.
It is gated by the env refusal, but the bundle ships a scripted resolver. Consider moving
the double under `src/dev/`, or excluding it from the production build.

Out of scope, noted: "Watch the fight" disabled (chunk 22); fights through the double (chunk
13); the store fixture's calendar week did not bite in this run. Chunk 15 QA D3
(`resolver_unavailable` start refusal) has not landed. When it does, it must skip when the inline
test resolver is installed (ORCHESTRATION chunk 23 note), or `pnpm e2e` breaks.
