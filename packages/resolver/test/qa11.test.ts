/**
 * Chunk 11 QA round 1 regressions (roadmap/qa/11-punchlist.md): B1 guard chatter (pursuit
 * route bound + aggro hysteresis), D1 every stance fires in reach, D2 a breacher answers only
 * a unit that can reach it, S1 input lower bounds, N1 the leash clamp, N2 traps skip 0-HP
 * units, N3 placement on the core / entry bands. The literal inputs are in qa11-fixtures.ts
 * and in the determinism corpus.
 */
import { describe, expect, it } from "vitest";
import {
  assertResolveInput,
  initialState,
  normalizeInput,
  postedUnitPhase,
  pursuitRouteInBounds,
  resolve,
  runTick,
  type Fixed,
  type LogEvent,
  type ResolveInput,
  type ResolveOutput,
  type SimState,
} from "../src/index.js";
import { CHATTER_GUARD_INPUT, RAND93_INPUT, SHIELD_BASELINE_INPUT, SHIELD_HOLD_INPUT } from "./qa11-fixtures.js";
import { DEFAULT_TUNABLES, SHORT_TUNABLES, battlefield, clone, fx, input, party, post, reserveFiresBackScenario, ringExcept, trap, unit } from "./fixtures.js";

const events = <K extends LogEvent["k"]>(out: { readonly log: readonly LogEvent[] }, k: K) => out.log.filter((e): e is Extract<LogEvent, { k: K }> => e.k === k);
const mk = (inp: ResolveInput): SimState => initialState(normalizeInput(clone(inp)));
const logBytes = (out: ResolveOutput) => JSON.stringify(out.log).length;

/** The highest number of `aggro` events any one post logged against any one attacker. */
function worstAggroPerPair(out: ResolveOutput): number {
  const n = new Map<string, number>();
  for (const e of events(out, "aggro")) n.set(`${e.u}>${e.v}`, (n.get(`${e.u}>${e.v}`) ?? 0) + 1);
  return Math.max(0, ...n.values());
}

describe("QA-11 B1: no guard chatter", () => {
  it("chatter-guard: at most 3 aggro events per post per target (was 782) and a small log (was 223 KB)", () => {
    const out = resolve(clone(CHATTER_GUARD_INPUT));
    expect(worstAggroPerPair(out)).toBeLessThanOrEqual(3);
    expect(events(out, "disengage").filter((e) => e.why === "lost")).toHaveLength(0);
    expect(logBytes(out)).toBeLessThan(40_000);
  });

  it("rand93: at most 3 aggro events per post per target (was 1550) and a log under the 118 KB full-load figure (was 455 KB)", () => {
    const out = resolve(clone(RAND93_INPUT));
    expect(worstAggroPerPair(out)).toBeLessThanOrEqual(3);
    expect(logBytes(out)).toBeLessThan(118_000);
  });

  it("PURSUIT_ROUTE_BOUND: a detour waypoint beyond the leash or outside aggro reach of the target makes the route no route", () => {
    const state = mk(input(battlefield({ posts: [post("p", { x: 15, y: 8 })] }), party([unit({ ref: "a" })])));
    const g = state.units[1]!; // aggro reach 3430, leash 4096 from (15872, 8704)
    const goal = { x: 15872 as Fixed, y: (8704 - 3000) as Fixed };
    const wp = (x: number, y: number) => ({ x: x as Fixed, y: y as Fixed, breach: -1 });
    expect(pursuitRouteInBounds(g, [wp(goal.x, goal.y)], goal)).toBe(true); // straight at it: always fine
    expect(pursuitRouteInBounds(g, [wp(15872 + 4096, 8704), wp(goal.x, goal.y)], goal)).toBe(false); // exactly on the leash, but 5000+ from the target
    expect(pursuitRouteInBounds(g, [wp(15872 + 2000, 8704 - 2000), wp(goal.x, goal.y)], goal)).toBe(true);
    expect(pursuitRouteInBounds(g, [wp(15872, 8704 + 4097), wp(goal.x, goal.y)], goal)).toBe(false); // one past the leash
    // Through the phase: a pursuing guard whose only route is out of bounds stands, keeps its target, logs nothing.
    const sealed = mk(input(battlefield({ fences: ringExcept([13, 14, 15, 16, 17, 18, 19, 20], 300), posts: [post("p", { x: 15, y: 13 }, { aggroRadius: fx(4096) })] }), party([unit({ ref: "a" })])));
    sealed.units[0]!.x = (15 * 1024 + 512) as Fixed;
    sealed.units[0]!.y = (10 * 1024 + 512) as Fixed; // north of the fence, 3 cells from the guard
    const log: LogEvent[] = [];
    for (let t = 0; t < 40; t++) {
      sealed.tick = t;
      postedUnitPhase(sealed, log);
    }
    expect(log.filter((e) => e.k === "aggro")).toHaveLength(1);
    expect(log.filter((e) => e.k === "disengage" || e.k === "path")).toHaveLength(0);
    expect(sealed.units[1]!.postMode).toBe("pursuing");
    expect([sealed.units[1]!.x, sealed.units[1]!.y]).toEqual([15 * 1024 + 512, 13 * 1024 + 512]);
  });

  it("AGGRO_HYSTERESIS: after a `lost`, the same attacker is re-acquired only within hysteresis × aggro reach; others at full reach", () => {
    const state = mk(input(battlefield({ posts: [post("p", { x: 15, y: 8 })] }), party([unit({ ref: "a" }), unit({ ref: "b" })])));
    const g = state.units[2]!;
    const PX = 15 * 1024 + 512;
    const PY = 8 * 1024 + 512;
    const reach = 3072 + 358;
    const hyst = Math.floor((reach * 819) / 1024);
    const park = () => {
      state.units[1]!.x = (2 * 1024) as Fixed;
      state.units[1]!.y = (2 * 1024) as Fixed;
    };
    park();
    state.units[0]!.x = PX as Fixed;
    state.units[0]!.y = (PY - 1000) as Fixed;
    postedUnitPhase(state, []);
    expect(g.target).toEqual({ kind: "unit", id: 0 });
    state.units[0]!.y = (PY - reach - 2000) as Fixed; // out of aggro → lost
    const log: LogEvent[] = [];
    postedUnitPhase(state, log);
    expect(log.find((e) => e.k === "disengage")).toMatchObject({ why: "lost" });
    expect(g.lostTarget).toBe(0);
    // Back on the post, a at full aggro reach: not re-acquired; at the hysteresis reach: re-acquired.
    g.x = PX as Fixed;
    g.y = PY as Fixed;
    state.units[0]!.y = (PY - reach) as Fixed;
    postedUnitPhase(state, []);
    expect(g.postMode).not.toBe("pursuing");
    // … but b, a different attacker, at the full reach is acquired at once.
    state.units[1]!.x = PX as Fixed;
    state.units[1]!.y = (PY + reach) as Fixed;
    postedUnitPhase(state, []);
    expect(g.target).toEqual({ kind: "unit", id: 1 });
    expect(g.lostTarget).toBe(0);
    // Reset to idle on the post without b, then bring a to exactly the hysteresis reach.
    park();
    g.postMode = "idle";
    g.target = null;
    g.x = PX as Fixed;
    g.y = PY as Fixed;
    state.units[0]!.y = (PY - hyst - 1) as Fixed;
    postedUnitPhase(state, []);
    expect(g.postMode).toBe("idle");
    state.units[0]!.y = (PY - hyst) as Fixed;
    postedUnitPhase(state, []);
    expect(g.target).toEqual({ kind: "unit", id: 0 });
    expect(g.lostTarget).toBe(-1);
  });
});

describe("QA-11 D2: a harmless post does not shield a fence", () => {
  it("shield-hold: the shooter reaches the core within one attack cooldown of the no-post baseline (was 299 → 1895)", () => {
    const base = resolve(clone(SHIELD_BASELINE_INPUT));
    const shielded = resolve(clone(SHIELD_HOLD_INPUT));
    const guarded = resolve(clone(CHATTER_GUARD_INPUT)); // same fight with the grizzly on `guard`
    const cooldown = mk(SHIELD_HOLD_INPUT).units[0]!.cooldownTicks;
    const b = base.units[0]!.reachedCoreTick;
    expect(b).toBeGreaterThan(0);
    for (const out of [shielded, guarded]) {
      const t = out.units[0]!.reachedCoreTick;
      expect(t).toBeGreaterThanOrEqual(b);
      expect(t - b).toBeLessThanOrEqual(cooldown);
    }
    // While it stands at the fence the shooter hits only the fence.
    const from = events(shielded, "fence_hit")[0]!.t;
    const to = events(shielded, "fence_broken")[0]!.t;
    expect(events(shielded, "hit").filter((h) => h.u === 0 && h.t >= from && h.t <= to)).toEqual([]);
  });
});

describe("QA-11 D1: every stance fires in reach", () => {
  it("reserve-fires-back: an unreleased reserve post lands hits on the attacker at the gap, without moving or acquiring", () => {
    const out = resolve(clone(reserveFiresBackScenario()));
    expect(events(out, "released")).toHaveLength(0);
    expect(events(out, "aggro")).toHaveLength(0);
    expect(events(out, "hit").filter((h) => h.u === 1).length).toBeGreaterThan(0);
    expect(events(out, "path").filter((e) => e.u === 1)).toHaveLength(0);
  });
});

describe("QA-11 N1: the leash clamp", () => {
  it("a pursuing guard never stands beyond its leash and never fires from beyond it, over every scenario", () => {
    const scen: ResolveInput[] = [
      CHATTER_GUARD_INPUT,
      RAND93_INPUT,
      // A fast guard chasing a runner straight out of its leash: the step that would cross is clamped.
      input(battlefield({ posts: [post("p", { x: 15, y: 9 }, { moveSpeed: fx(8192), aggroRadius: fx(8192) })] }), party([unit({ ref: "a", edge: "south", cell: { x: 15, y: 31 }, stance: "core" })]), SHORT_TUNABLES),
    ];
    for (const inp of scen) {
      const state = mk(inp);
      const log: LogEvent[] = [];
      let leashDisengages = 0;
      for (; state.tick < state.tickCap; state.tick++) {
        const before = log.length;
        runTick(state, log);
        for (const u of state.units) {
          if (u.side !== "defender" || !u.alive) continue;
          const dx = u.x - u.postX;
          const dy = u.y - u.postY;
          expect(dx * dx + dy * dy).toBeLessThanOrEqual(u.leashSq === 0 ? 0 : u.leashSq);
        }
        for (let i = before; i < log.length; i++) if (log[i]!.k === "disengage" && (log[i] as { why: string }).why === "leash") leashDisengages++;
      }
      if (inp !== CHATTER_GUARD_INPUT && inp !== RAND93_INPUT) expect(leashDisengages).toBeGreaterThan(0);
    }
  });
});

describe("QA-11 N2: traps skip a unit already at 0 HP", () => {
  it("a unit killed by the first of two traps on its path does not spend the second", () => {
    const u = unit({ ref: "a", cell: { x: 15, y: 0 }, moveSpeed: 65536, hp: 200, affinity: "grit" });
    const out = resolve(input(battlefield({ traps: [trap("t0", { x: 15, y: 3 }), trap("t1", { x: 15, y: 4 })] }), party([u]), { ...SHORT_TUNABLES, battleLengthCapSeconds: 2 }));
    expect(events(out, "trap_fired")).toHaveLength(1);
    expect(out.traps.find((t) => t.ref === "t1")!.spentTick).toBe(-1);
  });
});

describe("QA-11 S1 / N3: input lower bounds and placement", () => {
  type Mut = Record<string, unknown>;
  const base = () => input(battlefield({ posts: [post("p", { x: 15, y: 8 })], traps: [trap("t", { x: 15, y: 6 })] }), party([unit({ ref: "a" })]), DEFAULT_TUNABLES);
  const refused = (patch: (b: { posts: Mut[]; traps: Mut[] }) => void, why: RegExp) => {
    const o = clone(base()) as unknown as { battlefield: { posts: Mut[]; traps: Mut[] } };
    patch(o.battlefield);
    expect(() => assertResolveInput(o)).toThrow(why);
  };
  it("accepts the base input", () => {
    expect(() => assertResolveInput(base())).not.toThrow();
  });
  it("refuses negative post aggroRadius / leashDistance / attackRange", () => {
    refused((b) => (b.posts[0]!.aggroRadius = -8192), /posts\[0\]\.aggroRadius/);
    refused((b) => (b.posts[0]!.leashDistance = -6144), /posts\[0\]\.leashDistance/);
    refused((b) => (b.posts[0]!.attackRange = -3072), /posts\[0\]\.attackRange/);
  });
  it("refuses a post attackCooldown below 1 ms", () => {
    refused((b) => (b.posts[0]!.attackCooldown = 0), /posts\[0\]\.attackCooldown/);
    refused((b) => (b.posts[0]!.attackCooldown = -1000), /posts\[0\]\.attackCooldown/);
  });
  it("refuses trap damage below 1", () => {
    refused((b) => (b.traps[0]!.damage = 0), /traps\[0\]\.damage/);
    refused((b) => (b.traps[0]!.damage = -500), /traps\[0\]\.damage/);
  });
  it("refuses a slow magnitude outside [0, 1024]", () => {
    refused((b) => (b.traps[0]!.effect = { kind: "slow", magnitude: 1025, duration: 3000 }), /effect\.magnitude/);
    refused((b) => (b.traps[0]!.effect = { kind: "slow", magnitude: -1, duration: 3000 }), /effect\.magnitude/);
    expect(() => {
      const o = clone(base()) as unknown as { battlefield: { traps: Mut[] } };
      o.battlefield.traps[0]!.effect = { kind: "slow", magnitude: 1024, duration: 3000 };
      assertResolveInput(o);
    }).not.toThrow();
  });
  it("refuses an effect duration outside [1, maxMillis]", () => {
    refused((b) => (b.traps[0]!.effect = { kind: "root", duration: 0 }), /effect\.duration/);
    refused((b) => (b.traps[0]!.effect = { kind: "root", duration: -5 }), /effect\.duration/);
    refused((b) => (b.traps[0]!.effect = { kind: "root", duration: 60_001 }), /effect\.duration/);
  });
  it("refuses a trap or a post on a core cell and a trap in an entry band", () => {
    refused((b) => Object.assign(b.traps[0]!, { cell: { x: 15, y: 15 }, pos: { x: 15 * 1024 + 512, y: 15 * 1024 + 512 } }), /core cell/);
    refused((b) => Object.assign(b.posts[0]!, { cell: { x: 14, y: 16 }, pos: { x: 14 * 1024 + 512, y: 16 * 1024 + 512 } }), /core cell/);
    refused((b) => Object.assign(b.traps[0]!, { cell: { x: 3, y: 0 }, pos: { x: 3 * 1024 + 512, y: 512 } }), /entry band/);
  });
});
