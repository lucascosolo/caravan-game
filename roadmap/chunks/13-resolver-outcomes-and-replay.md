# Chunk 13 — Resolver outcomes & replay

**Depends on:** 12. **Status:** not started.
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

- **Log format, given continuous movement.** At 20 ticks/second for up to 180 seconds
  with ~20 entities, a naive per-tick position dump is far too large to store per
  raid. The log must therefore record **events and waypoints**, not per-tick state:
  *"unit 7 begins moving toward (x,y) at tick 412 at speed s"*, *"unit 7 attacks
  unit 3 at tick 480 for d"*, *"fence segment 12 breaks at tick 495"*, *"unit 4 fires
  ability at tick 500 affecting units 8, 9"*. The renderer **interpolates between
  waypoints**.
  This still satisfies the design: interpolation is not simulation. The renderer makes
  no decisions, resolves no combat, and cannot change an outcome — every decision and
  every number is already in the log. If the renderer ever has to decide *what
  happens*, rather than *where to draw something between two known points*, the format
  has crossed the line and must be fixed.
- Emit a **periodic full-state keyframe** (every few seconds) so playback can seek and
  so a corrupted or truncated log is detectable rather than silently misrendered.
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
| `TICK_RATE` / `TICK_CAP` | 20/sec, 3,600 ticks (180s) | From chunk 10. Stalemate threshold. |
| `DEPTH_METRIC` | fraction of the straight-line distance from the start edge to the core that the deepest attacker reached, plus fence segments broken and garrison units killed | Needs to be a legible, previewable notion of "depth" — the player should be able to reason about partial success. Keep it simple enough to explain in one sentence in the UI; a composite that can't be previewed defeats the purpose. |
| `PARTIAL_LOOT_CURVE` | `loot = full_loot × depth_fraction^1.5`, floored at 0 | Sub-linear, so a near-miss is worth meaningfully less than a clear but not nothing. |
| `STALEMATE_LOOT` | 0 for the attacker | Favors the defender. |
| `STALEMATE_REPUTATION` | treated as an attacker loss (chunk 04's loss values) | |
| `FULL_CLEAR_LOOT` | 100% of the stop's Coin value (chunk 16) | |
| `LOG_FORMAT` | versioned; event + waypoint records, not per-tick state | Renderer interpolates between waypoints. Must be self-sufficient for playback. |
| `LOG_KEYFRAME_INTERVAL` | every 5 seconds (100 ticks) | Enables seeking and detects truncation. |
| `LOG_SIZE_BUDGET` | 100 KB per raid, compressed | If a typical fight exceeds this, the format is wrong — revisit before shipping, not after storage bills arrive. |
| `LOG_RETENTION` | 30 days or last 50 raids per caravan, whichever is larger | Storage guard; tunable. |

## Definition of done

- [ ] All three end conditions implemented and distinguishable in the output.
- [ ] Depth-scaled loot on a wipe; full loot on a clear; nothing on a stalemate.
- [ ] Event/waypoint log emitted during resolution, sufficient to render the whole
      fight with no re-simulation. A replay renderer is fed only the log and produces
      the same sequence of events.
- [ ] Keyframes emitted at a fixed interval; playback can seek to any of them.
- [ ] A typical fight's log fits the size budget; measure it, don't assume.
- [ ] The renderer makes no decisions — a test or review confirms it only interpolates
      between known points and never resolves combat, targeting, or death.
- [ ] Log stored with the layout snapshot, loadout snapshot, and resolver version.
- [ ] Both attacker and defender can retrieve and watch the replay of a raid they
      were part of.
- [ ] Resolver still pure; log emission does not introduce I/O into the resolver
      (emit into a returned structure, don't write to disk from inside).
- [ ] **Full determinism harness, and this is the deliverable that matters most:**
  - [ ] Same input × 100 runs → byte-identical logs.
  - [ ] Same input across separate processes → identical.
  - [ ] A corpus of at least 50 varied fixture scenarios (gapped camps, full rings,
        all three stances, siege counters matched and mismatched, all six ability
        archetypes, all three end conditions, boundary cases from chunks 11 and 12)
        with **golden logs checked in**.
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
- **Interpolation has not become simulation:** examine the renderer specifically. Does
  it ever decide *what happens* — who gets hit, when a unit dies, where a unit turns —
  rather than only *where to draw something between two known points*? Anything the
  renderer decides is a decision that can diverge from the authoritative outcome, and
  is the exact failure the "nothing is re-simulated" rule exists to prevent.
- **Log completeness:** truncate a log mid-fight and confirm playback fails loudly
  rather than rendering a plausible-looking wrong fight.
- **Tick-resolution edge cases:** confirm all of chunk 11's and chunk 12's boundary
  scenarios are in the golden corpus, not just in transient tests.
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
