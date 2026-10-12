/**
 * PHASE-2 §37 — the fast subset of the balance sweep, in CI (no database; pure resolver fights
 * through the server's own adapter path). The full sweep is `scripts/balance/matchup-sweep.ts`
 * and the probes `scripts/balance/first-trip.ts` / `probes.ts`; numbers and their history are in
 * BALANCE-LOG.md. This file re-runs a slice of them on every content or tunables change and
 * fails when a change breaks one of the balance pass's acceptance targets:
 *   - a fresh account's encounter 1 is searched in band 0, and the guided first layout holds
 *     at least 70 % of those fights (chunk 24 QA D1);
 *   - a sensible free layout holds encounter 2 more often than not;
 *   - skill matters: the skilled search beats the naive layouts at the band-typical diagonal;
 *   - the same matchup resolves the same way twice (the sweep is deterministic).
 * Time budget: SWEEP_BUDGET_MS of wall clock for the whole file.
 */
import { describe, expect, it } from "vitest";
import { firstTrip, firstTripTasks, summarize } from "../../../scripts/balance/first-trip.js";
import { corpus } from "../../../scripts/balance/matchup-sweep.js";
import { turtleRoster } from "../../../scripts/balance/probes.js";
import { NAIVE, SKILLED, authoredParties, bandTypicalRoster, bestFight, manifestOf } from "../../../scripts/balance/sweep.js";

/** Tunable (chunk 37): the CI slice's wall-clock budget. */
const SWEEP_BUDGET_MS = 150_000;
const started = Date.now();

/**
 * Each fight is synchronous CPU work; vitest's worker answers its "onTaskUpdate" RPC only when the
 * event loop turns, so a long test on a loaded runner fails the run with every assertion green.
 * Yielding one macrotask between fights lets the RPC through. It changes no result.
 */
const yieldLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("balance sweep — the CI slice (PHASE-2 §37)", () => {
  it("the full sweep's corpus and the standing probes' turtle pack legally (the scripts typecheck through this import)", () => {
    expect(corpus(true).rosters).toHaveLength(18);
    expect(corpus(false).rosters).toHaveLength(68);
    for (const r of corpus(false).rosters) expect(() => manifestOf(r)).not.toThrow();
    for (const region of ["desert", "high_plains", "mountain", "badlands"] as const) expect(manifestOf(turtleRoster(region)).units).toHaveLength(8);
  });

  it("a fresh account's first trip: encounter 1 in band 0, the guided layout holds ≥ 70 %, encounter 2 held more often than not", async () => {
    // Final play-test review: the guide leaves GUIDE_RESERVE units home (firstTripTasks' default), so
    // the first fight posts 5. Eight seeds (64 caravans): two seeds' 16 fights are too few to read a
    // 70 % bar from (the full probe, 200 caravans, holds 73 %; BALANCE-LOG pass 2).
    const rs: ReturnType<typeof firstTrip>[] = [];
    for (const t of firstTripTasks(8, 1)) {
      rs.push(firstTrip(t));
      await yieldLoop();
    }
    const s = summarize(rs);
    expect(Object.keys(s.bands1)).toEqual(["0"]);
    expect(s.held1 / s.fights1, JSON.stringify(s)).toBeGreaterThanOrEqual(0.7);
    expect(s.held2Guided / Math.max(1, s.reached2), JSON.stringify(s)).toBeGreaterThan(0.5);
  }, SWEEP_BUDGET_MS);

  it("skill matters, and the sweep is deterministic: band-typical desert roster at its own band, bands 0 / 4 / 7", async () => {
    const parties = authoredParties();
    let skilled = 0;
    let naive = 0;
    let n = 0;
    for (const band of [0, 4, 7]) {
      const m = manifestOf(bandTypicalRoster("desert", band));
      for (const sp of parties.filter((p) => p.spec.band === band).slice(0, 4)) {
        const s = bestFight(m, sp, SKILLED)!;
        await yieldLoop();
        const v = bestFight(m, sp, NAIVE)!;
        await yieldLoop();
        n++;
        if (s.kind !== "caravan_overrun") skilled++;
        if (v.kind !== "caravan_overrun") naive++;
        expect(s.kind === "caravan_overrun" ? 0 : 1).toBeGreaterThanOrEqual(v.kind === "caravan_overrun" ? 0 : 1);
      }
    }
    expect(skilled).toBeGreaterThan(naive);
    expect(n).toBe(12);
    const sp = parties.find((p) => p.spec.band === 4)!;
    const m = manifestOf(bandTypicalRoster("mountain", 4));
    const a = bestFight(m, sp, SKILLED)!;
    const b = bestFight(m, sp, SKILLED)!;
    expect({ ...b, survivors: null }).toEqual({ ...a, survivors: null });
    expect(Date.now() - started).toBeLessThan(SWEEP_BUDGET_MS);
  }, SWEEP_BUDGET_MS);
});
