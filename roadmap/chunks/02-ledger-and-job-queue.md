# Chunk 02 — Event ledger & job queue

**Depends on:** 01. **Status:** built.
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
  from the trip/encounter identity, not a random one.
- **Concurrency is a known hazard** and is on the QA checklist: simultaneous trip
  resolutions; the same standing raiding party being served into several players'
  encounters at once; and a party edited by its owner while it is mid-resolution in
  someone else's trip. Handle it here, once, rather than letting each later chunk
  invent its own locking. Note that a standing party is **read-only during
  resolution** — it is a snapshotted template, never mutated by a fight — so the
  contention is over reading a consistent snapshot, not over shared mutable state.
- Event payloads must record enough to regenerate the outcome: the formation, the
  snapshotted attacking party, and the resolver version. A party's owner editing it
  after a fight must not change what that fight's replay shows.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `JOB_MAX_ATTEMPTS` | 3 | Retries before a job is parked for inspection. |
| `JOB_VISIBILITY_TIMEOUT_MS` | 30,000 | Lease window for an in-flight job. |
| `TRIP_LOCK_MODE` | row-level advisory lock on caravan id | Serializes encounter resolutions within one trip. Standing parties need no lock — they are snapshotted and never mutated by a fight. |
| `LEDGER_SNAPSHOT_INTERVAL` | every 500 events per account | Projection checkpointing; purely a perf knob. |

## Event types to define now

At minimum, so later chunks slot in rather than inventing shapes:
`coin_earned`, `coin_spent`, `coin_lost_on_wipe`, `coin_transferred_to_defender`,
`coin_purchased`, `reputation_changed`, `ladder_progress_gained`,
`unlock_points_granted`, `unlock_node_purchased`, `unit_acquired`, `unit_merged`,
`unit_demerged_on_death`, `unit_lost_on_wipe`, `trip_started`, `stop_resolved`,
`trip_banked`, `trip_overrun`, `encounter_resolved`, `formation_committed`,
`standing_party_saved`, `party_served_as_encounter`.

Each carries: account id, caravan id (nullable per the split), timestamp, a
deterministic causation id linking it to the job that produced it.

## Definition of done

- [ ] Ledger is append-only and enforced as such at the storage layer.
- [ ] Balances (Coin, Reputation, ladder) are projections; a rebuild-from-zero
      command exists and produces identical results to the live projection.
- [ ] Job queue: enqueue, lease, complete, retry, park. No background ticking.
- [ ] Jobs are idempotent — replaying a completed job commits nothing new. Prove it
      with a test that runs the same job twice.
- [ ] The same standing party served into many concurrent encounters resolves
      correctly and identically in each, and is never mutated; a test drives several
      at once and asserts the party is byte-identical afterward.
- [ ] Two trips resolving simultaneously for the same account do not interleave
      into an inconsistent state.
- [ ] Resolution jobs snapshot both the formation and the attacking party so later
      edits by either side don't alter history.
- [ ] The resolver version is recorded on every resolution event.

## QA guardrail checks for this chunk

- **Race conditions in the job queue:** simultaneous trip resolutions; one standing
  party served into many encounters at once; a party edited mid-resolution. Drive
  these deliberately, not just by inspection.
- **Determinism:** does anything in job scheduling, ordering, or retry leak
  nondeterminism into an outcome? Is any job id, ordering key, or tie-break derived
  from wall-clock or randomness?
- **Idempotency:** force a retry after a partial commit. Does Coin double-credit?
  Does a unit die twice?
- **Immutability:** attempt to update and delete ledger rows through every path.
- **Account/caravan split:** every event must carry the correct scope — a
  living-unit ladder event with no caravan id, or a trap ladder event with one, is a bug.
