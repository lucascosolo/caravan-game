# Chunk 13 — Resolver outcomes & replay

**Depends on:** 12. **Status:** built (awaiting QA).
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Close out the resolver: end conditions, depth-scaled loot, the tick log that **is**
the replay, and the full determinism test harness that every future change is
checked against.

## Design constraints that apply here

**End conditions — exactly three:**

- **The attacking party is wiped** → **the caravan holds** and may bank or push. The
  party's owner earns a reduced share, **scaled to the depth it reached**.
- **An attacker reaches the caravan core** → **the caravan is overrun**. The trip ends
  per chunk 19; the party's owner takes the full reward and Reputation.
- **Tick cap reached with neither outcome** → **the attackers withdraw; favors the
  caravan**
  (this is the safety valve against infinite kiting).

**Replay:**

- **The resulting tick log doubles as the replay both players can watch afterward;
  nothing is re-simulated for playback.** The log is the authoritative artifact. A
  replay player renders it; it must never call the resolver again.

- **Log format, given continuous movement.** At 20 ticks/second for up to 180 seconds
  with ~20 entities, a naive per-tick position dump is far too large to store per
  raid. The log must therefore record **events and waypoints**, not per-tick state:
  *"unit 7 begins moving toward (x,y) at tick 412 at speed s"*, *"unit 7 attacks
  unit 3 at tick 480 for d"*, *"fence segment 12 breaks at tick 495"*, *"unit 4 fires
  ability at tick 500 affecting units 8, 9"*. The renderer **interpolates between
  waypoints**.
  This still satisfies the design: interpolation is not simulation. The renderer makes
  no decisions, resolves no combat, and cannot change an outcome — every decision and
  every number is already in the log. If the renderer ever has to decide *what
  happens*, rather than *where to draw something between two known points*, the format
  has crossed the line and must be fixed.
- Emit a **periodic full-state keyframe** (every few seconds) so playback can seek and
  so a corrupted or truncated log is detectable rather than silently misrendered.
- This supports the "provably fair" claim: the log plus the inputs is a complete,
  checkable account of what happened.
- The log must be stored alongside the **layout snapshot and loadout snapshot** used
  (chunk 02), so a party's owner editing it afterwards doesn't alter history.
- Record the **resolver version** on every log. A resolver change must not silently
  invalidate old replays — either keep old versions renderable or mark them explicitly.

**Both players can watch, and they need it for different reasons.**

- The **caravan's player was present**, made the arrangement, and watched it resolve.
  For them the replay is a record and a post-mortem.
- The **standing party's owner was not present at all.** The replay is the *only* way
  they learn where their party struck and how it did — it is the entire feedback loop
  for the passive side of the game, and the delivery mechanism for the King of Thieves
  hook. A log that only serves the player who was present misses half the point, and
  leaves the asynchronous half of the game with no feedback whatsoever.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `TICK_RATE` / `TICK_CAP` | 20/sec, 3,600 ticks (180s) | From chunk 10. Stalemate threshold. |
| `DEPTH_METRIC` | fraction of the straight-line distance from the start edge to the core that the deepest attacker reached, plus fence segments broken and posted units killed | Needs to be a legible, previewable notion of "depth" — the player should be able to reason about partial success. Keep it simple enough to explain in one sentence in the UI; a composite that can't be previewed defeats the purpose. |
| `PARTIAL_LOOT_CURVE` | `loot = full_loot × depth_fraction^1.5`, floored at 0 | Sub-linear, so a near-miss is worth meaningfully less than a clear but not nothing. |
| `STALEMATE_LOOT` | 0 for the attacking party's owner | Favors the caravan. |
| `STALEMATE_REPUTATION` | treated as a loss for the attacking party (chunk 04) | |
| `FULL_CLEAR_LOOT` | 100% of the encounter's Coin value (chunk 16) | |
| `LOG_FORMAT` | versioned; event + waypoint records, not per-tick state | Renderer interpolates between waypoints. Must be self-sufficient for playback. |
| `LOG_KEYFRAME_INTERVAL` | every 5 seconds (100 ticks) | Enables seeking and detects truncation. |
| `LOG_SIZE_BUDGET` | 100 KB per raid, compressed | If a typical fight exceeds this, the format is wrong — revisit before shipping, not after storage bills arrive. |
| `LOG_RETENTION` | 30 days or last 50 raids per caravan, whichever is larger | Storage guard; tunable. |

## Definition of done

- [ ] All three end conditions implemented and distinguishable in the output.
- [ ] Depth-scaled loot on a wipe; full loot on a clear; nothing on a stalemate.
- [ ] Event/waypoint log emitted during resolution, sufficient to render the whole
      fight with no re-simulation. A replay renderer is fed only the log and produces
      the same sequence of events.
- [ ] Keyframes emitted at a fixed interval; playback can seek to any of them.
- [ ] A typical fight's log fits the size budget; measure it, don't assume.
- [ ] The renderer makes no decisions — a test or review confirms it only interpolates
      between known points and never resolves combat, targeting, or death.
- [ ] Log stored with the layout snapshot, loadout snapshot, and resolver version.
- [ ] Both the caravan's player and the attacking party's owner can retrieve and
      watch the replay of any encounter they were part of.
- [ ] Resolver still pure; log emission does not introduce I/O into the resolver
      (emit into a returned structure, don't write to disk from inside).
- [ ] **Full determinism harness, and this is the deliverable that matters most:**
  - [ ] Same input × 100 runs → byte-identical logs.
  - [ ] Same input across separate processes → identical.
  - [ ] A corpus of at least 50 varied fixture scenarios (gapped camps, full rings,
        all three stances, siege counters matched and mismatched, all six ability
        archetypes, all three end conditions, boundary cases from chunks 11 and 12)
        with **golden logs checked in**.
        Any resolver change that alters a golden log must be an explicit, reviewed
        decision — not a silent diff.
  - [ ] A harness command a QA session can run in one line.

## QA guardrail checks for this chunk

- **Determinism, comprehensively:** this is the last chunk where determinism can be
  established cheaply. Run the full harness. Then try to break it: change process
  start order, run under load, run on a different machine. Byte-compare.
- **Replay fidelity:** does the replay ever diverge from the recorded outcome? Is
  anything re-simulated at playback time? Does a party's owner editing it after the
  fight change what the replay shows? All three are hard bugs.
- **Interpolation has not become simulation:** examine the renderer specifically. Does
  it ever decide *what happens* — who gets hit, when a unit dies, where a unit turns —
  rather than only *where to draw something between two known points*? Anything the
  renderer decides is a decision that can diverge from the authoritative outcome, and
  is the exact failure the "nothing is re-simulated" rule exists to prevent.
- **Log completeness:** truncate a log mid-fight and confirm playback fails loudly
  rather than rendering a plausible-looking wrong fight.
- **Tick-resolution edge cases:** confirm all of chunk 11's and chunk 12's boundary
  scenarios are in the golden corpus, not just in transient tests.
- **Stalemate favors the caravan:** verify the attacking party's owner gains nothing
  on a tick-cap outcome. If a party that cannot win can still stall for value, the
  safety valve has failed.
- **Bounded stakes:** does depth-scaled loot ever exceed full-clear loot? Can any end
  condition produce more Coin than the encounter is worth?
- **The founding hook:** can a standing party's owner actually see **where their party
  struck and how it did**? They were never present, so this replay is their only
  feedback — without it the passive half of the game is silent, and the King of Thieves
  hook the design is anchored on simply isn't delivered. A replay that only serves the
  player who was there is a design regression, not a missing nice-to-have.
- **No pay-to-win:** the resolver still cannot see entitlement state.

## Notes from chunk 10 QA

- **Log budget (QA-10 N4).** Chunk 10's log is already ≈ 80 KB for a 180 s fight with 24
  entities, BEFORE any combat, trap or ability events (keyframes every 5 s carry every
  unit, fence and trap; `path` events carry full waypoint lists). When fixing LOG_FORMAT
  here, budget for chunks 11–12's events on top of that: consider 10 s keyframes (seeking
  precision is a renderer concern, not a fidelity one — interpolation between keyframes is
  exact by contract) and/or shorter keys, and measure the full-length corpus before
  freezing the format. The interpolation contract the renderer must follow is in
  `packages/resolver/src/log.ts` (leg-parametric movement; `hold` is load-bearing).
## Notes from chunk 09 QA

- **N3 — the served-party event must name the party version that fought.** The party
  snapshot in a job's input (`snapshotStandingParty`, chunk 09) carries `partyId` and
  `hash` (sha256 of the canonical stored config) alongside `savedAt`. The
  `party_served_as_encounter` payload this chunk writes **must carry all three**
  (`partyId`, `partyHash`, `partySavedAt`), copied from the job's snapshot and never
  re-read from the live row, so a feed entry and its replay name exactly which party
  version fought even after the owner has edited the party. Chunk 09's feed reads
  `partySavedAt` today and will read the other two once they exist.
- **Naming (X2):** the Coin an overrun caravan loses is credited through
  `coin_transferred_to_party_owner` (renamed from `coin_transferred_to_defender`: the
  receiver is the attacking party's owner, GUARDRAILS §0). The feed sums it per
  causation; write it under the same causation id as `party_served_as_encounter`.

## Build notes (chunk 13 Maker) — `RESOLVER_VERSION` 6 → 7 `[resolver-bump]`

**Status: `built`.** The resolver ends fights, measures depth and emits a versioned, compact,
self-checking replay; the golden corpus (72 fights) is checked in; the server resolves
encounters with the real resolver (`ENCOUNTER_RESOLUTION_WIRED = true`), stores every log in
`encounter_log`, and serves it to both participants.

**End conditions** (`packages/resolver/src/outcome.ts`, filled into the `endOfTick` seam in
hooks.ts). Checked after phase 8 of every tick, in this precedence: (1) `core_overrun` — an
attacker reached the core THIS tick (its `core_reached` was logged; arrival counts even if the
same unit dies later that tick, and beats a same-tick wipe); (2) `party_wiped` — no attacker
alive; (3) `tick_cap` — the loop ran TICK_CAP ticks (stalemate; the cap tick is checked for 1
and 2 first). The fight stops on that tick; the final keyframe is that tick's. Output:
`out.outcome = { kind: caravan_held | caravan_overrun | stalemate, end, endTick, depth, deepestUnit }`
(`out.end` kept). Golden fixtures pin an arrival on the cap tick (`c13-overrun-on-the-cap-tick`),
a wipe on the cap tick (`c13-wipe-on-the-cap-tick`, and chunk 12's `qa12-dash-over-trap-tick-cap`),
an arrival and the last raider's death on one tick (`c13-overrun-and-wipe-same-tick` → overrun),
a mutual kill that wipes both sides (`c11-mutual-kill-wipes-both-sides` → held).

**DEPTH_METRIC (QA-15 N8)** — one sentence for the UI: *"How far the deepest raider got: the
share of its straight-line distance to the core that it closed."* Per attacker: distance from
its centre to the nearest point of the 3×3 core block (0 on a core cell), at spawn and the
minimum sampled at the end of every tick it was alive for; depth = floor(1024 × (start −
closest) / start) via `isqrt`; the fight's depth is the max (an overrun is 1024 by
construction). Integer 0..1024, computed in the resolver (so it is in every golden), not in the
adapter. **Deviation for QA:** the chunk table's default adds "fence segments broken and posted
units killed"; I left them out — a composite cannot be said in one sentence or previewed, and
both already show up as distance. Content: `DEPTH_METRIC` (documentation string).

**Loot** (`apps/server/src/trip/loot.ts`; content `PARTIAL_LOOT_CURVE`, `FULL_CLEAR_LOOT_SHARE`
1024, `STALEMATE_LOOT_SHARE` 0). The resolver never sees Coin. `resolveEncounter` adds
`loot` to every outcome (real resolver and test double alike): overrun → full; held →
floor(full × d × isqrt(d × 1024) / 1024²) (= full × depth^1.5, one floor, monotone, never above
full); stalemate → 0 (asserted in the outcome shape check). `full` = chunk 16's
`coinForEncounter(n)`. It is REPORTED (`job.result.outcome.loot`, both events) — **not
credited**: crediting the party owner is the settle path's (chunk 19 / QA-15 S4).

**LOG_FORMAT v1** (`packages/resolver/src/replay.ts`). `encodeReplay(output) → ReplayLog`:
`{format: "caravan-replay", v: 1, resolverVersion, tickRate, tickCap, keyframeInterval, ticks,
outcome, units/fences/traps labels (ref, type, level, max and start HP, segment / tier /
category, trap position), events: positional rows [t, code, …], count, check (FNV-1a 32)}`.
One row per log event (codes documented in the file header); the log.ts INTERPOLATION
CONTRACT is unchanged. **KEYFRAME_DELTA**: keyframes stay every 5 s (LOG_KEYFRAME_INTERVAL),
but a keyframe row lists only units whose record changed since the previous keyframe (the
ability's ready tick stored ABSOLUTE so idle units do not churn), fences whose HP changed, traps
spent since; `alive` is implied by HP > 0 (asserted). Lossless: the reader reconstructs full
keyframes identical to the resolver's and decodes the whole log byte-identically (tested over
the corpus).

**Reader** — `readReplay(raw) → { log, events, keyframes, eventsAt(t), frame(t) }`, pure, in
the resolver package, importing only `fixed.ts`, three names from `battlefield.ts` and types.
It validates the envelope, count and checksum; decodes with per-code arity and id checks; checks
the keyframe schedule (k × interval − 1 and the final tick; last row = final keyframe), that the
stated outcome is the one the rows show, then interpolates the whole fight and compares every
keyframe (positions, HP, life, fences, traps). Anything wrong → `ReplayError`. HP / deaths /
breaks are copied from rows, positions by the leg rule — a test pins the import list and that
the only HP writes are row copies. `frame(t)` seeks from the nearest keyframe snapshot.

**Size (measured, `test/budget.test.ts`).** LOG_SIZE_BUDGET is 100 KB compressed:
- full load (16 v 8 v 28, 6 traps, 2 siege) as resolved (overrun at tick 137): **12.5 KB raw,
  2.7 KB gzip** (chunk 12's JSON objects: 16.2 KB);
- the same roster forced through 3600 ticks (the QA-10/11/12 figure): **23.4 KB raw, 5.3 KB
  gzip; keyframes 4.0 KB** (was 128 KB raw with 95 KB of keyframes);
- worst case, the full-load roster unkillable for 180 s (`c13-full-load-full-length`, 3804 hits):
  **143 KB raw, 30.2 KB gzip** — inside the compressed budget; raw is dominated by one row per
  hit, which the format must keep. Every corpus fight is asserted under the budget compressed.

**Determinism harness (chunk 13's main deliverable).** `pnpm determinism` →
`packages/resolver/scripts/determinism.mjs`: (1) vitest `test/determinism.test.ts`: every
corpus fight 100× byte-identical; every fight equal to its golden `packages/resolver/golden/<name>.golden.json`
(72 files, ~0.7 MB; `UPDATE_GOLDEN=1` regenerates); every golden readable and decoding to the
fight's log; the corpus ≥ 50 with coverage asserted (all three outcomes, all six archetypes on
the attacking side and the five a post can fire, all three attacker and post stances, sealed /
gapped / open rings, siege matched > 2 and mismatched > 1, ≥ 2 decisive endings on the cap
tick); integers every tick; nothing account-shaped (now also `loot`) in the output; input never
mutated. (2) three separate Node processes, each resolving the corpus in a different ORDER
(forward / reverse / rotated) with different V8 heap flags, 3 runs each, compared by sha256 of
the golden text. (3) those hashes compared with the checked-in files. The root
`scripts/determinism.mjs` (chunk 21) refuses a golden change without a RESOLVER_VERSION bump or
`[resolver-bump]`. Corpus: chunk 12's 7 ability fights, chunk 11 QA's 5, chunk 11's 4, chunk
10's 6, and 50 new whole fights (`boundaryScenarios` in test/fixtures.ts): every chunk 10–12
boundary rule that was only a transient test (breach/detour boundary, two units one segment,
nearest/trap tie-breaks, retarget on death, no tunnelling, reach in/out, mutual kill, trap
tie, two traps one tick, root/slow/refresh, 40 Hz root, aggro beyond leash, two guards, sealed
no-route guard, three post stances on one layout, siege matched/mismatched for fences and
traps, affinity win/loss, breacher vs ranged post, burst cluster, post burst, heavy strike both
sides, heal ceiling, buff refresh, guard dash, breaker room, capped huge buff, a guard leash
oscillation stalemate) and the chunk 13 end-condition edges.

**Mechanic isolation in old tests.** Nine chunk 10–12 tests watched behaviour after a fight
would now end (walking past the core edge to its centre, a guard's walk home after the raider
arrived, both raiders reaching the core). They use `runToCap` (test/fixtures.ts: the same tick
loop with `endOfTick` switched off — test-only, production has no such switch) like `quiet()`;
the same layouts run through `resolve` in the golden corpus. `replica.test.ts` now drives the
src reader over every corpus fight (0 divergences in position, HP, life, fences, traps).

**Server.**
- *Adapter* (`src/trip/resolverAdapter.ts`, re-exported as `productionEncounterResolver`):
  `toBattlefield(survivors, formation)` + `toResolverParty(party)` (new in @caravan/circle:
  content stats, full merged HP, unscaled offense, siege by type) + `resolverTunables()` →
  `resolve` → `{ outcome: {kind, depth, endTick, units, spentTraps, fences}, log: encodeReplay(out) }`.
- *S2*: `EncounterResolver.resolve` returns `{ outcome, log }`; `resolveEncounter` returns
  `{ outcome (with loot), log }`. The handler hands the log to the worker as
  `HandlerOutput.encounterLog`; the worker inserts it into **`encounter_log`** (migration 013)
  in the completion transaction: gzip (level 9), resolver version, log format, raw/stored
  bytes, sha256 of the log and of the formation / survivors / party snapshots, the content hash.
  `job.result.replay = { store, jobId, logFormat, sha256, rawBytes }` — never the log. Rows are
  immutable (UPDATE and TRUNCATE triggers). Retention (`pruneEncounterLogs`, same transaction,
  per caravan): delete only rows older than `LOG_RETENTION_DAYS` (30) AND outside the caravan's
  newest `LOG_RETENTION_MIN_PER_CARAVAN` (50).
- *S3*: `RESOLUTION_CONTENT_HASH` = sha256(canonicalJson(`resolutionContent()`: content
  units / traps / siege / fences + `resolverTunables()`)), stamped as `contentHash` in every
  job input at enqueue; the adapter throws `ContentHashMismatchError` on a different or missing
  stamp; the handler re-throws it RETRYABLE (a worker on the stamped content can take it; after
  the attempt budget it parks → QA-15 D3's void path).
- *N3*: `survivors` is a top-level job-input key (`enqueueEncounterResolution({…, survivors})`,
  `enqueueChosenEncounter(…, formation, survivors)`); the idempotent re-enqueue compares it too.
- *Events*: `encounter_resolved` and `party_served_as_encounter` carry `partyId`, `partyHash`,
  `partySavedAt` (from the job's snapshot) and `outcome` with `kind, depth, endTick, loot`
  (`encounter_resolved` keeps the full outcome with attrition).
- *Flag*: `ENCOUNTER_RESOLUTION_WIRED = true`; DEFAULT_HANDLERS resolves for real.
- *Replay API*: `GET /me/encounters/:jobId/replay` (bearer). The caravan's player → `viewer:
  "caravan"`, the party's owner → `viewer: "party_owner"`; anyone else, a malformed or unknown
  id → 404; not completed → 409 `not_resolved`; pruned → 410 `replay_expired`. Body:
  `{ jobId, viewer, tripId, encounterIndex, resolverVersion, currentResolverVersion, logFormat,
  renderable, reason, outcome (incl. loot), depthExplained, party: {partyId, partyHash,
  partySavedAt}, labels: {units[+displayName, ability], fences[+displayName], traps[+displayName]},
  stored: {rawBytes, storedBytes, encoding, sha256, contentHash, createdAt}, log }`. Old
  versions: the reader is versioned on the LOG FORMAT (`READABLE_REPLAY_FORMATS`), so logs from
  any resolver version stay renderable while their format is readable; an unreadable format, or
  a log the reader rejects, comes back `renderable: false` with the reason. No account id of the
  other side is in the body.

**Tests added.** Resolver: `replay.test.ts` (10: format, keyframe schedule and delta, lossless
over the corpus, truncation / padding / edit / re-sealed edit / removed hit / removed death /
swapped rows / unknown version / tampered outcome all throw, the reader's import list and no-
decision scan), `determinism.test.ts` rewritten (7), `budget.test.ts` rewritten (4),
`replica.test.ts` on the src reader. Circle: `resolverParty.test.ts` (4). Server:
`trip-resolver.test.ts` (11: loot curve; a strong-circle trip pushing through held encounters
and a weak-circle overrun with the real resolver — stored log decodes to the folded outcome,
re-running the adapter gives the same bytes, `verifyJobReplay` ok, events carry the party
version and outcome; replay API for both participants, 404/409/410/401, owner edit changes
nothing, unreadable format marked; log immutability; retention; S3 refusal), trip.test.ts's
seam shape and wired-handler test, qa02 TRUNCATE expectation (resolution_job is now
FK-referenced: plain TRUNCATE → 0A000, CASCADE → the guard's 23514), migrations table list.

**Hand-offs.**
- **[closed — chunk 15 fixer]** loot is credited at settle (held fights only); an overrun reports loot 0
  and pays chunk 19's transfer + party win instead (FULL_CLEAR_LOOT_SHARE removed); `full` is the chosen
  row's band schedule, stamped as `partyLootFull`. See roadmap/qa/15-punchlist.md.
- **Chunk 19 / QA-15 S4**: `outcome.loot` is computed and recorded, never credited. Credit it
  (capped by the owner's storage cap; nothing for an authored/system owner) in the settle
  transaction, under the job's causation id, as the chunk 09 note asks.
- **Web (chunk 08 fixer)**: play replays with `readReplay` from `@caravan/resolver` (pure, no
  simulation); `frame(t)` for positions/HP per tick, `eventsAt(t)` for hits, abilities, traps;
  sub-tick smoothing between `frame(t)` and `frame(t+1)` is the renderer's own lerp. The scout
  contract fixtures under apps/web/src/test/contract were regenerated by the server suite (they
  now carry chunk 12's `abilityDisplay`); the web guards accept them (217 tests pass).
- **Performance note**: a long breach-heavy fight is slow — an early probe (16 unkillable
  raiders breaching 1 000 000-HP segments with siege for 3477 ticks) took 3.4 s per resolve,
  ~1 ms/tick, dominated by phase 2's two A* runs per recompute while breaching. Not reachable
  with content fence HP (≤ 1000) at the time of writing, inside the 30 s job lease, but worth a
  QA look before chunk 37 raises HP.
