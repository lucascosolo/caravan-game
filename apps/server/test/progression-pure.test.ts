/**
 * Chunk 04 — the pure half: ladders, Reputation and event derivation, with no database.
 */
import { FIXED_ONE, TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import { canonicalJson, validateDraft, type Json } from "../src/ledger/events.js";
import {
  advanceLadder,
  applyFloor,
  assertReputationTunablesCoherent,
  REPUTATION_BASE_DELTAS,
  deriveProgressionEvents,
  ENCOUNTER_OUTCOME_KINDS,
  gapMultiplier,
  gapScaledDelta,
  LADDER_CAP,
  ladderGainFor,
  levelForPoints,
  pointsToRung,
  reputationBaseDelta,
  reputationDelta,
  totalUnlockPointsAtCap,
  unlockPointsForRung,
  type EncounterOutcomeKind,
  type EncounterProgressionInput,
  type LadderState,
  type PoolState,
  type ProgressionSnapshot,
} from "../src/progression/index.js";

/** Deterministic PRNG so a failing sequence is reproducible from its seed. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

const ACCOUNT_A = "11111111-1111-4111-8111-111111111111";
const CARAVAN_A = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_B = "33333333-3333-4333-8333-333333333333";

function freshSnapshot(): ProgressionSnapshot {
  const z = (): PoolState => ({ reputation: TUNABLES.REPUTATION_START, ladderLevel: 0, ladderPoints: 0 });
  return { caravan: { living: z(), trap: z() }, party: { siege: z() } };
}

function input(outcome: EncounterOutcomeKind, caravanPools: EncounterProgressionInput["caravan"]["poolsUsed"] = ["living", "trap"], partyPools: EncounterProgressionInput["party"]["poolsUsed"] = ["living", "siege"]): EncounterProgressionInput {
  return {
    outcome,
    caravan: { accountId: ACCOUNT_A, caravanId: CARAVAN_A, poolsUsed: caravanPools },
    party: { ownerAccountId: ACCOUNT_B, poolsUsed: partyPools },
  };
}

describe("ladder curve (tunables)", () => {
  it("is the integer floor of 100 × n^1.5, strictly increasing, cap + 1 entries", () => {
    expect(TUNABLES.LADDER_POINTS_TO_RUNG).toHaveLength(LADDER_CAP + 1);
    expect(pointsToRung(0)).toBe(0);
    for (let n = 1; n <= LADDER_CAP; n++) {
      expect(pointsToRung(n)).toBe(Math.floor(100 * Math.pow(n, 1.5))); // test-side float is fine; the table is the truth
      expect(pointsToRung(n)).toBeGreaterThan(pointsToRung(n - 1));
    }
    expect(pointsToRung(1)).toBe(100);
    expect(pointsToRung(10)).toBe(3162);
    expect(pointsToRung(20)).toBe(8944);
    expect(() => pointsToRung(LADDER_CAP + 1)).toThrow(RangeError);
  });

  it("grants 1 point for rungs 1–10 and 2 for 11–20: 30 per pool at cap", () => {
    for (let n = 1; n <= 10; n++) expect(unlockPointsForRung(n)).toBe(1);
    for (let n = 11; n <= 20; n++) expect(unlockPointsForRung(n)).toBe(2);
    expect(totalUnlockPointsAtCap()).toBe(30);
    expect(() => unlockPointsForRung(0)).toThrow(RangeError);
  });

  it("losses earn: the loss gain is > 0 and < every win-side gain, on both sides", () => {
    expect(TUNABLES.LADDER_GAIN_LOSS).toBeGreaterThan(0);
    expect(TUNABLES.LADDER_GAIN_STALEMATE).toBeGreaterThan(0);
    expect(ladderGainFor("caravan", "caravan_overrun")).toBeGreaterThan(0);
    expect(ladderGainFor("caravan", "caravan_overrun")).toBeLessThan(ladderGainFor("caravan", "caravan_held"));
    expect(ladderGainFor("caravan", "caravan_overrun")).toBeLessThan(ladderGainFor("caravan", "stalemate"));
    expect(ladderGainFor("party", "caravan_held")).toBeGreaterThan(0);
    expect(ladderGainFor("party", "caravan_held")).toBeLessThan(ladderGainFor("party", "caravan_overrun"));
    expect(ladderGainFor("party", "stalemate")).toBeLessThan(ladderGainFor("party", "caravan_overrun"));
    // every number is read from the registry, not inlined
    expect(ladderGainFor("caravan", "caravan_held")).toBe(TUNABLES.LADDER_GAIN_DEFENSE_HELD);
    expect(ladderGainFor("party", "caravan_overrun")).toBe(TUNABLES.LADDER_GAIN_WIN);
    expect(ladderGainFor("party", "stalemate")).toBe(TUNABLES.LADDER_GAIN_STALEMATE);
    expect(ladderGainFor("caravan", "caravan_overrun")).toBe(TUNABLES.LADDER_GAIN_LOSS);
  });
});

describe("ladder fold", () => {
  it("level never decreases under any outcome sequence, for either side (10 seeds × 2000 encounters)", () => {
    for (let seed = 1; seed <= 10; seed++) {
      const rnd = lcg(seed);
      for (const side of ["caravan", "party"] as const) {
        let state: LadderState = { level: 0, points: 0 };
        for (let i = 0; i < 2000; i++) {
          const outcome = ENCOUNTER_OUTCOME_KINDS[Math.floor(rnd() * 3)]!;
          const adv = advanceLadder(state, ladderGainFor(side, outcome));
          expect(adv.after.level).toBeGreaterThanOrEqual(state.level);
          expect(adv.after.points).toBeGreaterThanOrEqual(state.points);
          expect(adv.pointsDelta).toBeGreaterThanOrEqual(0);
          expect(adv.after.level).toBe(Math.max(state.level, levelForPoints(adv.after.points)));
          state = adv.after;
        }
        expect(state.level).toBe(LADDER_CAP);
      }
    }
  });

  it("an all-losses ladder still climbs (never zero progress), just slower than all-wins", () => {
    const climb = (outcome: EncounterOutcomeKind) => {
      let state: LadderState = { level: 0, points: 0 };
      let n = 0;
      while (state.level < LADDER_CAP) {
        state = advanceLadder(state, ladderGainFor("caravan", outcome)).after;
        n++;
      }
      return n;
    };
    const losses = climb("caravan_overrun");
    const wins = climb("caravan_held");
    expect(losses).toBeGreaterThan(wins);
    expect(wins).toBeGreaterThan(0);
  });

  it("every rung is crossed exactly once over a full climb, and grants sum to the cap total", () => {
    let state: LadderState = { level: 0, points: 0 };
    const crossings = new Map<number, number>();
    let granted = 0;
    for (let i = 0; i < 100_000 && state.level < LADDER_CAP; i++) {
      const adv = advanceLadder(state, ladderGainFor("caravan", i % 3 === 0 ? "caravan_overrun" : "caravan_held"));
      adv.rungsCrossed.forEach((r, k) => {
        crossings.set(r, (crossings.get(r) ?? 0) + 1);
        granted += adv.unlockPointsPerRung[k]!;
      });
      state = adv.after;
    }
    expect(crossings.size).toBe(LADDER_CAP);
    for (let r = 1; r <= LADDER_CAP; r++) expect(crossings.get(r)).toBe(1);
    expect(granted).toBe(totalUnlockPointsAtCap());
  });

  it("a capped ladder absorbs nothing: no points, no crossings, nothing owed", () => {
    const adv = advanceLadder({ level: LADDER_CAP, points: pointsToRung(LADDER_CAP) }, 1000);
    expect(adv.pointsDelta).toBe(0);
    expect(adv.rungsCrossed).toEqual([]);
    expect(adv.after).toEqual({ level: LADDER_CAP, points: pointsToRung(LADDER_CAP) });
  });

  it("a single large gain can cross several rungs, each reported once", () => {
    const adv = advanceLadder({ level: 0, points: 0 }, pointsToRung(3));
    expect(adv.rungsCrossed).toEqual([1, 2, 3]);
    expect(adv.unlockPointsPerRung).toEqual([1, 1, 1]);
  });

  it("refuses negative or fractional input rather than folding it", () => {
    expect(() => advanceLadder({ level: 0, points: 0 }, -1)).toThrow(RangeError);
    expect(() => advanceLadder({ level: 0, points: 0 }, 1.5)).toThrow(RangeError);
    expect(() => advanceLadder({ level: -1, points: 0 }, 1)).toThrow(RangeError);
  });
});

describe("Reputation gap scaling is pure and integer-only", () => {
  it("same inputs → same delta, every time, over a wide sweep; every result is an integer", () => {
    for (const side of ["caravan", "party"] as const) {
      for (const outcome of ENCOUNTER_OUTCOME_KINDS) {
        for (let self = TUNABLES.REPUTATION_FLOOR; self <= 3000; self += 37) {
          for (let opp = TUNABLES.REPUTATION_FLOOR; opp <= 3000; opp += 53) {
            const a = reputationDelta(side, outcome, self, opp);
            const b = reputationDelta(side, outcome, self, opp);
            expect(a).toEqual(b);
            expect(Number.isInteger(a.delta)).toBe(true);
            expect(Number.isInteger(a.unclamped)).toBe(true);
            expect(Number.isInteger(a.after)).toBe(true);
            expect(a.after).toBeGreaterThanOrEqual(Math.min(self, TUNABLES.REPUTATION_FLOOR));
          }
        }
      }
    }
  });

  it("is Elo-shaped: an underdog's win and a favourite's loss scale up; the mirrors scale down; clamped", () => {
    const d = TUNABLES.REPUTATION_GAP_DIVISOR;
    const win = TUNABLES.REPUTATION_WIN_ATTACKER;
    expect(gapScaledDelta(win, 1000, 1000)).toBe(win); // equal ratings: base
    expect(gapScaledDelta(win, 1000, 1000 + d)).toBe(win * 2); // beat someone a divisor above you: double
    expect(gapScaledDelta(win, 1000 + d, 1000)).toBe(Math.trunc((win * TUNABLES.REPUTATION_GAP_MULT_MIN) / FIXED_ONE)); // farming the weak: clamped down
    expect(gapScaledDelta(win, 1000, 1000 + 10 * d)).toBe(Math.trunc((win * TUNABLES.REPUTATION_GAP_MULT_MAX) / FIXED_ONE)); // clamped up
    const loss = TUNABLES.REPUTATION_LOSS_ATTACKER;
    expect(gapScaledDelta(loss, 1000, 1000)).toBe(loss);
    expect(gapScaledDelta(loss, 1000 + d, 1000)).toBe(loss * 2); // favourite losing: double
    expect(gapScaledDelta(loss, 1000, 1000 + d)).toBe(Math.trunc((loss * TUNABLES.REPUTATION_GAP_MULT_MIN_LOSS) / FIXED_ONE)); // losing to a titan: small, but floored higher than a win (D2)
    expect(gapMultiplier(0, 1)).toBe(FIXED_ONE);
    expect(gapMultiplier(12345, 0)).toBe(FIXED_ONE);
  });

  it("never flips the sign of a delta and is monotone in the gap", () => {
    for (const base of [TUNABLES.REPUTATION_WIN_ATTACKER, TUNABLES.REPUTATION_LOSS_ATTACKER, TUNABLES.REPUTATION_CARAVAN_HELD, TUNABLES.REPUTATION_CARAVAN_OVERRUN]) {
      let prev: number | null = null;
      for (let gap = -2000; gap <= 2000; gap += 7) {
        const v = gapScaledDelta(base, 1000, 1000 + gap);
        expect(Math.sign(v)).toBe(Math.sign(base));
        if (prev !== null) {
          // wins grow with the gap, losses shrink (toward zero) with the gap
          if (base > 0) expect(v).toBeGreaterThanOrEqual(prev);
          else expect(v).toBeGreaterThanOrEqual(prev);
        }
        prev = v;
      }
    }
  });

  it("floors at REPUTATION_FLOOR and records the clamp; gains are never clamped", () => {
    const floor = TUNABLES.REPUTATION_FLOOR;
    expect(applyFloor(floor + 5, -20)).toEqual({ unclamped: -20, delta: -5, after: floor, floored: true });
    expect(applyFloor(floor, -20)).toEqual({ unclamped: -20, delta: 0, after: floor, floored: true });
    expect(applyFloor(floor - 50, -20)).toEqual({ unclamped: -20, delta: 0, after: floor - 50, floored: true });
    expect(applyFloor(floor, 30)).toEqual({ unclamped: 30, delta: 30, after: floor + 30, floored: false });
    expect(applyFloor(5000, -20)).toEqual({ unclamped: -20, delta: -20, after: 4980, floored: false });
    // a long losing streak converges on the floor and stays there
    let r: number = TUNABLES.REPUTATION_START;
    for (let i = 0; i < 500; i++) r = reputationDelta("caravan", "caravan_overrun", r, r).after;
    expect(r).toBe(floor);
  });

  it("reads every base delta from the registry, and stalemate is a loss for the party / a win for the caravan", () => {
    expect(reputationBaseDelta("party", "caravan_overrun")).toBe(TUNABLES.REPUTATION_WIN_ATTACKER);
    expect(reputationBaseDelta("party", "caravan_held")).toBe(TUNABLES.REPUTATION_LOSS_ATTACKER);
    expect(reputationBaseDelta("party", "stalemate")).toBe(TUNABLES.REPUTATION_LOSS_ATTACKER);
    expect(reputationBaseDelta("caravan", "caravan_held")).toBe(TUNABLES.REPUTATION_CARAVAN_HELD);
    expect(reputationBaseDelta("caravan", "stalemate")).toBe(TUNABLES.REPUTATION_CARAVAN_HELD);
    expect(reputationBaseDelta("caravan", "caravan_overrun")).toBe(TUNABLES.REPUTATION_CARAVAN_OVERRUN);
    expect(() => gapScaledDelta(1.5, 1000, 1000)).toThrow(RangeError);
  });
});

describe("sandbagging shape (chunk 04 QA D2) and -0 hygiene (N4)", () => {
  it("floors a loss at REPUTATION_GAP_MULT_MIN_LOSS and a win at REPUTATION_GAP_MULT_MIN; the loss floor is the higher one", () => {
    expect(TUNABLES.REPUTATION_GAP_MULT_MIN_LOSS).toBeGreaterThan(TUNABLES.REPUTATION_GAP_MULT_MIN);
    expect(gapMultiplier(100_000, -1)).toBe(TUNABLES.REPUTATION_GAP_MULT_MIN_LOSS);
    expect(gapMultiplier(-100_000, 1)).toBe(TUNABLES.REPUTATION_GAP_MULT_MIN);
    expect(gapMultiplier(100_000, 1)).toBe(TUNABLES.REPUTATION_GAP_MULT_MAX);
    expect(gapMultiplier(-100_000, -1)).toBe(TUNABLES.REPUTATION_GAP_MULT_MAX);
    // the QA probe's numbers: a loss at 400 vs 1000 pays half the base, a win at 100 vs 1000 double
    expect(reputationDelta("party", "caravan_held", 400, 1000).delta).toBe(Math.trunc((TUNABLES.REPUTATION_LOSS_ATTACKER * TUNABLES.REPUTATION_GAP_MULT_MIN_LOSS) / FIXED_ONE));
    expect(reputationDelta("party", "caravan_overrun", 100, 1000).delta).toBe(Math.trunc((TUNABLES.REPUTATION_WIN_ATTACKER * TUNABLES.REPUTATION_GAP_MULT_MAX) / FIXED_ONE));
  });

  it("tanking a rating against 1000-rated opponents takes far more losses than climbing back takes wins", () => {
    let rep: number = TUNABLES.REPUTATION_START;
    let losses = 0;
    while (rep > TUNABLES.REPUTATION_FLOOR && losses < 100_000) {
      rep = reputationDelta("party", "caravan_held", rep, TUNABLES.REPUTATION_START).after;
      losses++;
    }
    let wins = 0;
    while (rep < TUNABLES.REPUTATION_START && wins < 100_000) {
      rep = reputationDelta("party", "caravan_overrun", rep, TUNABLES.REPUTATION_START).after;
      wins++;
    }
    expect(losses).toBeGreaterThan(100);
    expect(losses).toBeGreaterThan(3 * wins);
  });

  it("never yields -0, and the startup coherence assertion holds for the shipped registry", () => {
    for (const base of REPUTATION_BASE_DELTAS) {
      for (const gap of [-100_000, -5000, -400, -1, 0, 1, 400, 6000, 100_000]) {
        const v = gapScaledDelta(base, 1000, 1000 + gap);
        expect(Object.is(v, -0)).toBe(false);
        expect(Math.abs(v)).toBeGreaterThanOrEqual(1); // |base| × floor ≥ FIXED_ONE: a delta never truncates to nothing
      }
    }
    expect(Object.is(gapScaledDelta(0, 1000, 1000), -0)).toBe(false);
    expect(() => assertReputationTunablesCoherent()).not.toThrow();
  });
});

describe("event derivation", () => {
  it("is deterministic: the same snapshot and outcome produce byte-identical drafts", () => {
    for (const outcome of ENCOUNTER_OUTCOME_KINDS) {
      const a = deriveProgressionEvents(freshSnapshot(), input(outcome));
      const b = deriveProgressionEvents(freshSnapshot(), input(outcome));
      expect(canonicalJson(a.events as unknown as Json)).toBe(canonicalJson(b.events as unknown as Json));
      expect(canonicalJson(a.after as unknown as Json)).toBe(canonicalJson(b.after as unknown as Json));
    }
  });

  it("lands every draft on the right side of the split and passes the ledger's own validation", () => {
    const { events } = deriveProgressionEvents(freshSnapshot(), input("caravan_held"));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      validateDraft(e);
      const pool = e.payload["pool"];
      if (pool === "living") {
        expect(e.caravanId).toBe(CARAVAN_A);
        expect(e.accountId).toBe(ACCOUNT_A);
      } else {
        expect(e.caravanId ?? null).toBeNull();
      }
      if (pool === "trap") expect(e.accountId).toBe(ACCOUNT_A);
      if (pool === "siege") expect(e.accountId).toBe(ACCOUNT_B);
    }
  });

  it("attributes ladder progress only to pools actually used, on the side that used them", () => {
    const only = (ev: ReturnType<typeof deriveProgressionEvents>["events"], type: string) =>
      ev.filter((e) => e.type === type).map((e) => `${e.accountId === ACCOUNT_A ? "caravan" : "party"}:${String(e.payload["pool"])}`);
    // caravan fielded living only, party fielded siege
    let r = deriveProgressionEvents(freshSnapshot(), input("caravan_held", ["living"], ["living", "siege"]));
    expect(only(r.events, "ladder_progress_gained")).toEqual(["caravan:living", "party:siege"]);
    // caravan fielded traps too
    r = deriveProgressionEvents(freshSnapshot(), input("caravan_held", ["living", "trap"], ["living", "siege"]));
    expect(only(r.events, "ladder_progress_gained")).toEqual(["caravan:living", "caravan:trap", "party:siege"]);
    // party fielded no siege: no siege ladder; its living units are a template and earn nothing
    r = deriveProgressionEvents(freshSnapshot(), input("caravan_overrun", ["living"], ["living"]));
    expect(only(r.events, "ladder_progress_gained")).toEqual(["caravan:living"]);
    // nothing fielded at all: no ladder anywhere, but both matchmaking ratings still move
    r = deriveProgressionEvents(freshSnapshot(), input("caravan_overrun", [], []));
    expect(only(r.events, "ladder_progress_gained")).toEqual([]);
    expect(only(r.events, "reputation_changed")).toEqual(["caravan:living", "party:siege"]);
  });

  it("never moves trap Reputation (D1: nothing reads it); living and siege ratings always move", () => {
    const reps = (ev: ReturnType<typeof deriveProgressionEvents>["events"]) =>
      ev.filter((e) => e.type === "reputation_changed").map((e) => String(e.payload["pool"]));
    expect(reps(deriveProgressionEvents(freshSnapshot(), input("stalemate", ["living"], ["siege"])).events)).toEqual(["living", "siege"]);
    const withTraps = deriveProgressionEvents(freshSnapshot(), input("stalemate", ["living", "trap"], []));
    expect(reps(withTraps.events)).toEqual(["living", "siege"]);
    expect(withTraps.after.caravan.trap.reputation).toBe(TUNABLES.REPUTATION_START);
    expect(withTraps.events.some((e) => e.type === "ladder_progress_gained" && e.payload["pool"] === "trap")).toBe(true); // the trap LADDER still earns
    for (const outcome of ENCOUNTER_OUTCOME_KINDS) {
      const snap = freshSnapshot();
      snap.caravan.living.reputation = 1800;
      const r = deriveProgressionEvents(snap, input(outcome, ["living", "trap"], ["siege"]));
      expect(reps(r.events)).not.toContain("trap");
      expect(r.after.caravan.trap.reputation).toBe(TUNABLES.REPUTATION_START);
    }
  });

  it("writes no reputation_changed when the applied delta is 0 (N1): a rating on the floor stays silent", () => {
    const snap = freshSnapshot();
    snap.caravan.living.reputation = TUNABLES.REPUTATION_FLOOR;
    const r = deriveProgressionEvents(snap, input("caravan_overrun", ["living"], ["siege"]));
    const reps = r.events.filter((e) => e.type === "reputation_changed");
    expect(reps.map((e) => e.payload["pool"])).toEqual(["siege"]);
    expect(r.after.caravan.living.reputation).toBe(TUNABLES.REPUTATION_FLOOR);
    expect(r.summary.caravan[0]!.reputation).toMatchObject({ delta: 0, floored: true });
    // one step above the floor: the clamped event is written, with floored: true and the unclamped value
    snap.caravan.living.reputation = TUNABLES.REPUTATION_FLOOR + 3;
    const last = deriveProgressionEvents(snap, input("caravan_overrun", ["living"], ["siege"]));
    const living = last.events.find((e) => e.type === "reputation_changed" && e.payload["pool"] === "living")!;
    expect(living.payload).toMatchObject({ delta: -3, floored: true });
    expect(living.payload["unclamped"]).toBeLessThan(-3);
    for (const e of last.events) if (e.type === "reputation_changed") expect(e.payload["delta"]).not.toBe(0);
  });

  it("scales both sides by the gap between the caravan's living rating and the owner's siege rating", () => {
    const snap = freshSnapshot();
    snap.caravan.living.reputation = 1400; // strong caravan
    snap.party.siege.reputation = 1000; // ordinary party
    const r = deriveProgressionEvents(snap, input("caravan_overrun"));
    const partyRep = r.events.find((e) => e.type === "reputation_changed" && e.payload["pool"] === "siege")!;
    const caravanRep = r.events.find((e) => e.type === "reputation_changed" && e.payload["pool"] === "living")!;
    expect(partyRep.payload["delta"]).toBe(TUNABLES.REPUTATION_WIN_ATTACKER * 2); // underdog overran a strong caravan
    expect(caravanRep.payload["delta"]).toBe(TUNABLES.REPUTATION_CARAVAN_OVERRUN * 2); // favourite got overrun
    expect(partyRep.payload["selfRating"]).toBe(1000);
    expect(partyRep.payload["opponentRating"]).toBe(1400);
  });

  it("grants unlock points with the rung named, exactly once per rung, across a replayed full climb", () => {
    let snap = freshSnapshot();
    const grants: string[] = [];
    for (let i = 0; i < 5000 && (snap.caravan.living.ladderLevel < LADDER_CAP || snap.party.siege.ladderLevel < LADDER_CAP); i++) {
      const outcome = ENCOUNTER_OUTCOME_KINDS[i % 3]!;
      const r = deriveProgressionEvents(snap, input(outcome));
      for (const e of r.events) {
        if (e.type === "unlock_points_granted") grants.push(`${e.accountId}:${String(e.payload["pool"])}:${String(e.payload["rung"])}`);
      }
      snap = r.after;
    }
    expect(new Set(grants).size).toBe(grants.length); // no rung granted twice
    expect(grants.filter((g) => g.includes(":living:")).length).toBe(LADDER_CAP);
    expect(grants.filter((g) => g.includes(":trap:")).length).toBe(LADDER_CAP);
    expect(grants.filter((g) => g.includes(":siege:")).length).toBe(LADDER_CAP);
    // re-deriving from an earlier snapshot is a pure function: it yields the same crossing, not a second grant on top
    const first = deriveProgressionEvents(freshSnapshot(), input("caravan_held"));
    const again = deriveProgressionEvents(freshSnapshot(), input("caravan_held"));
    expect(canonicalJson(first.events as unknown as Json)).toBe(canonicalJson(again.events as unknown as Json));
  });

  it("refuses a self-encounter, unknown outcomes, and duplicated pools", () => {
    expect(() => deriveProgressionEvents(freshSnapshot(), { ...input("caravan_held"), party: { ownerAccountId: ACCOUNT_A, poolsUsed: [] } })).toThrow(/own standing party/);
    expect(() => deriveProgressionEvents(freshSnapshot(), { ...input("caravan_held"), outcome: "draw" as EncounterOutcomeKind })).toThrow(/unknown outcome/);
    expect(() => deriveProgressionEvents(freshSnapshot(), input("caravan_held", ["living", "living"]))).toThrow(/twice/);
  });
});
