# Orchestration log

Plain-English record of the autonomous Maker → QA → fix loop. One entry per chunk
transition. Kept so a session that loses context can resume from the last entry.

## Ground rules used by the orchestrator

- Branch: `roadmap/phase-2-spec` (work continues on it; one commit per chunk state change).
- Local Postgres 16 at `postgres://caravan:caravan@localhost:5432/caravan`
  (test db `caravan_test`). Started with `pg_ctlcluster 16 main start`.
- Toolchain: Node 22, pnpm 10.
- Loop per chunk: Maker builds to `built` → adversarial QA produces a punch list →
  Maker closes the list → QA re-checks → `done`. INDEX.md status column updated at
  every transition.
- Target for "ready for a play test": chunks 01–20 plus Phase 2 chunks 21, 22, 23,
  24, 25, 29 (in-app inbox only), then a final whole-game adversarial pass covering
  fun/playability as well as the guardrails.

## Entries

### 2026-10-11 — Chunk 01 (data model & auth): `not started` → `built`

**Built.** The monorepo scaffold plus the chunk itself.

- Workspace: `pnpm-workspace.yaml`, root `package.json` scripts, `tsconfig.base.json`
  (strict, NodeNext, `noUncheckedIndexedAccess`), `.env.example`.
- `packages/resolver`: empty placeholder (`RESOLVER_VERSION = 0`), zero runtime deps, with
  ESLint flat config enforcing isolation (no non-relative imports, no float literals, no
  bare `/` or `**`, banned `Math.random/sin/cos/atan2/exp/pow/sqrt/...`, banned `Date`,
  `process`, `console`, timers, `fetch`, etc.). `scripts/lint-selftest.mjs` lints a
  violations fixture and an allowed-idioms fixture to prove the rules fire.
- `packages/content`: tunables seed (`REGION_COUNT`, `COIN_STORAGE_CAP`,
  `MAX_CARAVANS_PER_ACCOUNT`, `REPUTATION_START`, merge level bounds) and the four
  placeholder regions. Chunk 03 builds the real registry on top of this.
- `apps/server`: Fastify 5 + `pg`, hand-rolled plain-SQL migration runner
  (`migrations/001_core_schema.{up,down}.sql`), typed repo layer, scrypt password hashing
  (Node built-in), hashed opaque bearer sessions, routes `POST /auth/register|login|logout`,
  `GET /me`, `GET /health`, idempotent seed script.
- Schema: `region`, `account`, `home_town`, `standing_party` (account level);
  `caravan` (keyed by account, no unique on account_id, `state` enum defaulting to
  `in_town`, region immutable via trigger), `pool_progress` (CHECK forces `living` rows
  onto a caravan id and `trap`/`siege` rows onto an account id; BEFORE UPDATE trigger
  refuses any decrease of `ladder_level` or `unlock_points_granted` and any scope change;
  BEFORE DELETE trigger refuses deletion while the owner exists), `unit_instance`
  (caravan-scoped, merge level CHECK 1..5), `session`.
- `apps/web`: placeholder package only.
- `/AGENTS.md` build/test/run section filled in.

**Test command:** `pnpm test` (runs vitest in `apps/server` against
`TEST_DATABASE_URL`, default `caravan_test`; resets the schema first). 5 files, 39 tests
passing: migrations up/down/up, split constraints (direct violating inserts refused),
permanence (DB refuses ladder/unlock-point decrements and row deletion; repo exposes no
decrement), multi-caravan readiness (second caravan inserted directly; v1 service refuses
it), auth flow. Also `pnpm lint` (resolver rules + self-test) and `pnpm typecheck`.

**Assumptions made:**
- Regions seeded as a lookup table (`region`) rather than an enum so names can be tuned;
  a test asserts the table matches `REGIONS` in `@caravan/content`.
- `account.coin_balance <= coin_storage_cap` is a CHECK constraint, per PROJECT.md §14
  ("accumulation, whether earned or bought, can't run unbounded"). Chunk 16 may relax if
  the cap is meant to bound only the trickle.
- No `trip`/purchase tables yet (chunks 15 and 20); `caravan.state` is the only trip-
  related field this chunk adds. No persistent defensive layout anywhere, by design.
- Seed unit instances use clearly marked `placeholder.<region>.<name>` type ids until
  chunk 03 defines real unit types.
- `unlock_points_spent` exists now (bounded by `unlock_points_granted`) so chunk 05 has a
  column to spend against without a migration; nothing writes it yet.

**Next:** hand to adversarial QA against GUARDRAILS §5 and the chunk's checklist.


### 2026-10-11 — Chunk 03 (content data & tunables): `not started` → `built`

**Built.** `packages/content` is now the full content pool plus the registry; nothing else
in the repo touched except the server seed's placeholder unit ids and this log.

- `fixedPoint.ts` — THE one scale: `FIXED_POINT_SCALE = 1024` (1/1024 cell, 1/1024 of a
  multiplier) for every fractional quantity; durations are whole milliseconds. Authoring
  helpers (`fp`, `fpMilli`, `fpRatio`, `seconds`, `ms`) take integers only and throw on
  anything else, so no float literal appears in any content file.
- `tunables.ts` — every constant from the chunk 03 brief plus the chunk 11/12 ability and
  trap-effect defaults and chunk 07's slot caps, each commented TUNABLE (or "fixed by
  design") with what would drive a change. Merge curve authored as a table.
- Data: 32 living units (8 per region: desert, high plains, mountain, badlands), 6 traps,
  5 siege pieces, 4 fence tiers, the 3×3 affinity matrix (Grit > Powder > Beast > Grit).
  Each unit: independent offense/defense ratings, HP, speed (cells/s), range, attack
  cooldown, aggro, leash, and exactly one ability from the six archetypes. Every type has an
  Old West name and one-line flavour; settler / outlaw / frontier-industry / animal only.
- `validate.ts` runs at import: counts vs. registry, dangling category refs, bounds,
  reachability (aggro ≤ leash + range), healer charges pinned to the registry bound, no stray
  ability fields (a smuggled `procChance` is rejected), every fence/trap category countered
  exactly once.

**Test command:** `pnpm --filter @caravan/content test` — 2 files, 34 tests passing.
Covers: merge curve below the components-combined line for both recipes at every level;
offense/defense not a fixed ratio (Pearson r = −0.15, ratios 0.47–2.81); no two unit types
share a stat block; regions differ in affinity/archetype/aggro-leash profile; exactly one
ability per type and all six archetypes used; affinity matrix complete and antisymmetric;
every siege piece counters exactly one category and every category is countered; every
number in the exported data is a safe integer; a source grep of `packages/content/src`
for float literals, bare `/`, `**` and banned Math calls (verified to fire on a planted
`1.5`). Also `pnpm typecheck` and `pnpm lint` clean repo-wide.

**Assumptions / deviations made:**
- **`MERGE_STAT_MULT_PER_LEVEL` is ×1.6, not the brief's ×1.8.** The brief's own QA check
  asks for both recipes; ×1.8 passes 2→1 (1.8 < 2) but fails 5→3 (3 × 1.8 = 5.4 > 5), so the
  large recipe would have been a net power gain. ×1.6 keeps both below the line
  (1.6 < 2, 4.8 < 5). Flagged in the registry comment, with the HP×DPS-squared caveat.
- Durations are integer milliseconds rather than fixed-point seconds, so 0.4 s survives the
  resolver's ms → ticks conversion exactly. Still "seconds, not ticks" in the brief's sense;
  a test asserts no key mentions ticks.
- Trap classes are `groundwork` / `powder` and fence classes `timber` / `wire` / `stone` —
  five categories so the brief's default of 5 siege types counters each exactly once.
  Traps deal damage of their own affinity (groundwork → Grit, powder → Powder), which is
  how trap classes enter the affinity layer.
- Ranged sentries may have aggro > leash (they shoot what they notice); the validator's
  reachability rule is `aggro ≤ leash + attackRange`.
- Server tests were run against `caravan_test_c03`; 49–51 of 54 pass with failures moving
  between runs in files chunk 02 / the QA-01 pass are editing concurrently
  (`ledger`, `caravans`, `qa01-guards`). The only server file this chunk changed is
  `src/seed.ts`, and the server typechecks.

**Next:** hand to adversarial QA against GUARDRAILS §1/§2 and the chunk's checklist —
especially the merge curve under an HP×DPS metric and whether affinity does enough work.

### 2026-10-11 — Chunk 01 (data model & auth): QA round 1 closed (items 1–3, 9–17)

**Closed** against `roadmap/qa/01-punchlist.md` (commit c1ce47e). Items 4–8 (resolver
lint evasions) stay with the chunk 21 Maker, who owns `eslint.config.js`.

- **1** `BEFORE TRUNCATE` statement triggers refuse TRUNCATE on `pool_progress` and
  `caravan`; `test/helpers.ts` wipes with `DELETE FROM account` (cascades through the row
  guards legitimately).
- **2** `caravan_guard_delete`: a caravan cannot be deleted while its account exists (it
  owns the living ladder); still cascades away with the account.
- **3** Two DB roles. `apps/server/db/roles.sql` (idempotent, applied by `db:migrate`/
  `db:reset`/`migrate.ts roles` and by the test global setup) creates `caravan_app`, a
  non-superuser DML-only login role with default privileges for future tables. The server
  runs as it (`DATABASE_URL`); migrations use the owner (`MIGRATE_DATABASE_URL`, falls
  back to `DATABASE_URL`). Documented in `.env.example` and AGENTS.md. Tests connected as
  `caravan_app` prove `ALTER TABLE ... DISABLE TRIGGER`, `TRUNCATE`, `DROP`, `CREATE` and
  touching `schema_migrations` are all refused (42501) while the guards still bite through
  it, and that a table the owner creates later is covered by the default grants.
- **9** `PASSWORD_MAX` 128; `caravanName` trimmed, 1–40 chars, no control characters.
- **10** Login verifies against a fixed dummy scrypt hash when the username is unknown
  (test asserts the unknown path costs at least half the known path).
- **11** Authorization must match `/^Bearer\s+(\S+)$/i`; trailing tokens are rejected.
- **12** Issuing a session purges that account's expired rows and caps live sessions at
  `SESSIONS_PER_ACCOUNT_MAX` (10), oldest evicted.
- **13** `unlock_points_spent` may never decrease (permanence trigger).
- **14** `CHECK (length(unit_type_id) > 0)`; migration comment states the one-living-row-
  per-caravan invariant is app-enforced until chunk 04.
- **15** Comment at `account_coin_within_cap`: it is a hard CHECK, credits must clamp first.
- **16** Migrations sorted by parsed numeric id; duplicate ids rejected (unit-tested).
- **17** Comment at the bigint type parser: lossy above 2^53, chunk 02 must pick per column.

**Verified:** `pnpm test` in `apps/server` against `caravan_test_qa01`: 7 files, 81 tests
passing (includes chunk 02's in-flight `ledger.test.ts`). `pnpm typecheck` clean.
`pnpm lint` passes (resolver self-test). Applied `roles.sql` to the dev `caravan` database
so the new `DATABASE_URL` default works.

**Not done / notes:** no `db:roles` package script was added because `apps/server/package.json`
carries chunk 02's uncommitted edits; the long-form `pnpm --filter @caravan/server exec tsx
src/db/migrate.ts roles` is documented instead (one-line follow-up for whoever next touches
that file). `caravans.test.ts` was adjusted to undo its direct second-caravan insert by
transaction rollback, since a caravan can no longer be deleted directly. Chunk 01 stays
`built` in INDEX.md until items 4–8 close.
### 2026-10-11 — Chunk 21 (build, CI, deploy pipeline): `not started` → `built`

**Built**, in parallel with the chunk 01 fixes and chunks 02/03.

- `.github/workflows/ci.yml`: on every push and PR — pnpm install (frozen lockfile),
  `typecheck`, `lint` (resolver rules + self-test), `test:boundary`, `test` against a
  `postgres:16` service container, `determinism`, `build`, migrate the test DB, smoke-run
  the built server (`GET /health`), upload `apps/server/dist` as an artifact. `pnpm ci`
  runs the same sequence locally. `.nvmrc` (22) and `.editorconfig` added.
- `scripts/resolver-boundary-check.mjs` (`pnpm test:boundary`): zero-dependency check that
  `packages/resolver` has no dependencies (devDependencies limited to an explicit tooling
  allowlist), its tsconfig keeps `rootDir`/`include` on `src` with `types: []` and no
  `paths`, every specifier in src is relative and resolves inside src, nothing names
  apps/content/billing-shaped modules, no `/// <reference>`, no `import.meta`.
- `scripts/determinism.mjs` (`pnpm determinism`): runs `@caravan/resolver`'s `determinism`
  script when it exists (reports PENDING until chunk 13); then, with a base ref (PR base or
  push `before` sha), fails if anything under `packages/resolver/golden/` changed without a
  `RESOLVER_VERSION` change or a `[resolver-bump]` commit tag. Verified in a scratch clone:
  unbumped change fails, tag or version bump passes, null-sha and no-base cases skip.
- `scripts/build.mjs` (`pnpm build`): esbuild bundles `apps/server/src/{index,db/migrate,seed}.ts`
  to `apps/server/dist/` at the same depth as src (so `migrate.js` still finds
  `apps/server/migrations`), inlining workspace packages and leaving npm deps external.
  `pnpm start` runs it; `scripts/smoke-server.mjs` (`pnpm smoke`) proves it answers.
  One root devDependency added: `esbuild@0.28.2` (the version tsx already pins).
- Resolver lint hardened (`packages/resolver/eslint.config.js`), closing QA-01 items 4–8:
  relative imports through apps/packages/content/server/billing segments; `Number()`,
  unary `+`, `JSON`, `parseInt`, `Infinity`, `NaN`, `DataView`/`getFloat*`, `Float*Array`;
  aliasing/destructuring/computed/optional access on `Math`/`Number`; string-keyed computed
  access anywhere; `eval`, `Function`, `Reflect`, `Proxy`, `WeakRef`, `.constructor`;
  `globalThis`/`self`/`global`, `import.meta`, ambient `declare`, `import()` types; async/
  await/Promise; `with`, `debugger`; `sort()` without a comparator. `(a / b) | 0` no longer
  exempt. `Map`/`Set`/`WeakMap`/`WeakSet` banned outright (dead for-of rule removed). Rules
  now cover `src/**/*.{ts,mts,cts,js,mjs,cjs}`. Self-test derives expectations from the
  fixture (every line from 3 on must error; 66 lines), plus `with.ts`, `violations.mjs`,
  and a glob probe per extension.

**Not done, by design:** staging/production deploy and the migration rehearsal against a
production snapshot — no hosting target exists yet. The workflow header says where the
deploy job goes.

**Observed while verifying:** `pnpm test` currently fails in `packages/content` (chunk 03's
validator rejecting its own data) and in `apps/server/test/jobs.test.ts` (chunk 02); both
are in-flight work in the shared tree, not CI issues. The chunk 01 suite plus
`qa01-guards.test.ts` (97 tests) pass. Root `.gitignore` ignores `*.log`; chunk 13 must
not name golden files `.log` (noted in `scripts/determinism.mjs`).

**Next:** hand to adversarial QA (smuggle a float via a dependency; read an env var from
inside the resolver).


### 2026-10-11 — Chunk 02 (event ledger & job queue): `not started` → `built`

**Built.** Migration `apps/server/migrations/002_ledger_and_jobs.{up,down}.sql`, modules
`apps/server/src/ledger/*` and `apps/server/src/jobs/*`, route `GET /me/ledger`, and the
`pnpm --filter @caravan/server ledger:rebuild` command.

- **Ledger** (`ledger_event`): append-only at the storage layer — a BEFORE UPDATE trigger
  refuses every update, a BEFORE DELETE trigger refuses deletes while the account exists
  (rows leave only by account cascade). All 21 event types from the brief are a Postgres
  enum. The account/caravan split is a CHECK: coin/standing-party events must have no
  caravan id, roster/trip/encounter events must have one, and reputation/ladder/unlock
  events take their scope from `payload.pool` exactly as `pool_progress` does (missing
  pool = CHECK violation). Resolution events (`encounter_resolved`, `stop_resolved`,
  `party_served_as_encounter`) must carry `resolver_version`. `(causation_id,
  causation_seq)` is unique — the idempotency backstop. Appends for one account are
  serialized by a transaction-scoped advisory lock, so per-account seq order == commit order.
- **Projections**: `account.coin_balance` and the `pool_progress` numbers are maintained by
  an AFTER INSERT trigger on the ledger — the only writer of those columns. The same fold
  exists in TypeScript (`projection.ts`); `verifyProjection` / the `ledger:rebuild` CLI
  replay from zero and compare. `ledger_snapshot` checkpoints (interval tunable) are exact
  because they're written under the same per-account lock. Coin credits are clamped to the
  storage cap inside the append transaction and the event records `overflowDiscarded`.
- **Job queue** (`resolution_job`): deterministic ids (`encounter:<tripId>:<n>`), idempotent
  enqueue (`ON CONFLICT DO NOTHING`), lease via `FOR UPDATE SKIP LOCKED` oldest-first,
  completion = handler events + job completion in ONE transaction under a per-caravan
  advisory lock (`TRIP_LOCK_MODE`). Handlers are pure `(input) → {events, result}`.
  Failure → `queued` for retry, `parked` at `JOB_MAX_ATTEMPTS`; an expired lease is
  re-leasable. Completion is "first valid completion wins" guarded by the job row lock +
  status check; the attempt counter fences only failure bookkeeping. Nothing ticks:
  `runOnce` / `drain` are explicit calls. Completed jobs and every job's `input` are
  immutable (trigger). `verifyJobReplay` re-runs a completed job's handler on its stored
  input and byte-compares with the committed stream.
- **Snapshots**: `enqueueEncounterResolution` freezes the committed formation and the
  standing party (owner id, `updated_at` as `savedAt`, composition placeholder) into the
  job input and emits `formation_committed`. The encounter handler is a clearly marked
  placeholder (`outcome.kind = "placeholder_unresolved"`) that emits `encounter_resolved`
  (defender, caravan-scoped, with both snapshots) and `party_served_as_encounter` (owner,
  account-scoped) stamped with `RESOLVER_VERSION`; chunk 13 replaces its body.

**Test command:** `cd apps/server && TEST_DATABASE_URL=postgres://caravan:caravan@localhost:5432/caravan_test_c02 npx vitest run`
— 9 files, 104 tests passing (run 4× for flakiness, all green). New: `test/ledger.test.ts`
(15), `test/jobs.test.ts` (18), `test/concurrency.test.ts` (4: one party served into 12
concurrent encounters by 4 workers with the party byte-identical afterward; 40 jobs for one
account over two caravans by 6 workers with Coin == sum of log and events contiguous per
job; 24 jobs with 5ms leases and 20–40ms handlers under 5 workers with every job committing
exactly once). Also `pnpm typecheck` in `apps/server`, and
`DATABASE_URL=...caravan_test_c02 pnpm --filter @caravan/server ledger:rebuild` → 15 accounts, 0 mismatches.

**Assumptions made:**
- Registration (chunk 01) does not write ledger events; "rebuild from zero" starts from
  Coin 0 and `REPUTATION_START` per pool. Chunk 04 may switch to an initial event.
- `coin_lost_on_wipe` is caravan-scoped and has no balance effect (unbanked trip Coin was
  never in the account balance); `coin_transferred_to_defender` is written on the
  *receiving* account as a credit. The brief's name reads oddly for an inverted game (the
  receiver is the raiding party's owner per PROJECT.md §loss); kept the name as the
  contract and documented it. Chunk 19 should confirm.
- `ladder_progress_gained` carries `{pool, pointsDelta, levelsGained}` so chunk 04 can
  reset points on a rung crossing with a negative delta; the DB still refuses any level decrease.
- Chunk 02 tunables live in `apps/server/src/jobs/tunables.ts` with `TODO(chunk-03)`.
- `apps/server` now depends on `@caravan/resolver` (workspace link) for `RESOLVER_VERSION`.
- A lease shorter than a handler's runtime is a misconfiguration the queue tolerates
  (still exactly-once) but does not optimize; `JOB_VISIBILITY_TIMEOUT_MS` should exceed
  resolver runtime once chunk 13 lands.
- Standing-party snapshot shape is `{ownerAccountId, savedAt, composition: {}}` until
  chunk 09 adds composition; the formation snapshot is `{fences, traps, posts}` until chunk 07.

**Next:** hand to adversarial QA against GUARDRAILS §1/§5 and the chunk's checklist
(race conditions, idempotency after partial commit, immutability, scope on every event).

### Orchestrator note — commit 45c04b3 carries chunk 02

Commit `45c04b3` ("Chunk 01 done") was made by the orchestrator while chunk 02's Maker
had its files staged in the shared index, so it also contains the whole of chunk 02
(ledger, projections, job queue, migration 002). The Maker amended the message locally,
but the original had already been pushed and history is not rewritten on this branch, so
the pushed message stands and this note is the correction. Lesson applied from here on:
the orchestrator commits only via `git commit <explicit paths>` with `--only`.

### 2026-10-11 — Chunk 16 (economy: Coin and merges): `not started` → `built`

**Built.** `apps/server/src/economy/{coin,trickle,merge,index}.ts`, route module
`apps/server/src/routes/economy.ts` (registered in `app.ts`, append-only), tunables added to
`packages/content/src/tunables.ts` (chunk 16 section only; the file was concurrently edited
by chunk 03 QA and chunk 07 — this commit stages only the chunk 16 hunk). No migration.

- **Earn paths** (`economy/coin.ts`): pure integer schedule `coinForEncounter(n)` =
  400 × 1.25^(n−1) floored per step (400, 500, 625, 781, 976, 1220, …); `creditBankedTrip`
  writes one `coin_earned{reason:"encounter_survived"}` per survived encounter plus
  `{reason:"trip_banked"}` 500; `creditPartyWin` writes `{reason:"party_win"}` 300 to the
  standing party's OWNER (never present, risks nothing). All go through `appendCoinCredits`,
  which reads the room ONCE under the account append lock and consumes it credit by credit, so
  a batch cannot overshoot the cap the way two independently clamped `coinCreditDraft`s could.
  Every clamped event records `overflowDiscarded`. `overflowForecast(balance, cap, earn)` is
  the pre-trip warning data (`GET /me/economy?prospectiveEarn=N` → `overflow.warn`).
- **Trickle** (`economy/trickle.ts`): no background tick. `computeTrickle` is pure: whole
  coins every `COIN_TRICKLE_MS_PER_COIN` (18 000 ms = 200/h), accrual point advances only by
  the time those coins consumed (remainder carried) → read-frequency independent. The accrual
  point is the last trickle event's `accruedThroughMs` (else account `created_at`): ledger-
  derived, no column. At the cap the coins are written as `amount:0, overflowDiscarded:N` and
  the point jumps to now, so idling at the cap never banks a backlog. Causation id
  `trickle:<account>:<fromMs>` makes a window unrepeatable; concurrent reads serialize on the
  account lock and the second sees the new point. The wall clock enters in exactly one place
  (`accrueTrickle`'s default `nowMs`); every function takes `nowMs` injectable.
- **Merge** (`economy/merge.ts`): recipes from `TUNABLES.MERGE_RECIPES` (2→1, 5→3), selected
  by input count; cost `MERGE_COST_BY_TARGET_LEVEL[target] × produce` (L2 250, L3 900, L4
  3000, L5 9500 per resulting unit); cap 5 from content, refused with `merge_cap`.
  `previewMerge` (read-only) returns cost, balance, affordability, consumed/produced counts
  and slots, per-unit and combined stats (HP and reference hit by content's multiplier;
  ratings shown unchanged per chunk 03 QA's `MERGE_MULT_APPLIES_TO`), and the ability
  (same one, no new ability). `performMerge` is one transaction: account append lock →
  trickle accrual (so the balance checked is the balance shown) → `FOR UPDATE` on the inputs
  → ownership/type/level/recipe/cap validation → `insufficient_coin` (409) → DELETE inputs
  (row count must equal `spend`) → INSERT outputs → `coin_spent` + `unit_merged` under
  causation `merge:<caravan>:<sorted ids>`. No multiplier is applied in economy code.

**Test command:** `cd apps/server && TEST_DATABASE_URL=postgres://caravan:caravan@localhost:5432/caravan_test_c16 npx vitest run`
— 13 files, 162 tests passing (includes chunk 04's and chunk 07's in-flight files). Chunk 16:
`economy-guards.test.ts` (17) and `economy.test.ts` (17). Proven: no credit path past the cap
(banked trip near cap, party win at cap, 12 concurrent writers, direct DB overshoot refused
by CHECK); trickle idempotent (60 irregular reads == one read; 8 concurrent reads credit one
window once; ceases at cap; resumes from last read after a spend); recipe arithmetic;
merged strength (HP × hit) < consumed for every unit type, every roster defense, both
recipes, every level; merge cost charged exactly once with 6 racing merges of the same
instances (1 success, 5 × 404, one `coin_spent`); insufficient Coin leaves roster and
ledger untouched; cross-account/caravan inputs refused; HTTP preview/commit flow; a source
scan of `src/economy/*` and `routes/economy.ts` for entitlement/billing/pack vocabulary and
`coin_purchased`, and that every `account` read names only Coin columns or `created_at`.
`pnpm typecheck` in `apps/server` is clean for chunk 16 files (one error in chunk 04's
in-flight `test/progression-pure.test.ts`, not mine). Content tests (34) still pass.

**Grind wall (QA asked to check, not infer):** one L5 unit from sixteen L1 via 2→1 costs
21 100 Coin (8×250 + 4×900 + 2×3000 + 9500). Trickle alone: ~105 h (4.4 days) of wall-clock
idling. Active: a 5-encounter banked trip pays 3 782 (3 282 + 500), so ~6 banked trips.
The 5→3 recipe at L5 costs 28 500 for three L5 units — also under the 50 000 cap, so no
merge is unreachable because of the cap. Whether 6 trips feels optional-paid is a play-data
question; the numbers are all in TUNABLES.

**Assumptions made:**
- Per-encounter Coin is unbanked trip state (chunk 15's) until the trip banks; it enters the
  account balance only via `creditBankedTrip`. There is deliberately no immediate
  per-encounter credit, because the bounded-stakes rule says that Coin is at risk until
  banked. Chunk 19's `coin_transferred_to_defender` should size the transfer from
  `coinForEncountersSurvived(n)` and clamp via `appendCoinCredits`-style room logic (the
  ledger's `coinCreditDraft` is fine for a single credit).
- The merge preview's stats follow chunk 03 QA's revised semantics (multiplier on max HP and
  damage output only, ×1.25/level). If chunk 11 applies it differently, the preview must
  follow chunk 11, not the other way round.
- `GET /me/economy` has a write side effect (materializing the trickle). That is the design:
  reading the balance IS the accrual; there is no other moment.
- The trickle at the cap writes `amount: 0` events at most once per 18 s of reads. Accepted
  as the price of keeping the accrual point in the ledger rather than a column.
- `MERGE_COST_BY_TARGET_LEVEL` is indexed by target level with `[0, 0, …]` padding so index
  == level, matching `MERGE_STAT_MULT_BY_LEVEL`'s convention.
- Chunk 17 (home town) is expected to call `accrueTrickle` for the mine and
  `previewMerge`/`performMerge` for the merge board; the API is already shaped for the UI
  (cost, slots, stats, ability all in the preview).

**Next:** hand to adversarial QA against GUARDRAILS §2 (grep the economy for anything
reading what an account has paid for; try to overshoot the cap with a trickle racing a
party win racing a bank), §4 (is every number the preview shows the number the ledger
records?), §5 (Coin account-level, roster caravan-level — the tests assert the event scopes),
and the trickle's read-frequency independence under adversarial clocks.

### 2026-10-11 — Chunk 03 (content data & tunables): QA round 1 closed (B1, S1–S7, N1–N5; N6 noted)

**Closed.** All in `packages/content` except S6 (one comment in `apps/server/src/jobs/tunables.ts`)
and S7 (new `apps/server/test/qa03-merge-cap.test.ts`). No other server file touched.

- **B1 — merge multiplier semantics CHANGED (consumers: chunk 16, chunks 07/11/12).**
  `TUNABLES.MERGE_STAT_MULT_BY_LEVEL` is now `[0, 1024, 1280, 1600, 2000, 2500]` (×1.25 per
  level, exact; L1..L5 = 1.0, 1.25, 1.5625, 1.953, 2.441) and it applies **linearly to max
  HP and to post-formula damage output only** — `hp = scaleInt(type.hp, mult)` and
  `hit = scaleInt(floor(o²/(o+d)), mult)`. It is **never** applied to the offense/defense
  ratings that enter the formula; ratings are the unmerged type values at every level.
  Declared as data: `MERGE_MULT_APPLIES_TO: ["hp", "damage_output"]`,
  `MERGE_MULT_NEVER_APPLIES_TO: [offense, defense, moveSpeed, attackRange, attackCooldown,
  aggroRadius, leashDistance, ability]`, `MERGE_MULT_PER_LEVEL` (1280), and
  `MERGE_EFFECTIVE_CEILING` (5/3: the 5→3 recipe demands k² < 5/3). Key names kept;
  `mergeStatMult(level)` unchanged in signature (packages/circle's `scaleInt(type.hp,
  mergeStatMult(level))` is exactly the intended HP use). `invariants.test.ts` now computes
  effective strength = HP × actual damage per hit (floor on the formula, floor on each
  fixed-point scale, every affinity outcome) for every unit type in both roles against every
  roster opponent, and asserts produced < spent at every level for both recipes: 36,864
  checks. Theoretical worst 3k²/5 = 0.9375; rounding-inclusive worst 0.982 (the roster's
  smallest hit, o=40 vs d=120 at disadvantage = 7 damage, floors to 13/10 and 17/13 instead
  of 1.25 at L3→L4 / L4→L5). Still strictly < 1 everywhere; the margin is pinned at < 0.99.
- **S1** — no ability field scales with merge level: sentence removed from abilities.ts,
  declared as `MERGE_MULT_SCALES_ABILITY_FIELDS: false`, tested.
- **S2** — `deepFreeze` (new `freeze.ts`) on every export: CONTENT, the four type arrays,
  TUNABLES, AFFINITY_MATRIX, REGIONS, REGION_IDS, the category/archetype lists. A test asserts
  `isDeepFrozen` on each and that assignment / push / pop throw TypeError.
- **S3** — key whitelists on unit, trap, trap.effect (per kind), siege, siege.counters,
  fence, ability; a test smuggles `critChance` onto each shape and expects the exact message.
- **S4** — healers are four chassis: Canteen Carrier = fast melee water-runner (2.2 c/s,
  Grit); Prairie Doctor = **mounted** circuit rider (Beast, range 1.5, 2.0 c/s, aggro 4,
  leash 6); Mountain Apothecary = slow wide-radius dispenser (0.9 c/s, def 70, radius 3, 16 s);
  Snake-Oil Peddler = **ranged** bottle-thrower (Powder, range 2.5, aggro 4.5). Metric for the
  new test: 8 min-max-normalised stats + one affinity dimension, Euclidean; every unit's
  nearest cross-region neighbour must be ≥ 0.10 (roster minimum is now 0.206,
  Shotgun Messenger ↔ Powder Thief); the healers are pairwise ≥ 0.65.
- **S5** — traps.ts authors no effect literal (all `TUNABLES.TRAP_*_DEFAULT`); healer
  fields equal to a default reference `TUNABLES.HEAL_*` / `HEAL_CHARGES_PER_BATTLE`.
  `TUNABLES.PER_TYPE_OVERRIDABLE_DEFAULTS` lists the 18 reference-default keys; a source
  test enforces the rule on traps and healers.
- **S6** — TODO replaced with a one-line "infra knobs stay server-side" comment.
- **S7** — server test pins `CHECK (merge_level BETWEEN 1 AND 5)` to
  `MERGE_LEVEL_MIN/MAX` in the migration text AND the live `pg_get_constraintdef`, and
  proves the DB refuses MAX+1 / MIN−1 and accepts both ends.
- **N1** key name fixed. **N2** `fpMul`/`scaleInt` assert every argument (tested).
  **N3** test: every digit in an ability description is one of that ability's authored
  values (fixed → 2 dp, fractions → %, ms → s) and healers state their charge count.
  **N4** `FENCE_CATEGORY_COUNT: 3`, `TRAP_CATEGORY_COUNT: 2`; validator and test assert
  `SIEGE_TYPES` equals their sum. **N5** comment: adv × disadv ≠ 1 exactly, intentional.

**BALANCE-NOTES (N6, for chunk 37 — no change now):** Grizzly is the top attacker by ~25 %;
the five best attackers are all Beast; Blasting Crew and Buffalo Hunter are weak in both
roles. Re-check after the B1 semantics change, since effective strength is now rating-linear
on the formula side rather than ×1.6-compounded, and after chunk 11's affinity test.

**Verification (real output):** `pnpm --filter @caravan/content test` — 2 files, 44 tests
passing (was 34). `cd apps/server && TEST_DATABASE_URL=...caravan_test_c03 npx vitest run
test/qa03-merge-cap.test.ts` — 1 file, 3 tests passing. `pnpm lint` — resolver lint +
self-test pass. `pnpm test:boundary` — pass. `pnpm typecheck` — content, resolver and circle
clean; `apps/server` fails only in the untracked, in-progress `test/circle.test.ts` (chunk 07's
Maker: Fastify `inject` typings), which is not part of this round — `apps/server/src` and the
new S7 test typecheck clean.

**Concurrency note:** chunks 07 and 16 had uncommitted hunks in `tunables.ts` and
`ORCHESTRATION.md` while this closed. This commit stages only this round's hunks of those two
files (HEAD + mine), so their additions remain in the working tree for their own commits.
`roadmap/INDEX.md` was also dirty from another Maker and was left alone — chunk 03's status
row still reads `built`; the orchestrator moves it to `QA'd`/`done`.

### 2026-10-11 — Chunk 04 (ladders & Reputation): `not started` → `built`

**Built**, concurrently with chunks 07 and 16 in the same tree. New files only, plus
append-only edits: `apps/server/src/progression/{ladder,reputation,outcome,view,index}.ts`,
`apps/server/src/routes/progression.ts` (registered in `app.ts`), migration
`003_unlock_grant_once.{up,down}.sql`, tests `progression-pure.test.ts` (21) and
`progression.test.ts` (17), and a "Chunk 04" block in `packages/content/src/tunables.ts`
(only that hunk is staged in this commit; the file carries chunks 07/16's edits too).

- **Pure core.** `ladder.ts`: cumulative `LADDER_POINTS_TO_RUNG` table (floor(100·n^1.5),
  authored integers), `advanceLadder` is monotone by construction (no subtraction exists),
  reports rungs crossed so each is granted once; `UNLOCK_POINTS_BY_RUNG` 1×10 + 2×10 = 30.
  `reputation.ts`: `gapScaledDelta(base, self, opponent)` — integer-only clamped linear
  ramp ×(1 ± gap/400) in fixed-point, clamp [×0.25, ×2]; `applyFloor` at 100 records the
  clamp. `outcome.ts`: `deriveProgressionEvents(snapshot, input)` → ordered drafts;
  `applyEncounterOutcome(client, causationId, input)` takes both account append locks
  (sorted) before reading, idempotent on causation id. Input: `{outcome, caravan:
  {accountId, caravanId, poolsUsed}, party: {ownerAccountId, poolsUsed}}`.
- **Where things land.** Caravan: living Reputation (caravan row, always — its matchmaking
  rating), trap Reputation (account row, when fielded), living/trap ladder when fielded.
  Party: siege Reputation (owner's account row, always — the party's matchmaking rating),
  siege ladder when fielded. The split is in the drafts' scopes and re-checked by the
  ledger CHECK. Storage backstop: unique index on `(pool, account, caravan, rung)` over
  `unlock_points_granted` events.
- **Endpoints.** `GET /me/progression` (per pool: scope, rating, level, points, next rung
  cost and grant, unlock points granted/spent/available), `GET /me/progression/events`
  (own history, pool filter, seq cursor), `GET /progression/rules` (public: whole curve,
  every per-outcome number, which pool is each side's matchmaking rating).

**Test command:** `cd apps/server && TEST_DATABASE_URL=postgres://caravan:caravan@localhost:5432/caravan_test_c04 npx vitest run`
— 14 files, 177 passing, 2 failing in `migrations.test.ts`, both caused by chunk 07's
uncommitted `004_wagon_circle` tables (`wagon_formation`, `wagon_manifest`), not by this
chunk (003 adds an index only). Chunk 04's 38 tests cover: level never decreases over
10 seeds × 2000 random outcomes per side and over a 100-encounter DB sequence ending in a
40-overrun wipe streak; every rung crossed once, grants sum to 30 per pool at cap, then
nothing; replay of the same causation appends nothing; two racing resolutions crossing the
same rung grant once; rebuild-from-zero == live for every account touched; gap scaling pure
and integer over a 2 × 3 × 79 × 55 sweep; loss gain > 0 and < every win gain; no mutating
route under progression, no `SET reputation` anywhere in src, `reputation_changed` produced
only by `progression/outcome.ts`. `pnpm lint` clean; `@caravan/content` 44 tests pass
(tunables still float-free); server typecheck clean apart from chunk 07's in-flight
`routes/circle.ts`.

**Assumptions made:** listed under "Build notes" in `chunks/04-ladders-and-reputation.md`
(matchmaking rating = caravan living vs. owner siege; party living units earn no ladder;
cumulative points; stalemate = held for the caravan; gap scaling on all four deltas;
self-encounter refused). Registration still writes no initial event (chunk 02's zero
state stands). Chunk 13's handler is pure, so it should call `applyEncounterOutcome`
from the completion transaction (or `deriveProgressionEvents` with state in its input);
causation id helper `progressionCausationId(jobId)`.

**Next:** hand to adversarial QA against GUARDRAILS §3/§5 and the chunk checklist —
especially the sandbagging shape of the ramp and whether siege-as-party-rating reads right.

### Maker note — commit 3137656 (chunk 03 QA round 1) dropped chunk 16's registry keys; restored in 0b1d787

While closing the chunk 03 punch list, chunk 16 committed `6a33390` (adding its `COIN_*`,
`MERGE_COST_BY_TARGET_LEVEL` and `COIN_OVERFLOW_BEHAVIOR` keys to `tunables.ts`) between
this Maker's read of the file and its commit. The "stage only my hunks" step was built from
that earlier read, so `3137656` removed those nine keys from the committed tree (the working
tree always had them; chunk 16's server code imports them, so `3137656` and the chunk 04
commit on top of it, `dbb7a11`, do not typecheck in `apps/server`). `0b1d787` puts the block
back exactly as `6a33390` authored it; from there HEAD carries every key from chunks 03, 16
and the QA round. For the same reason `3137656` also carries chunk 04's
"`not started` → `built`" entry in this log, appended here after the QA entry before the
blob was built. History is not rewritten on this branch, so this note is the correction.
Lesson: a reconstructed blob of a shared file must be built from the parent commit resolved
at the moment of staging, and re-checked against it, not from an earlier read.

### 2026-10-11 — Chunk 07 (wagon circle model): `not started` → `built`

**Built.** A new pure workspace package plus its server-side persistence and validation.

- `packages/circle` (`@caravan/circle`; only dependency `@caravan/content`; no I/O, clock,
  randomness or floats — a source grep test enforces the same rules as content):
  - `lattice.ts` — the 32×32 placement lattice; `cellCenter` is THE lattice→continuous
    conversion (cell × `FIXED_POINT_SCALE` + half a cell), defined once for the resolver
    to reuse; one Euclidean metric compared squared (`distSq`, `fixedSq`); the fixed 3×3
    core at the centre (cells 14..16); the fence ring as the square of cells at Chebyshev
    radius 4 round the core centre = exactly 32 segments, walked clockwise from the
    north-west corner, each tagged with the edge it faces; four entry edges with 2-cell
    bands; a BFS reachability helper for tests. Import-time assertion that the tunables
    are coherent (`8 × radius == PERIMETER_SEGMENTS`, budget < ring, ring clear of core
    and entry bands).
  - `manifest.ts` — the trip-locked loadout: `packManifest` enforces `DEPLOYMENT_SLOT_CAP`,
    `TRAP_SLOT_CAP`, `FENCE_MATERIAL_BUDGET` and the access seam, derives starting state
    from content (unit hp = type hp × merge multiplier; fence hp = tier hp), returns every
    issue at once, and deep-freezes the result. No add/resupply/heal function exists (a
    test greps the exports).
  - `formation.ts` — the per-encounter arrangement, referencing manifest entries by ref:
    `validateFormation` checks ref existence and usability (alive / unspent / intact), no
    duplicate refs, every living unit posted, ring positions distinct, cells on the lattice
    and off the ring, core and entry bands, no two objects on one cell, `MIN_POST_DISTANCE`,
    and the access seam again at the placement boundary. Gaps are never an issue;
    `formationGaps` reports them for the UI.
  - `attrition.ts` — `applyEncounterOutcome` is the ONLY state mover and is monotone: hp
    down, spent only to true, unknown refs and any rise thrown as `AttritionError`.
  - `serialize.ts` — canonical JSON (sorted keys, canonical array order, no whitespace,
    safe integers only) for formation and manifest; strict parsers refuse unknown keys,
    floats, bad versions and off-lattice cells.
  - `resolverInput.ts` — `Battlefield`, the closed, flat, integer-only structure the
    resolver consumes (positions, hp, defense × merge, aggro/leash, trap stats, entry
    bands, core); `assertBattlefield` refuses any extra key at every level by name.
- `packages/content/src/tunables.ts` — chunk 07 block appended: `GRID_WIDTH/HEIGHT` 32,
  `PERIMETER_RING_RADIUS` 4, `PERIMETER_SEGMENTS` 32, `FENCE_MATERIAL_BUDGET` 24,
  `CORE_SIZE` 3, `MIN_POST_DISTANCE` fp(1), `ENTRY_BAND_DEPTH` 2. (`DEPLOYMENT_SLOT_CAP`,
  `TRAP_SLOT_CAP`, fence tier HP, aggro/leash defaults were already there from chunk 03.)
- `apps/server`: migration `004_wagon_circle` — `wagon_manifest` (caravan-keyed; `packed`
  immutable by trigger; `survivors` same shape, trigger refuses any added/removed ref, any
  hp rise, any un-spend, any identity change; one open manifest per caravan; closed rows
  frozen; delete/TRUNCATE refused) and `wagon_formation` (per manifest + encounter index;
  draft re-savable, committed rows frozen and undeletable; sha256 hash column).
  `src/circle/access.ts` — the `isUnlocked(owner, typeId)` seam, stubbed on chunk 05's
  STARTING_NODES with TODO(chunk-05). `src/circle/service.ts` — `lockManifest`,
  `saveFormation`, `commitFormation`, `battlefieldForEncounter`, `applyOutcome` (service
  only, no route), `closeManifest`. `src/routes/circle.ts` — `POST/GET
  /caravans/:id/manifest`, `PUT/GET /caravans/:id/encounters/:n/formation`, `POST
  .../commit`; owner-only (404 otherwise); validation errors carry the issue list.
  Registered in `app.ts` (append only).

**Test command:** `pnpm --filter @caravan/circle test` — 7 files, 48 tests. `pnpm test` in
`apps/server` against `TEST_DATABASE_URL=...caravan_test_c07` — 15 files, 195 tests
passing (16 in `circle.test.ts`, plus the migration round-trip updated for the two new
tables). `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary` clean. Covered: manifest caps
and budget rejected server-side; locked unit/trap/fence tier rejected by hand-crafted
request through the seam (a desert caravan cannot pack `desert.vaquero` or
`mountain.grizzly`); another caravan's unit instance rejected; no manifest-editing route and
the DB refuses `packed` changes, added survivors, healing, repair, re-arm, counter rewind;
gapped formation legal, re-arrangeable, frozen on commit (service and DB); stored snapshot
re-canonicalizes byte-identically and hashes to the stored hash; trap spent at encounter 1
still spent at 2 and 3 via HTTP, dead unit and destroyed segment refused, chipped segment's
hp reaches the battlefield; four entry edges and split-across-edges; core reachable from
every edge with a legal gapped ring; no float in model/serialization/source;
`@ts-expect-error` and runtime tests that `Battlefield` cannot carry elevation, terrain,
scenery, cover or an account id; the two tables have no account column.

**Assumptions / decisions:**
- Ring geometry: a square ring at Chebyshev radius 4 (cells 11..19) gives exactly the
  brief's 32 segments; corners belong to the side their run starts on. Fence segments
  occupy lattice cells (a blocked cell), which is what chunk 10's lattice A* needs.
- Posts have NO stance field: the only stances the design defines are the attacking
  party's three targeting stances (chunk 09); a posted unit's behaviour is aggro/leash.
- Every living unit in the manifest must be posted (an unposted unit would need an
  invented default location). Holding traps or fence material back is legal.
- Traps and posts may not sit on the ring, the core, or an entry band; posting outside
  the ring is allowed.
- Unit hp and defense at pack/battlefield time are scaled by `mergeStatMult(level)`.
- The access stub includes `fence.brush_pile` as a starting node (the brief lists 2
  living / 1 trap / 1 siege; a caravan with no fence tier has no circle) — chunk 05 to
  confirm. Living starters are the first two of the caravan's region roster.
- `commitFormation` does not append `formation_committed`: chunk 02's
  `enqueueEncounterResolution` already does, with the formation snapshot, and chunk 15
  will call it with the committed canonical formation (its `{fences,traps,posts}` shape
  already fits `snapshotFormation`). `applyOutcome`/`closeManifest` are services for
  chunks 13/15; nothing here touches `caravan.state` or the trip cap.
- `formation` is stored as jsonb (queryable); jsonb normalizes key order, so the
  byte-compare guarantee is "canonical re-serialization of what is read equals what was
  written, and the stored sha256 is of that text" — tested.
- The resolver cannot import `@caravan/circle` under the chunk 21 boundary check (zero
  deps, relative imports only). Chunk 10 will have to either vendor the handful of
  lattice constants/`Battlefield` type or extend the allowlist deliberately; flagged.
- `apps/server/test/migrations.test.ts` (chunk 01) had to learn the two new tables; its
  "no table named *formation*" check became "every formation-shaped table is keyed by
  encounter_index and carries no account/caravan column", which is the invariant it was
  guarding (chunk 01's own schema comment allows per-encounter formations).
- Commit `470b86a` carries the code; this log entry landed in a follow-up commit because
  a concurrent restage of this file (`a91ce6b`) displaced the staged blob between staging
  and commit.

**Next:** hand to adversarial QA against the chunk's checklist — especially: can any path
re-arm a trap or add to a manifest; is the budget genuinely below the ring; does anything
treat a gap as an error; can a hand-crafted request place a locked type.

### 2026-10-11 — Chunk 05 (unlock webs: data + spend): `not started` → `built`

**Built** in a worktree on top of `900b908`. New: `packages/content/src/unlockWebs.ts`
(+ test `unlock-webs.test.ts`, 13 tests), a chunk 05 block in `packages/content/src/tunables.ts`,
`apps/server/src/unlocks/{access,spend,view,index}.ts`, `apps/server/src/routes/unlocks.ts`
(registered in `app.ts`), migration `005_unlock_node_once`, `apps/server/test/unlocks.test.ts`
(20 tests). Changed: `apps/server/src/circle/access.ts` (stub → re-export of the real check),
the three `accessCheckFor` call sites in `circle/service.ts` (now `await accessCheckFor(client,
owner)`), and the access-seam block of `test/circle.test.ts` (ported to the async API).

- **Data.** Six webs: four living (one per region, 8 nodes), trap (6 traps + 4 fence tiers),
  siege (5). A node's id is the type id it unlocks; one node per type, every type, validated
  on import both ways. DAGs with 2–3 roots, all-of prerequisites, prerequisites strictly
  lower-tier (plus an explicit cycle check), fence tiers in tier order. Tier 0 = the starting
  nodes (2 living, 1 trap, 1 fence tier, 1 siege), free and reached by data, no event at
  creation. Cost by tier 0/1/2/4/6 (`UNLOCK_NODE_COST_BY_TIER`). `evaluateWeb` / `checkSpend`
  / `maximalReachableSets` are pure and shared by server and (later) client.
- **Spend.** `POST /me/unlocks/spend {pool, nodeId, caravanId?}` → under the account append
  lock: resolve scope (living needs the caller's caravan, trap/siege must name none), node
  in THIS web, not reached, prerequisites reached, cost ≤ available → one
  `unlock_node_purchased` `{pool, nodeId, cost, tier}` with causation `unlock:<pool>:<scope
  id>:<node id>`. 201 on create, 200 `created: false` on a replay (starting nodes included),
  nothing appended. Migration 005 adds a once-per-node unique index as the storage backstop
  (same shape as 003's once-per-rung).
- **Access.** `hasAccess(db, owner, typeId)` / `unlockedTypeIds` / `accessCheckFor` in
  `src/unlocks/access.ts`, reading `unlock_node_purchased` straight from the ledger (living
  on the caravan row and its region's web; trap/siege on the account). The circle's
  `isUnlocked` is this function.
- **Reads.** `GET /unlocks/webs` (public, whole data with costs) and `GET /me/unlocks` (the
  caller's three webs with reached / affordable / missing per node and points per pool).

**Test command:** `cd apps/server && TEST_DATABASE_URL=postgres://caravan:caravan@localhost:5432/caravan_test_c05 npx vitest run`
— 16 files, 215 tests passing (baseline on `900b908`: 15 files, 195), run twice. `pnpm
--filter @caravan/content test` 55 passing (no-floats source grep covers the new file).
`pnpm --filter @caravan/circle test` unchanged, 48 passing. `pnpm typecheck`, `pnpm lint`,
`pnpm test:boundary` clean. Chunk 05's tests cover: public web identical across reads with
every cost; a new player sees every node (unaffordable and unreachable included) and no
other region's unit; hand-crafted requests naming a type nobody has, another region's unit,
a trap under the siege pool, living without a caravan, trap with one, and someone else's
caravan are all refused with nothing appended; insufficient points and unmet prerequisites
are 409s; a legal spend appends exactly one event on the right row and the projection
rebuilds; replay and starting node are 200/no-op; 8 concurrent identical spends reach the
node once; chains walk in order and an exact budget spends to zero; the real chunk 04 path
(held encounters → rung → point) funds a spend; roster, Coin, ladders and granted points are
byte-identical across an unlock and no instance appears; the circle seam sees a new node
through the same predicate; split (A's living node not reached for B's same-region caravan,
A's trap node on the account, events on the right rows, DB CHECK refuses the wrong scope);
permanence through 40 overruns + a deleted roster + owner-role attempts to refund, delete
the event, or insert a second purchase; source greps for the only writers of the two events
and a Coin/ladder/instance-free unlocks module. Content tests cover validation (dangling
prerequisite, cycle, foreign-region unit, missing type, costed starting node, line-shaped
web) and >1 maximal reachable set at a third of each web's paid total.

**Assumptions made:** listed under "Build notes" in `chunks/05-unlock-webs.md`. The two that
matter for QA: (1) `fence.brush_pile` is a starting node (chunk 07's assumption, confirmed);
(2) with the brief's node counts and cost curve every web's paid total (19 / 24 / 11) is
under the 30 points a capped ladder grants, so "most but not all of a web by cap" does not
hold — left as specified and flagged in the registry comment rather than re-tuned.
Reached nodes are read from the ledger on every check (no cache); fine at this scale, and
the once-per-node index doubles as the read index. `GET /me/progression/events` (chunk 04)
still filters to its three event types; purchases are visible in `GET /me/ledger`.

**Next:** hand to adversarial QA against GUARDRAILS §3/§4/§5 and the chunk checklist —
especially whether any caller can still reach the circle package's `packManifest` /
`validateFormation` with a predicate not bound by `accessCheckFor`, and the cost-curve
finding above.

### Orchestrator decision — who owns the battlefield geometry

Chunk 07 placed the lattice→continuous conversion and the `Battlefield` input type in
`packages/circle`, and chunk 21's boundary rules forbid the resolver from importing any
package. Decision: **the resolver owns the battlefield input type, the lattice constants,
and the one lattice→continuous conversion** (`packages/resolver/src/battlefield.ts`);
`packages/circle` depends on `@caravan/resolver` for those and re-exports them, never
the reverse. Chunk 10's Maker performs the move and updates `packages/circle` to import
from the resolver. The resolver still receives all content (unit stats, tunables) as
plain input data; it never imports `@caravan/content`.

### Orchestrator process change — worktrees

From chunk 10 onward every Maker and fixer runs in its own git worktree on a branch
named `chunk/NN`, and the orchestrator merges into `roadmap/phase-2-spec`. The shared
working tree caused three staging incidents in the first batch (45c04b3, 3137656,
a9a49a9).

### 2026-10-11 — chunk 02 QA round 1 closed

Maker closed B1, S1–S9, N1–N4 from `roadmap/qa/02-punchlist.md` (details per item there).
Migration 002 and `db/roles.sql` edited in place (nothing deployed). Regression file:
`apps/server/test/qa02-regressions.test.ts` (27 tests, every QA probe reproduction);
`jobs.test.ts`, `ledger.test.ts`, `concurrency.test.ts` updated for the new rules.

**Signature / behaviour changes other chunks should know about** (all in `src/ledger`,
`src/jobs`; no in-tree consumer outside chunk 02 used the changed functions):

- `lockJobForCompletion(client, jobId, fence)` and `markJobCompleted(client, jobId, result,
  fence)` now REQUIRE a `LeaseFence {workerId, attempts}` (B1). Only `worker.ts` and chunk
  02's tests called them. `markJobFailed` gained an optional 5th `{workerId, backoffMs}`.
- `coinCreditDraft` keeps its signature but no longer takes the account lock: it asserts
  the lock is already held and throws a message naming the fix (S5). The rule for any
  transaction that writes several accounts: `lockAccountsForAppend(client, ids)` first,
  then build drafts, then `appendEvents`. Chunk 04's `outcome.ts` (sorted locks up front)
  and chunk 16's `appendCoinCredits` (single account) already follow it.
- The worker clamps handler Coin credits to the cap at commit (S6), so a pure handler
  emits requested amounts; chunk 13/19 handlers need no balance access.
- `DEFAULT_HANDLERS.encounter_resolution` parks every job while `RESOLVER_VERSION < 1`
  (S9). **Chunk 13 must bump `RESOLVER_VERSION` to >= 1** when the resolver lands and
  replace the placeholder body; tests that need an encounter to complete register
  `PLACEHOLDER_HANDLERS` explicitly.
- `GET /me/ledger` validates `after`/`limit` (400 on garbage) and returns `hasMore`.
- `ResolutionJobRow` gained `next_attempt_at` (N3) in `src/db/types.ts` (chunk 02 section).
- The app DB role can no longer UPDATE `account.coin_balance` or the five projected
  `pool_progress` columns (S1); `repo/poolProgress.ts`'s `raiseLadderLevel` /
  `grantUnlockPoints` therefore only work on an owner connection (nothing in `src` calls
  them; progress moves through ledger events). Two assertions in `test/qa01-guards.test.ts`
  were adjusted for this, the only edit outside chunk 02's paths.

**Verification** (shared tree, concurrent Makers' files included):
`cd apps/server && TEST_DATABASE_URL=...caravan_test_qa02 npx vitest run` → 16 files,
224 tests passing, twice in a row. Root `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary`
clean. `DATABASE_URL=...caravan_test_qa02 pnpm --filter @caravan/server ledger:rebuild`
→ 0 mismatches. Not done: the QA probe script itself was not re-run (it calls the old
unfenced signatures); its reproductions live in the regression file instead.

**Next:** QA re-audit of chunk 02 (status stays `built` until QA signs off).

### 2026-10-11 — Chunk 16 (economy: Coin and merges): QA round 1 closed (S1–S6, N1–N6)

Worktree branch off `roadmap/phase-2-spec` at `a0bfe94`. Punch list
`roadmap/qa/16-punchlist.md`, every item marked `[closed]` with where it landed. Files
touched: `apps/server/src/economy/{coin,trickle,merge}.ts`, `apps/server/src/routes/economy.ts`,
`apps/server/test/{economy,economy-guards}.test.ts`, `packages/content/src/tunables.ts`
(two new keys only: `TRICKLE_MATERIALIZE_MIN_COINS` 10, `TRICKLE_MATERIALIZE_MIN_MS` 15 min),
the chunk file, the punch list, this entry. No migration. Exported names unchanged;
new exports `spendCoin`, `peekTrickle`, `UnitMergedPayload`, `SpendCoinOptions/Result`.

- **S5 first, because the others lean on it:** `spendCoin(client, accountId, amount, reason,
  nowMs, { causationId, extra?, alongside? })` is the only debit path — forced trickle flush,
  409 `insufficient_coin`, then `coin_spent` + `alongside` in one batch. `merge.ts` no
  longer builds a debit draft; a source scan asserts `coinDebitDraft` has exactly one
  importer (`economy/coin.ts`) and no `coin_spent` literal exists outside economy/ledger.
- **S4:** reads compute the trickle always and show `ledger + pending`; a row is written
  only at the coin/time threshold or a debit's flush; at the cap nothing is written (no
  zero-amount rows); accrual point = max(last valid trickle `accruedThroughMs`, last
  `coin_spent` `occurred_at`). Consequence worth knowing: a spend drops any sub-coin
  remainder (< 18 s) — the forced flush before the debit bounds it to that. Tests use a
  backdated `created_at` so the injectable clock and the database clock that stamps
  `occurred_at` stay consistent.
- **S1/S3/N2:** merges refuse 409 `caravan_on_trip` unless `in_town` (FOR SHARE in the
  commit transaction; preview checks too); `invalid_caravan_id` 400 and the id
  normalization / distinct / recipe checks all run before the first query.
- **S6:** a retry of a committed merge (same caravan, same lowercase-sorted ids) returns
  200 `{ replayed: true, merged, events, consumedInstanceIds, producedInstanceIds }` from
  the stored `unit_merged`. Behaviour change for the race test: six concurrent merges of
  the same inputs are now 1 winner + 5 replays (was 1 + 5 × 404); still one `coin_spent`.
- **S2, N1, N3, N4, N5, N6:** preview balance = ledger + pending via read-only
  `peekTrickle`; `prospectiveEarn` safe-integer ≤ 10 × cap; malformed trickle rows skipped
  for the previous valid one and `appendCoinCredits` refuses reason `trickle`; the earn
  schedule clamps at the cap per encounter (≈ encounter 23) and asserts safe integers;
  "room right now" wording in the forecast doc and `overflow.message`; the 404 convention
  for foreign caravans recorded in the chunk file.

**Verification (this worktree, base `a0bfe94`):** `cd apps/server && TEST_DATABASE_URL=
postgres://caravan:caravan@localhost:5432/caravan_test_f16 npx vitest run` — 15 files,
209 tests passing (was 195 at base; chunk 16: `economy.test.ts` 28, `economy-guards.test.ts`
20). `pnpm typecheck` clean across all five packages; `pnpm lint` (resolver) clean;
`pnpm test:boundary` passes; content tests 44 passing. The probe harness QA left at
`scratchpad/qa16/qa16.probe.test.ts` was turned into the "QA round 1 punch list" block of
`economy.test.ts` (S1–S6, N1–N3, clock-backwards / future `created_at`, ladder untouched
by a merge, 4-mine-plus-1-foreign refused whole) and the N4/S4/S5 pure checks in
`economy-guards.test.ts`.

**Next:** QA re-review of chunk 16; then `built` → `QA'd` in INDEX.md (not touched here —
out of this fixer's file set). Chunks 18 and 20 must debit through `spendCoin`.
### 2026-10-11 — Chunk 04 (ladders & Reputation): QA round 1 closed (D1, D2, S1–S8, N1–N4, N7; N5/N6 noted)

Closed by the Maker in a worktree branched from `roadmap/phase-2-spec` at `677bd9b`.
Punch list `/roadmap/qa/04-punchlist.md` carries the per-item dispositions; the QA probe's
reproductions are now `apps/server/test/qa04-progression.test.ts` (31 tests).

- **D1.** `trap` Reputation no longer moves (`progression/outcome.ts` writes living on the
  caravan side and siege on the party side, nothing else); `/progression/rules` publishes
  `matchmakingRating`, which ratings move, and that a zero delta writes no event. Recorded in
  the chunk 04 file and as "Decided in chunk 04 QA" in chunk 14's file.
- **D2.** New tunable `REPUTATION_GAP_MULT_MIN_LOSS = fpMilli(500)`; `gapMultiplier` floors a
  loss there and a win at `REPUTATION_GAP_MULT_MIN`. Rules endpoint renames `multMin` →
  `multMinWin` + `multMinLoss`. PHASE-2's Coin floor and recent-opponent exclusion are
  appended to chunk 14's file as checklist items (the punch list cites PHASE-2 §28; the text
  is §31 "Integrity and anti-abuse").
- **S1/S2/S8.** Migration `003_unlock_grant_once` (edited in place; nothing is deployed) now
  carries: `ledger_event_ladder_progress_nonneg` (integer `pointsDelta ≥ 0`, integer
  `levelsGained` in 0..20), `ledger_event_unlock_grant_shape` (integer `points > 0`, integer
  `rung` in 1..20), the grant-once index without the `payload ? 'rung'` predicate,
  `pool_progress_ladder_level_cap` (`ladder_level ≤ 20`) and a `pool_progress_guard_ladder_points`
  trigger (no decrease). A `jsonb_int()` helper keeps a non-number payload from ever reaching a
  cast. The cap literal is pinned to `TUNABLES.LADDER_RUNGS_PER_POOL` in the migration text and
  the live constraints. Migration 002 and `roles.sql` untouched (a chunk 02 fixer owns them).
- **S3.** `applyEncounterOutcome` stamps `payload.inputHash` (sha256 of the canonical input,
  pools sorted) on every event it appends and throws `ProgressionCausationMismatch` on a
  replay with a different input.
- **S4/S5.** `GET /me/progression/events` has a Fastify querystring schema (`after` integer
  0..2^53−1, `limit` 1..500, `pool` enum, unknown keys refused → 400). New
  `listProgressionEventsForAccount` filters by type and pool in SQL, reads limit+1 and returns
  `hasMore`.
- **S6.** `raiseLadderLevel` / `grantUnlockPoints` deleted; `permanence.test.ts` now raises
  progress through `appendEvents` only.
- **N1–N4, N7.** No zero-delta `reputation_changed`; `assertInTransaction` (force an xid, then
  `pg_current_xact_id_if_assigned()` in a second statement — the punch list's one-statement
  form is NULL in any transaction that has not written yet); `circle/service.ts` imports the
  attrition fold as `applyAttritionOutcome`; `gapScaledDelta` returns `|| 0` and
  `assertReputationTunablesCoherent()` runs at module load; `toPoolProgressView` throws on a
  living row without a caravan id.
- **Fixture fallout.** Chunk 02's `ledger.test.ts` carried a `pointsDelta: -7` and two
  rung-less grants (pre-dating cumulative points); updated to the shapes the CHECKs now
  demand, and its "ladder decrease through an event" case now hits the payload CHECK before
  chunk 01's trigger.

**Verification (real output):** `apps/server` suite against `caravan_test_f04` — 16 files,
231 tests passing (was 195 at the base); `@caravan/content` — 44 passing; `pnpm typecheck`
clean in all four packages; `pnpm lint` clean; `pnpm test:boundary` passed.

**Flagged, not changed:** (1) the `@caravan/circle` export is still named
`applyEncounterOutcome` — the N3 rename at the package level is chunk 07's; (2) the QA probe
also showed the app role can `UPDATE pool_progress SET ladder_level = ladder_level + 1`
directly (an increase, which no guard refuses) — not on this punch list, but it is a
ledger-bypassing rise; worth a QA item for chunk 02 or a column-level `REVOKE UPDATE` on the
projected columns in `roles.sql`. `roadmap/INDEX.md` left at `built`; the orchestrator moves
it to `QA'd`.

### 2026-10-11 — chunk 02 QA round 2 closed

Maker closed R2-S1–S4 and R2-N1–N3 from `roadmap/qa/02-punchlist.md` (details per item
there). Migration 002 and `db/roles.sql` edited in place (nothing deployed). Regression
file: `apps/server/test/qa02-round2.test.ts` (18 tests, the reviewer's fence-probe
reproductions); the round-1 B1a regression in `qa02-regressions.test.ts` was rewritten
for the new leasing rule; `jobs.test.ts` / `concurrency.test.ts` stamp `resolverVersion`.

**Signature / behaviour changes other chunks should know about** (all in `src/jobs`;
`enqueueEncounterResolution` and the worker's public surface are unchanged):

- **Every job input must carry an integer `resolverVersion`** (CHECK, R2-S1). Any chunk
  that calls `enqueueJob` directly (none in `src` today besides the encounter handler)
  must stamp it; `enqueueEncounterResolution` already does.
- **A worker leases only jobs for its own `RESOLVER_VERSION`** (R2-S2).
  `leaseNextJob(db, workerId, visibilityTimeoutMs, resolverVersion = RESOLVER_VERSION)`;
  a job for another version stays queued, untouched, until a worker on that version runs.
  Chunk 13's version bump therefore strands nothing and parks nothing during a rolling
  deploy; it only has to bump the constant.
- **Job state moves only through SQL functions** (R2-S3): `resolution_job_{lease,
  complete,fail,park,requeue}` are SECURITY DEFINER (owner, pinned `search_path`), and
  the app role has no UPDATE on `status, leased_by, attempts, lease_expires_at,
  requeued_at, requeued_by, requeue_count`. `queue.ts` keeps its exported names and
  signatures and calls the functions. **Re-run `db/roles.sql` after migrating**
  (`pnpm db:migrate` / `db:reset` do; the test suite's global setup does).
- `requeueParkedJob(db, id, { extraAttempts?, requeuedBy? })` records
  `requeued_at / requeued_by / requeue_count` on the row (`ResolutionJobRow` gained the
  three columns); `requeuedBy` defaults to `DEFAULT_REQUEUED_BY` (`"operator"`).
- Trigger + CHECK tightening (R2-S4, N3): `completed` only from `leased` by the lease
  holder; a lease must increase `attempts`; `parked` only from `leased`; a queued row has
  `attempts < max_attempts`; `result`/`completed_at` only on a completed row. Nothing in
  `src` took any of the refused transitions; an owner-connection script that flips a
  parked job back to `queued` by hand must now also raise `max_attempts` (or call
  `requeueParkedJob`).
- Park-on-exhaustion records `leased_by = NULL` (R2-N1); the lease clock is
  `clock_timestamp()` (R2-N2).

**Verification** (isolated worktree off `roadmap/phase-2-spec` @ 443f122):
`cd apps/server && TEST_DATABASE_URL=...caravan_test_f02 npx vitest run` → 17 files,
242 tests passing, twice in a row. Root `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary`
clean. The probe file itself was not re-run (it imports from the shared checkout and P5/P7
assert the old lenient behaviour on purpose); its cases live in the regression file.

**Next:** QA re-audit of chunk 02 round 2 (status stays `built` until QA signs off).
### 2026-10-11 — chunk 07 QA round 1 closed

Maker closed D1, D2, S1–S8 and N1–N7 from `roadmap/qa/07-punchlist.md` (details per item
there). Migration 004 edited in place (nothing deployed). Regression files:
`apps/server/test/qa07-regressions.test.ts` (14 tests, every server probe reproduction)
and the chunk's own `packages/circle/test/*` (48 → 64 tests). Status stays `built` until
QA re-audits.

**Shape / behaviour changes other chunks should know about:**

- **Formation is `v: 2`; a post is `{ref, cell, stance}`** with `stance ∈ {guard, hold,
  reserve}` (D1). A client may omit `stance` (→ `guard`); the stored canonical form always
  carries it. Semantics are in `formation.ts`'s header, PROJECT.md's revision note and the
  chunk 11 file. Chunk 08 must offer the three stances per post; chunk 11 implements them.
- **Ring geometry changed (D2):** `TUNABLES.PERIMETER_SEGMENTS` 32 → **28**,
  `FENCE_MATERIAL_BUDGET` 24 → **20**, new `RING_ANCHOR_CELLS` = 4 and `PATH_CONNECTIVITY`
  = 4. The four corners of the radius-4 square are permanent wagon anchors
  (`RING_ANCHORS`, clockwise from NW), not fence positions; segment 0 is the cell just east
  of the NW anchor; 7 segments per side. `isCoreReachableFrom` always treats anchors as
  blocked and is 4-connected (`neighbours4`). Chunk 08 draws the anchors as parked wagons.
- **`Battlefield` is version 2** and gained `pathConnectivity: 4`, `anchors: Cell[]` (four
  permanently blocked cells with no HP) and `posts[].stance`. `assertBattlefield` now also
  closes the nested `ability`/`effect` shapes per archetype/kind, checks every enum field
  against the content enums, `pos` within the field and hp within `0..maxHp` (S1).
  **For the chunk 10 Maker moving the lattice/`Battlefield` into the resolver:** the
  geometry diff is confined to `packages/circle/src/lattice.ts` (anchor block, ring walk
  skipping corners, `PATH_CONNECTIVITY`/`neighbours4`, coherence assertions) and
  `resolverInput.ts` (three new fields, the S1 checks); every constant still reads from
  `TUNABLES`, so the move carries over by re-pointing imports. The resolver's pathfinder
  must block `anchors` exactly as it blocks an intact fence segment and step 4-connected.
- **`applyOutcome` (service) refuses refs that were not in the fight** (S2): a trap not
  laid cannot be spent, a fence not placed cannot be chipped, a unit not posted cannot
  change. Chunk 13's handler must only report what the resolver actually touched.
- **`wagon_formation.survivors_snapshot`** (S7): set at commit, equal to the manifest's
  survivors at that moment (DB-enforced), frozen with the row. `battlefieldForEncounter`
  builds from it, so a replay input for encounter N is byte-identical however many
  encounters resolved since. `commitFormationRow` takes the snapshot JSON as a 4th arg.
- `POST /caravans/:id/manifest` returns 400 `manifest_empty` for a loadout with no living
  unit (S3) and 400 `bad_body` for arrays/unknown keys; caravan ids must be real UUIDs
  (404 otherwise, S4); encounter index must match `^[1-9]\d{0,5}$` (N2).
- Oversized formation bodies are refused before validation with a one-line
  `malformed_formation` (S8); issue lists are capped at `MAX_ISSUES` = 50.
- New issue codes: `manifest_empty`, `bad_version`, `oversized`, `bad_stance`.
- `applyEncounterOutcome` validates the outcome's shape first (`assertEncounterOutcome`,
  N4); `packManifest` asserts the unit/trap/fence ref namespaces are disjoint (N3).
- Chunk 15 must set `caravan.state = 'on_trip'` in the same transaction as `lockManifest`,
  before locking (N7; chunk 16's S1 is the merge-side guard). Note appended to its file.

**Verification** (worktree `agent-a8146002f49bf74f4`, base `1c8930c` on
`roadmap/phase-2-spec`): `pnpm --filter @caravan/circle test` → 7 files, 64 passing;
`pnpm --filter @caravan/content test` → 44 passing; `cd apps/server &&
TEST_DATABASE_URL=...caravan_test_f07 npx vitest run` → 17 files, 238 passing. Root
`pnpm typecheck`, `pnpm lint`, `pnpm test:boundary` clean. The QA probe scripts
themselves were not re-run (they import the main tree's paths and the pre-D1 `v: 1`
shape); their reproductions live in the regression files.

**Next:** QA re-audit of chunk 07; the orchestrator merges this with chunk 10's
lattice/`Battlefield` move.
