# Chunk 02 — Event ledger & job queue

**Depends on:** 01. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Build the two pieces of infrastructure every later system writes through: an
append-only event-sourced ledger, and a job queue that resolves raids/trip stops
one shot at a time. Nothing continuous, nothing always-on.

## Design constraints that apply here

- **Event-sourced ledger** for trades, Reputation, Coin, and outcomes. It supports
  the "provably fair" claim and clean replay generation. Events are **append-only** —
  no updates, no deletes. Current balances are projections over the log, and any
  balance must be reconstructible by replaying the log from zero.
- **Job queue for pending raids/trip stops, rather than an always-on tick engine.**
  Ticking happens once, instantly, server-side, per resolution call — not
  continuously. Do not build a game loop, a scheduler tick, or a persistent world
  simulation. Nothing "runs" between requests except the passive Coin trickle
  (which is computed lazily from elapsed time, not by a background tick — see chunk 16).
- **Determinism extends to the queue.** Two resolutions of the same job must produce
  the same event stream. A job must be **idempotent**: retrying a job that already
  committed must not double-apply its effects. Use a deterministic job id derived
  from the trip/stop identity, not a random one.
- **Concurrency is a known hazard** and is on the QA checklist: simultaneous trip
  resolutions, and concurrent raids against the same camp. Handle it here, once,
  rather than letting each later chunk invent its own locking.
- Event payloads must record enough to regenerate the outcome: the loadout, the
  layout snapshot, and the resolver version. A defender editing their camp after
  a raid must not change what that raid's replay shows.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `JOB_MAX_ATTEMPTS` | 3 | Retries before a job is parked for inspection. |
| `JOB_VISIBILITY_TIMEOUT_MS` | 30,000 | Lease window for an in-flight job. |
| `CAMP_LOCK_MODE` | row-level advisory lock on caravan id | Prevents concurrent raids corrupting shared state. |
| `LEDGER_SNAPSHOT_INTERVAL` | every 500 events per account | Projection checkpointing; purely a perf knob. |

## Event types to define now

At minimum, so later chunks slot in rather than inventing shapes:
`coin_earned`, `coin_spent`, `coin_lost_on_wipe`, `coin_transferred_to_defender`,
`coin_purchased`, `reputation_changed`, `ladder_progress_gained`,
`unlock_points_granted`, `unlock_node_purchased`, `unit_acquired`, `unit_merged`,
`unit_demerged_on_death`, `unit_lost_on_wipe`, `trip_started`, `stop_resolved`,
`trip_banked`, `trip_wiped`, `camp_layout_saved`, `camp_shield_applied`.

Each carries: account id, caravan id (nullable per the split), timestamp, a
deterministic causation id linking it to the job that produced it.

## Definition of done

- [ ] Ledger is append-only and enforced as such at the storage layer.
- [ ] Balances (Coin, Reputation, ladder) are projections; a rebuild-from-zero
      command exists and produces identical results to the live projection.
- [ ] Job queue: enqueue, lease, complete, retry, park. No background ticking.
- [ ] Jobs are idempotent — replaying a completed job commits nothing new. Prove it
      with a test that runs the same job twice.
- [ ] Concurrent raids against the same camp serialize correctly; a test drives two
      at once and asserts a consistent final state.
- [ ] Two trips resolving simultaneously for the same account do not interleave
      into an inconsistent state.
- [ ] Resolution jobs snapshot the defender layout so later edits don't alter history.
- [ ] The resolver version is recorded on every resolution event.

## QA guardrail checks for this chunk

- **Race conditions in the job queue:** simultaneous trip resolutions; concurrent
  raids against the same camp. Drive these deliberately, not just by inspection.
- **Determinism:** does anything in job scheduling, ordering, or retry leak
  nondeterminism into an outcome? Is any job id, ordering key, or tie-break derived
  from wall-clock or randomness?
- **Idempotency:** force a retry after a partial commit. Does Coin double-credit?
  Does a unit die twice?
- **Immutability:** attempt to update and delete ledger rows through every path.
- **Account/caravan split:** every event must carry the correct scope — a
  living-unit ladder event with no caravan id, or a trap ladder event with one, is a bug.
