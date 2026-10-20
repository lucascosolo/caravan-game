/**
 * PHASE-2 §37 — the fast subset of the balance sweep, in CI (no database; pure resolver fights
 * through the server's own adapter path). The full sweep is `scripts/balance/matchup-sweep.ts`
 * and the probes `scripts/balance/first-trip.ts` / `probes.ts`; numbers and their history are in
 * BALANCE-LOG.md. This file re-runs a slice of them on every content or tunables change and
 * fails when a change breaks one of the balance pass's acceptance targets:
 *   - a fresh account's encounter 1 is searched in band 0, and the guided first layout holds
 *     at least 70 % of those fights (chunk 24 QA D1);
 *   - final play-test review r3 S1: the pick and the bank-or-push advice are the CLIENT's rule
 *     (@caravan/circle guide.ts, imported by the harness, not mirrored), and the encounter 2 the
 *     guide pushes into is held by the guide's shape at least 60 % of the time;
 *   - skill matters: the skilled search beats the naive layouts at the band-typical diagonal;
 *   - the same matchup resolves the same way twice (the sweep is deterministic).
 * Time budget: SWEEP_BUDGET_MS of wall clock for the whole file.
 */
import { describe, expect, it } from "vitest";
import { authoredPhase, firstTrip, firstTripTasks, raisedGate, raisedGateTasks, summarize, summarizePhase, summarizeRaised } from "../../../scripts/balance/first-trip.js";
import { CORE_HEAVY_MAX_SHARE, LOW_BAND_GUIDED_MIN, freshPacks, isCoreHeavy, lowBandFight } from "../../../scripts/balance/low-bands.js";
import { corpus } from "../../../scripts/balance/matchup-sweep.js";
import { turtleRoster } from "../../../scripts/balance/probes.js";
import { NAIVE, SKILLED, authoredParties, raiseCaravanIds, bandTypicalRoster, bestFight, guidePick, isRangedOnly, manifestOf, servedMenu, starterTypes } from "../../../scripts/balance/sweep.js";
import { guidePick as clientGuidePick, isRangedOnly as clientRangedOnly, scoutParty } from "@caravan/circle";

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

  it("r3 S1: the harness's pick is the client's rule over the scout the client is served (one shared function, @caravan/circle guide.ts)", () => {
    let n = 0;
    for (const region of ["desert", "mountain"] as const) for (let seed = 1; seed <= 20; seed++) for (const j of [1, 2]) {
      const { menu } = servedMenu(`pin-${region}-${seed}`, `pin-trip-${seed}`, 400 + seed * 7, j, 1, { packedUnits: 5, rosterLevels: [1, 1, 1, 1, 1, 1, 1] });
      const scouts = menu.map((sp) => scoutParty(sp.party));
      expect(guidePick(menu)).toBe(menu[clientGuidePick(scouts)!.index]);
      for (const sp of menu) expect(isRangedOnly(sp.party)).toBe(clientRangedOnly(scoutParty(sp.party)));
      n++;
    }
    expect(n).toBe(80);
  });

  it("a fresh account's first trip: encounter 1 in band 0, the guided layout holds ≥ 70 %; the encounter 2 the guide pushes into is held ≥ 60 % by the guide's shape (r3 S1)", async () => {
    // Final play-test review: the guide leaves GUIDE_RESERVE units home (firstTripTasks' default), so
    // the first fight posts 5. Eight seeds (64 caravans): two seeds' 16 fights are too few to read a
    // 70 % bar from (the full probe, 200 caravans; BALANCE-LOG).
    const rs: ReturnType<typeof firstTrip>[] = [];
    for (const t of firstTripTasks(8, 1)) {
      rs.push(firstTrip(t));
      await yieldLoop();
    }
    const s = summarize(rs);
    expect(Object.keys(s.bands1)).toEqual(["0"]);
    expect(s.held1 / s.fights1, JSON.stringify(s)).toBeGreaterThanOrEqual(0.7);
    expect(s.pushed2, JSON.stringify(s)).toBeGreaterThan(0);
    expect(s.pushed2Guided / s.pushed2, JSON.stringify(s)).toBeGreaterThanOrEqual(0.6);
  }, SWEEP_BUDGET_MS);

  it("pass 8, the bands 0–1 gate: at most a third of each band core-stance-heavy; every band 0–1 outfit held ≥ 60 % by the guided layout of the guide's default pack", async () => {
    // The full gate is `low-bands.ts` (56 packs: every rotation of who stays home). The slice: two rotations per pack (16).
    const parties = authoredParties();
    for (const band of [0, 1]) {
      const inBand = parties.filter((p) => p.spec.band === band);
      expect(inBand.filter(isCoreHeavy).length / inBand.length, `band ${band}`).toBeLessThanOrEqual(CORE_HEAVY_MAX_SHARE);
    }
    const packs = freshPacks();
    const picked = packs.map((_, i) => i).filter((i) => i % 7 === 0 || i % 7 === 4);
    expect(picked).toHaveLength(16);
    const low: string[] = [];
    for (let party = 0; party < parties.length; party++) {
      if (parties[party]!.spec.band > 1) continue;
      let held = 0;
      for (const pack of picked) {
        if (lowBandFight({ party, variant: 0, pack })) held++;
        await yieldLoop();
      }
      if (held < LOW_BAND_GUIDED_MIN * picked.length) low.push(`${parties[party]!.spec.outfit.name} ${held}/${picked.length}`);
    }
    expect(low).toEqual([]);
  }, SWEEP_BUDGET_MS);

  it("pass 8, the authored-only phase: trip 2 (attrition carried, the guide's pick, layout and advice throughout) is delivered ≥ 50 %", async () => {
    // The full probe is `first-trip.ts --phase` (200 caravans). The slice: 4 seeds (32 caravans).
    const rs: ReturnType<typeof authoredPhase>[] = [];
    for (const t of firstTripTasks(4, 1)) {
      rs.push(authoredPhase(t));
      await yieldLoop();
    }
    const s = summarizePhase(rs);
    expect(s.caravans).toBe(32);
    expect(s.trip2Banked / s.caravans, JSON.stringify(s)).toBeGreaterThanOrEqual(0.5);
  }, SWEEP_BUDGET_MS);

  it("final play-test review r2 S2 / r3 S2, the later trips' gate: raised parties of every region (ranged pairs, whole 7-unit rosters with the refugee, and since r4 D1 the 5-unit suggested party) — over what a bands 0–1 search can serve against the 5-post circle, guided ≥ 60 %, best skilled ≥ 70 %", async () => {
    // The full gate is `first-trip.ts --raised` (all 76 skilled layouts; BALANCE-LOG pass 6).
    // The slice: one fresh roster per region (refugee = its first starter type) and the first 24 skilled layouts.
    const defenders = (["desert", "high_plains", "mountain", "badlands"] as const).map((region) => ({ region, refugee: starterTypes(region)[0]! }));
    const rs: ReturnType<typeof raisedGate>[] = [];
    // r4 D2: the raise's starter edges come from the caravan id; the slice fights one caravan's raise.
    for (const t of raisedGateTasks(undefined, 24, defenders, [raiseCaravanIds()[0]!])) {
      rs.push(raisedGate(t));
      await yieldLoop();
    }
    const s = summarizeRaised(rs);
    expect(s.fights).toBe(96); // r4 D1: + the suggested party (SUGGESTED_PARTY_MAX) of each region
    // r3 S2(b): a 7-raider whole roster is never served against 5 posts in bands 0–1.
    for (const [label, e] of Object.entries(s.byParty)) if (/whole roster/.test(label)) expect(e.servedLowBands, label).toBe(0);
    expect(s.servedFights).toBe(64); // the 5-raider suggested party IS served against the 5-post circle
    expect(s.servedGuidedHeld / s.servedFights, JSON.stringify(s.byParty)).toBeGreaterThanOrEqual(0.6);
    expect(s.servedBestHeld / s.servedFights, JSON.stringify(s.byParty)).toBeGreaterThanOrEqual(0.7);
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
