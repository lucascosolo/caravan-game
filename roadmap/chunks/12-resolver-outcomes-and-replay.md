# Chunk 12 — Resolver outcomes & replay

**Depends on:** 11. **Status:** not started.
Read `/roadmap/GUARDRAILS.md` in full first.

## Goal

Close out the resolver: end conditions, depth-scaled loot, the tick log that **is**
the replay, and the full determinism test harness that every future change is
checked against.

## Design constraints that apply here

**End conditions — exactly three:**

- **Full party wipe** → raid fails this stop, **loot scaled to depth reached**.
- **An attacker reaches the caravan core** → full clear, full loot/Reputation for
  this stop.
- **Tick cap reached with neither outcome** → **stalemate, favors the defender**
  (this is the safety valve against infinite kiting).

**Replay:**

- **The resulting tick log doubles as the replay both players can watch afterward;
  nothing is re-simulated for playback.** The log is the authoritative artifact. A
  replay player renders it; it must never call the resolver again.
- This supports the "provably fair" claim: the log plus the inputs is a complete,
  checkable account of what happened.
- The log must be stored alongside the **layout snapshot and loadout snapshot** used
  (chunk 02), so a defender editing their camp afterwards doesn't alter history.
- Record the **resolver version** on every log. A resolver change must not silently
  invalidate old replays — either keep old versions renderable or mark them explicitly.

**Both players can watch.** The attacker sees how their raid went; the defender sees
who raided them and how they did it — this asynchronous tension is one of the two
founding hooks of the game and the replay is how it's delivered. A log that only
serves the attacker misses half the point.

## Tunables this chunk needs (defaults proposed — all tunable)

| Name | Default | Note |
|---|---|---|
| `TICK_CAP` | 600 | From chunk 10. Stalemate threshold. |
| `DEPTH_METRIC` | fraction of the straight-line distance from the start edge to the core that the deepest attacker reached, plus fence segments broken and garrison units killed | Needs to be a legible, previewable notion of "depth" — the player should be able to reason about partial success. |
| `PARTIAL_LOOT_CURVE` | `loot = full_loot × depth_fraction^1.5`, floored at 0 | Sub-linear, so a near-miss is worth meaningfully less than a clear but not nothing. |
| `STALEMATE_LOOT` | 0 for the attacker | Favors the defender. |
| `STALEMATE_REPUTATION` | treated as an attacker loss (chunk 04's loss values) | |
| `FULL_CLEAR_LOOT` | 100% of the stop's Coin value (chunk 15) | |
| `LOG_FORMAT` | versioned, compact, per-tick deltas rather than full state snapshots | Keep it small; a 600-tick full-state log per raid adds up. Must still be self-sufficient for playback. |
| `LOG_RETENTION` | 30 days or last 50 raids per caravan, whichever is larger | Storage guard; tunable. |

## Definition of done

- [ ] All three end conditions implemented and distinguishable in the output.
- [ ] Depth-scaled loot on a wipe; full loot on a clear; nothing on a stalemate.
- [ ] Tick log emitted during resolution, sufficient to render the whole fight with
      no re-simulation. A replay renderer is fed only the log and produces the same
      sequence of events.
- [ ] Log stored with the layout snapshot, loadout snapshot, and resolver version.
- [ ] Both attacker and defender can retrieve and watch the replay of a raid they
      were part of.
- [ ] Resolver still pure; log emission does not introduce I/O into the resolver
      (emit into a returned structure, don't write to disk from inside).
- [ ] **Full determinism harness, and this is the deliverable that matters most:**
  - [ ] Same input × 100 runs → byte-identical logs.
  - [ ] Same input across separate processes → identical.
  - [ ] A corpus of at least 50 varied fixture scenarios (gapped camps, full rings,
        all three stances, siege counters matched and mismatched, all three end
        conditions, boundary cases from chunk 11) with **golden logs checked in**.
        Any resolver change that alters a golden log must be an explicit, reviewed
        decision — not a silent diff.
  - [ ] A harness command a QA session can run in one line.

## QA guardrail checks for this chunk

- **Determinism, comprehensively:** this is the last chunk where determinism can be
  established cheaply. Run the full harness. Then try to break it: change process
  start order, run under load, run on a different machine. Byte-compare.
- **Replay fidelity:** does the replay ever diverge from the recorded outcome? Is
  anything re-simulated at playback time? Does a defender editing their camp after
  the raid change what the replay shows? All three are hard bugs.
- **Tick-resolution edge cases:** confirm all of chunk 11's boundary scenarios are in
  the golden corpus, not just in transient tests.
- **Stalemate favors the defender:** verify the attacker gains nothing on a tick-cap
  outcome. If a kiting strategy can extract value from stalemates, the safety valve
  has failed.
- **Bounded stakes:** does depth-scaled loot ever exceed full-clear loot? Can any end
  condition produce more Coin than the stop is worth?
- **The founding hook:** can the defender actually see **who raided them and how they
  did it**? That asynchronous tension is one of the two hooks the whole game is
  anchored on. A replay that's attacker-only is a design regression, not a missing
  nice-to-have.
- **No pay-to-win:** the resolver still cannot see entitlement state.
