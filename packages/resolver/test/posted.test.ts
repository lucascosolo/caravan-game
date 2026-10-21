/**
 * Chunk 11 — phase 5 posted units: the three stances, aggro acquisition at the exact
 * boundary, leash at the exact boundary (inclusive), hysteresis and the bounded oscillation,
 * disengage-and-return, a target outside the leash but inside aggro, two posts acquiring
 * one attacker, `hold` never moving and hitting at exactly its reach, `reserve` releasing on
 * a ring cell vs one cell inside, and pursuit that routes around fence rather than through.
 */
import { describe, expect, it } from "vitest";
import {
  CORE_CENTER,
  acquireTarget,
  attackPhase,
  attackerInsideRing,
  cellCenter,
  cellKey,
  cellOf,
  initialState,
  normalizeInput,
  planPostedRoute,
  postedUnitPhase,
  resolve,
  runTick,
  type Fixed,
  type LogEvent,
  type ResolveInput,
  type ResolveOutput,
  type SimState,
} from "../src/index.js";
import { runToCap, DEFAULT_TUNABLES, QUIET_SHORT_TUNABLES, SHORT_TUNABLES, battlefield, clone, input, ms, party, post, reachSq, ringExcept, unit } from "./fixtures.js";

const events = <K extends LogEvent["k"]>(out: { readonly log: readonly LogEvent[] }, k: K) => out.log.filter((e): e is Extract<LogEvent, { k: K }> => e.k === k);
const keyframes = (out: ResolveOutput) => events(out, "keyframe");
const mk = (inp: ResolveInput): SimState => initialState(normalizeInput(clone(inp)));
const place = (state: SimState, id: number, x: number, y: number): void => {
  state.units[id]!.x = x as Fixed;
  state.units[id]!.y = y as Fixed;
};
/** The fixture guard at (15,8): aggro 3 cells (+0.35 reach = 3430), leash 4 cells (4096), hysteresis 0.8 × 4096 = 3276, speed 51/tick. */
const guardAt = (cell = { x: 15, y: 8 }) => post("p", cell);
const PX = 15 * 1024 + 512;
const PY = 8 * 1024 + 512;
const AGGRO_REACH = 3072 + 358;
const LEASH = 4096;
const HYST = 3276;

describe("guard: acquisition", () => {
  it("acquires an attacker at exactly aggroRadius + unitRadius, not one unit further; the nearest wins, ties → lowest id", () => {
    const state = mk(input(battlefield({ posts: [guardAt()] }), party([unit({ ref: "a" }), unit({ ref: "b" })])));
    place(state, 0, PX, PY - AGGRO_REACH - 1);
    place(state, 1, PX, PY - AGGRO_REACH - 1);
    expect(acquireTarget(state, state.units[2]!)).toBe(-1);
    place(state, 1, PX, PY - AGGRO_REACH);
    expect(acquireTarget(state, state.units[2]!)).toBe(1);
    place(state, 0, PX, PY - AGGRO_REACH);
    expect(acquireTarget(state, state.units[2]!)).toBe(0); // tie → lower id
    place(state, 1, PX + 1, PY - AGGRO_REACH + 100);
    expect(acquireTarget(state, state.units[2]!)).toBe(1); // nearer
    // Through the phase: an `aggro` event and the pursuing mode.
    const log: LogEvent[] = [];
    postedUnitPhase(state, log);
    expect(log[0]).toEqual({ t: 0, k: "aggro", u: 2, v: 1 });
    expect(state.units[2]!.postMode).toBe("pursuing");
    expect(state.units[2]!.target).toEqual({ kind: "unit", id: 1 });
  });

  it("two posted units acquiring the same attacker on the same tick both pursue it, in id order", () => {
    const state = mk(input(battlefield({ posts: [post("p1", { x: 14, y: 8 }), post("p2", { x: 16, y: 8 })] }), party([unit({ ref: "a" })])));
    place(state, 0, PX, PY - 2000);
    const log: LogEvent[] = [];
    postedUnitPhase(state, log);
    expect(log.filter((e) => e.k === "aggro")).toEqual([
      { t: 0, k: "aggro", u: 1, v: 0 },
      { t: 0, k: "aggro", u: 2, v: 0 },
    ]);
  });

  it("acquisition is decided by aggro, not the leash: a target beyond the leash but inside aggro is acquired, chased to the leash, then dropped there", () => {
    // Aggro 6 cells (reach 6502) > leash 4 cells; the attacker stands 6000 away — beyond leash + attack
    // reach (4096 + 1382), so the guard can never get it in reach — and never comes closer.
    const state = mk(input(battlefield({ posts: [post("q", { x: 15, y: 8 }, { aggroRadius: 6144 as Fixed })] }), party([unit({ ref: "a", attackRange: 0 })])));
    place(state, 0, PX, PY - 6000);
    const log: LogEvent[] = [];
    for (; state.tick < 120; state.tick++) {
      postedUnitPhase(state, log);
      // Hold the attacker still: it is a fixture for the guard, not a mover.
      place(state, 0, PX, PY - 6000);
    }
    const q = state.units[1]!;
    expect(log.filter((e) => e.k === "aggro")[0]).toEqual({ t: 0, k: "aggro", u: 1, v: 0 });
    const dis = log.filter((e) => e.k === "disengage");
    expect(dis[0]).toMatchObject({ k: "disengage", u: 1, why: "leash" });
    // After the leash disengage it is on its way back, and it was never in reach of the attacker.
    expect(PY - q.y).toBeLessThanOrEqual(LEASH); // y decreases northward
    expect(q.postMode).not.toBe("idle");
    expect(log.filter((e) => e.k === "hit")).toHaveLength(0);
  });
});

describe("guard: leash and hysteresis", () => {
  const pursuing = (dy: number, attackerDy: number) => {
    const state = mk(input(battlefield({ posts: [guardAt()] }), party([unit({ ref: "a" })])));
    const g = state.units[1]!;
    place(state, 0, PX, PY - attackerDy);
    place(state, 1, PX, PY - dy);
    g.postMode = "pursuing";
    g.target = { kind: "unit", id: 0 };
    const log: LogEvent[] = [];
    postedUnitPhase(state, log);
    return { state, g, log };
  };

  it("LEASH_BOUNDARY_RULE: at exactly leashDistance from the post the unit is still engaged; one unit beyond, it disengages", () => {
    const at = pursuing(LEASH, LEASH + 1000);
    expect(at.g.postMode).toBe("pursuing");
    expect(at.log.filter((e) => e.k === "disengage")).toHaveLength(0);
    const beyond = pursuing(LEASH + 1, LEASH + 1000);
    expect(beyond.g.postMode).toBe("returning");
    expect(beyond.log[0]).toEqual({ t: 0, k: "disengage", u: 1, why: "leash" });
    expect(beyond.g.target).toBeNull();
  });

  it("the leash is measured from the POST, the aggro from the UNIT: a target that leaves the unit's aggro reach is `lost`; the checks run dead → leash → lost", () => {
    const lost = pursuing(1000, 1000 + AGGRO_REACH + 1);
    expect(lost.log[0]).toEqual({ t: 0, k: "disengage", u: 1, why: "lost" });
    const kept = pursuing(1000, 1000 + AGGRO_REACH);
    expect(kept.g.postMode).toBe("pursuing");
    // Both beyond the leash and out of aggro: the leash reason wins (it is checked first).
    const both = pursuing(LEASH + 1, LEASH + 1 + AGGRO_REACH + 1);
    expect(both.log[0]).toEqual({ t: 0, k: "disengage", u: 1, why: "leash" });
    // Dead target: `dead` wins over everything.
    const state = mk(input(battlefield({ posts: [guardAt()] }), party([unit({ ref: "a" })])));
    place(state, 1, PX, PY - LEASH - 1);
    state.units[0]!.alive = false;
    state.units[1]!.postMode = "pursuing";
    state.units[1]!.target = { kind: "unit", id: 0 };
    const log: LogEvent[] = [];
    postedUnitPhase(state, log);
    expect(log[0]).toEqual({ t: 0, k: "disengage", u: 1, why: "dead" });
  });

  it("LEASH_HYSTERESIS: a returning unit is deaf to aggro until it is within 80 % of its leash from the post (inclusive), then re-acquires", () => {
    const returning = (dy: number) => {
      const state = mk(input(battlefield({ posts: [guardAt()] }), party([unit({ ref: "a" })])));
      place(state, 0, PX, PY - dy - 500); // an attacker right next to the guard, well inside aggro
      place(state, 1, PX, PY - dy);
      state.units[1]!.postMode = "returning";
      const log: LogEvent[] = [];
      postedUnitPhase(state, log);
      return { mode: state.units[1]!.postMode, log };
    };
    expect(returning(HYST + 1).mode).toBe("returning");
    expect(returning(HYST + 1).log.filter((e) => e.k === "aggro")).toHaveLength(0);
    expect(returning(HYST).mode).toBe("pursuing");
    expect(returning(HYST).log[0]).toEqual({ t: 0, k: "aggro", u: 1, v: 0 });
    expect(returning(HYST).log.filter((e) => e.k === "path")).toHaveLength(0); // in reach already: no route
  });

  it("DISENGAGE_BEHAVIOR: after disengaging the unit walks back to its exact post position, logs `returned`, and goes idle", () => {
    const state = mk(input(battlefield({ posts: [guardAt()] }), party([unit({ ref: "a" })])));
    place(state, 0, 2 * 1024, 2 * 1024); // far away: nothing to acquire
    place(state, 1, PX, PY - 2000);
    state.units[1]!.postMode = "returning";
    state.units[1]!.pathDirty = true;
    const log: LogEvent[] = [];
    for (let t = 0; t < 45; t++) {
      state.tick = t;
      postedUnitPhase(state, log);
    }
    expect(state.units[1]!.postMode).toBe("idle");
    expect([state.units[1]!.x, state.units[1]!.y]).toEqual([PX, PY]);
    const returned = log.find((e) => e.k === "returned")!;
    expect(returned).toEqual({ t: 39, k: "returned", u: 1 }); // ⌈2000 / 51⌉ = 40 ticks of walking: ticks 0..39, the last one lands exactly
    // The route was logged with the exact post as its final waypoint, and the hold edges bracket the walk.
    const path = log.find((e) => e.k === "path") as Extract<LogEvent, { k: "path" }>;
    expect(path.wp[path.wp.length - 1]).toEqual([PX, PY, -1]);
    expect(log.filter((e) => e.k === "hold").map((h) => (h as { holding: boolean }).holding)).toEqual([false, true]);
  });

  it("oscillation at the leash boundary is deterministic and bounded: a guard chasing a target it can never reach alternates aggro / leash disengage, never passing the leash by more than one step, and re-acquires only inside the hysteresis radius", () => {
    // Guard at (15,9), aggro 8 cells, leash 4; the attacker holds at the core centre 6 cells away (never in reach).
    const inp = input(battlefield({ posts: [post("p", { x: 15, y: 9 }, { aggroRadius: 8192 as Fixed })] }), party([unit({ ref: "a", edge: "south", cell: { x: 15, y: 31 } })]), { ...SHORT_TUNABLES, keyframeIntervalMs: ms(50) });
    // runToCap (mechanic isolation): the raider holds on the core, which would end the fight.
    const out = runToCap(inp);
    expect(JSON.stringify(runToCap(clone(inp)))).toBe(JSON.stringify(out));
    const postY = cellCenter({ x: 15, y: 9 }).y;
    const aggro = events(out, "aggro");
    const dis = events(out, "disengage");
    expect(aggro.length).toBeGreaterThan(3);
    expect(dis.length).toBeGreaterThan(3);
    expect(dis.every((d) => d.why === "leash")).toBe(true);
    // Strictly alternating, aggro first.
    const seq = out.log.filter((e) => e.k === "aggro" || e.k === "disengage").map((e) => e.k);
    for (let i = 0; i < seq.length; i++) expect(seq[i]).toBe(i % 2 === 0 ? "aggro" : "disengage");
    // Never further than the leash plus one tick's step (51), and every re-acquire happens at ≤ hysteresis.
    const ks = keyframes(out);
    expect(Math.max(...ks.map((k) => k.units[1]!.y - postY))).toBeLessThanOrEqual(LEASH + 51);
    expect(Math.max(...ks.map((k) => k.units[1]!.y - postY))).toBeGreaterThan(LEASH - 51);
    for (const a of aggro.slice(1)) expect(ks[a.t - 1]!.units[1]!.y - postY).toBeLessThanOrEqual(HYST);
    // Each half-cycle takes at least (leash − hysteresis) / speed = 16 ticks.
    for (let i = 1; i < seq.length; i++) {
      const prev = out.log.filter((e) => e.k === "aggro" || e.k === "disengage")[i - 1]!.t;
      const cur = out.log.filter((e) => e.k === "aggro" || e.k === "disengage")[i]!.t;
      expect(cur - prev).toBeGreaterThanOrEqual(16);
    }
    expect(events(out, "hit")).toHaveLength(0);
  });
});

describe("guard: pursuit and the fight", () => {
  it("end to end: a guard notices a passing attacker, chases it within its leash, drops it, returns, and goes idle — every transition logged", () => {
    // The attacker (core stance) walks straight down x = 14 past a guard at (11,8), 3 cells off its line.
    // runToCap: the walk home happens after the raider reaches the core (which ends a real fight).
    const out = runToCap(input(battlefield({ posts: [guardAt({ x: 11, y: 8 })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: 5000 })]), QUIET_SHORT_TUNABLES));
    const kinds = out.log.filter((e) => (e.k === "aggro" || e.k === "disengage" || e.k === "returned") && e.u === 1).map((e) => e.k);
    expect(kinds).toEqual(["aggro", "disengage", "returned"]);
    // Following the attacker keeps it inside aggro reach, so it is the leash that ends the chase.
    expect(events(out, "disengage")[0]!.why).toBe("leash");
    // At 51/tick it cannot catch a 76/tick attacker: it chased (left its post) but never got a hit in.
    const postCell = cellCenter({ x: 11, y: 8 });
    expect(keyframes(out).some((k) => k.units[1]!.x !== postCell.x || k.units[1]!.y !== postCell.y)).toBe(true);
    expect(events(out, "hit").filter((h) => h.u === 1)).toHaveLength(0);
    expect(out.units[1]!.alive).toBe(true);
    expect([out.units[1]!.x, out.units[1]!.y]).toEqual([cellCenter({ x: 11, y: 8 }).x, cellCenter({ x: 11, y: 8 }).y]);
    expect(out.units[0]!.reachedCoreTick).toBeGreaterThan(0);
    // Posted-unit movement is in the log on the attacker's terms: path / hold / speed only.
    const pathsForGuard = events(out, "path").filter((p) => p.u === 1);
    expect(pathsForGuard.length).toBeGreaterThan(0);
    expect(pathsForGuard[0]!.speed).toBe(51);
  });

  it("a guard that kills its target disengages (`dead`) and returns; a dead guard is skipped and no longer pursues", () => {
    // runToCap: the guard's walk home comes after the wipe that ends a real fight (resolve: caravan_held).
    expect(resolve(input(battlefield({ posts: [guardAt()] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 15, y: 0 }, hp: 40 })]), SHORT_TUNABLES)).outcome.kind).toBe("caravan_held");
    const out = runToCap(input(battlefield({ posts: [guardAt()] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 15, y: 0 }, hp: 40 })]), SHORT_TUNABLES));
    expect(events(out, "unit_died")).toEqual([{ t: events(out, "unit_died")[0]!.t, k: "unit_died", u: 0 }]);
    expect(events(out, "disengage")).toEqual([{ t: out.units[0]!.diedTick + 1, k: "disengage", u: 1, why: "dead" }]);
    expect(events(out, "returned")).toHaveLength(1);
    const dead = resolve(input(battlefield({ posts: [post("p", { x: 15, y: 8 }, { hp: 1, maxHp: 1100 })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    expect(dead.units[1]!.alive).toBe(false);
    expect(events(dead, "aggro").length).toBeLessThanOrEqual(1);
    expect(events(dead, "disengage")).toHaveLength(0);
    // Nothing of the dead guard's after its death: no path, no hold, no hit; its position is frozen.
    const diedAt = dead.units[1]!.diedTick;
    expect(dead.log.filter((e) => e.t > diedAt && e.k !== "keyframe" && e.k !== "fence_broken" && e.u === 1)).toHaveLength(0);
    const frozen = keyframes(dead).filter((k) => k.t >= diedAt);
    expect(frozen.every((k) => k.units[1]!.x === frozen[0]!.units[1]!.x && k.units[1]!.y === frozen[0]!.units[1]!.y && !k.units[1]!.alive)).toBe(true);
  });

  it("a pursuing guard with no breach-free route stands at its post, keeps pursuing without chatter, and still fires when the target comes into reach", () => {
    // Sealed ring; the guard inside at (15,12) has an 8-cell aggro; the attacker chips the fence at (15,11) from (15,10).
    const out = resolve(input(battlefield({ fences: ringExcept([], 1_000_000), posts: [post("p", { x: 15, y: 12 }, { aggroRadius: 8192 as Fixed, attackRange: 4096 as Fixed })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 }, hp: 100_000 })]), SHORT_TUNABLES));
    expect(events(out, "aggro")).toHaveLength(1);
    expect(events(out, "disengage")).toHaveLength(0);
    expect(keyframes(out).every((k) => k.units[1]!.x === cellCenter({ x: 15, y: 12 }).x && k.units[1]!.y === cellCenter({ x: 15, y: 12 }).y)).toBe(true);
    expect(events(out, "hit").filter((h) => h.u === 1).length).toBeGreaterThan(5);
    expect(events(out, "path").filter((p) => p.u === 1)).toHaveLength(0);
  });

  it("planPostedRoute never breaches: null through a sealed ring, a clear route through a gap, the exact goal as the last waypoint", () => {
    const sealed = mk(input(battlefield({ fences: ringExcept([]), posts: [post("p", { x: 15, y: 13 })] }), party([unit({ ref: "a" })])));
    expect(planPostedRoute(sealed, sealed.units[1]!, cellCenter({ x: 15, y: 5 }))).toBeNull();
    const gapped = mk(input(battlefield({ fences: ringExcept([3]), posts: [post("p", { x: 15, y: 13 })] }), party([unit({ ref: "a" })])));
    const goal = { x: (15 * 1024 + 700) as Fixed, y: (5 * 1024 + 300) as Fixed };
    const route = planPostedRoute(gapped, gapped.units[1]!, goal)!;
    expect(route).not.toBeNull();
    expect(route[route.length - 1]).toEqual({ x: goal.x, y: goal.y, breach: -1 });
    expect(route.every((w) => w.breach === -1)).toBe(true);
    for (const w of route) expect(gapped.grid[cellKey(cellOf(w))]).toBe(-1);
    // Already in the goal cell: a single waypoint to the exact goal; on the goal: no route.
    const same = planPostedRoute(gapped, gapped.units[1]!, { x: (gapped.units[1]!.x + 10) as Fixed, y: gapped.units[1]!.y })!;
    expect(same).toEqual([{ x: gapped.units[1]!.x + 10, y: gapped.units[1]!.y, breach: -1 }]);
    expect(planPostedRoute(gapped, gapped.units[1]!, { x: gapped.units[1]!.x, y: gapped.units[1]!.y })).toEqual([]);
  });
});

describe("hold", () => {
  it("never leaves its post, never acquires, and hits an attacker at exactly its reach from the post but not one unit further", () => {
    // The attacker walks down x = 15, one cell (1024 < 1382 reach) from a hold post at (14,8).
    const out = resolve(input(battlefield({ posts: [post("p", { x: 14, y: 8 }, { stance: "hold" })] }), party([unit({ ref: "a", cell: { x: 15, y: 0 }, hp: 5000 })]), SHORT_TUNABLES));
    expect(events(out, "aggro")).toHaveLength(0);
    expect(events(out, "path").filter((p) => p.u === 1)).toHaveLength(0);
    expect(events(out, "hold").filter((h) => h.u === 1)).toHaveLength(0);
    const c = cellCenter({ x: 14, y: 8 });
    expect(keyframes(out).every((k) => k.units[1]!.x === c.x && k.units[1]!.y === c.y)).toBe(true);
    expect(events(out, "hit").filter((h) => h.u === 1).length).toBeGreaterThan(0); // it shot the attacker as it passed
    expect(out.units[0]!.reachedCoreTick).toBeGreaterThan(0); // and did not follow it
    const state = mk(input(battlefield({ posts: [post("p", { x: 15, y: 8 }, { stance: "hold" })] }), party([unit({ ref: "a" })])));
    const at = (dy: number) => {
      place(state, 0, PX, PY - dy);
      state.units[1]!.cooldownRemaining = 0;
      state.units[0]!.cooldownRemaining = 5;
      const log: LogEvent[] = [];
      postedUnitPhase(state, log);
      attackPhase(state, log);
      return log;
    };
    expect(at(1382).filter((e) => e.k === "hit")).toEqual([{ t: 0, k: "hit", u: 1, v: 0, damage: 40, hp: 580 }]);
    expect(at(1383).filter((e) => e.k === "hit")).toHaveLength(0);
    expect(at(1383).filter((e) => e.k === "aggro")).toHaveLength(0);
    expect(state.units[1]!.postMode).toBe("idle");
    expect(reachSq(1024)).toBe(1382 * 1382);
  });
});

describe("reserve", () => {
  it("is released by an attacker whose cell is strictly inside the ring: a ring (gap) cell does not count, one cell inside does", () => {
    const state = mk(input(battlefield({ posts: [post("p", { x: 15, y: 13 }, { stance: "reserve" })] }), party([unit({ ref: "a" })])));
    const c = cellCenter({ x: 14, y: 10 }); // segment 15 (the north gap), a ring cell
    place(state, 0, c.x, c.y);
    expect(attackerInsideRing(state)).toBe(-1);
    place(state, 0, c.x, (11 * 1024) as Fixed); // the first fixed unit of row 11, inside the ring
    expect(attackerInsideRing(state)).toBe(0);
    place(state, 0, (11 * 1024) as Fixed, (12 * 1024) as Fixed); // segment 14 (11,12), a ring cell
    expect(attackerInsideRing(state)).toBe(-1);
    place(state, 0, (12 * 1024) as Fixed, (12 * 1024) as Fixed); // (12,12), inside the ring
    expect(attackerInsideRing(state)).toBe(0);
  });

  it("does not acquire or move until released, but fires at an attacker in reach (QA-11 D1); then behaves as guard for good", () => {
    const state = mk(input(battlefield({ posts: [post("p", { x: 15, y: 9 }, { stance: "reserve" })] }), party([unit({ ref: "a" }), unit({ ref: "b" })])));
    const r = state.units[2]!;
    const ry = cellCenter({ x: 15, y: 9 }).y;
    place(state, 0, PX, ry - 1000); // in reach and in aggro, but outside the ring (row 8)
    place(state, 1, 2 * 1024, 2 * 1024);
    const log: LogEvent[] = [];
    postedUnitPhase(state, log);
    attackPhase(state, log);
    expect(log.filter((e) => e.k === "aggro" || e.k === "released" || e.k === "hold" || e.k === "path")).toHaveLength(0);
    expect(r.postMode).toBe("idle");
    expect([r.x, r.y]).toEqual([PX, ry]);
    expect(log.filter((e) => e.k === "hit" && e.u === 2)).toHaveLength(1); // stance gates acquisition and movement, not what gets hit
    expect(log.filter((e) => e.k === "hit" && e.u === 0)).toHaveLength(1);
    r.cooldownRemaining = 0;
    // Unit b steps one cell inside the ring: released on b, and it acquires the NEAREST attacker (a).
    place(state, 1, (12 * 1024 + 512) as Fixed, (12 * 1024 + 512) as Fixed);
    state.units[0]!.cooldownRemaining = 0;
    const log2: LogEvent[] = [];
    postedUnitPhase(state, log2);
    attackPhase(state, log2);
    expect(log2[0]).toEqual({ t: 0, k: "released", u: 2, v: 1 });
    expect(log2[1]).toEqual({ t: 0, k: "aggro", u: 2, v: 0 });
    expect(log2.filter((e) => e.k === "hit" && e.u === 2)).toHaveLength(1);
    // b leaves the ring again: still released.
    place(state, 1, 2 * 1024, 2 * 1024);
    postedUnitPhase(state, []);
    expect(r.reserveReleased).toBe(true);
    expect(r.postMode).toBe("pursuing");
  });

  it("end to end: released the tick the first attacker's cell enters row 11 through the gap at segment 15", () => {
    // The reserve post at (17,17) is 2.83 cells from the core centre: inside its aggro reach once released.
    // runToCap: the released post's hits land after the raider stands on the core.
    const out = runToCap(input(battlefield({ fences: ringExcept([15]), posts: [post("p", { x: 17, y: 17 }, { stance: "reserve" })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: 5000 })]), { ...SHORT_TUNABLES, keyframeIntervalMs: ms(50) }));
    const released = events(out, "released")[0]!;
    expect(released).toMatchObject({ u: 1, v: 0 });
    const ks = keyframes(out);
    expect(cellOf({ x: ks[released.t]!.units[0]!.x as Fixed, y: ks[released.t]!.units[0]!.y as Fixed }).y).toBe(11);
    expect(cellOf({ x: ks[released.t - 1]!.units[0]!.x as Fixed, y: ks[released.t - 1]!.units[0]!.y as Fixed }).y).toBe(10);
    expect(events(out, "aggro")[0]!.t).toBeGreaterThanOrEqual(released.t);
    expect(events(out, "hit").filter((h) => h.u === 1).length).toBeGreaterThan(0);
    expect(CORE_CENTER.y).toBe(15 * 1024 + 512);
  });
});

describe("stance is data", () => {
  it("the same layout with the three stances produces three different fights", () => {
    const run = (stance: "guard" | "hold" | "reserve") => JSON.stringify(resolve(input(battlefield({ fences: ringExcept([15]), posts: [post("p", { x: 13, y: 12 }, { stance })] }), party([unit({ ref: "a", cell: { x: 14, y: 0 }, hp: 5000 })]), SHORT_TUNABLES)).log);
    const g = run("guard");
    const h = run("hold");
    const r = run("reserve");
    expect(g).not.toBe(h);
    expect(h).not.toBe(r);
    expect(g).not.toBe(r);
    expect(DEFAULT_TUNABLES.leashHysteresisMult).toBe(819);
  });

  it("phase order within a tick is attackers move → traps → posted units → attacks → deaths (one tick, by hand)", () => {
    const state = mk(input(battlefield({ posts: [guardAt()] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 15, y: 0 }, hp: 1 })])));
    place(state, 0, PX, PY - 1382 - 76); // one step short of reach
    const log: LogEvent[] = [];
    runTick(state, log);
    // Phase 3 closes the last 76; phase 5 acquires (the attacker is now inside aggro), phase 6 both fire, phase 8 the attacker dies.
    expect(log.map((e) => e.k)).toEqual(["target", "path", "aggro", "hit", "hit", "unit_died"]);
  });
});
