# Chunk 10 — QA punch list (merge 068f45a / ce977be)

No blockers. Probes at scratchpad/qa10 (run.sh, probe.ts, hash.ts, perf.ts, pathprobe.ts, tie.ts).

## Should-fix
S1. Breach cost over-states real breach time by one attack cooldown (tick.ts:169-176 vs attackPhase 280-291): model `hits × cd × spd`, actual `(hits−1) × cd` (+1 recompute tick). 41/41 observed breaches mismatch. Price the edge as `max(0, hits−1) × cooldownTicks × speedPerTick` + the unit's current `cooldownRemaining` + 1 recompute tick; add a test that resolves a fixture both ways and asserts the chosen route matches the cheaper measured time.
S2. A moving unit can clip through an intact fence cell's corner within one tick (tick.ts:233-245 checks only the landing cell). Step parametrically along the leg's anchor→waypoint line (store the anchor; position = anchor + d·k/len), or check `losClear(prev, next)` and stop-and-replan on failure. Pin the `rand4` seed as a fixture.
S3. Breach cost ≥ COST_INFINITE silently makes a breakable fence a wall (path.ts:116-118); unit stands still all fight. Clamp the breach edge to `COST_INFINITE − 1 − STEP_COST` (passable but expensive) and reserve COST_INFINITE for anchors; also bound hp/cooldown/speed in `assertResolveInput` so the product fits. Test.
S4. `moveSpeed < tickRate` floors speedPerTick to 0 (state.ts:157); bound `moveSpeed ≥ tickRate` in `assertResolveInput` and assert content's slowest unit clears it.

## Nits
N1. Waypoint landed-on-but-not-consumed wastes a tick (tick.ts:241-243): treat `isqrt(d2) <= remaining` as arrival.
N2. Document in log.ts that `hold` is load-bearing for interpolation.
N3. Assert a post's `pos` lies inside its `cell` in input validation.
N4. Log budget note for chunk 13: 80 KB at 180 s with 24 entities before combat events; consider 10 s keyframes or shorter keys.
