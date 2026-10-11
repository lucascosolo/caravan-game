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

