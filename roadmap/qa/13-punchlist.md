# Chunk 13 — QA punch list (merged at 752aaa0; reviewed on roadmap/phase-2-spec 0baed2a; RESOLVER_VERSION 7)

Probes: scratchpad/qa13 (`qa13-tamper.probe.ts`, `qa13-size.probe.ts`, `qa13-fun.probe.ts`, `qa13-hash.probe.ts`,
`forge.sql`, `jobdel.sql`). To rerun one, copy it back into the package it names and run it with
`apps/server/node_modules/.bin/tsx`. DB: `caravan_test_qa13`.
Not counted (known): loot reported at band 0 and not credited (chunk 15 / 19 fixer).

**What held up (observed):** `DETERMINISM_BASE_REF=roadmap/phase-2-spec pnpm determinism`
passes: 72 goldens; 3 processes × 3 orders agree. It passed again while the full resolver suite ran
alongside it (load). I committed a temporary depth change with regenerated goldens and no bump:
the gate refused it ("golden logs changed without a resolver version bump"). Reverted.
`pnpm --filter @caravan/server test`: 604 passed, 1 skipped. `pnpm lint` and `pnpm test:boundary`
are clean. No float, `Math.random`, `Date`, or Map/Set iteration in outcome.ts, replay.ts or
hooks.ts. `isqrt` is integer Newton. End-condition order matches the notes and the goldens:
overrun on the cap tick, wipe on the cap tick, overrun and wipe on the same tick → overrun, and a
mutual kill → held. A truncated log, a padded log, and an hp edit to a hit row are all refused.
A third party gets 404 before any status leaks. Size: the budget claim holds for content (worst
case below). Resolve time: worst realistic fight 40 ms; the 3600-tick full-load fixture 141 ms.
Both are far inside the 30 s lease.

## Should-fix

S1. **No process runs the real resolver, so no running server can produce a replay.**
`ENCOUNTER_RESOLUTION_WIRED = true` (jobs/handlers/encounterResolution.ts:200), but only tests call
`drain`/`runOnce`: `grep -rn "drain\|runOnce" apps/server/src` finds only worker.ts and
dev/testResolver.ts. index.ts:1-9 starts Fastify and nothing else. The build has no worker entry:
scripts/build.mjs:32 names `src/worker.ts`, which does not exist. The one in-process runner
(routes/trip.ts:61 → testResolver.ts `scheduleInlineDrain`) uses the chunk 15 double, which returns
`log: null` (test/trip-double.ts:46).
*Failure:*
- `pnpm dev`: commit → the job stays `queued` forever.
- `CARAVAN_TEST_RESOLVER=double pnpm dev`: the fight resolves, but `GET /me/encounters/:id/replay`
  answers **410 "past its retention window"** for a fight a second old.
- So neither participant can watch a replay outside vitest (a DoD bullet).

*Fix:* add a worker entry, `src/worker.ts`: a `drain` loop on `DEFAULT_HANDLERS`, built by
build.mjs and started by `pnpm dev` and `pnpm start`. Or add an in-process drain with the real
handlers, gated by config. Separately, the route should return 409/404 rather than 410 when the
job's `result.replay` is null. Update AGENTS.md:167-177, which still says jobs park until chunk 13.
The orchestrator decides whether the process belongs to this chunk; the bug stands either way.

S2. **A held fight can pay the party owner 100 %, the same as an overrun.**
The path, step by step:
- A dash ends on a core cell.
- `springTraps` kills the dasher, so `core_reached` is not logged (abilities.ts:338-346).
- `sampleDepth` still samples units that died this tick (outcome.ts:87), at the dash end
  position. That gives `coreClosestSq = 0`, so depth is 1024.
- If that was the last raider, the outcome is `caravan_held` with depth 1024.
- `partyLoot("caravan_held", 1024, full)` = `full` (loot.ts:105-106).

It is in the golden corpus: `qa12-dash-over-trap-onto-core` → `{"kind":"caravan_held",
"depth":1024}`. Its sibling `qa12-dash-over-trap-tick-cap` → held, depth 1021, 99.6 % loot. The
chunk says a wipe earns a "reduced share".
*Fix:* sample depth for a unit only while its HP > 0 after the phase that moved it. Or sample a
dash killed by a trap at its trap-firing point, not at the dash end. And/or clamp held depth below
DEPTH_SCALE. Requires a RESOLVER_VERSION bump and golden regeneration. Pin it: no held fight in the
corpus has depth 1024.

S3. **readReplay accepts edited logs; `check` covers only `events`** (replay.ts:155, 429).
Accepted with **no re-seal at all**:
- a unit's `typeId` swapped
- `level` 1→5 with `maxHp` ×10
- a defender relabelled `side: "attacker"`
- a trap moved 3 cells
- `outcome.deepestUnit`
- `resolverVersion` 7→1
- `tickRate` 20→40

Accepted after recomputing the FNV over the rows:
- hit damage ×100 (hp unchanged)
- fence-hit damage ×100
- trap damage ×100
- a hit credited to another attacker
- a `tg` retarget
- an `ab` archetype index change

So "any … edited number … throws ReplayError" (replay.ts header) is false. A renderer would draw
the wrong sprite, the wrong damage number, or the wrong attacker. The server never checks
`log_sha256` on read (routes/replay.ts:49-59), and never checks `row.log_format` /
`row.resolver_version` against the log body.
*Fix:*
1. Fold the envelope, outcome and labels into `check` (or add a second checksum).
2. In the reader, check each `x`/`fh`/`tf` row's `hp` = max(0, previous − damage).
3. Check that a hit's `u` was alive at `t`.
4. In the route, compare sha256(decompressed text) with `row.log_sha256` and with
   `job.result.replay.sha256`; mark `renderable: false` on mismatch.

Add the twelve edits above as `replay.test.ts` cases.

S4. **The app role can rewrite or erase any replay; immutability is UPDATE-only.**
As `caravan_app` (forge.sql):
- `UPDATE` → refused ("immutable").
- `BEGIN; DELETE …; INSERT …(forged log, sha '000…0', raw_bytes 1); COMMIT` → **accepted**.
- `DELETE` of a fresh row → accepted. The route then reports it as 410 "expired".

jobdel.sql: an INSERT naming another caravan, random account ids, and `resolver_version 1` is
accepted for a real job id. Migration 013:14 says "Deletion is the retention prune only", but
nothing enforces it. Also, store.ts:61 `ON CONFLICT (job_id) DO NOTHING` means a row planted
before completion silently replaces the real log.
*Fix:*
- Add a BEFORE DELETE trigger that allows a row only when it is outside the retention rule
  (older than LOG_RETENTION_DAYS and not among the caravan's newest N; pass N as a setting or a
  constant table).
- Add a BEFORE INSERT trigger that requires the job to be `leased` and that `caravan_id` and both
  account ids match `resolution_job`.
- On conflict, raise instead of DO NOTHING.
- Test each as caravan_app.

S5. **`[resolver-bump]` alone lets goldens change with RESOLVER_VERSION unchanged.**
Observed: the same depth change committed with only the tag in the message →
"accepted — commit tagged [resolver-bump]". The regenerated goldens still say
`"resolverVersion":7`, so two different behaviours ship under v7. Stored v7 logs can then no
longer be re-checked against their inputs (the "provably fair" claim). The version test
(scripts/determinism.mjs:91) also counts **any** `+`/`-` line touching `const RESOLVER_VERSION`.
A trailing comment edit or a decrement passes; verified on the regex.
*Fix:*
- Golden **M** or **D** must come with a strictly greater numeric RESOLVER_VERSION (parse old and
  new values).
- Allow the tag only for **A** (new fixtures).
- Add a self-test for the gate with fixture diffs.

S6. **The determinism gate can fail CI with every test passing.**
`determinism.test.ts:47` runs all 72 fights × 100 synchronously in one `it` (59 s under load).
Running the resolver suite alongside `pnpm determinism` gave "Tests 204 passed", then
`Error: [vitest-worker]: Timeout calling "onTaskUpdate"` and **exit 1**
(scratchpad/qa13/resolver-tests-load.txt). The worker's event loop is blocked past vitest's RPC
timeout. On a busy runner this flakes the most important gate.
*Fix:* `it.each` over the scenarios (100 runs each). That keeps every synchronous block to a
few seconds.

## Decisions (orchestrator)

D1. **DEPTH_METRIC saturates. A held fight pays the owner ~84 % on median, and never below ~64 %.**
The data: 82 held fights from the fun probe (realistic circles vs authored bands 0–3):
- held depth min 760, p25 845, median 909, max 1017
- 67 of 82 at ≥ 0.8
- loot share (depth^1.5): 64 % / 76 % / 84 % / 99 %

Why it saturates: depth is measured from each raider's spawn on the edge, about 13 cells out,
and the ring sits about 2.5 cells from the core block. Reaching the fence is already about 0.77
(≈ 67 % loot). "A near-miss is worth meaningfully less than a clear" does not hold. The Maker also
dropped the table's "fence segments broken and posted units killed" terms (a flagged deviation).

Options:
- (a) Measure from the ring line: depth = share of the ring-to-core distance closed, 0 outside
  the ring.
- (b) A steeper curve (d^3).
- (c) Accept as is.

Any change needs a resolver bump.

D2. **Defense is too weak against authored parties.** Real resolver, desert starting types, three
naive layouts (contiguous fence + guard, spread gaps + hold, spread gaps + mixed), 12 authored
parties per band. Held / 36:

| roster | band 0 | band 1 | band 2 | band 3 | band 5 / 7 |
|---|---|---|---|---|---|
| fresh: 3×L1, 2 pits, 20 brush | 6 | 0 | 0 | 0 | 0 |
| early: 5×L1-2, 4 pits | 13 | 7 | 0 | 0 | 0 |
| full early: 8×L2, 6 pits | 14 | 8 | 0 | 1 | 0 |
| mid: 8×L3 incl. 2 sharpshooters, 6 pits, split rail | 18 | 9 | 2 | 4 | 0 |

- **Zero stalemates in all 864 realistic fights (bands 0, 1, 2, 3, 5, 7).**
- At band 3 a mid roster holds 11 %.
- Median end tick is 190–420 (10–21 s of a 180 s cap). Fights are short and mostly lost.

The layouts are naive, so a skilled player will do better. Even so, this is consistent with the
Maker's 53/9/10 corpus and argues for a chunk 37 pass: authored party strength per band vs a
band-appropriate circle, with a target hold rate.

D3. **The content stamp hashes display text** (circle/resolverInput.ts:220-221 hashes whole
`CONTENT.units/traps/fences`, including `displayName`, `flavor`, ability `description`).
hash.probe.ts: a description-only edit changes RESOLUTION_CONTENT_HASH (83fff8c9… → c7959829…).
*Failure:* a copy-fix deploy makes every in-flight encounter throw ContentHashMismatchError.
After 3 attempts (≈ 3 s of backoff) it parks as `resolution_unavailable`, voiding live trips.

Options:
- Hash only fight-relevant fields (the stat projection `toBattlefield` / `toResolverParty` emit,
  minus strings).
- Snapshot the stats into the job input at commit, so there is no hash and no void.

## Nits

N1. 500 instead of `renderable: false` on an undecodable row. routes/replay.ts:49
`JSON.parse(decompressLog(row))` throws on a bad gzip body; the forged row from S4 gives an
unhandled 500.

N2. A parked job answers 409 `not_resolved` forever (routes/replay.ts:45). Return a distinct
code, e.g. `resolution_unavailable`, so the client stops polling.

N3. The replay route runs a full `readReplay` on every GET, synchronously, on the request thread:
50–96 ms for the worst content logs (size.probe.ts). It also returns the raw JSON log, up to
288 KB, with no response compression. Cache the verdict per job id, or verify once at insert and
store a flag. Add compression.

N4. Size (verified): the 100 KB compressed budget holds for content.
- `fullLoadFullLength`: 140 KB raw / 30.2 KB gzip.
- The same with every cooldown at the content minimum (400 ms): 288 KB / 61.4 KB.
- 8 raiders (the real cap) at 400 ms: 180 KB / 38.6 KB.

Input bounds still allow `attackCooldown: 1` ms. At 1 tick per hit that is 2.0 MB raw / 415 KB
gzip, so the budget rests on content, not on input validation. Either tighten INPUT_BOUNDS
(e.g. cooldown ≥ 1 tick × 4), or document it and add a content invariant test (min cooldown vs
budget).

N5. `depthExplained` (routes/replay.ts:31) is player-facing English served by the server. It
says neither that distance is counted from where the raider started nor that loot is depth^1.5.
The owner sees `loot` but cannot derive it. Move the copy to web strings; expose `lootShare`.

N6. `partyLoot` (loot.ts:98-106) accepts any safe-integer `full`. The product
`full × d × root` loses precision above ~8.6·10⁹ (the comment says ≤ 8·10⁹), and nothing enforces
it. Add a bound or use BigInt.

N7. Not tested: a second physical machine. Both runs were on this one container (4 cores):
alone, and under concurrent load.
