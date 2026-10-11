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

