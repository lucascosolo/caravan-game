# Chunk 15 — Trip loop

**Depends on:** 07, 13, 14. **Status:** QA'd — fixes closed (S4 settle at resolution + owner loot credited, D3 void path, S6, N2, N4, N5, N7; migration 014); D2 / D4 doc edits open (see `roadmap/qa/15-punchlist.md`).
Read `/roadmap/GUARDRAILS.md` in full first, including §0 on which way round the game runs.

## Goal

The outer loop. A caravan sets out from town, meets a chain of individually matchmade,
individually scoutable **attacking parties**, and after surviving each one the player
chooses to **bank** (deliver) or **push**. This chunk chains the pieces together and
owns attrition, trip state, and the trip cap.

## Design constraints that apply here

**A trip, in order:**
1. Player packs the caravan in town — **manifest locked for the whole trip**: living
   units, traps, fence material. No resupply mid-trail.
2. Matchmaking presents a scoutable attacking party.
3. Player **arranges the wagon circle** against that specific party, then resolves.
4. On surviving: **bank** (end trip, deliver, keep everything earned) or **push**
   (matchmaking serves the next attacker; the caravan carries forward whatever damage
   and losses it has — **no repair, no resupply, no healing until the trip ends**).
5. Trip ends on: **voluntary bank, the caravan being overrun, or** — favorably —
   a tick-cap stalemate at which the attackers withdraw.

**Critical framing — this is not a map or travel layer.** There is **no geography, no
route-picking, no spatial overworld, no travel timer**. Do not build one. A trip is a
chain of matchmade encounters, nothing more. "Region" is a one-time choice unrelated
to trip structure. This is the specific way the concept drifted once already; watch for it.

- **One trip, regardless of how many encounters, consumes one use of an hourly trip cap.**
- **Attrition carries forward between encounters**: unit damage and deaths, destroyed
  fence segments, spent traps. Nothing is repaired or restocked until the trip ends.
- **Pushing is straightforwardly risky.** Each further encounter is another chance to
  lose the cargo and the caravan, against a party that arrives fresh while yours does
  not, and against escalating difficulty (chunk 14). **There is no safety bonus for
  staying out.** The escalating reward is the only reason to push; mounting attrition
  is the only reason to stop. That opposition is what makes bank-or-push a real
  decision — do not add any benefit to remaining on the trail.
- **Between trips the caravan is home in town and cannot be attacked at all.** There is
  no asynchronous raid against a player's caravan; the asynchronous layer is entirely
  on the standing-party side (chunk 09).
- **Banking is the delivery.** Reaching the end and banking *is* the delivery — there
  is no separate delivery step. Banked Coin goes home to a town that cannot be
  attacked, which is what makes §13's "banking locks Coin in permanently" true.
- The bank/push decision must be made **with full information**. A loss must always be
  a **foreseeable consequence, not bad luck**.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `TRIPS_PER_HOUR_CAP` | 3 | Regenerating, capped at 3 stored. Consumed at trip **start**, not per encounter. |
| `TRIP_CAP_REGEN` | 1 per 20 minutes | |
| `MAX_ENCOUNTERS_PER_TRIP` | none (unbounded) | Attrition plus escalating difficulty is the natural limit. Add a cap only if testing shows a degenerate infinite push. |
| `NO_REPAIR_BETWEEN_ENCOUNTERS` | true | Hard design rule, not tunable. Covers HP, fences, and traps alike. |
| `RESTORE_ON_TRIP_END` | full heal and full restock on bank; nothing to restore if overrun | The caravan refits in town. |
| `ENCOUNTER_REWARD_SCALING` | encounter N Coin value = base × 1.25^(N−1) | Escalating reward against rising attrition and rising difficulty. **The central balance lever of the outer loop.** |
| `TRIP_ABANDON` | not permitted mid-encounter; banking is offered only **after surviving one** | Per the design, the choice appears on surviving. Being overrun ends the trip. |

## Definition of done

- [ ] Trip start: locks the manifest, consumes one trip-cap use, sets caravan state to
      `on_trip`.
- [ ] Per encounter: matchmaking candidate → scout → arrange circle → resolve.
- [ ] Bank/push offered **after surviving**; push draws a fresh candidate at escalated
      difficulty.
- [ ] Attrition carries forward: unit damage and deaths, destroyed fence segments, and
      spent traps all persist with no repair or restock.
- [ ] Trip ends on bank, being overrun, or stalemate-then-bank. Each path returns the
      caravan to town.
- [ ] Manifest edits refused for the whole trip, server-side.
- [ ] Trip cap enforced: one use per trip regardless of encounter count; regen works.
- [ ] Before the bank/push prompt, the player sees: unbanked Coin at risk, which units
      are alive and would be lost entirely, current damage, remaining traps and fence
      material, and that the next encounter will be harder.
- [ ] **No geography, no route, no travel timer anywhere.** A reviewer should be able
      to grep for map/route/travel concepts and find none.
- [ ] Caravan is fully restored on bank.
- [ ] No path exists by which another player attacks a caravan outside a trip.

## QA guardrail checks for this chunk

- **The founding hooks — check explicitly:** does the loop deliver the King of Thieves
  hook (a hard-to-beat standing party, and the async tension of checking where it
  struck) and the loadout-optimization hook? **Flag any implementation choice that
  quietly changes what the player is actually doing versus what's designed** — this
  chunk is where the concept drifted before.
- **Which way round:** confirm the player's active experience here is defending, and
  that nothing has crept in letting them actively raid during a trip. Confirm no
  asynchronous attack against a caravan exists outside a trip.
- **Attrition is real:** push through several encounters and verify damage, deaths,
  spent traps, and broken fences all persist. If any resets, pushing is free and the
  outer loop has no stakes.
- **No safety bonus for pushing:** confirm nothing rewards remaining on the trail
  beyond the escalating Coin. The design deliberately removed the old
  untargetable-while-away pull; if some equivalent has crept back, risk and reward stop
  opposing each other.
- **Legibility of stakes:** at the bank/push prompt, can the player see everything they
  stand to lose *and* that difficulty escalates? If a loss can surprise them, the
  claim that loss is never bad luck is false.
- **Bounded stakes:** can a trip touch units outside the packed manifest, or Coin
  beyond what that trip earned? The roster in town and banked Coin must be untouchable.
- **Determinism:** is encounter sequencing, reward scaling, or difficulty escalation
  affected by wall-clock or unseeded randomness?
- **Race conditions:** two trips started concurrently for one account; an encounter
  resolving twice on a retry; a standing party edited mid-encounter. Exercise chunk 02.
- **Grind wall:** with `TRIPS_PER_HOUR_CAP` at 3, is free-path progress slow enough
  that the paid path stops feeling optional? Trip cap is not purchasable — but check
  its interaction with Coin earn rates.

## Notes from chunk 04 QA

- **N5 — no initial progression event at registration.** Registration writes no ledger
  event for a pool's starting Reputation; `pool_progress` rows are created at
  `REPUTATION_START` directly and the rebuild-from-zero fold
  (`apps/server/src/ledger/projection.ts`, `zeroPool()`) hardcodes the same constant.
  That is consistent today, but it means a retune of `REPUTATION_START` silently changes
  what "zero" means for every existing account on the next rebuild. When this chunk wires
  the first trip, decide whether registration (or the first trip) should emit an initial
  `reputation_changed`-style event per pool so the fold starts from 0 and the constant is
  recorded in the ledger. No change was made in chunk 04.
## Note from chunk 07 QA (N7) — `caravan.state` is the "on a trip" mark

`unit_instance` carries no per-unit "on a trip" flag, and chunk 07 added none. The mark is
`caravan.state = 'on_trip'`: chunk 16's fix S1 makes `performMerge`/`previewMerge` refuse
(409 `caravan_on_trip`) unless the caravan is `in_town`, which is what stops packed units
being merged away mid-trip. **This chunk must set `caravan.state = 'on_trip'` in the same
transaction as `lockManifest`, before the manifest is locked**, and set it back to
`in_town` on bank/overrun together with `closeManifest`. If the state is set after the
lock, there is a window in which a packed unit can be merged.

## From chunk 14 (matchmaking & scouting) — the seam this chunk builds on

Everything below is already built and tested in chunk 14; this chunk calls it, it does not
re-implement it. Files: `apps/server/src/matchmaking/{trips,service}.ts`, migration 009.

- **Trip rows.** `createTrip(client, caravanId)` (needs the caravan's open, locked manifest;
  one trip per manifest, at most one open per caravan — both DB-enforced) and
  `endTrip(client, tripId)`. The `trip` row is caravan-level and minimal: this chunk owns
  the trip cap (`TRIPS_PER_HOUR_CAP`), `caravan.state = 'on_trip'` (set in the same
  transaction as `lockManifest`, before the lock — chunk 07 N7 above), closing the manifest
  on bank/overrun, the `trip_started` ledger event and the bank/push loop. Trips and their
  menus are history: neither row can be deleted while the caravan exists.
- **Encounter index.** Search and choose accept `n` only while `n ===
  manifest.encounters_resolved + 1`; the manifest counter advances by exactly one per
  outcome (DB-guarded), so this chunk advances it from the resolution outcome, never by hand.
- **The encounter flow per index n:** `searchCandidates` (the player's `POST
  …/encounters/:n/search`; free, the reroll is time-gated on a caller-supplied `nowMs`)
  → `chooseCandidate` (`POST …/choose`) → `commitFormation` (chunk 07) →
  **`enqueueChosenEncounter(client, caravan, n, formation)`** — THE SEAM. It reads the
  chosen candidate from `encounter_candidates`, self-checks that its stored snapshot is
  canonical, and calls `enqueueEncounterResolution` with that snapshot as the REQUIRED
  `party` input (chunk 14 QA S1: there is no live-snapshot fallback; passing nothing throws
  before anything is written). The stored `job.input.party` is byte-identical to what the
  defender scouted, tested. `chosenCandidate(db, tripId, n)` returns the stored row shape
  (owner account id included) for this chunk's own reads; the client view omits it.
- **A new trip resets the reroll gate.** The gate is per `(trip, encounter_index)`: the
  first search of every encounter is immediate and only a repeat for the SAME encounter
  waits `REROLL_COOLDOWN_SECONDS`. Ending a trip and starting another therefore starts
  from an immediate search; nothing carries over, by design (free, time-gated, never
  resource-gated). Do not add a cross-trip cooldown here.
- **Recent opponents** are read from chosen `encounter_candidates` rows across ALL of the
  account's trips, so this chunk writes nothing extra for the exclusion to work.
- **Legibility hooks this chunk must surface before bank/push:** the menu carries
  `escalation.applied / perEncounter / nextEncounter` and each candidate carries
  `reputation.gapBeyondBand` and `reputation.sandbagEarnMultiplier`; put both next to the
  stakes preview (unbanked Coin, exposed units) in the bank-or-push decision.

## Note from chunk 17 QA (B1 / D2) — packed units and merging

Packing (`POST /caravans/:id/manifest`) does not move `caravan.state`; this chunk flips it at
trip start and end. The merge refusal for packed units does **not** depend on that flip:
`apps/server/src/economy/merge.ts` refuses 409 `unit_packed` for any instance named in
`packed.units` or `survivors.units` of an open manifest (`closed_at IS NULL`), in the preview
and inside the commit transaction (after the caravan's FOR SHARE, which serializes against
`lockManifest`'s FOR UPDATE). Keep both properties when building the trip loop: (1) a
manifest stays open (`closed_at` NULL) for as long as its units are at risk, including
between "packed" and "rode out"; (2) closing it at bank / overrun is what returns the
survivors to the merge board. The `caravan_on_trip` check (chunk 16 QA S1) remains as a
second, independent guard once this chunk sets the state.


## Build notes (chunk 15 Maker)

**Status: `built` — the fight result is consumed through ONE marked seam until chunk 13.**
Chunk 13 (end conditions, depth-scaled loot, replay log) is not built. Everything the trip
loop owns is built and tested; the outcome of a fight enters through
`apps/server/src/trip/outcome.ts`:

```ts
export type EncounterOutcomeKind = "caravan_held" | "caravan_overrun" | "stalemate";
export interface EncounterOutcome {
  readonly kind: EncounterOutcomeKind;
  readonly depth: number; // fixed-point 0..FIXED_ONE (1024 = reached the core; an overrun is always 1024)
  readonly units: readonly { readonly ref: string; readonly hp: number }[];  // posted units; 0 = died
  readonly spentTraps: readonly string[];                                      // laid traps that fired
  readonly fences: readonly { readonly ref: string; readonly hp: number }[]; // placed segments; 0 = destroyed
}
export interface EncounterResolverInput { tripId; encounterIndex; formation: Formation; survivors: Manifest; party: Party }
export interface EncounterResolver { readonly name: string; resolve(input: EncounterResolverInput): EncounterOutcome }
export function resolveEncounter(resolver, input): EncounterOutcome // validates shape + "only what was in the fight"
```

`units / spentTraps / fences` is exactly `@caravan/circle`'s attrition outcome (`applyOutcome`).
The job handler `makeEncounterResolutionHandler(resolver)` (jobs/handlers/encounterResolution.ts)
is pure: it parses the job input (`resolverInputFromJob`), runs the resolver, dry-runs the
monotone attrition fold against the committed survivors (a heal / re-arm / rebuild / unknown
ref parks the job; nothing recorded), and writes `encounter_resolved` +
`party_served_as_encounter` (the latter with `partyId`, `partyHash`, `partySavedAt`,
`outcome: {kind, depth}`), with the outcome in `job.result.outcome`. **Production stays gated**:
`ENCOUNTER_RESOLUTION_WIRED = false` (chunk 02), so `DEFAULT_HANDLERS` still parks every
encounter job; once flipped it calls `makeEncounterResolutionHandler(productionEncounterResolver)`,
whose body throws `TODO(chunk-13)`. **Chunk 13:** implement `productionEncounterResolver.resolve`
as an adapter (`toBattlefield(input.survivors, input.formation)` + `input.party` → simulate → this
shape) and flip the flag. Nothing in the trip loop changes. Tests use the deterministic double in
`apps/server/test/trip-double.ts` (`plannedResolver` / `doubleHandlers`), registered explicitly.

**Files.** `src/trip/{outcome,cap,repo,service}.ts`, `src/routes/trip.ts` (registered in
`app.ts`), migration `012_trip_loop`, `test/trip.test.ts` + `test/trip-double.ts`. Touched:
`jobs/handlers/encounterResolution.ts` (handler factory; the gated production path delegates to
it), `matchmaking/trips.ts` (`end_reason`, `endTrip(client, id, reason?)`),
`matchmaking/service.ts` (search gate, one call), `progression/outcome.ts` (`partySide: "skip"`
option, hash unchanged when omitted), `packages/content/src/tunables.ts` (chunk 15 block:
`TRIPS_PER_HOUR_CAP` 3, `TRIP_CAP_REGEN_MS` 20 min, `NO_REPAIR_BETWEEN_ENCOUNTERS`,
`RESTORE_ON_TRIP_END`), `test/migrations.test.ts` (table list).

**Routes** (owner-only, 404 otherwise): `GET /me/caravans/:id/trip` (status, phase, trip cap;
settles a finished resolution lazily), `POST …/trip/start` (201), `POST …/trip/encounters/:n/commit`
(202 new / 200 replay), `GET …/trip/preview`, `POST …/trip/push` and `POST …/trip/bank`, both
`{ tripId, encounterIndex }` — the survived encounter the decision is about, so a stale retry
can never decide a later encounter. Search / choose stay chunk 14's routes, arranging chunk 07's.

**Migration 012.** `trip.end_reason` (`banked` | `overrun`, frozen with the trip);
`trip_encounter` (one row per SETTLED encounter: job id, kind, `depth_fp`, `deaths`,
`coin_accrued` = the encounter's UNBANKED Coin, owner, one-time `decision` pushed | banked;
otherwise immutable, undeletable, inserted only after n−1 was pushed past and only on an open
trip; overrun ⇒ 0 Coin and no decision); `trip_cap` (account-level, one GCRA timestamp
`tat_ms`; the DB refuses any decrease — no refund path — and deletion).

**How the loop runs.**
- *Start* (one tx; lock order caravan advisory → account → caravan row → manifest): refuses
  `not_packed` without an open manifest, `trip_open` when already out, `manifest_used`;
  consumes one trip-cap use (`trip_cap_exhausted` 409 + Retry-After); sets `caravan.state =
  on_trip` BEFORE `createTrip`, same tx; appends `trip_started {tripId, manifestId, startedAtMs,
  tripCap}` under `trip:<id>:start`. Packing stays in town and never moves the state (17 D2).
- *Commit* (`commitEncounter`): for n > 1 requires a recorded push past n−1; commits the
  formation (chunk 07, idempotent) and calls `enqueueChosenEncounter` with the canonical
  formation plus one extra key, `survivors` (the snapshot it was committed against), so the job
  input alone determines the fight.
- *Settle* (`settleEncounter`; lazy from GET status / preview / bank / push; idempotent and
  race-safe — 10 concurrent settles → one row, one fold, one progression set): `applyOutcome`
  (monotone; advances the counter by exactly one), chunk 04 `applyEncounterOutcome` under
  `progression:<jobId>` (caravan: living if posts, trap if traps laid; party: siege if fielded;
  **party side skipped for a system owner** — no event on the system account except chunk 09's
  feed entry), `coin_accrued = coinForEncounter(n)` if survived else 0, and on an overrun:
  `endTrip(…, "overrun")`, `closeManifest`, caravan `in_town`, `trip_overrun` with the typed
  `TripOverrunHandoff` payload (`unbankedCoin`, `unitsAliveAtCollapse`, `unitsDiedOnTrip`,
  `partyOwnerAccountId`, `partyOwnerAuthored`, `lossesApplied: false`). **TODO(chunk-19)** in
  `settleLocked`: destroy / de-merge / transfer in that same transaction. No losses applied here.
- *Push*: binding — the next party is served only after it (chunk 14's `searchCandidates` now
  refuses 409 `decide_first` while the decision is open, so scouting is not a free peek).
- *Bank*: only after surviving (held or stalemate); asserts the accrued sum equals
  `coinForEncountersSurvived(n)` (preview = ledger), credits `creditBankedTrip` once under
  `trip:<id>:bank`, records the decision, `endTrip(…, "banked")`, `closeManifest` (the refit,
  RESTORE_ON_TRIP_END: the next manifest packs at full HP, traps restocked, fences rebuilt; the
  bank result itemizes `restored`), caravan `in_town`, `trip_banked` under `trip:<id>:banked`.
  A retry replays from the stored event (`replayed: true`); a concurrent double bank credits
  once; bank racing push: exactly one wins.
- *Preview* (`GET …/trip/preview`): unbanked Coin (total + per encounter); bank-now total with
  chunk 16's overflow forecast; every unit from the MANIFEST (hp, maxHp, damage, alive,
  `diedAtEncounter`, `mergeLevelOnDeath` = max(1, L−1)); `ifOverrun` (Coin lost, units lost
  outright = alive now, units de-merged-not-destroyed = dead now); remaining / spent traps;
  intact / destroyed fences; the next encounter (index, reward, bank total if survived, chunk 14
  escalation applied / per encounter / harder, party arrives fresh); the last opponent's chunk 14
  reputation block (`gapBeyondBand`, `sandbagEarnMultiplier`) beside the stakes.

**Tests.** `test/trip.test.ts` (27): cap math and regen; start refusals / state / event; four
concurrent starts → one trip, one use; cap exhausted → 409 + Retry-After, regen at +20 min, one
use per trip regardless of encounter count; cap and trip_encounter DB guards as the app role;
the chain 1 → 2 → 3 with attrition (a trap spent at 1 is still spent at 2 and 3, a unit dead
at 2 stays dead and unpostable at 3, HP never rises, a spent trap is unplaceable); heal / re-arm
resolvers park with nothing folded; search / commit refused before deciding; preview itemized;
push binding and idempotent; stale bank refused; stalemate → bank; bank exactly once (retry +
concurrent); refit on the next pack; a new trip's first search is immediate (reroll gate reset);
bank guards; bank racing push ×3; overrun hand-off (no Coin, roster byte-identical); 10 racing
settles; replay determinism (`verifyJobReplay`); production handler still parks; authored owner
gets no progression / Coin event; source scans (no travel / route / map concepts in `src/trip`
or the route file; `enqueueChosenEncounter` called only by the trip loop).

**Assumptions / decisions for QA.**
- The trip cap is ACCOUNT-level (a player's budget; a future second caravan must not multiply
  it), stored as one GCRA timestamp; routes pass the wall clock, services take `nowMs`.
- The caravan's encounter Coin does not depend on depth: depth scales the party OWNER's loot
  (chunk 13's PARTIAL_LOOT_CURVE). Held and stalemate both accrue `coinForEncounter(n)`.
- The sandbagging earn floor is NOT applied (chunk 19's `applyEarnFloor`, at the accrual site
  marked TODO(chunk-19); `creditBankedTrip` would then need the per-encounter amounts). The
  multiplier is shown in the preview's `lastOpponent.reputation` as chunk 14 computed it.
- Dead units are banked home at full HP at their packed level; the per-death de-merge is chunk
  19's (`restored.deMergePending` lists them). On an overrun the manifest closes and the units
  return to the roster untouched until chunk 19 wires the losses into the same transaction.
- No new ledger types: `trip_started`, `trip_banked`, `trip_overrun` were already in the enum
  (`stop_resolved` stays unused). A push writes no ledger event (it moves no Coin, Reputation or
  unit); it is recorded on `trip_encounter.decision`.
- Chunk 04 N5 (initial progression event at registration): left as is — registration still
  writes no initial event and the trip loop adds none.
- The search gate in `searchCandidates` bites only when the trip loop has a row for n−1 (chunk
  14's own tests advance the manifest counter by hand and are unaffected); the trip loop's own
  commit path is strict, and `trip_encounter`'s insert trigger enforces order in the DB.

## QA fixes (chunk 15 fixer, after chunk 13) — roadmap/qa/15-punchlist.md

- **S4 / chunk 19 S3 — settle at resolution.** `runOnce` / `drain` accept `afterCompleted` (inside the
  completion transaction, in a SAVEPOINT: a failing settle rolls back alone, the resolution still
  commits, the lazy settle retries) and `afterParked`. `TRIP_SETTLE_HOOKS` (trip/service.ts) wires
  `settleResolvedJobTx` / `voidTripForParkedJob`; `scheduleInlineDrain` passes them. Lazy settle stays.
  No production worker process exists yet; the hooks apply wherever a worker runs.
- **Owner loot credited** (`trip/loot.ts`, settle step 3b). One rule: held → depth-scaled loot of
  `coinForEncounter(n, chosen-row band)` (`partyLootFull`, stamped into the job input at commit; 0 for a
  system owner), credited as `coin_earned` `party_loot` under `transfer:<jobId>`, capped; overrun →
  chunk 19's transfer + party win, loot 0 (`FULL_CLEAR_LOOT_SHARE` removed); stalemate → nothing. The
  reported `outcome.loot` equals what is requested. Feed: `lootCoin`.
- **D3 — void path.** A parked job (worker hook or any read) voids the trip: `trip.end_reason = 'voided'`,
  `trip_voided` (`trip:<id>:voided`) with the job's last error, banked as of the last survived encounter
  exactly as a bank (Coin under `trip:<id>:bank`, per-death de-merges, refit; nothing for k = 0), nothing
  of the voided fight applied, cap use not refunded. Trip view `ending.kind = "voided"` (the web client
  does not render this kind yet). `POST trip/start` → 409 `resolver_unavailable` only when
  `ENCOUNTER_RESOLUTION_WIRED` is false and no CARAVAN_TEST_RESOLVER double is installed.
- **S6** `tripId` via `isUuid`. **N2** `bankNow` / `harderThanThisEncounter` omitted before the first
  survival. **N4** the raw formation-commit route needs an open trip and a chosen candidate.
  **N5** `trip_banked.balanceAfter`, returned by a replayed bank. **N7** `trip_cap_use` (migration 014).
- Tests: `test/qa15-fixes.test.ts` (13); trip / stakes / trip-resolver / circle / qa07 / party updated.
