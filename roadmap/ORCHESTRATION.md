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
### 2026-10-11 — Chunk 10 (resolver core: tick loop & movement): `not started` → `built`

**Built**, in an isolated worktree (branch `worktree-agent-ad8d56f1595c82b99`, branched
from `roadmap/phase-2-spec` at 900b908). `RESOLVER_VERSION` is now **1**.

- `packages/resolver/src` — 11 files, zero dependencies, every lint and boundary rule
  passing (no float literal, no bare `/`, no Map/Set, no Math beyond trunc/floor/abs/sign,
  no Date/process, relative imports only, `tsconfig.json` untouched):
  - `fixed.ts` — `FIXED_POINT_SCALE` 1024, the rounding mode (every division is
    `Math.floor`, toward −∞, exact for integer operands below 2^52 — documented why),
    `fpMul`/`scaleInt`/`ceilDiv`/`clamp`, and `isqrt` (integer Newton; the only "magnitude"
    the sim ever takes, for scaling a step along a direction vector).
  - `battlefield.ts` — THE GEOMETRY, moved here from `packages/circle` per the
    orchestrator decision: `Cell`/`FixedPoint`, `cellCenter` (the one lattice→continuous
    conversion), `cellOf`, `distSq`, the 32×32 lattice, the 3×3 core, the ring, the entry
    bands, `isCoreReachableFrom` (callback-based; circle wraps it with its Set signature),
    the `Battlefield` input type, `BATTLEFIELD_VERSION`, `assertBattlefield` (closed keys at
    every level, integers only), and structural mirrors of content's category / ability /
    `Fixed` / `Millis` shapes so content values are assignable without an import (a circle
    test pins the lists equal). Per the chunk 07 QA decision relayed mid-task: the four ring
    corners are permanent **anchors** (`RING_ANCHORS`, never breakable; `Battlefield.anchors`
    carries them and the input guard requires exactly those four), **PERIMETER_SEGMENTS is
    28**, and `BattlefieldPost.stance` (`guard` | `hold` | `reserve`, default `guard`) is
    carried for chunk 11.
  - `input.ts` — `Party` (`PartyUnit` with the three stances, entry edge + cell, offense,
    speed, range, cooldown, ability; `PartySiege`), `ResolverTunables` (tickRate,
    battleLengthCapSeconds, pathRecomputeIntervalMs, unitRadius, keyframeIntervalMs,
    `pathConnectivity: 4` — fixed, only 4 accepted), `assertResolveInput` (closed shapes,
    no floats, stances, entry bands, ring/anchor/grid cross-checks, unique refs, no dead
    units) and `normalizeInput` (every array sorted by ref / segment; the input contract is
    "order is normalized on entry").
  - `path.ts` — 4-connected A* (PATH_CONNECTIVITY 4: no diagonals, no corner cutting),
    STEP_COST one cell, breach edges priced by the caller (`ticks to destroy × speed per
    tick`, so walk-around vs break-through is one cost comparison), tie-break = equal f →
    lower row → lower column (= lower cell key), neighbours N/W/E/S, strictly-cheaper
    parent replacement, Manhattan heuristic. `losClear`: exact integer supercover walk of
    the segment (crossing times compared cross-multiplied, never divided), a segment through
    a cell corner touches all three cells beyond it. `smoothPath`: string pulling from the
    unit's actual position; breach cells and their predecessor are hard waypoints.
  - `state.ts` — unit ids: attackers in ref order (0..A−1) then posts in ref order; per-tick
    quantities derived once (`speedPerTick = floor(speed/tickRate)` → 76 at 1.5 cells/s;
    `cooldownTicks = max(1, floor(ms × rate / 1000))`); the pathing grid as an Int32Array.
  - `tick.ts` — TICK_PHASE_ORDER written at the top and run in that order: 1 retarget
    (only on invalid target; fallback chains documented), 2 path recompute (tick % interval
    === 0 for every unit, plus the unit whose target changed, plus everyone on the tick after
    a fence breaks), 3 movement (sub-cell steps along waypoints, hold when a unit target is
    in attack range, breach-stand when the next cell is an intact segment, bounds clamp,
    `core_reached` recorded when a unit's cell is a core cell), 4/5/7 explicit no-op hooks
    (`hooks.ts`, chunk 11/12), 6 attack cooldowns — chunk 10 implements only the fence
    BREACH hit (adjacent cell, on cooldown, `fenceHitDamage` = offense × `siegeFenceMult`
    (×1.0 until chunk 11), floor, min 1), 8 death — fence destruction only (grid rebuilt,
    paths dirtied). Keyframe every keyframeInterval ticks and on the last tick.
  - `resolve.ts` — `resolve(input) → ResolveOutput` (version, tickCap, ticks, `end`,
    unit/fence/trap summaries, the event log). `log.ts` — events + waypoints, not per-tick
    state: spawn, target, path (waypoints + per-tick speed), hold, core_reached, fence_hit,
    fence_broken, keyframe. `hooks.ts` — also `endOfTick` (chunk 13's end conditions; null
    today, so the loop always runs to the cap).
- Tests (`packages/resolver/test`, vitest, 5 files, **53 passing**, ~3.4 s; fixtures are
  literals, never content): geometry (28 segments + 4 anchors, sealed ring unreachable /
  one gap reachable, 4-connectivity); path (no diagonal step, no corner cut, BOTH tie-break
  axes pinned by symmetric walls, breach chosen vs avoided by cost, the exact-equal-cost
  case pinned, LOS corner conservatism); movement (76/tick sub-cell and never on a centre,
  reaches the core through a gap, detours vs breaches by cost, 3 hits of 40 on 100 HP at
  20-tick spacing then `fence_broken`, sealed ring terminates, bounds + never inside an
  intact fence/anchor, no unit collision, three stances, retarget-only-on-invalid,
  fallback chains, id order independent of input order, shuffled input byte-identical,
  same-tick double breach hits in id order with the 0-HP skip); input (every refusal);
  determinism (4 scenarios × 100 runs byte-identical, every state field a safe integer
  after every tick incl. the grid, no float in the output, input never mutated).
- `pnpm determinism` (chunk 21's gate) now runs `packages/resolver/scripts/determinism.mjs`:
  the vitest harness, then `test/harness/driver.ts` bundled with the root's esbuild and run
  in 3 separate Node processes × 3 runs, sha256 per scenario compared across processes.
  Output lists the hashes. (The root `.gitignore` note about `*.log` still applies to chunk
  13's goldens.)
- `packages/circle` now depends on `@caravan/resolver`: `lattice.ts` re-exports the geometry
  under every chunk 07 name, keeps the Set-signature `isCoreReachableFrom` (anchors always
  blocked), and asserts at import that `TUNABLES.{GRID_WIDTH,GRID_HEIGHT,CORE_SIZE,
  PERIMETER_RING_RADIUS,PERIMETER_SEGMENTS,RING_ANCHORS,ENTRY_BAND_DEPTH}` agree with the
  resolver. `resolverInput.ts` keeps `toBattlefield` (adds `anchors`, `stance: "guard"`),
  re-exports the type/guard from the resolver, adds `resolverTunables()`. `formation.ts`
  refuses a trap/post on an anchor (`cell_reserved`). Circle: 7 files, **50 passing**.
- `packages/content/src/tunables.ts`: `PERIMETER_SEGMENTS` 32 → **28**,
  `FENCE_MATERIAL_BUDGET` 24 → **20**, `RING_ANCHORS` 4 (fixed), and the chunk 10 block
  `TICK_RATE` 20, `BATTLE_LENGTH_CAP_SECONDS` 180, `PATH_RECOMPUTE_INTERVAL` ms(500),
  `PATH_CONNECTIVITY` 4, `UNIT_RADIUS` fpMilli(350), `LOG_KEYFRAME_INTERVAL` seconds(5).
  Content's "no key mentions ticks" test now exempts exactly `TICK_RATE` (the clock itself);
  the intervals are ms and the resolver converts. Content: **44 passing**.
- `apps/server`: no source change; `test/circle.test.ts` learned the `anchors` key.
  Server: 15 files, **195 passing** against `caravan_test_c10`.
- `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary` (11 src files), `pnpm determinism`
  all clean. AGENTS.md's command block updated.

**Assumptions / decisions (for QA and for the chunk 07 fixer):**
- The mid-task coordinator message (4-connectivity, 28 segments + 4 anchors, budget 20,
  post stance) was applied HERE, including the content registry numbers and the circle
  tests that pinned 32/24 (`lattice.test.ts`, `manifest/attrition/serialize/formation.test.ts`
  now read the budget from `TUNABLES`; `fixtures.ts` `innerCells()` now starts from
  `RING_ANCHORS[0]` — with `RING_SEGMENTS[0]` no longer the corner, the old fixture put
  posts on the east side of the ring). The chunk 07 fixer working in parallel should expect
  these files already changed and merge rather than redo; `RING_SEGMENTS` index 0 is now
  (12,11), the four sides have 7 segments each, `formationGaps` on the fixture is
  `[0,1,2,3,24,25,26,27]`.
- Fence chipping lives in phase 6 (attack cooldowns), not phase 3: the hit is paced by the
  unit's attack cooldown, which is phase 6's job, so chunk 11 extends one phase rather than
  moving code. Phases 4, 5 and 7 are the pure no-op hooks the brief asked for. Phase 8 does
  fence destruction only; unit death is chunk 11's.
- Breach hit damage = offense (chunk 11's o²/(o+d) with fence defense 0), × siege mult
  (×1.0 stub), floored, min 1 — so a breach always terminates. Breaching happens from the
  orthogonally adjacent cell regardless of attack range (ranged units walk up too).
- A unit whose stance target is a unit within attack range holds still ("engaged"); chunk 11
  makes it attack. A `traps` unit reaches the trap cell and waits (nothing spends traps yet).
- Reaching the core = the unit's cell is a core cell (recorded per unit as `reachedCoreTick`
  and logged); the loop never ends early — `endOfTick` in hooks.ts is chunk 13's seam.
- `path` events are emitted whenever a recompute changes the remaining waypoint list, which
  happens on most 10-tick recomputes mid-leg (string pulling from a new position); chunk 13
  measures the size budget and may coalesce.
- Floor division is used for the direction-vector step, so a negative component rounds
  toward −∞ (documented in fixed.ts); every position stays a safe integer and in bounds.
- The resolver's `tsconfig.json` is untouched (boundary check); tests typecheck through
  `tsconfig.test.json`. `vitest` and `@types/node` were already on the boundary allowlist.
- Branch name: the worktree branch is `worktree-agent-ad8d56f1595c82b99`, not `chunk/10`
  (the worktree was created with that name and had to be reset from `main` to
  `roadmap/phase-2-spec` before starting).

**Next:** hand to adversarial QA against the chunk's checklist — especially: grep the
package for the banned list; the two tie-break axes; a unit exactly on the goal-cell
boundary; recompute cadence (`tick % interval`, never event timing); and whether anything
in `tick.ts` reads beyond `state` and `log`.

### 2026-10-11 — Integrator: merged chunk 10 with chunk 07 fixes

One `--no-ff` merge of `worktree-agent-ad8d56f1595c82b99` (ce977be, based on 900b908)
into `roadmap/phase-2-spec` (c977601, which carries the chunk 07 QA round 1 fixes). Both
sides had implemented the same D2 geometry decision in different places; what was decided:

- **Geometry source of truth is `packages/resolver/src/battlefield.ts`** (chunk 10's
  structure). `packages/circle/src/lattice.ts` re-exports it. What stays circle-side:
  the Set-signature `isCoreReachableFrom` (over the resolver's walk, anchors always
  blocked), `neighbours4`, `isRingOrAnchorCell`, the registry mirrors `RING_ANCHOR_CELLS` /
  `PATH_CONNECTIVITY`, and the import-time coherence check (now the union of both sides:
  registry vs resolver for every geometry number incl. `PATH_CONNECTIVITY`, anchors never
  on a segment, `PATH_CONNECTIVITY === 4`). `ringIndexAt` is the resolver's Int32Array
  lookup, not chunk 07's Map (lint rule in the resolver).
- **`Battlefield` is v2 in the resolver**, with `pathConnectivity: 4`, `anchors` and
  `posts[].stance` (chunk 07's shape, chunk 10's home). `BATTLEFIELD_VERSION` = 2; the
  resolver's `normalizeInput` carries `pathConnectivity`; resolver fixtures build v2.
- **Chunk 07's richer `assertBattlefield` moved INTO the resolver** (option A of the two
  offered), not kept as a circle-side wrapper: per-archetype ability key sets, per-kind
  trap-effect key sets, enum checks for edge / fence category / trap category / affinity /
  stance, `pos` within `[0, GRID × SCALE)`, hp within `0..maxHp` (a float hp now says
  "must be an integer"), grid pinned to 32 × 32, `pathConnectivity` pinned, exactly 4
  anchors and 4 entries. The resolver stays zero-dependency: the enums are its own
  structural literals (`isAffinityCategory`, `isFenceCategory`, `isTrapCategory`,
  `isTrapEffectKind`, `isAbilityArchetype`, `isPostStance` — new exports), and
  `packages/circle/test/battlefield.test.ts` pins the mirrored lists equal to
  @caravan/content's. Circle's `resolverInput.ts` re-exports the guard; `toBattlefield`
  passes the post's real `stance` (chunk 10's `DEFAULT_POST_STANCE` dropped — formation v2
  always carries one; `DEFAULT_DEFENSIVE_STANCE` in formation.ts is the default).
- **Tunables: one key per number.** `PERIMETER_SEGMENTS` 28, `FENCE_MATERIAL_BUDGET` 20,
  **`RING_ANCHOR_CELLS`** 4 (chunk 07's name wins — chunk 10's `RING_ANCHORS` key collided
  with the `RING_ANCHORS: Cell[]` export and the chunk files already name
  `RING_ANCHOR_CELLS`), `PATH_CONNECTIVITY` 4 kept once in the chunk 07 block (chunk 10's
  duplicate removed), chunk 10's `TICK_RATE` … `LOG_KEYFRAME_INTERVAL` kept.
- **Tests: union of both sides**, reconciled: circle `fixtures.ts` keeps chunk 07's stance
  import with chunk 10's `innerCells()` anchor start; `lattice.test.ts` has chunk 07's D2
  anchor / 4-connectivity / sealed-ring tests AND chunk 10's anchor-list, 32-cell-square and
  corner-adjacency assertions; attrition / serialize / formation read the budget from
  `TUNABLES` (chunk 10) inside chunk 07's test bodies; the server `circle.test.ts` key list
  includes `pathConnectivity`. Two resolver `input.test.ts` regexes (`/integer/`,
  `/lattice/`) are satisfied by the moved guard's wording.
- **Cross-chunk regression found and fixed in the merge:** chunk 10 bumped
  `RESOLVER_VERSION` to 1, and chunk 02's production encounter handler gated "no resolver,
  park the job" (QA-02 S9) on `RESOLVER_VERSION < 1` — so after the merge the production
  handler would have fallen through to the placeholder and written permanent
  `placeholder_unresolved` resolutions. The gate is now a server-side flag
  `ENCOUNTER_RESOLUTION_WIRED = false` in `apps/server/src/jobs/handlers/encounterResolution.ts`
  (**chunk 13 flips it** when it maps a real outcome; `FIRST_REAL_RESOLVER_VERSION` is
  gone). `qa02-regressions.test.ts` reads that flag and `RESOLVER_VERSION` instead of
  hardcoding `v0`; its S9 test runs again (it was being skipped at version ≥ 1).

**Verification** (main checkout, after the merge): `pnpm install --offline` up to date;
`pnpm typecheck`, `pnpm lint`, `pnpm test:boundary` (11 src files) clean; `pnpm determinism`
→ 4 scenarios × 100 in-process + 3 processes × 3 runs agree; `@caravan/resolver` 5 files /
53 passing; `@caravan/circle` 7 files / 66 passing; `@caravan/content` 3 files / 55
passing; server against `caravan_test_c10` → 20 files, **326 passing, 0 skipped**.

**Next:** QA re-audit of chunk 07 (status `built`) and adversarial QA of chunk 10 (status
`built`) can both run against this merged tree.

### 2026-10-11 — Chunk 05 (unlock webs: data + spend): QA round 1 closed (D1, S1–S3, N1–N4)

Maker closed every item in `roadmap/qa/05-punchlist.md` (details per item there) on top of
`96ac47b`. Regressions: the `QA-05 …` describes in `apps/server/test/unlocks.test.ts` (20 →
33 tests; the reviewer's probes reproduced) and `packages/content/test/unlock-webs.test.ts`
(11 → 14). New: `apps/server/src/util/uuid.ts` (`isUuid`), migration
`006_unlock_node_purchase_shape`. Edited in place: migration 005's comment (N3).

**Signature / behaviour changes other chunks should know about:**

- `TUNABLES.UNLOCK_NODE_COST_BY_TIER` is now `{ living, trap, siege }` (D1: 0/1/4/8/14,
  0/1/3/7/10, 0/1/8/15/21; paid totals 39/39/38, cap reaches ~77–79%). `nodeCost(web, node)`
  takes the web (was `nodeCost(node)`); `GET /unlocks/webs` `costByTier` is the per-pool
  record. New pure exports: `costCurveFor`, `pointsPerPoolAtLadderCap`, `closureCost`,
  `compareCodePoints`. `validateUnlockWebs` now also refuses any node whose closure cost
  exceeds the capped ladder's points. Chunk 06 (web UI) should read costs per pool.
- `AccessOwner.regionId` is optional and never trusted (S2): `hasAccess` /
  `unlockedTypeIds` / `accessCheckFor` resolve `(accountId, caravanId)` against the caravan
  row (region + ownership) and the three purchase lists in one query (`readOwnerSnapshot`,
  exported). A pair that does not resolve, or a caller region that disagrees with the row,
  gets `false` / an empty set, never a throw. Chunk 07's `ownerOf(caravan)` triple is
  unchanged and still valid.
- `isUuid` (`src/util/uuid.ts`) is the one uuid check (S1); `routes/circle.ts` line 37 and
  its import are the only edits outside chunk 05's files. Chunks 09/18 should use it for any
  id taken from a request.
- The storage layer refuses an `unlock_node_purchased` with `cost ≤ 0`, a non-number cost,
  or a missing / empty / non-string `nodeId` (S3, migration 006, 23514). Test fixtures that
  write the event by hand must carry both (chunk 02's `ledger.test.ts` fixture already does).
- `GET /me/unlocks` reads through `unlockWebsSnapshot` (`REPEATABLE READ READ ONLY`; N1).

**Verification** (`cd apps/server && TEST_DATABASE_URL=...caravan_test_f05 npx vitest run`):
17 files, 271 tests passing (+13 over `96ac47b`, all in `unlocks.test.ts`). `pnpm --filter
@caravan/content test` 58 passing; `pnpm --filter @caravan/circle test` 48 passing
unchanged. Root `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary` clean.

**Next:** QA re-audit of chunk 05; then `built` → `QA'd` in INDEX.md (not touched here —
out of this fixer's file set). Chunk 06 consumes the per-pool `costByTier`.

### 2026-10-11 — Chunk 06 (unlock web UI) + web client scaffold: `not started` → `built`

**Built** in a worktree on `c977601` (`roadmap/phase-2-spec`). `apps/web` was a placeholder;
this chunk creates the client scaffold the later client chunks (08, 17, 22, 23, 24) build
on, then the unlock web screen on top of it.

- **Scaffold decisions (settled):** Vite 7 + React 18 + TypeScript strict (`apps/web`,
  extends `tsconfig.base.json` with `moduleResolution: Bundler`, `jsx: react-jsx`). A
  typed `fetch` wrapper (`src/api/client.ts`) — bearer token read from in-memory session
  state on every call, never localStorage/cookies; every non-2xx becomes an `ApiError`
  with the server's exact `{error, message}`; a 401 drops the session. Hand-rolled hash
  router (`src/shell/router.tsx`; four screens do not justify react-router). App shell
  with a fixed 56px bottom tab bar (Town / Trail / Party / Webs; Town/Trail/Party are
  placeholders), header with sign-out. Login/register screen against chunk 01's auth
  routes (register picks a region from `REGIONS`, with the never-swapped hint). Vite
  dev AND preview proxy `/api/*` → `CARAVAN_API_URL` (default `http://127.0.0.1:3000`),
  prefix stripped, so no CORS and the built app sits behind one reverse-proxy rule.
  Strings in `src/strings.ts` only; CSS-variable theme in `src/theme.css` with the
  Okabe–Ito palette; affinity = shape + word, node state = icon + word + border style.
  PWA manifest (portrait, standalone); service worker left to chunk 34. vitest +
  @testing-library/react in jsdom; `@playwright/test` 1.56.1 pinned to the preinstalled
  browsers. `@caravan/content` is imported by the client for display data (public, pure).
- **Chunk 06 screen:** `src/screens/webs/{WebsScreen,WebGraph,NodeCard,NodeDetail,
  PointsPanel,ConfirmDialog,AffinityIcon,catalogue}.tsx|ts`. Pool tabs for living (the
  caravan's region) / trap / siege; whole DAG per pool laid out by tier, every node with
  name, cost (from the node payload — per-pool curves, QA-05 D1), prerequisites by name,
  reached/affordable/locked with the reason (missing prerequisites or points short);
  points granted/spent/available and the next rung's distance and grant per web; scope
  line (account vs caravan/region); bottom sheet with the full stat block on every node
  including locked ones and the access-not-instance copy; unlock button only when the
  server says affordable; modal confirm quoting cost/available/remainder; POST then
  re-fetch (no optimistic update); 409 etc. shown with exact server message and code.
  Details in the chunk file's "Build notes".
- **Root wiring:** `pnpm typecheck` / `pnpm test` are recursive and now include the web;
  `pnpm build` = server esbuild + `vite build`; new `pnpm dev:web`; new `pnpm e2e` =
  `scripts/e2e.mjs` (seeds `E2E_DATABASE_URL`, starts the built server on :3917, runs the
  Playwright smoke through vite preview, stops it). CI: build step renamed, plus
  "Install Playwright Chromium" and "Web smoke e2e" steps after the server smoke, on the
  same seeded test database. AGENTS.md build block updated.

**Test output:** `pnpm --filter @caravan/web test` → 3 files, 9 tests passing.
`pnpm --filter @caravan/web typecheck` and `build` clean (203 kB JS / 65 kB gzip).
`pnpm --filter @caravan/web e2e` against a seeded `caravan_dev_c06` server: 1 passed, two
consecutive runs (1.1s, 0.7s), then `pnpm build && pnpm e2e` end to end: 1 passed. Root
`pnpm typecheck`, `pnpm lint`, `pnpm test:boundary` clean.

**Assumptions / flags for QA:** (1) `WEB_LAYOUT` is a tier-layered layout computed from
the authored node order, not authored coordinates — deterministic, but a deviation from
the chunk's proposed default, recorded in the chunk file. (2) The coordinator's heads-up
about chunk 05 QA's per-pool `costByTier` was applied (client reads `node.cost`; test
fixtures use the per-pool curves), but commit `1fe574f` is not yet on
`roadmap/phase-2-spec`; the screen never calls `GET /unlocks/webs`, so it is unaffected
either way. (3) v1 has one caravan, so the first living web in `GET /me/unlocks` is the
one shown. (4) The e2e runs the built server as the owner DB role locally; CI runs it on
the migrated test database the smoke step already uses.

**Next:** hand to adversarial QA against GUARDRAILS §3/§4 and the chunk checklist — in
particular whether any string reads as "you get a unit", whether anything is hidden on a
locked node, and the direct-API bypass (which chunk 05 covers server-side).

### 2026-10-11 — Chunk 18 (unit acquisition): QA round 1 punch list closed

**Closed** in a worktree on top of `0896b8f` (`roadmap/qa/18-punchlist.md`: D1, D2, S1–S3,
N1–N5 all `[closed]`). Files touched: `apps/server/src/acquisition/{refugees,grant}.ts`,
`routes/acquisition.ts`, `db/types.ts`, migration `007_refugee_menu` (in place: new column),
`test/acquisition.test.ts` (41 → 51), the chunk file, the punch list, this entry.

- **D1 — a free refresh is taken, never pushed.** GET writes only the caravan's first menu
  (bootstrap) and otherwise never; past the timer it reports `timer.freeRefreshDue` and leaves
  an unclaimed menu alone. New free, idempotent `POST /me/caravans/:id/refugees/refresh
  {fromSequence}` takes the owed menu (201; 200 replay; `forfeitedOffers` when the current menu
  was unclaimed; 409 `free_refresh_not_due` / `stale_menu`). A claim of the current menu takes
  it in the same request. A reroll while one is owed is 409 `free_refresh_due`, unpaid.
- **D2 — fixed grid.** `refugee_menu.window_opened_at_ms`: a free menu's grid point
  (`anchor + k·interval`, the latest ≤ now; CHECK `<= generated_at_ms`), copied onto its
  rerolls. 16 menus/day whatever the polling cadence; a week away still yields one menu, on the
  grid. The window-opener row is no longer read.
- **S1/S3** `sequence` / `fromSequence` required and bounded to `1..2147483647` → 400 before
  any query. **N2** `msUntilFreeRefresh` clamped to `[0, interval]`. **N3** `menu_corrupt`
  (409, names the caravan) replaces the bare `Error`s. **N1/N4/N5** documented in the chunk
  file (migration 007; three slots not three types; reroll deliberately cheaper than recruit).
- **Regressions from the reviewer's probes:** golden sha256 of 5 000 draws
  (`c489d769…ec152`, pinned), the `{}` double-tap reroll, the lost-response claim retry
  across a free refresh, the claim landing at 90:01, clock skew, replay of every stored row,
  the junk-request sweep (NUL in a type id, upper-cased ids, non-object bodies).

**Test command:** `TEST_DATABASE_URL=postgres://caravan:caravan@localhost:5432/caravan_test_f18 pnpm --filter @caravan/server exec vitest run`
— see the closing report for the counts. `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary` clean.

**Client note:** the web client (chunk 11 onward) must send `menu.sequence` back on every
mutating refugee call and show a "take your free menu" action when `timer.freeRefreshDue`.

**Next:** QA re-review of chunk 18 against the closed list.

### 2026-10-11 — Chunk 18 (unit acquisition: refugee drip & mercenary recruit): `not started` → `built`

**Built** in a worktree on top of `c977601`. New: `apps/server/src/acquisition/{refugeeMenu,
grant,refugees,recruit,index}.ts`, `apps/server/src/routes/acquisition.ts` (registered in
`app.ts`, append only), migration `007_refugee_menu` (one row per menu ever offered: seed,
the pool drawn from, the offers, `generated_at_ms`, the claim), a chunk 18 block in
`packages/content/src/tunables.ts` (`REFUGEE_REFRESH_INTERVAL_MINUTES` 90,
`REFUGEE_OFFER_COUNT` 3, `REFUGEE_REROLL_COST_SCHEDULE` [150, 300, 600],
`REFUGEE_OFFER_WEIGHTING`, `REFUGEE_OFFER_SEED`, `MERCENARY_COST_BASE` 600,
`MERCENARY_COST_SCALING` "none", `UNIT_INVENTORY_CAP` 200), `RefugeeMenuRow` in
`db/types.ts`, `test/acquisition.test.ts` (41 tests). Changed: `test/migrations.test.ts`
(table list gains `refugee_menu`).

- **Boundary.** `grantUnit` is the only INSERT into `unit_instance` in the module and calls
  chunk 05's `hasAccess` right before it, under the account append lock, inside the
  transaction. Both paths route through it. A hand-crafted request naming a locked node,
  another region's unit, a trap id, or a type nobody has gets 409 `not_unlocked` with nothing
  written — tested per case, exhaustively over every living type outside the reached set with
  the storage cap in Coin, and against a tampered menu row offering a locked type.
- **Refugee drip.** Seed fnv1a32(`<caravan id>:<sequence>`), xorshift32 with rejection
  sampling, partial Fisher–Yates over the pool sorted by id; replayable from the row
  (`replayMenu`). Free timer lazy, one menu per refresh, no stockpiling; a free refresh
  resets the reroll window; rerolls never move the timer and are served AFTER any due free
  refresh. Claim = the pick, no further randomness; one pick per menu; 8 concurrent claims →
  1 instance. 50 rerolls never leave the unlocked pool; unlocking a node through
  `/me/unlocks/spend` is what widens it. Uniformity checked over 20 000 seeds.
- **Mercenary recruit.** Flat 600 via `spendCoin` (+ `unit_acquired` alongside, one cause),
  every unlocked type, always: 10 back-to-back and 6 concurrent purchases succeed; optional
  `requestId` for retry safety. Price list shows locked types as not for sale.
- **Legibility.** Both GETs return everything before commit: offers with display names and
  abilities, the timer, next reroll cost + schedule + affordability, recruit cost per type,
  balance including pending trickle, inventory count/cap.

**Test command:** `cd apps/server && TEST_DATABASE_URL=postgres://caravan:caravan@localhost:5432/caravan_test_c18 npx vitest run`
— 21 files, 367 tests passing (baseline on `c977601`: 20 files, 326). `pnpm typecheck`,
`pnpm lint`, `pnpm test:boundary` clean; `@caravan/content` 55 passing.

**Assumptions made:** listed under "Build notes" in `chunks/18-unit-acquisition.md`. The ones
QA should weigh: (1) acquisition is allowed while the caravan is on a trip (the instance joins
the town roster, never the locked manifest); (2) a free refresh replaces an unclaimed menu
and rerolling forfeits an unclaimed menu — the view flags both; (3) the reroll price holds at
600 past the third reroll until the next free refresh; (4) a pool of fewer than 3 types fills
the extra slots with replacement so a menu is always exactly 3.

**Note for the orchestrator:** during one full run, `qa02-regressions.test.ts` S1/S3 failed
after `migrations.test.ts` had rolled the schema back and forward in the same run (column-level
grants on recreated tables); it did not reproduce in three further runs or in isolation. Not
touched here — flagged as a pre-existing suite-order hazard.

**Next:** hand to adversarial QA against GUARDRAILS §1/§2/§3/§4/§5 and the chunk checklist;
re-run the grind-wall/P2W check on reroll and recruit pricing as chunk 16's QA asked.

### 2026-10-11 — Chunk 09 (standing raid party): `not started` → `built`

**Built** in worktree `agent-a2ac97f2ed890ce31` off `roadmap/phase-2-spec` @ `c977601`.
The passive side, server-side: the party model, its routes, the real party snapshot and
the results feed. Nothing else in the repo touched beyond the append-only edits listed.

- **`packages/circle/src/party.ts`** (pure): `TARGETING_STANCES = nearest | traps | core`
  (a different enum from the formation's defensive stances, on purpose); `PartyConfig` =
  the owner's CHOICES (`{v:1, units:[{ref, stance, edge, cell}], siege:[typeId]}`, refs are
  `unit_instance` ids, each unit its own edge + start cell in that edge's entry band, split
  across all four allowed); `resolveParty(config, roster, isUnlocked)` joins each ref to its
  live type/merge level and returns every issue at once (`slot_cap_units` 8, `slot_cap_siege`
  3, `unknown_ref`, `duplicate_ref`, `duplicate_siege`, `type_locked`, `bad_stance`,
  `bad_edge`, `bad_cell`, `cell_off_band`, `oversized`) or a deep-frozen canonical `Party`
  (units sorted by ref, siege by type — the explicit order the resolver's tie-breaks get);
  `scoutParty(party)` is THE scouting view, one function for the owner's preview and chunk
  14's scout: every unit with both ratings (`ratingInUse: "offense"`, no blended number),
  merged HP, range, cooldown, ability, stance, edge, cell and `pos = cellCenter`, every
  siege piece with `counters`, `effect` (accelerates/bypasses), the multiplier/nullify
  tunable and the exact fence tiers / trap types it hits; `serialize.ts` gained strict
  `partyConfigFromJson` / `serializePartyConfig` / `partyFromJson` / `serializeParty`.
  Import-time coherence assertions (`MAX_APPROACH_EDGES == ENTRY_EDGES.length`,
  `PARTY_EDIT_COOLDOWN_MS == 0`). No-floats source grep covers the new file.
- **Tunables** (`packages/content`): `PARTY_SLOT_CAP` 8 (asserted == `DEPLOYMENT_SLOT_CAP`),
  `SIEGE_SLOT_CAP` 3, `MAX_APPROACH_EDGES` 4, `PARTY_EDIT_COOLDOWN_MS` 0 (fixed by design,
  nothing reads it as a gate), `PARTIES_PER_ACCOUNT` 1.
- **Migration 006**: `standing_party` gets its own `id` (PK), `slot` (unique per account —
  the schema now allows more parties; v1 reads slot 0 only) and `composition` jsonb (shape
  CHECK with `coalesce`, so a missing key cannot pass). Triggers: identity immutable,
  `updated_at` moves iff composition changes (so chunk 02's `savedAt` means "which version
  was served"; the jobs tests' manual `updated_at` edits still work), delete refused while
  the account exists, TRUNCATE refused. **Deliberately no FK from party units to
  `unit_instance`**: a merge or a trip loss removes the instance and the party must then read
  as invalid, not be silently trimmed nor block the roster change. Down deletes non-zero
  slots before restoring the account-id key.
- **Server**: `src/party/{repo,service,feed}.ts`, `src/routes/party.ts` (registered
  append-only in `app.ts`). `GET /me/party` → config, `valid` + issues, resolved `party`,
  `scout` preview, `edges`, caps, `rules` (template / neverConsumed /
  unitsMayAlsoBePackedOnTrips / stances), the roster with `inParty`, `packedOnTrip`,
  `aliveOnTrip`, both ratings and `slotCost: 1`, and the `siegeCatalog` with `unlocked`.
  `PUT /me/party` → free, instant, idempotent; 400 `malformed_party` from the strict parser
  (stance/edge enums named), 400 `invalid_party` + full issue list from resolution; stores
  the canonical config and appends one account-scoped `standing_party_saved`
  (`party_saved:<partyId>:<saveSeq>`, counted under the account append lock). `GET
  /me/party/feed` → `party_served_as_encounter` joined with same-causation Coin / siege
  Reputation / siege ladder events and the defender caravan's name, region and username;
  newest first, `before` cursor. **`snapshotStandingParty`** now resolves the party against
  the live roster + web and freezes `{ownerAccountId, partyId, slot, savedAt, hash,
  composition: Party}`; an unresolvable party throws `StandingPartyInvalidError` (chunk 14
  must re-scout rather than serve a party the defender did not see).
- **Access** reads chunk 05's `accessCheckFor`: living on each instance's caravan, siege
  on the account (union over the account's caravans; exact with one).

**Test command:** `cd apps/server && TEST_DATABASE_URL=postgres://caravan:caravan@localhost:5432/caravan_test_c09 npx vitest run`
→ 21 files, 351 tests passing (baseline on c977601: 20 files, 326). `pnpm --filter
@caravan/circle test` 8 files, 84 (was 64); `pnpm --filter @caravan/content test` 55;
root `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary` clean. New: `packages/circle/test/
party.test.ts` (20) and `apps/server/test/party.test.ts` (25). Covered: fresh party valid
and empty with caps/rules/roster/catalog; full party split across four edges, event
account-scoped, stored canonical, re-PUT in another order a no-op; ninth unit / fourth
siege, bad stance, bad edge, core / interior / wrong-band cells, off-lattice, duplicate
instance and siege, another player's instance (`unknown_ref`, no hint), locked living type
the caravan owns and locked siege by hand-crafted request, unknown siege, unknown keys /
float cell / smuggled hp / array / wrong version, 500-unit body → one `oversized`; twenty
alternating saves all 200 with `saveSeq` 1..20; **the load-bearing check**: one party
served into 12 resolutions by 3 workers under a stand-in handler that annihilates it on
half and credits Coin/Reputation/ladder on the other half — owner's `unit_instance` rows,
`standing_party` row and `GET /me/party` byte-identical, every job holds one identical
snapshot; editing afterwards leaves old jobs' snapshots and serves the new one; feed pages
newest-first with defender/depth/outcome/Coin/Reputation per entry and a defender's own
feed empty; a unit both packed and in the party: packing legal and reported, the unit
dying in the manifest (chunk 07 `applyOutcome`) leaves roster/party/snapshot untouched and
the party rides at full HP, deleting the instance (chunk 19's loss) makes `GET` invalid
with `unknown_ref`, `PUT` 400, snapshot throws, dropping the ref fixes it; a de-merge is
reflected not refused; DB guards against the app role; a source grep that `src/party`,
`routes/party.ts` and `jobs/snapshots.ts` never write `unit_instance` or read Coin /
purchases, and `party/repo.ts` is the only writer of `standing_party`.

**Assumptions** are listed under "Build notes" in `chunks/09-standing-raid-party.md`. The
three that matter most for QA and for chunks 14/19: (1) stored composition is choices only,
stats/levels are joined live, so a lost instance invalidates the party and a de-merge is
simply reflected; (2) the snapshot refuses an invalid party — chunk 14 should resolve and
scout from the same `snapshotStandingParty` it will commit with, and handle the error by
re-scouting; (3) siege types cannot repeat within a party. The visual builder (drag
lattice, touch targets) is chunk 17's town screen; everything it needs is in `GET /me/party`.

**Next:** hand to adversarial QA against GUARDRAILS §0/§2/§3/§4 and the chunk checklist —
especially whether any path can reach `unit_instance` or `standing_party` from the
resolution path, whether the preview and the scout can ever diverge, and whether the
chunk 02 placeholder handler and chunk 14 need the invalid-party error surfaced.

### 2026-10-11 — Chunk 14 (matchmaking & scouting): `not started` → `built`

**Built** in worktree `agent-ab0db9580a484b2ab` off `roadmap/phase-2-spec` @ `f0a2209`
(Merge chunk 09). Picks WHO ATTACKS THE CARAVAN at each encounter and lets the defender
scout every candidate in full before committing. Also settles the chunk 09 QA blocker on
party snapshots (contract recorded in the chunk file's Build notes).

- **Pure core** `apps/server/src/matchmaking/band.ts`: `candidateSeed` (fnv1a32 over
  caravan:trip:index:seq), `escalatedCentre` (+15 per encounter = 5% of the 300 span),
  `bandWidths` (±150 → ±600 by 100), `bandOf`, `authoredAllowance` (floor(L × 0.3/0.7), never
  fewer than needed to reach 3), `sandbagEarnMultiplier` (chunk 04 QA D2 earn floor, fixed-
  point), `selectCandidates` (seeded Fisher–Yates over the sorted eligible pool per widening
  pass, authored cap per pass, then authored-outside-band nearest-first fallback; takes a
  `skipped` set so a skipped invalid party replays). Integer-only; chunk 18's xorshift32 /
  uniformBelow are now exported and reused.
- **Service** `matchmaking/service.ts`: `searchCandidates` (locks the trip row, requires
  n = encounters_resolved + 1, first search immediate, later ones free after
  `REROLL_COOLDOWN_SECONDS` on a caller-supplied `nowMs`, `409 already_chosen` once chosen;
  excludes self + `LinkedAccountsResolver` (v1 stub, `exclusions.ts`) + the account's last 5
  chosen parties; pool = every non-empty slot-0 party joined to owner username/`is_system`
  and SIEGE Reputation, region never read; **snapshots each pick exactly once**, skips
  `StandingPartyInvalidError` with the id recorded and re-draws; stores seed/centre/pool/
  excluded/skipped/candidates), `readCandidates`, `chooseCandidate` (current menu only;
  `stale_candidate` for a rerolled-away id; no live re-resolve), `replaySearch`,
  `enqueueChosenEncounter` — THE CHUNK 15 SEAM: hands the chosen snapshot to
  `enqueueEncounterResolution`'s new optional `party` input, which stores it as-is.
- **Candidate view**: stable 32-hex id, owner {accountId, displayName, authored},
  reputation {rating, band, gapFromCaravan, sandbagEarnMultiplier}, the frozen snapshot and
  `scout = scoutParty(partyFromJson(snapshot.composition))`. The menu carries caravan
  rating/band, centre, escalation applied/perEncounter/nextEncounter, passes, widened,
  usedAuthoredFallback, the reroll gate (time only), chosen, and the rules.
- **Routes** `routes/matchmaking.ts`: `POST /me/caravans/:id/encounters/:n/search` (201),
  `GET …/candidates`, `POST …/choose {candidateId}`; `409 reroll_cooldown` with Retry-After.
- **Migration 009**: `account.is_system`; `trip` (one per manifest, one open per caravan,
  identity immutable, ended frozen, delete refused while the caravan exists);
  `encounter_candidates` (PK trip/index/seq, immutable once inserted except the one-time
  choose, CHECK that the chosen id was offered, partial unique index one chosen per
  encounter, delete refused). `trips.ts` `createTrip` / `endTrip` for chunk 15.
- **Authored cold-start seam (PHASE-2 §25)** `matchmaking/authored.ts`: 12 system accounts,
  3 parties per band for bands 0–3, all regions/stances/edge splits on free starting types;
  ordinary rows via `saveParty`; `pnpm db:seed` calls it (idempotent).
- **Tunables** (chunk 14 block): CANDIDATES_PER_SEARCH 3, REPUTATION_BAND_WIDTH 150,
  _WIDEN_STEP 100, _WIDTH_MAX 600, REROLL_COOLDOWN_SECONDS 180, SELF_EXCLUDE,
  RECENT_OPPONENT_EXCLUSION 5, DIFFICULTY_ESCALATION_BP 500, EMPTY_POOL_BEHAVIOR,
  CANDIDATE_SELECTION_SEED, AUTHORED_PARTY_MAX_SHARE_BP 3000, SANDBAG_EARN_GAP_START 300,
  SANDBAG_EARN_MULT_MIN 0.25.

**Test command:** `cd apps/server && TEST_DATABASE_URL=postgres://caravan:caravan@localhost:5432/caravan_test_c14 npx vitest run`
→ 24 files, 438 tests passing (baseline on f0a2209: 22 files, 405). New:
`test/matchmaking-pure.test.ts` (16: integer band math, escalation, widths, seed, allowance,
earn floor, reproducible/order-independent draw, widening passes, skip set, authored fill and
share over 500 seeds, fallback and short pool, the authored spec set, the no-Coin / no-
availability / no-region source scan) and `test/matchmaking.test.ts` (17: exactly 3 scoutable
candidates with every scout field, scout byte-identical to the owner's preview, cross-region
candidates, auth/404/no_trip/wrong_encounter, reroll 409 + Retry-After + exact boundary +
sequence, stored rows replay, self / linked / recent-5-across-trips exclusion, escalation
across encounters 1–3, choose/idempotent/already_chosen/search-after-choose refused, owner
edits + de-merge + loss after scouting leave `job.input.party` byte-identical to the scouted
snapshot and its scout view, invalid party skipped at generation and recorded while an
invalid-after-scout party is still honoured, stale_candidate, authored fallback on an empty
band with the snapshot shape indistinguishable and system logins refused, authored cap with a
deep live pool, DB guards against the app role). `migrations.test.ts` table list updated.
Root `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary` clean; `packages/content` 58 pass.

**Assumptions** are in the chunk file's Build notes: the snapshot contract (choose never
re-resolves; the brief's "refuse and re-scout" is replaced by skip-at-generation); +15/encounter
reads "5% of band width" as 5% of the full span; the authored cap is a draw-pool cap, not a
served ratio; empty parties are never served; routes under `/me/caravans/…`.

**Next:** hand to adversarial QA against GUARDRAILS §1/§2/§4 and the chunk checklist — the
field-by-field scout comparison, whether any code can re-resolve a party after the search, the
reroll gate's immunity to any Coin surface, and whether chunk 15 can drive
`createTrip → search → choose → commitFormation → enqueueChosenEncounter` without touching
`encounter_candidates` directly.
### 2026-10-11 — Chunk 10 (resolver core): QA round 1 closed (S1–S4, N1–N3; N4 forwarded) — `[resolver-bump]` 1 → 2

Maker closed `roadmap/qa/10-punchlist.md` in an isolated worktree branched from
`roadmap/phase-2-spec` at 1109f4f. **`RESOLVER_VERSION` is now 2**; there is no golden corpus
yet so nothing else gates it (`pnpm determinism`: 6 scenarios, 3 processes × 3 runs agree).
Details per item are in the punch list (`[closed]` marks) and in
`chunks/10-resolver-core.md` § "QA round 1 — closed". What other chunks should know:

- **Movement is leg-parametric** (`UnitState.legX/legY/legLen/legProgress`; position =
  anchor + sign(d) × floor(|d| × progress / len), `tick.ts legOffset`) and smoothing accepts a
  leg only if `losClear(…, LOS_LEG_MARGIN = 2)` holds — a near-corner pass counts as touching
  all three cells. A corner clip is impossible by construction; the landing-cell check plus
  an exact `losClear(prev, next)` stay as a defensive stop-and-replan. **Log format
  unchanged**; `log.ts` now carries the INTERPOLATION CONTRACT chunk 13's renderer must
  follow (the leg rule; `hold` is load-bearing and edge-triggered).
- **Breach price** = `((hits − 1) × cooldownTicks + max(0, cooldownRemaining − 1)) ×
  speedPerTick`, clamped to `BREACH_COST_MAX`. The punch list's "+1 recompute tick" was
  measured and NOT added (phase 2 recomputes before phase 3 moves; a 1-hit breach costs 0
  extra ticks).
- **ROUTE_CHOICE** (`planRoute`, new): the both-ways test exposed that the lattice's Manhattan
  detour price made v1 smash fences it could walk round (a 2-cell sidestep = 4 steps ≈ 54
  ticks on the lattice, 5 ticks on foot). When the best lattice route breaches, the best
  breach-free lattice route is also found and the two *smoothed* routes are compared on
  walked length + breach price; a tie walks round. Residual on the gap-5/6/7 fixtures: two
  single-HP-step cases 8 and 17 ticks slower than optimal (plan aims at gap cell centres);
  the test pins "within one attack cooldown" and exact choices at the ends.
- **`findPath` costs are plain integers**; any finite breach cost is clamped to
  `BREACH_COST_MAX = COST_INFINITE − 1 − STEP_COST`; `COST_INFINITE` remains the callback's
  explicit "cannot breach" (chunk 11's siege hook may still return it).
- **`INPUT_BOUNDS`** (new export, `input.ts`): hp/ratings ≤ 10⁶, speeds/distances ≤ 64 cells,
  durations ≤ 60 s, tickRate ≤ 1000, battle ≤ 1 h, `moveSpeed ≥ tickRate` for every mover,
  every post/trap `pos` inside its `cell`. Content's values sit far inside
  (`packages/circle/test/battlefield.test.ts` pins it). Chunks 11/12: author within them.
- New exports: `BREACH_COST_MAX`, `LOS_LEG_MARGIN`, `INPUT_BOUNDS`, `legOffset`, `planRoute`,
  `routeCost`; `losClear(grid, a, b, margin = 0)` gained an optional 4th parameter.
- Fixtures: `cornerClipScenario()` (the reviewer's seeded `rand4` as literals) and
  `sealed-ring-1e6-hp` joined `scenarios()`.

**Verification:** resolver **64 passing** (was 53; 11 new QA regressions), circle 67, content
58; `pnpm lint`, `pnpm test:boundary`, `pnpm determinism` clean; typecheck clean for
resolver / circle / content / web. Two things NOT mine, left alone: `apps/server` typecheck
fails in `src/acquisition/recruit.ts:79` (chunk 18, commit 3248ffd — region id possibly
undefined), and circle's "QA S8" `performance.now() < 50 ms` assertion flakes under parallel
vitest load (passes 3/3 alone). Reviewer's `probe.ts` (copied to `scratchpad/qa10wt`, import
paths pointed at the worktree, replica interpolator updated to the leg rule): `cannotHappen 0,
crossedBlocked 0, insideBlocked 0, oob 0, revisits 0, maxGroundedStall 0; interpolation
divergences 0; keyframe mismatches 0; model-vs-actual mismatches 2` — both are two units
sharing one segment in `rand53` (46/48 single-hitter breaches tick-exact; the per-unit price
does not model help). `pathprobe.ts`: case 5's 2e6-HP ring is now refused by validation; at
the 1e6 bound the unit breaches (24 hits, target never null); case 10 still prints
`speedPerTick 0` because it bypasses validation (`resolve()` refuses that input).
`AGENTS.md`'s "53 tests" note for the resolver is stale (64) — not edited, outside this task's
file list.

**Next:** QA re-audit of chunk 10 round 1; then chunk 11 may start on RESOLVER_VERSION 2.
### 2026-10-11 — Chunk 06 (unlock web UI) QA punch list: all 17 items closed (`built`, awaiting re-audit)

**Fixed** in a worktree on `e0f32b8` (`roadmap/phase-2-spec`), `apps/web/**` plus the chunk
file and the punch list only. Everything in `roadmap/qa/06-punchlist.md` (B1, S1–S8, N1–N8)
is closed; each item there carries its closure note.

- **Two new scaffold conventions (B1), documented in `apps/web/README.md` for chunk 08 and
  every later screen:** (1) payload guards — `src/api/shape.ts` is a dependency-free
  combinator validator (`string / boolean / integer / literal / nullable / optional / array /
  object`, bounds on numbers and lists); `src/api/shapes.ts` declares a guard per response,
  typed against `types.ts`; `createApi` runs the guard on every 2xx body and raises
  `ApiError(0, "bad_payload", message, detail=path)`. (2) `src/shell/ErrorBoundary.tsx`
  wraps `<Routed>` in `App.tsx` and renders the same `ErrorBox` + Retry (now in
  `src/shell/ErrorBox.tsx`, re-exported from `WebsScreen` so existing imports hold; it takes
  an optional `onRetry`). `ApiError` gained an optional `detail`.
- **A11y (S1–S4):** `ConfirmDialog` portals under `<body>`, inerts everything else, traps
  Tab, restores focus to the opener (`restoreFocusTo` fallback when a successful spend removed
  it); `NodeCard`'s accessible name is its content; pool tabs are a roving-tabindex tablist
  with arrows / Home / End and `aria-controls`; the sheet focuses its heading on open and
  hands focus back to the card on close.
- **Server state only (S7, N8):** no shortfall arithmetic ("Not enough points yet" when
  `missing` is empty and `affordable` false), no remainder in the confirm; tapping Unlock
  re-fetches and opens the confirm only if the fresh read still says affordable; the
  post-spend notice quotes `points.available` from the spend response and the dialog stays
  busy until the re-read lands. `NodeCard` / `NodeDetail` dropped the now-unused `available`
  prop (webs-screen-internal; `WebGraph`'s API is unchanged).
- **S5 typography:** root `100%`, every size rem, floor `0.75rem`, no `text-size-adjust`.
  **S6** kind-aware `accessGranted(kind)`. **N1** hidden source maps. **N2** dashed unmet
  edges. **N3** tier row top padding. **N4** catalogue strings into `strings.ts`. **N5**
  canonical-hash rewrite (`readRoute`), `#/login` → `#/town` when signed in. **N6** dotted
  env + `vite-env.d.ts`. **N7** placeholder `public/icon.svg` in the manifest (real set:
  chunk 34).
- **S8 e2e:** exact costs per pool asserted; a second test registers a fresh account via the
  API, grants 5 trap points by inserting an `unlock_points_granted` ledger event through `pg`
  (new web devDependency, e2e only), runs cancel then confirm → spend → re-fetch in the UI and
  checks `GET /me/unlocks` agrees. `playwright.config.ts` takes `E2E_WEB_PORT` so two
  checkouts can run e2e side by side (`scripts/e2e.mjs` already took `E2E_PORT`).

**Verification (real output):** `pnpm --filter @caravan/web test` → 5 files, 41 tests
passing (was 3 files / 9). `pnpm --filter @caravan/web typecheck` clean; root
`pnpm typecheck` clean (content, resolver, circle, web, server). `pnpm build` clean
(212 kB JS / 68 kB gzip). `E2E_PORT=3961 E2E_WEB_PORT=4261 E2E_DATABASE_URL=…caravan_dev_f06
pnpm e2e` → 2 passed, twice consecutively (5.0 s, 6.4 s). A fixer probe at 360×640 on the
built app: tier label 8 px clear of the first card on every tier at 100% and 150%; unmet
edges `stroke-dasharray: 6 5`, met edges solid; root pref 24 px scales `.node__cost`
13 → 19.5 px; at 150% root: 0 px horizontal overflow, no clipped control, no page errors.

**Not done here:** `roadmap/INDEX.md` (outside this fixer's file set) still says `built`;
the coordinator flips it after the re-audit. One observation for the coordinator, not a
change: `scripts/e2e.mjs` health-checks `/health` on `E2E_PORT` even when its own server
failed to bind, so with another checkout's server already on 3917 it would run the suite
against that server; passing a distinct `E2E_PORT` per checkout avoids it.

**Next:** QA re-audit of chunk 06 against the punch list; then `built` → `QA'd` in INDEX.md.
### 2026-10-11 — Chunk 09 QA round 1 closed: `built` → `QA'd`

Fixer worked in worktree `agent-a6600267a306ed516` off `roadmap/phase-2-spec` @ `017d205`.
Everything in `roadmap/qa/09-punchlist.md` is `[closed]` except **B1**, which is chunk 14's:
its snapshot-at-selection contract is written into the chunk 09 file (snapshot once at
candidate selection, scout from the stored snapshot, `enqueueEncounterResolution` takes
the pre-taken snapshot, invalid parties are dropped at candidate generation);
`enqueueEncounterResolution` and the snapshot call site were not touched.

- **S3** (decision): `standing_party_invalidated` enum value (migration 002 in place, account
  scope) appended under the remover's causation by `standingPartyInvalidationDraft`; merge
  preview reports `consumed.inParty` + `requiresConfirmInParty`; commit 409 `unit_in_party`
  unless `confirmInParty: true`. Chunk 19's `unit_lost_on_wipe` must call the same helper
  (noted in its file).
- **S1** `MAX_ID_LENGTH` 64 in the strict parser; messages name entries by position, ids
  only in a truncated `subject`. **S2** `saveParty` takes the account append lock before
  reading the roster (race test: 6 rounds). **S4** `PARTY_SAVE_RATE_LIMIT_PER_MINUTE` 30
  (`jobs/tunables.ts`), `util/rateLimit.ts`, 429 `rate_limited`; `standing_party.save_seq`
  counter column with a trigger-enforced +1 (migration 008 in place).
- **X1** `resolverInput.ts` no longer scales `defense`; test pins unscaled ratings at
  every merge level. **X2** `coin_transferred_to_defender` → `coin_transferred_to_party_owner`
  (migration 002 in place, events/coin/feed/tests; a test pins code enum == DB enum).
- **N1–N5** done; D1 noted in the chunk file and PHASE-2 §46; D2 recorded; N3 written into
  chunk 13's file (`party_served_as_encounter` carries `partyId`, `partyHash`, `partySavedAt`).
- Files outside the fixer's list touched minimally: `db/types.ts` (`save_seq` on the row
  type), `INDEX.md` status column. Flagged, not changed: the `BattlefieldPost.defense` doc
  comment in `packages/resolver` still says "scaled by merge level" (chunk 10's file); stale
  `coin_transferred_to_defender` mentions in `chunks/02-*.md` and older entries above.

**Test command:** `cd apps/server && TEST_DATABASE_URL=postgres://caravan:caravan@localhost:5432/caravan_test_f09 npx vitest run`
→ see the fixer's report for the run; `apps/server/test/party.test.ts` is 34 tests (was 25),
`packages/circle` 89 (was 84). `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary` clean.

### 2026-10-11 — Chunk 08 (encounter formation UI + shared isometric renderer): `not started` → `built`

**Built** in a worktree branched from `56a4305` (Merge chunk 06), then merged with
`roadmap/phase-2-spec` at `e91c082` (chunk 14) mid-task on the coordinator's instruction,
so the screen is wired to the real matchmaking routes rather than the fixture seam it
started on. Full notes in the chunk file's "Build notes".

- **Renderer** (`apps/web/src/iso`, PixiJS 8.6.6; the ONE isometric scene for chunks 08/17/22):
  pure 2:1 projection + inverse, painter's depth over row+column, lattice snap, camera
  (fit/pan/pinch/wheel/clamp), pure hit test; the island with three inert decorative tiers
  and cliff faces, the flat 32×32 play area, the core, the four anchors as parked wagons;
  lattice overlay visible ONLY while something is dragged (fade; instant under
  reduced-motion); entity layers in depth order; aggro/leash/attack-range as true-radius
  ellipses per stance; entry-band threat tint; open ring positions as soft outlines. Skin
  seam: `SkinRegistry` keyed by type id with placeholder shapes (affinity = shape); sprites
  reserved for chunk 26. Entity positions are world points, so chunk 22 interpolates the
  chunk 10 log straight in (`fixedToWorld`). React wrapper owns every gesture: pan, pinch,
  entity drag, tap-to-place (no hover anywhere), `touch-action: none`.
- **Trail tab** (`apps/web/src/screens/trail`): manifest (07) → candidates (14) →
  search / three fully scouted candidates with the free time-gated reroll countdown /
  choose → formation against the chosen candidate's `PartyScoutView`. Scouting panel shows
  every field of the view (DOM, the text alternative to the canvas). Manifest tray shows
  survivors truthfully (dead/spent/destroyed marked, real HP, fence remaining/on ring/
  destroyed/packed). Fence placement on the 28 ring positions with the budget meter and
  open positions reported per edge against the attacker's approach — never a warning.
  Trap/post placement by drag or tap, the three-stance picker (QA D1), radii drawn while
  dragging. Legality is the server's: no local `validateFormation`; the PUT/commit issue
  lists are shown verbatim. Commit through a real modal (portal, inert shell, focus trap,
  restore) that itemizes everything placed. Every payload shape-guarded → `bad_payload`.
- **Chunk 06 QA conventions adopted:** payload guards, real modal, rem sizes, strings
  externalized, no client-side derivation of server-decided validity.
- **Seed / e2e plumbing:** `seed.ts` honours `SEED_USERNAME`/`SEED_PASSWORD`; `scripts/e2e.mjs`
  seeds a run-unique account, packs via the API and opens the trip with chunk 14's
  `createTrip` SQL (the trip route is chunk 15's), then runs the Playwright flow on the
  real WebGL canvas: search → scout each candidate → countdown visible → choose → drag a
  fence and a rider → Hold → tap-place → save → commit a 27-gap circle → server agrees →
  reload shows it locked.

**Test output:** `pnpm --filter @caravan/web test` → 8 files, 47 tests passing;
`pnpm --filter @caravan/web typecheck` and `pnpm build` clean (486 kB JS / 154 kB gzip
incl. PixiJS); `pnpm e2e` against a migrated `caravan_dev_c08` → 2 passed (smoke 1.0s,
formation 15.7s); root `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary` clean;
`pnpm --filter @caravan/server test` against `caravan_test_c08` → 24 files, 448 tests.

**Not built / flags:** FORMATION_PRESETS deferred (drafts are re-savable). Posted-unit
defense shown merge-scaled to match `toBattlefield`. The canvas is sticky with
`scroll-margin-top` on the screen's content so nothing scrolls under it. The `window.__isoDebug`
handle is a test hook (harmless in production). Pointer capture is deliberately NOT taken
on tray drags: capture re-targets the pointer-up and the browser then fires a `click` on
the chip, undoing the drop's selection. `pnpm e2e` leaves one `e2e_formation_*` account per
run in the e2e database.

**Next:** adversarial QA against the chunk checklist — field-by-field scout coverage against
`PartyScoutView`, "has it drifted into a set-and-forget base editor" (it is per encounter,
keyed by the chosen candidate), gap framing, no blended power number, no Coin surface, and
the direct-API bypasses chunk 07/14 cover server-side.

### 2026-10-11 — Chunk 08 merged into `roadmap/phase-2-spec` (integrator note)

Merged `--no-ff` over chunk 06's QA fixes (f68cd2f) and chunk 09's QA round 1 (9ebbdcb).
Conflicts and how they were resolved:

- **`apps/web/src/api/client.ts`:** HEAD's guard-per-route convention stands —
  `request(method, path, guard, body)`. Chunk 08's own guards (`screens/trail/guards.ts`,
  hand-written) are gone; every chunk 07/14 route now has a guard in `src/api/shapes.ts`
  built from the `shape.ts` combinators (`manifestShape`, `formationShape`, `menuShape`,
  `choiceShape`, `scoutViewShape`). The manifest and formation bodies are parsed by
  @caravan/circle's strict `manifestFromJson` / `formationFromJson` wrapped as guards, so
  `ManifestView.packed/survivors` and `FormationView.formation` ARE circle's `Manifest` /
  `Formation` (types.ts aliases them) and the screens take the validated views directly
  (`TripState` / `FormationState` wrappers removed). `ApiError` carries `detail`, `issues`
  and `body` together: `new ApiError(status, code, message, detail?, issues = [], body = {})`.
- **`strings.ts`:** union; HEAD's `badPayload` / `renderError` wording kept.
- **`INDEX.md`:** HEAD's status column; row 08 → `built` with chunk 08's note.
- **Cross-chunk fix (follow-up commit):** chunk 08 showed a posted unit's defense
  merge-scaled "to match `toBattlefield`"; chunk 09's X1 had already made `toBattlefield`
  hand the resolver the UNSCALED rating (ratings never scale, only HP and damage output —
  `roadmap/qa/03-punchlist.md` B1). `screens/trail/stats.ts` now shows the type's defense
  and the manifest's (merge-scaled) HP; `stats.test.ts` pins both.
### 2026-10-11 — Chunk 14 QA round 1, fixer half: S1, S2, S3, S6, N3, N4, N5 closed; D1–D3 recorded

Fixer worked in worktree `agent-a51623e635a344309` off `roadmap/phase-2-spec` @ `1b8ad8a`
(Record chunk 14 QA punch list). The chunk 25 Maker is closing B1, B2, S4, S5, N1, N2
concurrently in `authored.ts`, band.ts's authored allowance, `routes/auth.ts`, migration
009's `is_system` bits and the seed — none of those were touched here. The one band.ts
change is the gap computation (`gapBeyondBand`), as the split allowed.

- **S1** `enqueueEncounterResolution` requires `party`; the live-snapshot fallback is
  deleted (omitting it throws a TypeError before any write; a snapshot of another owner is
  refused). Chunk 02 tests (`jobs`, `concurrency`, `qa02-regressions`, `party`) take their
  own `snapshotStandingParty` inside the enqueuing transaction.
- **S2** `loadPool` bounds the scan in SQL: `pp.reputation BETWEEN centre ∓
  REPUTATION_BAND_WIDTH_MAX OR a.is_system`; migration 009 adds `pool_progress
  (pool, reputation)` (down drops it). The stored pool is the subset; replay stays exact.
- **S3** `gapBeyondBand(gap, band_width_used)`; every candidate carries
  `reputation.gapBeyondBand` and its `sandbagEarnMultiplier` is computed from it. Tests:
  pure sweep over every width; a ±550 widening pays `FIXED_ONE` where the raw gap would
  have been floored; the fresh-player n = 6 path pays `FIXED_ONE`; the far authored
  fallback is floored and labelled.
- **S6** "From chunk 14" blocks appended to `chunks/15-trip-loop.md` and
  `chunks/19-stakes-and-loss.md` (`applyEarnFloor` named as chunk 19's single apply site).
- **N3** `snapshots.ts` header: skip-at-generation, never re-scout. **N4** client view built
  from `CandidateView` (owner = `{displayName, authored}`), `skippedPartyIds` row-only;
  `snapshot.ownerAccountId` still published (flagged in the chunk file). **N5**
  `authoredShare {authored, of, shareBp, maxShareBp}`; `usedAuthoredFallback` →
  `authoredOutsideBand` in the view only.
- **D1–D3** recorded in the chunk 14 file ("QA round 1"); PHASE-2 §25's QA check amended
  per D3. Punch list items marked `[closed]` / `[recorded]`. `INDEX.md` untouched (the
  coordinator flips the status after the chunk 25 half lands and the re-audit).

**Test command:** `cd apps/server && TEST_DATABASE_URL=postgres://caravan:caravan@localhost:5432/caravan_test_f14 npx vitest run`
→ 24 files, 461 tests passing (was 438; `matchmaking.test.ts` 20, `matchmaking-pure.test.ts`
17). `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary` clean. Observation, not a change:
`packages/circle test/formation.test.ts` "QA S8 … capped at MAX_ISSUES" failed once under
the full parallel `pnpm test` run (timing, 118 ms) and passed on every rerun of the
package alone — a flaky duration assertion, chunk 07's file.

### 2026-10-11 — Chunk 20 (monetization packs, sandboxed): `not started` → `built`

**Built** in worktree `agent-a23c966270f3d0f39` off `roadmap/phase-2-spec` @ `e91c082`
(Merge chunk 14). The weekly storefront with the guardrail side real and the billing side a
loud stub; the minimal cosmetics system from PHASE-2 §28 underneath it.

- **Content** (`packages/content`): `cosmetics.ts` — 24-entry catalog across the five kinds,
  no numeric field on any entry (asserted on load), `reviewNote` per entry; deterministic
  weekly rotation (FNV-1a → xorshift32 Fisher–Yates over the sorted catalog, 1/2/3 ids per
  tier) with `cosmeticOfferWeeks` as the return schedule. `packs.ts` — `packOfferForWeek`
  (price and Coin from the registry, cosmetics from the rotation, `contents` = the exact
  granted list, a two-member union), `weekIndexAt`, `weeklyPayCeiling`, `assertPacksValid`
  (ceiling = sum of tiers; ratio bound). Chunk 20 tunables block, headed **"THE P2W-RELEVANT
  NUMBER IS WEEKLY_PAY_CEILING (60,000), NOT ANY SINGLE TIER"**, with
  `FREE_WEEKLY_EARN_ESTIMATE` 40,000 and its derivation (1.5× at the defaults).
- **Schema** (migration 010): `pack_purchase` (UNIQUE (account, week, tier) = the limit;
  `pack_contents_ok()` CHECK admits only coin/cosmetic entries; `backend = 'sandbox_stub'`
  CHECK; immutable), `cosmetic_ownership` (account-level, `purchase_id NOT NULL`: no cosmetic
  from anywhere but a pack in v1), `cosmetic_equip` (FK to ownership). No FK to or from any
  battle-side table.
- **Server** (`src/store/`): `storeView` (three tiers with purchase state, per-tier and
  combined overflow forecast via chunk 16's `overflowForecast` over balance + pending
  trickle, next week previewed, the sandbox notice, the ceiling block); `purchasePack` (one
  transaction under the account append lock; sandbox "charge"; `appendCoinCredits` with
  `type: "coin_purchased"` — clamped, `overflowDiscarded` recorded on the event and the row;
  ownership rows; 23505 backstop → 409); `listCosmetics` / `equipCosmetic` / `unequipSlot`.
  Routes `/me/store`, `/me/store/purchase`, `/me/store/purchases`, `/me/cosmetics`,
  `/me/cosmetics/equip`, `/me/cosmetics/unequip`. `economy/coin.ts`'s `CoinCreditSpec` gained
  an optional credit `type` (default `coin_earned`); no economy file names `coin_purchased`.
- **Boundary**: `scripts/resolver-boundary-check.mjs` bans `cosmetic(s)` / `pack(s)` and now
  matches a banned word as a file basename too. `packages/circle/test/no-cosmetic-field.test.ts`
  pins at the type level (`@ts-expect-error`) and at runtime that no formation / manifest /
  party / battlefield / resolver input can carry a cosmetic field.

**Test command:** `cd apps/server && TEST_DATABASE_URL=postgres://caravan:caravan@localhost:5432/caravan_test_c20 npx vitest run`
→ 26 files, 472 tests passing (baseline on e91c082: 24 files, 448). New: `store.test.ts` (15),
`store-guards.test.ts` (9, including rotation sha256-compared across two separate Node
processes and the boundary script run as a test). `packages/content` 71 (was 58),
`packages/circle` 90 (was 86), `packages/resolver` 53. Root `pnpm typecheck`, `pnpm lint`,
`pnpm test:boundary` clean.

**Assumptions** (in the chunk file's Build notes): the purchase names the previewed week and
the server re-derives the offer; a repeat tier is a 409, not a replay; the cosmetic grant's
ledger record is the `coin_purchased` event's `cosmetics` payload field (no new enum value —
`ALTER TYPE … ADD VALUE` cannot be used inside the migration transaction that would also
need it); a returning cosmetic is not granted twice; the catalog is placeholder-named art
for chunk 26; no web screen here.

**Next:** hand to adversarial QA against GUARDRAILS §2 (try to reach `pack_purchase` or
`cosmetic_*` from anything that feeds a resolution; try to get a third kind into
`contents`; race the cap with a purchase against a bank), §4 (is every number the store
shows the number the purchase records, including the combined forecast?), and the grind
wall: `WEEKLY_PAY_CEILING` 60,000 against chunk 16's actual numbers, not the estimate.

### 2026-10-11 — Chunk 11 (resolver combat: damage, traps, posted units): `not started` → `built` — `[resolver-bump]` 2 → 3

**Built**, in an isolated worktree (branch `worktree-agent-ab787d08b49b8cb9f`, branched from
`roadmap/phase-2-spec` at 224b72d). **`RESOLVER_VERSION` is now 3.** No golden corpus exists
yet, so nothing else gates the bump (`pnpm determinism`: 10 scenarios, 3 processes × 3 runs
agree). The full rule list — every tie-break, boundary and rounding point — is in
`roadmap/chunks/11-resolver-combat.md` § "Build notes"; what other chunks need to know:

- **Phases 4, 5, 6, 8 are real.** `combat.ts` (formula, DAMAGE_SLOTS, affinity, merge,
  ATTACK_TARGET_SELECTION), `move.ts` (the leg stepping, now shared by attackers and posted
  units, plus trap effects and the per-tick sweep polyline), `traps.ts` (phase 4),
  `posted.ts` (phase 5). `hooks.ts` keeps `abilityPhase` (chunk 12) and `endOfTick`
  (chunk 13) as seams; the loop still runs to the cap.
- **Slots**: dealer's rating → o, receiver's rating → d; an attacker's rating is its
  offense, a post's is its defense. **Rounding**: formula → affinity → merge → siege (fence
  only) → min 1, each floored. **Merge (QA-03 B1)**: `mergeStatMultByLevel[mergeLevel]`
  scales damage OUTPUT and (upstream) max HP, never a rating — **`packages/circle`'s
  `toBattlefield` was scaling `defense` by merge level; it no longer does** (the circle
  test pins the unscaled rating). Chunk 12: abilities multiply the merged hit; nothing in
  them scales with level.
- **REACH**: every range/radius test is `distSq ≤ (radius + unitRadius)²` (attack range,
  aggro, trap trigger); leash and hysteresis are centre-vs-post. Chunk 10's engaged-hold
  moved from attackRange to reach.
- **Simultaneity**: hits land in id order but `alive` holds until phase 8, so a 0-HP unit
  still fires that tick; mutual kills are tested. **Death**: `unit_died`, `diedTick` in the
  summary; attackers retarget / guards disengage on the next tick.
- **Traps**: swept polyline (corners included) vs (trigger + unitRadius)², floored closest
  point; attackers in id order then traps in index order; spent when sprung, nullified by
  countering siege (still spent); slow/root in ticks, refresh-not-stack, with a new `speed`
  log event (in force from the next tick; legs are never restarted). **The replay contract
  in `log.ts` gained the `speed` clause and posted-unit movement** — chunk 13's renderer
  must honour both.
- **Posted stances** (chunk 07 QA D1): `hold` never moves and hits in reach from its post;
  `reserve` ignores everything (no acquire, **no attack**) until an attacker's cell is
  strictly inside the ring (`released`), then guard; `guard` = idle / pursuing / returning
  with an INCLUSIVE leash, aggro from the unit, leash from the post, hysteresis 0.80 before
  re-acquiring, every disengage (`leash` | `lost` | `dead`) returning to the post, breach-
  free routes (null route = stand and keep pursuing, no chatter). Oscillation at the leash
  is bounded and in the corpus.
- **Input**: `ResolverTunables` gained 8 keys (affinity mults + matrix, merge table, trap
  trigger radius, siege fence mult, leash hysteresis); content gained
  `LEASH_HYSTERESIS_MULT`; circle's `resolverTunables()` builds them. `INPUT_BOUNDS.maxMult`
  ×64, `maxMergeLevels` 16. Chunk 13's stored-input snapshots carry all of it.
- **Log events** new: `speed`, `trap_fired`, `trap_nullified`, `aggro`, `disengage`,
  `returned`, `released`, `hit`, `unit_died`; keyframes carry `cd` / `slow` / `root`.
- **Budgets** (`test/budget.test.ts`, 16 v 8 v 28 fences + 6 traps + 2 siege, 3600 ticks):
  resolve ≈ 70–80 ms best-of-7 (asserted < 100 ms; median under the parallel vitest load
  78–95 ms, which is why the check asserts the best run — the same contention flake chunk
  10 QA saw in circle's timing test). **Log 115.5 KB, of which keyframes are 89 KB** and all
  combat events ≈ 25 KB: the 100 KB lever is the keyframe (QA-10 N4, already with chunk 13),
  not the event stream.

**Verification:** resolver **119 passing** (9 files; `combat` 19, `traps` 15, `posted` 18,
`budget` 3 new), circle 87, content 58; `pnpm typecheck`, `pnpm lint`, `pnpm test:boundary`
(15 src files), `pnpm determinism` clean. Server: no source change (it reads
`RESOLVER_VERSION` symbolically; `toBattlefield`'s defense change is a circle-side data
fix). AGENTS.md's resolver test count updated (119).

**Assumptions / decisions for QA:**
- `reserve` does not attack before release ("ignores every attacker" read literally); the
  D1 note's "target selection is the same for all three" is honoured after release.
- An enemy in reach beats the fence a unit is breaching (ATTACK_PRIORITY); the breach price
  stays an estimate.
- Trap trigger uses trigger radius + unitRadius (the REACH rule applied uniformly), so the
  effective radius is 1.1 cells with content's defaults.
- Posted units route around fence only (no breach edges) and keep pursuing when no route
  exists rather than disengaging, to avoid per-tick chatter.
- `SIEGE_TRAP_NULLIFY` is not carried as input (content marks it fixed by design).

**Next:** hand to adversarial QA against the chunk's checklist — especially the slot rule by
hand-calculation, the exact-boundary tests (leash, aggro, reach, ring cell), the trap sweep
at high speed, and whether anything in `posted.ts` / `combat.ts` reads beyond `state` and
`log`.
### 2026-10-11 — Chunk 25 (cold-start content: authored standing parties): `not started` → `built`

**Built** in worktree `agent-ad0a505821b382d9a` off `roadmap/phase-2-spec` @ `1b8ad8a`
(Record chunk 14 QA punch list). Grows chunk 14's 12-party seam into the full authored set
and closes the six chunk 14 QA items assigned to this chunk (B1, B2, S4, S5, N1, N2 —
`roadmap/qa/14-punchlist.md`, all `[closed]`).

- **The set** (`apps/server/src/matchmaking/authored.ts`, names and flavour in
  `authoredOutfits.ts`): 96 parties, 12 per display band for bands 0–7 — the band list is
  derived from `REPUTATION_FLOOR` (100) and the new tunable `AUTHORED_REPUTATION_CEILING`
  (2200), never listed. Per band: three parties per region, each region with a 1-, 2- and
  4-edge split; four stance patterns (all-nearest, all-traps, all-core, mixed); a siege
  loadout from a ladder of twelve combos gated by band. Size (3→8), merge level (1→5),
  living tier (0→4) and siege count rise with the band. Validated on first use: every band
  full, every rating in band and above the floor, every party reachable within one capped
  ladder per pool, every region / stance / edge split per band, every siege piece and
  every living type somewhere in the set, usernames unique and ≤ 32 chars, no Indigenous
  content (test regex over the outfit table).
- **No bypass (GUARDRAILS §3).** A system account reaches its types the ordinary way:
  `ladder_progress_gained` + `unlock_points_granted` per rung, then `spendUnlockPoints`.
  Ratings go through `reputation_changed` (14-S5). `verifyProjection` is `ok` for all 96.
- **Unmistakably system.** `is_system` set at creation and permanent (migration 010
  trigger: false→true only while the account owns no caravan and has no events; never
  true→false — 14-N1); login 401 whatever the password (14-B1); `sys_outfit_` reserved at
  registration (14-N2); zero Coin and **no credit path**: `appendCoinCredits`,
  `creditPartyWin`, `creditBankedTrip` and the trickle throw `SystemAccountCreditError`
  (`economy/systemAccount.ts`), and a `ledger_event` BEFORE INSERT trigger refuses any
  Coin-credit row for a system account even as a hand-written insert. Chunk 19 routes
  `is_system` owners around the credit (destroy + record), it does not catch the error.
- **Retire by ratio, two stages.** Chunk 14's draw-pool cap stays, now with 14-S4: authored
  parties join narrower passes by ratio only and fill the menu only at the widest pass.
  New second stage: the authored share of the SERVED encounters in a band (chosen rows in
  `encounter_candidates` whose centre fell in the band, most recent
  `AUTHORED_SERVED_SHARE_WINDOW` = 40) over `AUTHORED_PARTY_MAX_SHARE_BP` scales every
  by-ratio allowance by `AUTHORED_OVER_SHARE_WEIGHT_BP` (2500, floored) — never below what
  fills the menu at the widest pass. Measured at search time (`authoredShare.ts`), stored on
  the menu row (`encounter_candidates.authored_served`, immutable), replayed from it;
  `CandidateMenuView.authoredServed` publishes it. Integer-only; tests prove it triggers
  after two authored encounters, weights the allowance 5 → 1, and releases at 2 of 7.
- **Content-drop hook.** `seedAuthoredParties` is idempotent and versioned:
  `AUTHORED_SET_VERSION` + a per-spec hash in the new `authored_party` table; a changed spec
  is applied in place (`applyAuthoredSpec`: rating delta, further rungs/nodes, roster
  rebuilt, party re-saved, same party row). Test applies a modified spec, then the seed
  reports it `updated` and restores it.
- **Migration 010** (`authored_parties`): the two triggers, `authored_served` column (+
  the stored-menu guard extended to it, + an index), `authored_party` table. **Migration
  009 down** now refuses while system accounts exist (14-B2); the test suite's global
  setup empties `account` before its schema reset.
- **Files outside the chunk's own:** `routes/auth.ts` (B1, exactly as allowed),
  `services/onboarding.ts` (N2), `economy/coin.ts` + `trickle.ts` (the credit guard),
  `db/types.ts` (`is_system` on `AccountRow`), `test/global-setup.ts`, and a deliberately
  minimal edit to `matchmaking/service.ts` (compute + store + replay the served share;
  `authoredServed` on the view) — the chunk 14 fixer owns the rest of that file. Chunk 14's
  tests updated for S4 (fresh-database menus now fill at ±600) and the 96-party seed
  (one 60 s test timeout).

**Verification (real output):** `cd apps/server && TEST_DATABASE_URL=…/caravan_test_c25
npx vitest run` → see the Maker's report; `test/authored.test.ts` 10 tests (seed of 96
parties ≈ 7.5 s), `matchmaking-pure.test.ts` 21. `pnpm typecheck`, `pnpm lint`,
`pnpm test:boundary` clean.

**Next:** adversarial QA of chunk 25 against GUARDRAILS §0/§1/§3 and PHASE-2 §25's checks
(amended per 14-D3); chunk 24 (onboarding) and chunk 19 (destroy Coin lost to `is_system`
owners) build on this.

### Orchestrator note — model switch after a rate limit

The session's model limit was reached mid-batch; four agents stopped (chunk 17 Maker, chunk 20
fixer, chunk 08 and chunk 11 reviewers). The session moved to a different model. The two
Makers were relaunched inside their existing worktrees so their uncommitted work carries over;
the two reviews restarted from scratch because they had only begun reading. Commits from here
on carry the new model's Co-Authored-By trailer. Chunk 25 merged at ecbc300 with its authored
migration renumbered to 011 (010 is the store).
### 2026-10-11 — Chunk 20 (monetization packs): QA round 1 closed (D1–D3, S1, S2, N1–N4)

Punch list `roadmap/qa/20-punchlist.md`, every item `[closed]`.
- **D1** a repeat of a tier in the same week → 200 `{replayed: true}` with the stored purchase
  view and stored `coin_purchased` event (also the 23505 backstop's answer); nothing moves.
- **D2** reserve → charge → credit + settle: `pack_purchase` is born a reservation
  (`sandbox_receipt` NULL, nothing credited, new `settled_at` NULL) and settled in place once —
  the only UPDATE its guard admits (migration 010 edited in place: CHECK
  `pack_purchase_settlement` replaces `pack_purchase_coin_accounted`). The backend is charged
  with `idempotencyKey = causationId`; the stub's receipt is a pure function of the key; an
  unsettled reservation is resumed with the same key. The rule is written in `store/sandbox.ts`.
- **D3** `FREE_WEEKLY_EARN_ESTIMATE` stays 40,000, documented as the floor of a 39k / 94k / 118k
  range with the cap-bounds-the-paid-add note.
- **S1** `accrueTrickleTx(…, { force: true })` after the lock, before `appendCoinCredits`;
  `trickle` in the result; probe P1 (NOW + 2 h) is a test: forecast == recorded credit.
- **S2** `contentsHash` (sha256 of `canonicalPackContents`) on every offer; required by
  `POST /me/store/purchase` (400 `contents_hash_required` / `invalid_contents_hash`, 409
  `offer_changed`). The rotation is now per-cosmetic (`rotationRank(week, id)` ordering), so a
  catalog addition never re-deals a week; **the week-0 pin was changed deliberately** (old pin
  kept in the test comment; no purchase existed under the old draw).
- **N1** `pack_contents_ok`: exactly one coin entry, amount > 0. **N2** review notes carry
  reviewer/date or "pending art review (chunk 26)" (validated on load). **N3** purchase.ts
  documents `payload.cosmetics` = offered ids, rebuild = "first event naming an id owns it"
  (tested against `cosmetic_ownership`). **N4** `isPackTier` documented as integer equality.

Tests: `apps/server` 27 files / 497 passing (new `qa20-store-regressions.test.ts`, 12 — the
reviewer's probe P1–P5 as regressions); `packages/content` 75. `pnpm typecheck`, `pnpm lint`,
`pnpm test:boundary` clean. INDEX.md status left for the orchestrator.
