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
