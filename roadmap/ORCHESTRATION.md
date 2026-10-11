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
