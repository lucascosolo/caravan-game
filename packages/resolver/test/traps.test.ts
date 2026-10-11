/**
 * Chunk 11 — phase 4 traps: swept-path detection (no tunnelling), fire once, spend, the
 * unit-id tie-break, two traps in one tick, siege nullification, slow/root effects with
 * their durations in ticks and the `speed` events the replay contract needs, and that the
 * caravan's own posted units never spring its traps.
 */
import { describe, expect, it } from "vitest";
import { cellCenter, initialState, normalizeInput, resolve, segmentDistSq, sweepCrosses, trapTriggerPhase, type Fixed, type FixedPoint, type LogEvent, type ResolveOutput } from "../src/index.js";
import { DEFAULT_TUNABLES, ROOT, SHORT_TUNABLES, SLOW, battlefield, input, ms, party, post, quiet, trap, unit } from "./fixtures.js";

const events = <K extends LogEvent["k"]>(out: ResolveOutput, k: K) => out.log.filter((e): e is Extract<LogEvent, { k: K }> => e.k === k);
const keyframes = (out: ResolveOutput) => events(out, "keyframe");
// Chunk 12: abilities held past the cap (fixtures `quiet`) — these tests pin trap timing tick-exactly.
const PER_TICK_KEYFRAMES = quiet({ ...SHORT_TUNABLES, keyframeIntervalMs: ms(50) });
const p = (x: number, y: number): FixedPoint => ({ x: x as Fixed, y: y as Fixed });
/** TRAP reach: trigger radius 768 + unit radius 358. */
const TRAP_REACH = 768 + 358;

describe("segmentDistSq and sweepCrosses", () => {
  it("measures the squared distance from a point to a segment: before the start, past the end, and the floored closest point between", () => {
    expect(segmentDistSq(p(0, 0), p(10, 0), p(20, 0))).toBe(100);
    expect(segmentDistSq(p(30, 0), p(10, 0), p(20, 0))).toBe(100);
    expect(segmentDistSq(p(15, 7), p(10, 0), p(20, 0))).toBe(49);
    expect(segmentDistSq(p(15, 7), p(10, 0), p(10, 0))).toBe(25 + 49); // degenerate: a point
    // Diagonal: the closest point to (10,0) on (0,0)→(10,10) is (5,5), distance² 50.
    expect(segmentDistSq(p(10, 0), p(0, 0), p(10, 10))).toBe(50);
    // Rounding is toward the segment start: (0,0)→(3,3) vs (3,0): exact closest (1.5,1.5) → floored (1,1) → 4+1 = 5 rather than 4.5.
    expect(segmentDistSq(p(3, 0), p(0, 0), p(3, 3))).toBe(5);
  });

  it("a polyline is tested segment by segment, a single point as a point, an empty sweep never crosses", () => {
    expect(sweepCrosses([p(0, 0), p(10, 0), p(10, 10)], p(10, 5), 0)).toBe(true);
    expect(sweepCrosses([p(0, 0), p(10, 0)], p(10, 5), 24)).toBe(false);
    expect(sweepCrosses([p(0, 0), p(10, 0)], p(10, 5), 25)).toBe(true);
    expect(sweepCrosses([p(3, 4)], p(0, 0), 25)).toBe(true);
    expect(sweepCrosses([p(3, 4)], p(0, 0), 24)).toBe(false);
    expect(sweepCrosses([], p(0, 0), 1 << 30)).toBe(false);
  });
});

describe("TRAP_TRIGGER_TEST", () => {
  it("fires once when the swept path first comes within trigger radius + unitRadius, with the trap's affinity applied, then is spent", () => {
    // Straight south along x = 15: the trap at (15,5) is reached when y ≥ 5632 − 1126 = 4506 → tick 52 (y = 4540).
    const out = resolve(input(battlefield({ traps: [trap("t", { x: 15, y: 5 })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), PER_TICK_KEYFRAMES));
    const fired = events(out, "trap_fired");
    // grit trap vs beast unit: disadvantage → 250 × 819/1024 = 199.9 → 199
    expect(fired).toEqual([{ t: 52, k: "trap_fired", i: 0, u: 0, damage: 199, hp: 421, effect: null }]);
    expect(keyframes(out)[52]!.units[0]!.y).toBe(512 + 76 * 53);
    expect(keyframes(out)[52]!.traps).toEqual([{ i: 0, spent: true }]);
    expect(keyframes(out)[51]!.traps).toEqual([{ i: 0, spent: false }]);
    expect(out.traps[0]).toEqual({ i: 0, ref: "t", spent: true, spentTick: 52 });
    expect(out.units[0]!.hp).toBe(421);
    expect(events(out, "unit_died")).toHaveLength(0);
    // An advantaged trap: powder vs beast → 250 × 1.25 = 312.
    const powder = resolve(input(battlefield({ traps: [trap("t", { x: 15, y: 5 }, { category: "powder", affinity: "powder" })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    expect(events(powder, "trap_fired")[0]!.damage).toBe(312);
  });

  it("no tunnelling: a unit fast enough to cross the trap entirely between two ticks still springs it, where a landing-position test would miss it", () => {
    // 64 cells/s → 3276 per tick; the trap at (15,5) is 1844 behind the tick-0 landing and 1432 past the tick-1 landing.
    const out = resolve(input(battlefield({ traps: [trap("t", { x: 15, y: 5 })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 }, moveSpeed: 65536 })]), PER_TICK_KEYFRAMES));
    expect(keyframes(out)[0]!.units[0]!.y).toBe(512 + 3276);
    expect(keyframes(out)[1]!.units[0]!.y).toBe(512 + 2 * 3276);
    const trapY = cellCenter({ x: 15, y: 5 }).y;
    expect(trapY - (512 + 3276)).toBeGreaterThan(TRAP_REACH);
    expect(512 + 2 * 3276 - trapY).toBeGreaterThan(TRAP_REACH);
    expect(events(out, "trap_fired")).toEqual([{ t: 1, k: "trap_fired", i: 0, u: 0, damage: 199, hp: 421, effect: null }]);
  });

  it("the sweep follows waypoint corners, not the start→end chord", () => {
    const state = initialState(normalizeInput(input(battlefield({ traps: [trap("t", { x: 10, y: 10 })] }), party([unit({ ref: "a" })]))));
    const u = state.units[0]!;
    const c = cellCenter({ x: 10, y: 10 });
    // An L-shaped sweep whose corner sits on the trap, whose chord misses it by far.
    u.sweep = [p(c.x - 4000, c.y), p(c.x, c.y), p(c.x, c.y - 4000)];
    const log: LogEvent[] = [];
    trapTriggerPhase(state, log);
    expect(log).toHaveLength(1);
    expect(sweepCrosses([u.sweep[0]!, u.sweep[2]!], c, state.trapReachSq)).toBe(false);
  });

  it("TRAP_TIE_BREAK: two units crossing one trap on the same tick — the lower id springs it, the other is untouched, and it fires exactly once", () => {
    const out = resolve(input(battlefield({ traps: [trap("t", { x: 15, y: 5 })] }), party([unit({ ref: "b", cell: { x: 15, y: 0 } }), unit({ ref: "a", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    expect(out.units.map((u) => u.ref)).toEqual(["a", "b"]);
    expect(events(out, "trap_fired")).toEqual([{ t: 52, k: "trap_fired", i: 0, u: 0, damage: 199, hp: 421, effect: null }]);
    expect(out.units[1]!.hp).toBe(620);
  });

  it("one unit crossing two traps on one tick springs both, in trap index order", () => {
    const out = resolve(input(battlefield({ traps: [trap("t2", { x: 15, y: 6 }), trap("t1", { x: 15, y: 5 })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 }, moveSpeed: 65536 })]), SHORT_TUNABLES));
    expect(out.traps.map((t) => t.ref)).toEqual(["t1", "t2"]);
    expect(events(out, "trap_fired")).toEqual([
      { t: 1, k: "trap_fired", i: 0, u: 0, damage: 199, hp: 421, effect: null },
      { t: 1, k: "trap_fired", i: 1, u: 0, damage: 199, hp: 222, effect: null },
    ]);
  });

  it("a trap that kills the unit still spends; the unit dies in phase 8 of that tick", () => {
    const out = resolve(input(battlefield({ traps: [trap("t", { x: 15, y: 5 })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 }, hp: 100 })]), SHORT_TUNABLES));
    expect(events(out, "trap_fired")[0]).toMatchObject({ t: 52, damage: 199, hp: 0 });
    expect(events(out, "unit_died")).toEqual([{ t: 52, k: "unit_died", u: 0 }]);
    expect(out.units[0]).toMatchObject({ alive: false, hp: 0, diedTick: 52, reachedCoreTick: -1 });
  });
});

describe("SIEGE_TRAP_NULLIFY", () => {
  it("a siege piece countering the trap's category makes it fire blank — no damage, no effect — and it is still spent; a mismatched piece changes nothing", () => {
    const field = battlefield({ traps: [trap("t", { x: 15, y: 5 }, { effect: ROOT })] });
    const matched = resolve(input(field, party([unit({ ref: "a", cell: { x: 15, y: 0 } })], [{ ref: "s", typeId: "siege.bridging_planks", counters: { kind: "trap", category: "groundwork" } }]), PER_TICK_KEYFRAMES));
    expect(events(matched, "trap_nullified")).toEqual([{ t: 52, k: "trap_nullified", i: 0, u: 0 }]);
    expect(events(matched, "trap_fired")).toHaveLength(0);
    expect(events(matched, "speed")).toHaveLength(0);
    expect(matched.traps[0]).toMatchObject({ spent: true, spentTick: 52 });
    expect(matched.units[0]!.hp).toBe(620);
    expect(keyframes(matched)[53]!.units[0]!.y).toBe(512 + 76 * 54); // never rooted
    const mismatched = resolve(input(field, party([unit({ ref: "a", cell: { x: 15, y: 0 } })], [{ ref: "s", typeId: "siege.dousing_wagon", counters: { kind: "trap", category: "powder" } }]), SHORT_TUNABLES));
    expect(events(mismatched, "trap_fired")).toHaveLength(1);
    expect(events(mismatched, "trap_nullified")).toHaveLength(0);
    // A spent (nullified) trap is not there for the next unit.
    const two = resolve(input(field, party([unit({ ref: "a", cell: { x: 15, y: 0 } }), unit({ ref: "b", cell: { x: 15, y: 1 } })], [{ ref: "s", typeId: "siege.bridging_planks", counters: { kind: "trap", category: "groundwork" } }]), SHORT_TUNABLES));
    expect(events(two, "trap_nullified")).toHaveLength(1);
    expect(events(two, "trap_fired")).toHaveLength(0);
  });
});

describe("TRAP_EFFECTS", () => {
  it("root: 0 movement for exactly msToTicks(duration) ticks after the trigger, with `speed` 0 / restore events and `hold` edges", () => {
    const out = resolve(input(battlefield({ traps: [trap("t", { x: 15, y: 5 }, { effect: ROOT })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), PER_TICK_KEYFRAMES));
    expect(events(out, "trap_fired")[0]).toMatchObject({ t: 52, effect: "root" });
    expect(events(out, "speed")).toEqual([
      { t: 52, k: "speed", u: 0, speed: 0 },
      { t: 82, k: "speed", u: 0, speed: 76 }, // 1500 ms = 30 ticks: 53..82 stand still
    ]);
    const ks = keyframes(out);
    const yAt = (t: number) => ks[t]!.units[0]!.y;
    expect(yAt(52)).toBe(512 + 76 * 53);
    for (let t = 53; t <= 82; t++) expect(yAt(t), `tick ${t}`).toBe(yAt(52));
    expect(yAt(83)).toBe(yAt(52) + 76);
    expect(ks[53]!.units[0]!.root).toBe(29);
    expect(ks[82]!.units[0]!.root).toBe(0);
    expect(events(out, "hold")).toEqual([
      { t: 53, k: "hold", u: 0, holding: true },
      { t: 83, k: "hold", u: 0, holding: false },
      { t: events(out, "hold")[2]!.t, k: "hold", u: 0, holding: true }, // arrival at the core
    ]);
  });

  it("slow: −magnitude of the per-tick speed (floored) for msToTicks(duration) ticks, then the base speed again", () => {
    const out = resolve(input(battlefield({ traps: [trap("t", { x: 15, y: 5 }, { effect: SLOW })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), PER_TICK_KEYFRAMES));
    // 76 − floor(76 × 410/1024) = 76 − 30 = 46, for 3000 ms = 60 ticks.
    expect(events(out, "speed")).toEqual([
      { t: 52, k: "speed", u: 0, speed: 46 },
      { t: 112, k: "speed", u: 0, speed: 76 },
    ]);
    const ks = keyframes(out);
    const yAt = (t: number) => ks[t]!.units[0]!.y;
    for (let t = 53; t <= 112; t++) expect(yAt(t) - yAt(t - 1), `tick ${t}`).toBe(46);
    expect(yAt(113) - yAt(112)).toBe(76);
    expect(ks[53]!.units[0]!.slow).toBe(59);
    expect(events(out, "hold").filter((h) => h.t < 200)).toHaveLength(0); // slowed is still moving
  });

  it("EFFECT_STACKING: a second effect of the same kind refreshes to the longer remaining time, never adds", () => {
    const state = initialState(normalizeInput(input(battlefield({ traps: [trap("t1", { x: 10, y: 10 }, { effect: ROOT }), trap("t2", { x: 12, y: 10 }, { effect: ROOT })] }), party([unit({ ref: "a" })]))));
    const u = state.units[0]!;
    u.sweep = [cellCenter({ x: 10, y: 10 })];
    const log: LogEvent[] = [];
    trapTriggerPhase(state, log);
    expect(u.rootRemaining).toBe(30);
    u.rootRemaining = 5;
    u.sweep = [cellCenter({ x: 12, y: 10 })];
    trapTriggerPhase(state, log);
    expect(u.rootRemaining).toBe(30);
    u.rootRemaining = 40; // a longer root in force stays
    expect(state.traps.every((t) => t.spent)).toBe(true);
  });

  it("effect durations are converted with the tick rate: at 40 ticks/s a 1.5 s root is 60 ticks", () => {
    const out = resolve(input(battlefield({ traps: [trap("t", { x: 15, y: 5 }, { effect: ROOT })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), { ...DEFAULT_TUNABLES, battleLengthCapSeconds: 10, tickRate: 40 }));
    const [slowed, restored] = events(out, "speed");
    expect(restored!.t - slowed!.t).toBe(60);
  });
});

describe("posted units and traps", () => {
  it("a posted unit sweeping across an unspent trap never springs it (traps test attackers only)", () => {
    const state = initialState(normalizeInput(input(battlefield({ traps: [trap("t", { x: 10, y: 10 })], posts: [post("p", { x: 10, y: 12 })] }), party([unit({ ref: "a" })]))));
    const d = state.units[1]!;
    d.sweep = [cellCenter({ x: 10, y: 13 }), cellCenter({ x: 10, y: 9 })];
    state.units[0]!.sweep = [cellCenter({ x: 20, y: 20 })];
    const log: LogEvent[] = [];
    trapTriggerPhase(state, log);
    expect(log).toHaveLength(0);
    expect(state.traps[0]!.spent).toBe(false);
  });

  it("end to end: a guard chasing back and forth over a trap cell leaves it unspent, while the attacker it chases stops short of it", () => {
    // Guard at (15,9) with an 8-cell aggro and a 4-cell leash; the attacker holds at the core centre
    // (6 cells away) — out of the guard's reach at full leash, so it oscillates across the trap at (15,12).
    const out = resolve(input(battlefield({ traps: [trap("t", { x: 15, y: 12 })], posts: [post("p", { x: 15, y: 9 }, { aggroRadius: 8192 as Fixed })] }), party([unit({ ref: "a", edge: "south", cell: { x: 15, y: 31 } })]), SHORT_TUNABLES));
    expect(events(out, "aggro").length).toBeGreaterThan(1);
    const ks = keyframes(out);
    expect(ks.some((k) => k.units[1]!.y > cellCenter({ x: 15, y: 12 }).y)).toBe(true);
    expect(out.traps[0]!.spent).toBe(false);
  });
});
