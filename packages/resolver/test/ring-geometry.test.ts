/**
 * Chunk 50: the round wagon circle's geometry, checked against the owner-approved fixture
 * packages/resolver/geometry/round-ring.json (look-test coordinates, core centre (5, 5)).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CORE_CELLS,
  CORE_CENTER_CELL,
  ENTRY_EDGES,
  GRID_HEIGHT,
  GRID_WIDTH,
  INTERIOR_POST_CELLS,
  PERIMETER_SEGMENTS,
  RING_ANCHORS,
  RING_ANCHOR_COUNT,
  RING_ORDER,
  RING_SEGMENTS,
  WAGON_RING_INDICES,
  assertResolveInput,
  attackerInsideRing,
  cellCenter,
  cellKey,
  entryBand,
  initialState,
  isAnchorCell,
  isCoreReachableFrom,
  isInsideRing,
  isRingCell,
  normalizeInput,
  runTick,
  type Cell,
  type EntryEdge,
  type LogEvent,
} from "../src/index.js";
import { DASH, SHORT_TUNABLES, battlefield, fence, fx, input, party, post, ringExcept, trap, unit } from "./fixtures.js";

type XY = readonly [number, number];
interface Fixture {
  core: XY[];
  wagons: { cells: [XY, XY]; facing: string }[];
  ring_fence_cells: XY[];
  gaps: XY[];
  ring_order: XY[];
  interior_post_cells: XY[];
  segments: number;
}
const FIXTURE = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../geometry/round-ring.json"), "utf8")) as Fixture;

// The fixture's core centre is (5, 5); the game's is CORE_CENTER_CELL.
const OFF = { x: CORE_CENTER_CELL.x - 5, y: CORE_CENTER_CELL.y - 5 };
const tr = ([i, j]: XY): Cell => ({ x: i + OFF.x, y: j + OFF.y });
const keyOf = (c: Cell): string => `${c.x},${c.y}`;
const same = (a: readonly Cell[], b: readonly Cell[]): void => expect(a.map(keyOf)).toEqual(b.map(keyOf));

const SIDE: readonly EntryEdge[] = ["north", "north", "east", "east", "east", "south", "south", "south", "south", "south", "west", "west", "west", "west", "west", "north"];

describe("fixture <-> constants", () => {
  it("maps the fixture's core exactly onto CORE_CELLS", () => {
    expect(FIXTURE.core.map(tr).map(keyOf).sort()).toEqual(CORE_CELLS.map(keyOf).sort());
  });
  it("RING_ORDER is the fixture's ring_order, translated, in order", () => same(RING_ORDER, FIXTURE.ring_order.map(tr)));
  it("RING_ANCHORS are the fixture's wagon cells in order", () => same(RING_ANCHORS, FIXTURE.wagons.flatMap((w) => w.cells.map(tr))));
  it("RING_SEGMENTS cells are ring_fence_cells in order; 16 of them", () => {
    same(RING_SEGMENTS.map((s) => s.cell), FIXTURE.ring_fence_cells.map(tr));
    expect(RING_SEGMENTS.map((s) => s.index)).toEqual([...Array(16).keys()]);
    expect(PERIMETER_SEGMENTS).toBe(FIXTURE.segments);
    expect(PERIMETER_SEGMENTS).toBe(16);
  });
  it("INTERIOR_POST_CELLS equal interior_post_cells as a set", () => {
    expect(INTERIOR_POST_CELLS.map(keyOf).sort()).toEqual(FIXTURE.interior_post_cells.map(tr).map(keyOf).sort());
  });
  it("has 12 wagon cells", () => {
    expect(RING_ANCHOR_COUNT).toBe(12);
    expect(RING_ANCHORS).toHaveLength(12);
  });
});

describe("segment order and sides", () => {
  it("RING_ORDER starts due north of the core centre; segment 0 is the first fence cell clockwise of it", () => {
    expect(RING_ORDER[0]!.x).toBe(CORE_CENTER_CELL.x);
    expect(RING_ORDER[0]!.y).toBeLessThan(CORE_CENTER_CELL.y);
    const wagon = new Set(WAGON_RING_INDICES.flat());
    const firstFence = RING_ORDER.findIndex((_, k) => !wagon.has(k));
    expect(RING_SEGMENTS[0]!.cell).toEqual(RING_ORDER[firstFence]);
  });
  it("the side table is exactly 0-1 N, 2-4 E, 5-9 S, 10-14 W, 15 N", () => {
    expect(RING_SEGMENTS.map((s) => s.edge)).toEqual(SIDE);
  });
  it("each segment's edge is the dominant axis from the core centre (diagonal: next edge clockwise)", () => {
    for (const s of RING_SEGMENTS) {
      const dx = s.cell.x - CORE_CENTER_CELL.x;
      const dy = s.cell.y - CORE_CENTER_CELL.y;
      let want: EntryEdge;
      if (Math.abs(dy) > Math.abs(dx)) want = dy < 0 ? "north" : "south";
      else if (Math.abs(dx) > Math.abs(dy)) want = dx > 0 ? "east" : "west";
      else want = dx > 0 ? (dy < 0 ? "east" : "south") : dy > 0 ? "west" : "north";
      expect(s.edge, `segment ${s.index}`).toBe(want);
    }
  });
});

describe("ring is a closed 8-connected curve", () => {
  it("consecutive RING_ORDER cells (cyclic) are at Chebyshev distance 1", () => {
    RING_ORDER.forEach((c, k) => {
      const n = RING_ORDER[(k + 1) % RING_ORDER.length]!;
      expect(Math.max(Math.abs(c.x - n.x), Math.abs(c.y - n.y)), `step ${k}`).toBe(1);
    });
  });
  it("each wagon's two cells are orthogonally adjacent", () => {
    for (let w = 0; w < 6; w++) {
      const a = RING_ANCHORS[2 * w]!;
      const b = RING_ANCHORS[2 * w + 1]!;
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1);
    }
  });
  it("wagons are never fences", () => {
    for (const s of RING_SEGMENTS) {
      expect(isAnchorCell(s.cell)).toBe(false);
      expect(isRingCell(s.cell)).toBe(true);
    }
    for (const a of RING_ANCHORS) expect(isRingCell(a)).toBe(false);
  });
});

describe("closure on the 4-connected lattice (port of ring_check.py)", () => {
  const fenceKeys = RING_SEGMENTS.map((s) => cellKey(s.cell));
  const wagonKeys = RING_ANCHORS.map(cellKey);
  const bandStarts = ENTRY_EDGES.flatMap((e) => entryBand(e));
  const reachable = (blocked: Set<number>): boolean => bandStarts.some((c) => isCoreReachableFrom(c, (k) => blocked.has(k)));

  it("a full ring plus wagons seals the core from every cell of every entry band", () => {
    expect(reachable(new Set([...fenceKeys, ...wagonKeys]))).toBe(false);
  });
  it("leaving out any single fence segment opens the core", () => {
    for (const s of RING_SEGMENTS) {
      const blocked = new Set([...fenceKeys, ...wagonKeys]);
      blocked.delete(cellKey(s.cell));
      expect(reachable(blocked), `gap at segment ${s.index}`).toBe(true);
    }
  });
  it("removing any single wagon cell opens the core", () => {
    for (const a of RING_ANCHORS) {
      const blocked = new Set([...fenceKeys, ...wagonKeys]);
      blocked.delete(cellKey(a));
      expect(reachable(blocked), `wagon cell ${keyOf(a)}`).toBe(true);
    }
  });
  it("the fixture's two gaps open the core", () => {
    const gaps = new Set(FIXTURE.gaps.map(tr).map(cellKey));
    expect(reachable(new Set([...fenceKeys.filter((k) => !gaps.has(k)), ...wagonKeys]))).toBe(true);
  });
});

// ── fight level: no slipping through a shared corner ─────────────────────────────────────

const diagonalSteps = RING_ORDER.map((a, k) => ({ k, a, b: RING_ORDER[(k + 1) % RING_ORDER.length]! })).filter(({ a, b }) => a.x !== b.x && a.y !== b.y);

function bandNear(a: Cell, b: Cell): { edge: EntryEdge; cell: Cell } {
  const dx = (a.x + b.x) / 2 - CORE_CENTER_CELL.x;
  const dy = (a.y + b.y) / 2 - CORE_CENTER_CELL.y;
  const cx = Math.floor((a.x + b.x) / 2);
  const cy = Math.floor((a.y + b.y) / 2);
  if (Math.abs(dy) > Math.abs(dx)) return dy < 0 ? { edge: "north", cell: { x: cx, y: 0 } } : { edge: "south", cell: { x: cx, y: GRID_HEIGHT - 1 } };
  return dx > 0 ? { edge: "east", cell: { x: GRID_WIDTH - 1, y: cy } } : { edge: "west", cell: { x: 0, y: cy } };
}

/** Runs the real tick loop; the first tick a living attacker stood strictly inside the ring while both corner cells were intact, else null. */
function firstSlip(raw: ReturnType<typeof input>, a: Cell, b: Cell): number | null {
  assertResolveInput(raw);
  const state = initialState(normalizeInput(raw));
  const log: LogEvent[] = [];
  const segOf = (c: Cell): number => RING_SEGMENTS.findIndex((s) => s.cell.x === c.x && s.cell.y === c.y);
  const intact = (c: Cell): boolean => {
    const s = segOf(c);
    if (s < 0) return true; // a wagon cell: permanent
    return state.fences.some((f) => f.segment === s && f.intact);
  };
  for (; state.tick < state.tickCap; state.tick++) {
    runTick(state, log);
    if (!intact(a) || !intact(b) || state.fences.some((f) => !f.intact)) return null; // any broken fence legitimately opens the ring
    for (let id = 0; id < state.attackerCount; id++) {
      const u = state.units[id]!;
      if (!u.alive) continue;
      const cell = { x: Math.floor(u.x / 1024), y: Math.floor(u.y / 1024) };
      if (isInsideRing(cell)) return state.tick;
    }
  }
  return null;
}

describe("a sealed ring holds at every diagonal corner", () => {
  it("has 12 diagonal steps (3 per quadrant; the brief said 14)", () => expect(diagonalSteps).toHaveLength(12));
  for (const { k, a, b } of diagonalSteps) {
    const { edge, cell } = bandNear(a, b);
    it(`step ${k} (${keyOf(a)} -> ${keyOf(b)}): a fast attacker from ${edge} never gets inside`, () => {
      const raw = input(battlefield({ fences: ringExcept([], 3000) }), party([unit({ ref: "a", edge, cell, moveSpeed: 2600, stance: "core", offense: 95 })]), SHORT_TUNABLES);
      expect(firstSlip(raw, a, b)).toBeNull();
    });
    it(`step ${k}: a dashing attacker from ${edge} never gets inside`, () => {
      const raw = input(battlefield({ fences: ringExcept([], 3000) }), party([unit({ ref: "a", edge, cell, moveSpeed: 2600, stance: "core", ability: DASH })]), { ...SHORT_TUNABLES, abilityFirstUseDelayMult: fx(256) });
      expect(firstSlip(raw, a, b)).toBeNull();
    });
  }
});

// ── reserve wake ─────────────────────────────────────────────────────────────────────────

describe("attackerInsideRing (the reserve stance's wake)", () => {
  const stateWithAttackerAt = (c: Cell) => {
    const raw = input(battlefield({ fences: ringExcept([], 300) }), party([unit({ ref: "a", edge: "north", cell: { x: 15, y: 0 } })]), SHORT_TUNABLES);
    const s = initialState(normalizeInput(raw));
    const p = cellCenter(c);
    s.units[0]!.x = p.x;
    s.units[0]!.y = p.y;
    return s;
  };
  for (const { k, a, b } of [diagonalSteps[0]!, diagonalSteps[5]!, diagonalSteps[11]!]) {
    it(`step ${k}: a ring cell does not count, the interior cell beside the corner does`, () => {
      for (const c of [a, b]) {
        expect(attackerInsideRing(stateWithAttackerAt(c)), `ring cell ${keyOf(c)}`).toBe(-1);
      }
      const corners: Cell[] = [{ x: a.x, y: b.y }, { x: b.x, y: a.y }];
      const inner = corners.filter(isInsideRing);
      expect(inner).toHaveLength(1);
      expect(attackerInsideRing(stateWithAttackerAt(inner[0]!))).toBe(0);
      expect(attackerInsideRing(stateWithAttackerAt(corners.find((c) => !isInsideRing(c))!))).toBe(-1);
    });
  }
  it("a wagon cell does not count either", () => {
    expect(attackerInsideRing(stateWithAttackerAt(RING_ANCHORS[0]!))).toBe(-1);
  });
});

// ── input validation ─────────────────────────────────────────────────────────────────────

describe("assertResolveInput and wagon cells", () => {
  const party1 = party([unit({ ref: "a" })]);
  const w = RING_ANCHORS[0]!;
  it("accepts the canonical sealed ring", () => {
    expect(() => assertResolveInput(input(battlefield({ fences: ringExcept([]) }), party1))).not.toThrow();
  });
  it("refuses a fence whose cell is a wagon cell", () => {
    const f = { ...fence({ segment: 0 }), cell: w, pos: cellCenter(w) };
    expect(() => assertResolveInput(input(battlefield({ fences: [f] }), party1))).toThrow();
  });
  it("refuses a trap on a wagon cell", () => {
    expect(() => assertResolveInput(input(battlefield({ traps: [trap("t", w)] }), party1))).toThrow();
  });
  it("refuses a post on a wagon cell", () => {
    expect(() => assertResolveInput(input(battlefield({ posts: [post("p", w)] }), party1))).toThrow();
  });
  it("refuses a battlefield whose anchors differ from RING_ANCHORS", () => {
    const bf = { ...battlefield(), anchors: RING_ANCHORS.slice(0, 11) };
    expect(() => assertResolveInput(input(bf, party1))).toThrow();
    const swapped = { ...battlefield(), anchors: [...RING_ANCHORS].reverse() };
    expect(() => assertResolveInput(input(swapped, party1))).toThrow();
  });
});
