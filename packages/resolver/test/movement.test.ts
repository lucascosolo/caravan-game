/**
 * The tick loop end to end: continuous sub-cell movement, gaps, breaching chosen by cost,
 * fence HP, the three stances and the retarget rule, holds, bounds, tie-breaks, the tick
 * cap, and the no-deadlock guarantee on a sealed ring.
 */
import { describe, expect, it } from "vitest";
import {
  BREACH_COST_MAX,
  CELL_FREE,
  CORE_CENTER,
  CORE_CENTER_CELL,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  GRID_HEIGHT,
  RING_ANCHORS,
  RING_SEGMENTS,
  breachCostFor,
  cellCenter,
  cellKey,
  cellOf,
  distSq,
  initialState,
  isCoreCell,
  legOffset,
  losClear,
  movementPhase,
  normalizeInput,
  resolve,
  ringSegment,
  runTick,
  type LogEvent,
  type ResolveOutput,
} from "../src/index.js";
import { DEFAULT_TUNABLES, SHORT_TUNABLES, battlefield, clone, cornerClipScenario, fence, input, ms, party, post, reachSq, ringExcept, scenarios, trap, unit } from "./fixtures.js";

const keyframes = (out: ResolveOutput) => out.log.filter((e): e is Extract<LogEvent, { k: "keyframe" }> => e.k === "keyframe");
const events = <K extends LogEvent["k"]>(out: ResolveOutput, k: K) => out.log.filter((e): e is Extract<LogEvent, { k: K }> => e.k === k);

describe("fixed-timestep loop", () => {
  it("derives TICK_CAP = seconds × rate, runs exactly that many ticks and stops", () => {
    const out = resolve(input(battlefield(), party([unit({ ref: "a" })]), { ...DEFAULT_TUNABLES, battleLengthCapSeconds: 3 }));
    expect(out.tickRate).toBe(20);
    expect(out.tickCap).toBe(60);
    expect(out.ticks).toBe(60);
    expect(out.end).toBe("tick_cap");
    expect(out.resolverVersion).toBe(4);
    const full = resolve(input(battlefield(), party([unit({ ref: "a" })])));
    expect(full.tickCap).toBe(3600);
    expect(full.ticks).toBe(3600);
  });

  it("logs a keyframe every keyframeInterval ticks and on the last tick, with every unit, fence and trap", () => {
    const out = resolve(input(battlefield({ fences: [fence({ segment: 0 })], traps: [trap("t", { x: 5, y: 5 })] }), party([unit({ ref: "a" })]), { ...DEFAULT_TUNABLES, battleLengthCapSeconds: 3, keyframeIntervalMs: ms(1250) }));
    expect(keyframes(out).map((k) => k.t)).toEqual([24, 49, 59]);
    expect(keyframes(out)[0]!.units).toHaveLength(1);
    expect(keyframes(out)[0]!.fences).toEqual([{ f: 0, hp: 300 }]);
    expect(keyframes(out)[0]!.traps).toEqual([{ i: 0, spent: false }]);
  });
});

describe("continuous movement", () => {
  it("moves 76 fixed units per tick at 1.5 cells/s (floor of 1536 / 20), sub-cell, never snapped to cell centres", () => {
    const out = resolve(input(battlefield(), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), { ...DEFAULT_TUNABLES, battleLengthCapSeconds: 1, keyframeIntervalMs: ms(50) }));
    const ks = keyframes(out);
    expect(ks).toHaveLength(20);
    // Straight south toward the core: x constant, y advancing 76 per tick from the cell centre.
    for (let i = 0; i < 20; i++) {
      expect(ks[i]!.units[0]!.x).toBe(15 * 1024 + 512);
      expect(ks[i]!.units[0]!.y).toBe(512 + 76 * (i + 1));
    }
    // Positions between cell centres are the norm: most are not on a centre.
    const offCentre = ks.filter((k) => (k.units[0]!.y - 512) % 1024 !== 0);
    expect(offCentre.length).toBeGreaterThan(15);
  });

  it("reaches the core through a deliberate gap in the ring and stops at the core centre", () => {
    // Gap at segment 3 (cell (15,11)): the unit's straight line south to the core.
    const out = resolve(input(battlefield({ fences: ringExcept([3]) }), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    const a = out.units[0]!;
    expect(a.reachedCoreTick).toBeGreaterThan(0);
    expect(a.reachedCoreTick).toBeLessThan(300);
    expect({ x: a.x, y: a.y }).toEqual(CORE_CENTER);
    expect(out.fences.every((f) => f.hp === f.maxHp && f.intact)).toBe(true);
    expect(events(out, "fence_hit")).toHaveLength(0);
    expect(events(out, "core_reached")).toEqual([{ t: a.reachedCoreTick, k: "core_reached", u: 0 }]);
  });

  it("goes round through a gap when that is cheaper than breaking through", () => {
    // Gap at segment 6 (cell (18,11)), three cells east of the unit's line; brush pile is 300 HP,
    // offense 95 → (4 − 1) hits × 20 ticks × 76 = 4560 (≈ 4.5 cells) of standing still vs a
    // detour of about a cell on foot: the detour wins; a sturdier fence makes it unambiguous.
    const out = resolve(input(battlefield({ fences: ringExcept([6], 1000) }), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    expect(out.units[0]!.reachedCoreTick).toBeGreaterThan(0);
    expect(events(out, "fence_hit")).toHaveLength(0);
    expect(out.fences.every((f) => f.intact)).toBe(true);
  });

  it("breaks through when the detour is dearer, chipping the segment's HP on its attack cooldown until it breaks", () => {
    // Only gap is on the far (south) side: a 100-HP timber segment right in the way is cheaper.
    const out = resolve(input(battlefield({ fences: ringExcept([17], 100) }), party([unit({ ref: "a", cell: { x: 15, y: 0 }, offense: 40, attackCooldown: 1000 })]), { ...SHORT_TUNABLES, keyframeIntervalMs: ms(50) }));
    const hits = events(out, "fence_hit");
    expect(hits.length).toBe(3); // ⌈100 / 40⌉
    expect(hits.every((h) => h.f === 3 && h.u === 0 && h.damage === 40)).toBe(true);
    expect(hits.map((h) => h.hp)).toEqual([60, 20, 0]);
    // One hit per attack cooldown (1000 ms = 20 ticks), the first on arrival.
    expect(hits[1]!.t - hits[0]!.t).toBe(20);
    expect(hits[2]!.t - hits[1]!.t).toBe(20);
    const broken = events(out, "fence_broken");
    expect(broken).toEqual([{ t: hits[2]!.t, k: "fence_broken", f: 3 }]);
    expect(out.fences.find((f) => f.segment === 3)).toMatchObject({ hp: 0, intact: false, brokenTick: hits[2]!.t });
    // The unit stood in the adjacent cell (15,10) while breaching, then went on to the core.
    const holdOn = events(out, "hold").find((h) => h.holding);
    expect(holdOn).toBeDefined();
    const atHold = keyframes(out).find((k) => k.t >= holdOn!.t)!;
    expect(cellOf({ x: atHold.units[0]!.x as never, y: atHold.units[0]!.y as never })).toEqual({ x: 15, y: 10 });
    expect(out.units[0]!.reachedCoreTick).toBeGreaterThan(hits[2]!.t);
    // A fence break recomputes every unit's path on the next tick.
    const pathAfterBreak = events(out, "path").find((p) => p.t === hits[2]!.t + 1);
    expect(pathAfterBreak).toBeDefined();
  });

  it("a fully sealed ring (no gap) still terminates: the unit breaches and reaches the core, or the cap ends it", () => {
    const out = resolve(input(battlefield({ fences: ringExcept([], 300) }), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    expect(out.ticks).toBe(600);
    expect(events(out, "fence_broken")).toHaveLength(1);
    expect(out.units[0]!.reachedCoreTick).toBeGreaterThan(0);
  });

  it("a unit standing on a decision boundary — equal cost to breach or detour — takes a deterministic choice", () => {
    // 95 offense vs 95 HP → 1 hit × 20 ticks × 76 = 1520 breach cost. Pinned.
    const run = () => resolve(input(battlefield({ fences: ringExcept([4], 95) }), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    const a = run();
    const b = run();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.units[0]!.reachedCoreTick).toBeGreaterThan(0);
  });

  it("stays inside the field bounds and never enters an intact fence or anchor cell", () => {
    const field = battlefield({ fences: ringExcept([9]) });
    const out = resolve(input(field, party([unit({ ref: "a", cell: { x: 0, y: 0 }, edge: "north" }), unit({ ref: "b", edge: "west", cell: { x: 0, y: 31 } })]), { ...SHORT_TUNABLES, keyframeIntervalMs: ms(50) }));
    const brokenAt = new Map(events(out, "fence_broken").map((e) => [e.f, e.t]));
    for (const k of keyframes(out)) {
      // Intact at this tick: every fence not yet broken, plus the anchors always.
      const blocked = new Set([...field.fences.filter((f, i) => (brokenAt.get(i) ?? Infinity) > k.t).map((f) => `${f.cell.x},${f.cell.y}`), ...RING_ANCHORS.map((c) => `${c.x},${c.y}`)]);
      for (const u of k.units) {
        expect(u.x).toBeGreaterThanOrEqual(0);
        expect(u.y).toBeGreaterThanOrEqual(0);
        expect(u.x).toBeLessThan(FIELD_WIDTH);
        expect(u.y).toBeLessThan(FIELD_HEIGHT);
        const c = cellOf({ x: u.x as never, y: u.y as never });
        expect(blocked.has(`${c.x},${c.y}`)).toBe(false);
      }
    }
    expect(out.units.every((u) => u.reachedCoreTick > 0)).toBe(true);
  });

  it("units do not collide: two units on identical positions and paths move identically and overlap", () => {
    const out = resolve(input(battlefield({ fences: ringExcept([3]) }), party([unit({ ref: "a", cell: { x: 15, y: 0 } }), unit({ ref: "b", cell: { x: 15, y: 0 } })]), { ...SHORT_TUNABLES, keyframeIntervalMs: ms(50) }));
    for (const k of keyframes(out)) expect([k.units[0]!.x, k.units[0]!.y]).toEqual([k.units[1]!.x, k.units[1]!.y]);
    expect(out.units[0]!.reachedCoreTick).toBe(out.units[1]!.reachedCoreTick);
  });
});

describe("stances and the retarget rule", () => {
  it("core: beelines for the core centre and ignores posts and traps", () => {
    const out = resolve(input(battlefield({ traps: [trap("t", { x: 15, y: 5 })], posts: [post("p", { x: 15, y: 7 })] }), party([unit({ ref: "a", stance: "core", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    expect(events(out, "target")[0]).toEqual({ t: 0, k: "target", u: 0, target: { kind: "core", id: -1 } });
    expect({ x: out.units[0]!.x, y: out.units[0]!.y }).toEqual(CORE_CENTER);
  });

  it("nearest: targets the nearest posted unit (tie → lowest id), closes to attack reach and HOLDS there", () => {
    // Two posts equidistant from the unit; "p1" sorts before "p2" so it gets the lower id. The
    // posts `hold` so they stay put (chunk 11), and the fight is cut before anyone dies.
    const inp = normalizeInput(input(battlefield({ posts: [post("p2", { x: 17, y: 6 }, { stance: "hold" }), post("p1", { x: 13, y: 6 }, { stance: "hold" })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    const state = initialState(inp);
    const log: LogEvent[] = [];
    expect(state.units[1]!.ref).toBe("p1");
    for (; state.tick < 160; state.tick++) runTick(state, log);
    expect(log.filter((e) => e.k === "target")[0]).toEqual({ t: 0, k: "target", u: 0, target: { kind: "unit", id: 1 } });
    const a = state.units[0]!;
    // REACH: it stopped once p1's centre was within attackRange + unitRadius.
    expect(distSq({ x: a.x, y: a.y }, cellCenter({ x: 13, y: 6 }))).toBeLessThanOrEqual(reachSq(1024));
    // ... and not before: one more tick's step (76) would have been needed to get there earlier.
    expect(distSq({ x: a.x, y: a.y }, cellCenter({ x: 13, y: 6 }))).toBeGreaterThan((1024 + 358 - 76) * (1024 + 358 - 76));
    expect(a.reachedCoreTick).toBe(-1);
    expect(a.holding).toBe(true);
    expect(state.units[1]!.alive).toBe(true);
    // RETARGET_RULE: the target is never re-evaluated while it stays valid — one target event only.
    expect(log.filter((e) => e.k === "target")).toHaveLength(1);
    // Both sides are trading hits now (chunk 11).
    expect(log.some((e) => e.k === "hit" && e.u === 0 && e.v === 1)).toBe(true);
    expect(log.some((e) => e.k === "hit" && e.u === 1 && e.v === 0)).toBe(true);
  });

  it("nearest with no posts falls back to the core", () => {
    const out = resolve(input(battlefield(), party([unit({ ref: "a", stance: "nearest" })]), SHORT_TUNABLES));
    expect(events(out, "target")[0]!.target).toEqual({ kind: "core", id: -1 });
    expect(out.units[0]!.reachedCoreTick).toBeGreaterThan(0);
  });

  it("traps: goes to the nearest unspent trap (tie → lowest trap index), springs it, then moves on to the next trap", () => {
    const out = resolve(input(battlefield({ traps: [trap("t2", { x: 18, y: 6 }), trap("t1", { x: 12, y: 6 })], posts: [post("p", { x: 15, y: 8 }, { stance: "hold" })] }), party([unit({ ref: "a", stance: "traps", cell: { x: 15, y: 0 }, hp: 2000 })]), SHORT_TUNABLES));
    expect(out.traps.map((t) => t.ref)).toEqual(["t1", "t2"]);
    expect(events(out, "target")[0]!.target).toEqual({ kind: "trap", id: 0 });
    // Chunk 11: the trap fires on the swept path, is spent, and the spent target sends the unit to t2.
    const fired = events(out, "trap_fired");
    expect(fired.map((f) => [f.i, f.u])).toEqual([
      [0, 0],
      [1, 0],
    ]);
    // Trap → trap → the post (which it then kills) → the core: RETARGET_RULE's fallback chain.
    expect(events(out, "target").map((e) => e.target)).toEqual([
      { kind: "trap", id: 0 },
      { kind: "trap", id: 1 },
      { kind: "unit", id: 1 },
      { kind: "core", id: -1 },
    ]);
    expect(events(out, "target")[1]!.t).toBe(fired[0]!.t + 1);
    expect(events(out, "target")[3]!.t).toBe(out.units[1]!.diedTick + 1);
    expect(out.traps.every((t) => t.spent)).toBe(true);
  });

  it("traps with no traps falls back to nearest post, then to the core", () => {
    const withPost = resolve(input(battlefield({ posts: [post("p", { x: 15, y: 8 })] }), party([unit({ ref: "a", stance: "traps", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    expect(events(withPost, "target")[0]!.target).toEqual({ kind: "unit", id: 1 });
    const bare = resolve(input(battlefield(), party([unit({ ref: "a", stance: "traps" })]), SHORT_TUNABLES));
    expect(events(bare, "target")[0]!.target).toEqual({ kind: "core", id: -1 });
  });

  it("retargets only when the target becomes invalid: a post dying mid-fight sends the unit to the next candidate", () => {
    const inp = normalizeInput(input(battlefield({ posts: [post("p1", { x: 15, y: 8 }), post("p2", { x: 15, y: 22 })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    const state = initialState(inp);
    const log: LogEvent[] = [];
    for (; state.tick < 100; state.tick++) runTick(state, log);
    expect(state.units[0]!.target).toEqual({ kind: "unit", id: 1 });
    // Chunk 11 will kill units; simulate the invalidation the retarget rule reacts to.
    state.units[1]!.alive = false;
    runTick(state, log);
    expect(state.units[0]!.target).toEqual({ kind: "unit", id: 2 });
    expect(log.filter((e) => e.k === "target").map((e) => e.t)).toEqual([0, 100]);
  });
});

describe("tie-breaks and ordering", () => {
  it("unit ids follow ref order — attackers first, then posts — regardless of input array order", () => {
    const a = resolve(input(battlefield({ posts: [post("pz", { x: 15, y: 8 }), post("pa", { x: 15, y: 22 })] }), party([unit({ ref: "z", cell: { x: 10, y: 0 } }), unit({ ref: "a", cell: { x: 20, y: 0 } })]), SHORT_TUNABLES));
    expect(a.units.map((u) => [u.id, u.side, u.ref])).toEqual([
      [0, "attacker", "a"],
      [1, "attacker", "z"],
      [2, "defender", "pa"],
      [3, "defender", "pz"],
    ]);
  });

  it("shuffled input arrays produce a byte-identical output", () => {
    const base = input(battlefield({ fences: ringExcept([3, 10]), traps: [trap("t1", { x: 13, y: 13 }), trap("t2", { x: 17, y: 17 })], posts: [post("p1", { x: 15, y: 13 }), post("p2", { x: 14, y: 17 })] }), party([unit({ ref: "a", stance: "core", cell: { x: 15, y: 0 } }), unit({ ref: "b", stance: "nearest", cell: { x: 20, y: 0 } }), unit({ ref: "c", stance: "traps", edge: "south", cell: { x: 10, y: GRID_HEIGHT - 1 } })]), SHORT_TUNABLES);
    const shuffled = {
      ...base,
      battlefield: { ...base.battlefield, fences: [...base.battlefield.fences].reverse(), traps: [...base.battlefield.traps].reverse(), posts: [...base.battlefield.posts].reverse() },
      party: { ...base.party, units: [base.party.units[2]!, base.party.units[0]!, base.party.units[1]!] },
    };
    expect(JSON.stringify(resolve(shuffled))).toBe(JSON.stringify(resolve(base)));
  });

  it("two units at identical positions with equidistant choices make the same choice; ids break the tie in the log order", () => {
    const out = resolve(input(battlefield({ posts: [post("p1", { x: 13, y: 6 }), post("p2", { x: 17, y: 6 })] }), party([unit({ ref: "a", stance: "nearest", cell: { x: 15, y: 0 } }), unit({ ref: "b", stance: "nearest", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
    const targets = events(out, "target").filter((e) => e.t === 0);
    expect(targets.map((e) => e.u)).toEqual([0, 1]);
    expect(targets.map((e) => e.target!.id)).toEqual([2, 2]);
  });

  it("two units reaching a segment on the same tick: hits land in id order, a segment at 0 HP takes no further hit, both re-plan through the opening", () => {
    // Identical units from the same cell arrive adjacent to segment 3 on the same tick.
    // 40 HP vs 40 offense: a's hit (id 0) destroys it; b's would-be hit on the same tick is skipped.
    const one = resolve(input(battlefield({ fences: ringExcept([17], 40) }), party([unit({ ref: "a", cell: { x: 15, y: 0 }, offense: 40 }), unit({ ref: "b", cell: { x: 15, y: 0 }, offense: 40 })]), SHORT_TUNABLES));
    expect(events(one, "fence_broken")).toHaveLength(1);
    expect(events(one, "fence_hit")).toEqual([{ t: events(one, "fence_broken")[0]!.t, k: "fence_hit", u: 0, f: 3, damage: 40, hp: 0 }]);
    expect(one.units.every((u) => u.reachedCoreTick > 0)).toBe(true);
    expect(one.units[0]!.reachedCoreTick).toBe(one.units[1]!.reachedCoreTick);
    // 80 HP: a then b on the same tick, in id order; the segment breaks on that tick.
    const two = resolve(input(battlefield({ fences: ringExcept([17], 80) }), party([unit({ ref: "a", cell: { x: 15, y: 0 }, offense: 40 }), unit({ ref: "b", cell: { x: 15, y: 0 }, offense: 40 })]), SHORT_TUNABLES));
    const t = events(two, "fence_broken")[0]!.t;
    expect(events(two, "fence_hit")).toEqual([
      { t, k: "fence_hit", u: 0, f: 3, damage: 40, hp: 40 },
      { t, k: "fence_hit", u: 1, f: 3, damage: 40, hp: 0 },
    ]);
  });
});

describe("QA-10 round 1 regressions", () => {
  const field = (gaps: number[], hp: number) => battlefield({ fences: ringExcept(gaps, hp) });

  it("S2: the rand4 corner-clip fixture — every tick's displacement passes the EXACT line-of-sight rule and every position is in a free cell", () => {
    const state = initialState(normalizeInput(clone(cornerClipScenario())));
    const log: LogEvent[] = [];
    let moves = 0;
    for (; state.tick < state.tickCap; state.tick++) {
      const before = state.units.map((u) => ({ x: u.x, y: u.y }));
      const grid = new Int32Array(state.grid); // what movement ran against (phase 8 may free a cell afterwards)
      runTick(state, log);
      for (let id = 0; id < state.attackerCount; id++) {
        const u = state.units[id]!;
        const p = before[id]!;
        expect(grid[cellKey(cellOf({ x: u.x, y: u.y }))], `tick ${state.tick} unit ${id} stands in a blocked cell`).toBe(CELL_FREE);
        if (p.x === u.x && p.y === u.y) continue;
        moves++;
        expect(losClear(grid, p as never, { x: u.x, y: u.y }), `tick ${state.tick} unit ${id} moved (${p.x},${p.y})→(${u.x},${u.y}) across a blocked cell`).toBe(true);
        expect(u.pathDirty, "the defensive stop-and-replan branch never fires").toBe(false);
      }
    }
    expect(moves).toBeGreaterThan(1000);
    // In v1 unit u1 (id 1) clipped the corner of an intact segment at tick 143 on this fixture.
    expect(state.units[1]!.ref).toBe("u1");
  });

  it("S2: movement is leg-parametric — the position after k ticks is anchor + legOffset(d, k × speed, len), so rounding never accumulates; a same-route recompute keeps the leg", () => {
    // Open field from (10,0) to the core (a line that clears the ring anchors): one diagonal
    // leg of ≈ 15.8 cells that every 10-tick recompute re-derives identically, so the route
    // is set once and the leg is never restarted.
    const out = resolve(input(battlefield(), party([unit({ ref: "a", cell: { x: 10, y: 0 } })]), { ...SHORT_TUNABLES, keyframeIntervalMs: ms(50) }));
    const paths = events(out, "path");
    expect(paths).toHaveLength(1);
    expect(paths[0]!.t).toBe(0);
    expect(paths[0]!.wp).toEqual([[CORE_CENTER.x, CORE_CENTER.y, -1]]);
    const start = cellCenter({ x: 10, y: 0 });
    const dx = CORE_CENTER.x - start.x;
    const dy = CORE_CENTER.y - start.y;
    const len = Math.floor(Math.sqrt(dx * dx + dy * dy));
    expect(len).toBe(16190);
    let checked = 0;
    for (const k of keyframes(out)) {
      const progress = 76 * (k.t + 1);
      if (progress >= len) break;
      expect([k.units[0]!.x, k.units[0]!.y], `tick ${k.t}`).toEqual([start.x + legOffset(dx, progress, len), start.y + legOffset(dy, progress, len)]);
      checked++;
    }
    expect(checked).toBe(213); // ticks 0..212 are mid-leg; tick 213 lands exactly on the centre
    expect(keyframes(out)[213]!.units[0]).toMatchObject({ x: CORE_CENTER.x, y: CORE_CENTER.y });
    expect(events(out, "hold")).toEqual([{ t: 214, k: "hold", u: 0, holding: true }]);
    // v1 re-aimed from the rounded position each tick, so drift accumulated over 213 ticks;
    // the parametric position is within one unit of the exact line to the end.
    const last = keyframes(out)[212]!.units[0]!;
    expect(Math.abs(last.x - (start.x + (dx * 76 * 213) / len))).toBeLessThan(1);
    expect(Math.abs(last.y - (start.y + (dy * 76 * 213) / len))).toBeLessThan(1);
  });

  it("N1: a step that would land exactly on a waypoint consumes it in the same tick, and a negative leg never reaches its waypoint early", () => {
    const mk = (moveSpeed: number) => initialState(normalizeInput(input(battlefield(), party([unit({ ref: "a", cell: { x: 15, y: 0 }, moveSpeed })]), SHORT_TUNABLES)));
    // dx = dy = 54: d² = 5832 > 76² but isqrt(5832) = 76 = the tick's budget. v1 stepped onto the
    // waypoint without consuming it and spent the next tick consuming it in place.
    const s = mk(1536);
    const u = s.units[0]!;
    const start = { x: u.x, y: u.y };
    u.waypoints = [{ x: (u.x + 54) as never, y: (u.y + 54) as never, breach: -1 }];
    const log: LogEvent[] = [];
    movementPhase(s, log);
    expect([u.x, u.y]).toEqual([start.x + 54, start.y + 54]);
    expect(u.waypoints).toHaveLength(0);
    expect(u.holding).toBe(false);
    movementPhase(s, log);
    expect(u.holding).toBe(true);
    // Negative leg of length 98 at 97 per tick: floor toward −∞ would give −70 = the whole leg
    // on tick 1 (on the waypoint, waypoint unconsumed); the magnitude floor gives −69.
    expect(Math.floor((-70 * 97) / 98)).toBe(-70);
    expect(legOffset(-70, 97, 98)).toBe(-69);
    expect(legOffset(70, 97, 98)).toBe(69);
    const s2 = mk(1940);
    const u2 = s2.units[0]!;
    const start2 = { x: u2.x, y: u2.y };
    u2.waypoints = [{ x: (u2.x - 70) as never, y: (u2.y - 70) as never, breach: -1 }];
    movementPhase(s2, log);
    expect([u2.x, u2.y]).toEqual([start2.x - 69, start2.y - 69]);
    expect(u2.waypoints).toHaveLength(1);
    movementPhase(s2, log);
    expect([u2.x, u2.y]).toEqual([start2.x - 70, start2.y - 70]);
    expect(u2.waypoints).toHaveLength(0);
  });

  it("S1: the breach price is the stationary time — (hits − 1) cooldowns plus the cooldown still running — clamped to BREACH_COST_MAX", () => {
    const state = initialState(normalizeInput(input(battlefield({ fences: [fence({ segment: 3, maxHp: 300 })] }), party([unit({ ref: "a", offense: 95, attackCooldown: 1000 })]), SHORT_TUNABLES)));
    const u = state.units[0]!;
    const cost = breachCostFor(state, u);
    expect(cost(0)).toBe((4 - 1) * 20 * 76); // ⌈300 / 95⌉ = 4 hits; v1 priced 4 × 20 × 76
    u.cooldownRemaining = 1; // fires on the arrival tick (phase 6 decrements, then checks)
    expect(cost(0)).toBe(3 * 20 * 76);
    u.cooldownRemaining = 5;
    expect(cost(0)).toBe((3 * 20 + 4) * 76);
    u.cooldownRemaining = 0;
    state.fences[0]!.hp = 95;
    expect(cost(0)).toBe(0);
    const weak = initialState(normalizeInput(input(battlefield({ fences: [fence({ segment: 3, maxHp: 1_000_000 })] }), party([unit({ ref: "a", offense: 1 })]), SHORT_TUNABLES)));
    expect(breachCostFor(weak, weak.units[0]!)(0)).toBe(BREACH_COST_MAX); // 999 999 × 20 × 76 ≈ 1.5e9 > COST_INFINITE
  });

  it("S1: breach vs detour is decided by MEASURED time — resolved both ways, the chosen route is the quicker one to within one attack cooldown, exactly at the unambiguous ends", () => {
    const cooldownTicks = 20; // 1000 ms at 20 ticks/s; one hit's worth, the planner's resolution
    const timeTo = (gaps: number[], hp: number) => {
      const out = resolve(input(field(gaps, hp), party([unit({ ref: "a", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES));
      return { t: out.units[0]!.reachedCoreTick, breached: events(out, "fence_hit").length > 0 };
    };
    // A forced breach of h hits costs exactly (h − 1) cooldowns over a one-hit breach.
    expect(timeTo([], 95).t).toBeGreaterThan(0);
    expect(timeTo([], 95 * 5).t - timeTo([], 95).t).toBe(4 * cooldownTicks);
    for (const gap of [5, 6, 7]) {
      const detour = timeTo([gap], 1_000_000);
      expect(detour.breached).toBe(false);
      for (const hits of [1, 2, 3, 4, 5, 8, 12]) {
        const hp = 95 * hits;
        const breach = timeTo([], hp); // forced: no gap
        const chosen = timeTo([gap], hp);
        const label = `gap ${gap}, ${hits} hits: chosen ${chosen.t} (${chosen.breached ? "breach" : "detour"}) vs breach ${breach.t} / detour ${detour.t}`;
        expect(chosen.t, label).toBe(chosen.breached ? breach.t : detour.t);
        expect(chosen.t, label).toBeLessThanOrEqual(Math.min(breach.t, detour.t) + cooldownTicks);
      }
      expect(timeTo([gap], 95).breached, `gap ${gap}: one hit beats any detour`).toBe(true);
      expect(timeTo([gap], 95 * 12).breached, `gap ${gap}: eleven cooldowns never beat the detour`).toBe(false);
    }
    // The v1 lattice-only comparison breached through a 190-HP segment with a gap two cells away
    // (4 lattice steps ≈ 54 ticks "saved" for a walk that really costs 5): pinned.
    expect(timeTo([5], 190).breached).toBe(false);
  });

  it("S3: a 1 000 000-HP sealed ring is breached, not treated as a wall — the unit keeps its target, stands at the segment and chips it all fight", () => {
    const out = resolve(scenarios().find((s) => s.name === "sealed-ring-1e6-hp")!.input);
    expect(events(out, "target")).toEqual([{ t: 0, k: "target", u: 0, target: { kind: "core", id: -1 } }]);
    const hits = events(out, "fence_hit");
    expect(hits).toHaveLength(24); // arrival + every 20 ticks until the 600-tick cap
    const seg3 = out.fences.find((f) => f.segment === 3)!;
    expect(hits.every((h) => h.f === seg3.f && h.damage === 1)).toBe(true);
    expect(seg3.hp).toBe(1_000_000 - 24);
    expect(cellOf({ x: out.units[0]!.x as never, y: out.units[0]!.y as never })).toEqual({ x: 15, y: 10 });
    expect(events(out, "hold").map((h) => h.holding)).toEqual([true]);
  });
});

describe("the two spaces stay separate", () => {
  it("the lattice is only used to plan: the unit's recorded path has waypoints, not cell steps, and its position is continuous", () => {
    const out = resolve(input(battlefield({ fences: ringExcept([0]) }), party([unit({ ref: "a", cell: { x: 2, y: 0 } })]), { ...SHORT_TUNABLES, keyframeIntervalMs: ms(50) }));
    const firstPath = events(out, "path")[0]!;
    // A string-pulled route is far shorter than the lattice route it came from.
    expect(firstPath.wp.length).toBeLessThan(8);
    expect(firstPath.speed).toBe(76);
    const ks = keyframes(out);
    const diagonalTicks = ks.filter((k, i) => i > 0 && k.units[0]!.x !== ks[i - 1]!.units[0]!.x && k.units[0]!.y !== ks[i - 1]!.units[0]!.y);
    expect(diagonalTicks.length, "movement is free-direction, not axis-locked").toBeGreaterThan(10);
    expect(isCoreCell(cellOf({ x: out.units[0]!.x as never, y: out.units[0]!.y as never }))).toBe(true);
    expect(CORE_CENTER_CELL).toEqual({ x: 15, y: 15 });
    expect(ringSegment(0).cell).toEqual(RING_SEGMENTS[0]!.cell);
  });
});
