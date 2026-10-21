/**
 * Saved layouts (chunk 51): rotation about the core centre, save normalised to a north main edge,
 * load turned to the next party with an attrition floor, the reasons a piece is left out, and the hints.
 */
import { describe, expect, it } from "vitest";
import {
  BATTLEFIELD_VERSION,
  CORE_CENTER_CELL,
  EMPTY_FORMATION,
  ENTRY_EDGES,
  FORMATION_VERSION,
  INTERIOR_POST_CELLS,
  DEFAULT_DEFENSIVE_STANCE,
  ParseError,
  RING_ANCHORS,
  RING_ORDER,
  RING_SEGMENTS,
  cellKey,
  isAnchorCell,
  layoutFromJson,
  layoutHints,
  loadLayout,
  mainEdge,
  normalizeFormation,
  ringIndexAt,
  ringSegment,
  rotateCell,
  rotateEdge,
  saveLayout,
  savedSidesFacing,
  serializeLayout,
  sideOfCell,
  validateFormation,
  type Cell,
  type EntryEdge,
  type Formation,
  type Manifest,
  type SavedLayout,
} from "../src/index.js";
import { arrange, fullPack } from "./fixtures.js";

const scoutOf = (counts: Partial<Record<EntryEdge, number>>, edges: EntryEdge[] = []) => ({
  units: (Object.entries(counts) as [EntryEdge, number][]).flatMap(([edge, n]) => Array.from({ length: n }, () => ({ edge }))),
  edges,
});
const facing = (e: EntryEdge) => scoutOf({ [e]: 3, [rotateEdge(e, 1)]: 1 });
const keys = (cells: readonly Cell[]) => new Set(cells.map(cellKey));
const closed = (cells: readonly Cell[]) => {
  const s = keys(cells);
  return cells.every((c) => s.has(cellKey(rotateCell(c, 1))));
};
const withFences = (m: Manifest, hps: number[]): Manifest => ({ ...m, fences: m.fences.map((f, i) => ({ ...f, hp: hps[i] ?? f.hp })) });
const saved = (o: Partial<SavedLayout> = {}): SavedLayout => ({
  v: 1, battlefieldVersion: BATTLEFIELD_VERSION, mainEdge: "north", raiders: { north: 3, east: 0, south: 0, west: 0 }, fences: [], traps: [], posts: [], ...o,
});

describe("rotation", () => {
  it("turns clockwise about the core centre, y down", () => {
    const c = CORE_CENTER_CELL;
    const north = { x: c.x, y: c.y - 5 };
    expect(rotateCell(north, 1)).toEqual({ x: c.x + 5, y: c.y });
    expect(rotateCell(north, 2)).toEqual({ x: c.x, y: c.y + 5 });
    expect(rotateCell(north, 3)).toEqual({ x: c.x - 5, y: c.y });
    expect(rotateCell(north, -1)).toEqual(rotateCell(north, 3));
    expect(rotateCell(north, 5)).toEqual(rotateCell(north, 1));
    expect(rotateCell(c, 1)).toEqual(c);
  });
  it("rotateEdge goes north, east, south, west", () => {
    expect(ENTRY_EDGES.map((e) => rotateEdge(e, 1))).toEqual(["east", "south", "west", "north"]);
    expect(rotateEdge("north", -1)).toBe("west");
  });
  it("four quarter turns are the identity, and sides turn with cells", () => {
    for (const c of [...RING_ORDER, ...INTERIOR_POST_CELLS]) {
      let r: Cell = c;
      for (let i = 0; i < 4; i++) r = rotateCell(r, 1);
      expect(r).toEqual(c);
      expect(sideOfCell(rotateCell(c, 1))).toBe(rotateEdge(sideOfCell(c), 1));
    }
  });
});

describe("symmetry of the wagon circle", () => {
  it("the ring and the interior are closed under a quarter turn", () => {
    expect(closed(RING_ORDER)).toBe(true);
    expect(closed(INTERIOR_POST_CELLS)).toBe(true);
  });
  it("the six wagons are not (six cannot divide into four), so a ring cell can turn onto one", () => {
    expect(closed(RING_ANCHORS)).toBe(false);
    expect(RING_SEGMENTS.some((s) => isAnchorCell(rotateCell(s.cell, 1)))).toBe(true);
  });
});

describe("saveLayout", () => {
  const m = fullPack();
  const f = arrange(m);
  it("stores a layout normalised to a north main edge, with raiders in the original frame", () => {
    const scout = scoutOf({ east: 3, south: 1 });
    const s = saveLayout(f, m, scout);
    expect(s.v).toBe(1);
    expect(s.battlefieldVersion).toBe(3);
    expect(s.battlefieldVersion).toBe(BATTLEFIELD_VERSION);
    expect(s.mainEdge).toBe("east");
    expect(s.raiders).toEqual({ north: 0, east: 3, south: 1, west: 0 });
    const nf = normalizeFormation(f);
    expect(s.fences).toEqual(nf.fences.map((p) => ({ cell: rotateCell(ringSegment(p.segment).cell, -1), tierId: "fence.brush_pile" })));
    expect(s.traps).toEqual(nf.traps.map((p) => ({ cell: rotateCell(p.cell, -1), typeId: m.traps.find((t) => t.ref === p.ref)!.typeId })));
    expect(s.posts).toEqual(nf.posts.map((p) => {
      const u = m.units.find((x) => x.ref === p.ref)!;
      return { cell: rotateCell(p.cell, -1), instanceId: u.ref, typeId: u.typeId, stance: p.stance };
    }));
  });
  it("ties go in ENTRY_EDGES order; no units uses the first scouted edge, else north", () => {
    expect(saveLayout(f, m, scoutOf({ south: 2, east: 2 })).mainEdge).toBe("east");
    expect(saveLayout(f, m, scoutOf({}, ["west", "south"])).mainEdge).toBe("west");
    expect(saveLayout(f, m, scoutOf({})).mainEdge).toBe("north");
  });
  it("a north party leaves the cells as they are", () => {
    const s = saveLayout(f, m, scoutOf({ north: 2 }));
    expect(s.traps.map((t) => t.cell)).toEqual(normalizeFormation(f).traps.map((t) => t.cell));
  });
});

describe("loadLayout round trip and turning", () => {
  const m = fullPack();
  const f = arrange(m);
  it.each(ENTRY_EDGES)("save then load against the same party (main %s) restores the formation exactly", (e) => {
    const sc = facing(e);
    expect(mainEdge(sc)).toBe(e);
    const out = loadLayout(saveLayout(f, m, sc), m, sc);
    expect(out.unavailable).toBeNull();
    expect(out.leftOut).toEqual([]);
    expect(out.formation).toEqual(normalizeFormation(f));
  });
  it("turned to an east party: traps and posts turn, fences on a wagon are left out as 'wagon'", () => {
    const north = facing("north");
    const east = facing("east");
    const wagonSeg = RING_SEGMENTS.find((s) => isAnchorCell(rotateCell(s.cell, 1)))!;
    const other = RING_SEGMENTS.find((s) => s.index !== wagonSeg.index && !isAnchorCell(rotateCell(s.cell, 1)))!;
    const g: Formation = { ...f, fences: [{ ref: "f0", segment: wagonSeg.index }, { ref: "f1", segment: other.index }].sort((a, b) => a.segment - b.segment) };
    const s = saveLayout(g, m, north);
    const out = loadLayout(s, m, east);
    for (const t of s.traps) {
      const ref = normalizeFormation(g).traps.find((p) => p.cell.x === t.cell.x && p.cell.y === t.cell.y)!.ref;
      expect(out.formation.traps.find((p) => p.ref === ref)!.cell).toEqual(rotateCell(t.cell, 1));
    }
    for (const p of s.posts) expect(out.formation.posts.find((q) => q.ref === p.instanceId)!.cell).toEqual(rotateCell(p.cell, 1));
    expect(out.formation.fences).toHaveLength(1);
    expect(out.formation.fences[0]!.segment).toBe(ringIndexAt(rotateCell(ringSegment(other.index).cell, 1))!);
    expect(out.leftOut).toEqual([{ kind: "fence", typeId: "fence.brush_pile", instanceId: null, edge: sideOfCell(rotateCell(wagonSeg.cell, 1)), reason: "wagon" }]);
  });
  it("a different battlefield version loads nothing", () => {
    const s = { ...saveLayout(f, m, facing("north")), battlefieldVersion: 2 };
    expect(loadLayout(s, m, facing("north"))).toEqual({ formation: EMPTY_FORMATION, leftOut: [], unavailable: "battlefield_version" });
  });
});

describe("loadLayout leaves out, with a reason", () => {
  const m = fullPack();
  const sc = scoutOf({ north: 3 });
  const seg0 = RING_SEGMENTS[0]!;
  const cellA = INTERIOR_POST_CELLS[0]!;
  const one = (s: SavedLayout, surv: Manifest = m, scout = sc) => loadLayout(s, surv, scout);

  it("not_packed: a fence tier, a trap type and a unit instance that are not in the survivors", () => {
    const out = one(saved({
      fences: [{ cell: seg0.cell, tierId: "fence.nonexistent" }],
      traps: [{ cell: cellA, typeId: "trap.nonexistent" }],
      posts: [{ cell: INTERIOR_POST_CELLS[5]!, instanceId: "ghost", typeId: "desert.vaquero", stance: DEFAULT_DEFENSIVE_STANCE }],
    }));
    expect(out.formation).toEqual(normalizeFormation(EMPTY_FORMATION));
    expect(out.leftOut).toEqual([
      { kind: "fence", typeId: "fence.nonexistent", instanceId: null, edge: sideOfCell(seg0.cell), reason: "not_packed" },
      { kind: "trap", typeId: "trap.nonexistent", instanceId: null, edge: sideOfCell(cellA), reason: "not_packed" },
      { kind: "post", typeId: "desert.vaquero", instanceId: "ghost", edge: sideOfCell(INTERIOR_POST_CELLS[5]!), reason: "not_packed" },
    ]);
  });
  it("broken: the tier is packed but every segment of it is destroyed", () => {
    const surv = withFences(m, m.fences.map(() => 0));
    const out = one(saved({ fences: [{ cell: seg0.cell, tierId: "fence.brush_pile" }] }), surv);
    expect(out.formation.fences).toEqual([]);
    expect(out.leftOut.map((l) => l.reason)).toEqual(["broken"]);
  });
  it("spent: the trap type is present but every one is spent", () => {
    const surv = { ...m, traps: m.traps.map((t) => ({ ...t, spent: true })) };
    const out = one(saved({ traps: [{ cell: cellA, typeId: "trap.spike_pit" }] }), surv);
    expect(out.formation.traps).toEqual([]);
    expect(out.leftOut).toEqual([{ kind: "trap", typeId: "trap.spike_pit", instanceId: null, edge: sideOfCell(cellA), reason: "spent" }]);
  });
  it("dead: a unit at 0 hp is not brought back", () => {
    const surv = { ...m, units: m.units.map((u) => (u.ref === "u-rider" ? { ...u, hp: 0 } : u)) };
    const out = one(saved({ posts: [{ cell: cellA, instanceId: "u-rider", typeId: "desert.dust_rider", stance: DEFAULT_DEFENSIVE_STANCE }] }), surv);
    expect(out.formation.posts).toEqual([]);
    expect(out.leftOut).toEqual([{ kind: "post", typeId: "desert.dust_rider", instanceId: "u-rider", edge: sideOfCell(cellA), reason: "dead" }]);
  });
  it("blocked: a second post on the first's cell, and a trap on the core", () => {
    const near = cellA; // MIN_POST_DISTANCE (1 cell) is a no-op, so sharing a cell is the way two posts collide
    const out = one(saved({
      traps: [{ cell: CORE_CENTER_CELL, typeId: "trap.spike_pit" }],
      posts: [
        { cell: cellA, instanceId: "u-rider", typeId: "desert.dust_rider", stance: DEFAULT_DEFENSIVE_STANCE },
        { cell: near, instanceId: "u-digger", typeId: "desert.well_digger", stance: DEFAULT_DEFENSIVE_STANCE },
      ],
    }));
    expect(out.formation.posts.map((p) => p.ref)).toEqual(["u-rider"]);
    expect(out.leftOut).toEqual([
      { kind: "trap", typeId: "trap.spike_pit", instanceId: null, edge: sideOfCell(CORE_CENTER_CELL), reason: "blocked" },
      { kind: "post", typeId: "desert.well_digger", instanceId: "u-digger", edge: sideOfCell(near), reason: "blocked" },
    ]);
  });
});

describe("fence matching and the attrition floor", () => {
  const m = fullPack();
  const sc = scoutOf({ north: 3 });
  it("two stored fences of one tier take the highest-HP intact segments, ties by manifest order", () => {
    const base = m.fences[0]!.maxHp;
    const surv: Manifest = { ...m, fences: m.fences.slice(0, 3).map((f, i) => ({ ...f, hp: [5, base + 4, 0][i]! })) };
    const [s0, s1] = [RING_SEGMENTS[0]!, RING_SEGMENTS[1]!];
    const out = loadLayout(saved({ fences: [{ cell: s0.cell, tierId: "fence.brush_pile" }, { cell: s1.cell, tierId: "fence.brush_pile" }] }), surv, sc);
    expect(out.formation.fences).toEqual([{ ref: surv.fences[1]!.ref, segment: s0.index }, { ref: surv.fences[0]!.ref, segment: s1.index }]);
    expect(out.leftOut).toEqual([]);
  });
  it("equal HP falls to manifest order", () => {
    const surv: Manifest = { ...m, fences: m.fences.slice(0, 3) };
    const out = loadLayout(saved({ fences: [RING_SEGMENTS[0]!, RING_SEGMENTS[1]!].map((s) => ({ cell: s.cell, tierId: "fence.brush_pile" })) }), surv, sc);
    expect(out.formation.fences.map((p) => p.ref)).toEqual([surv.fences[0]!.ref, surv.fences[1]!.ref]);
  });
  it("never brings back a destroyed fence, a spent trap or a dead unit", () => {
    const f = arrange(m);
    const s = saveLayout(f, m, sc);
    const surv: Manifest = {
      ...m,
      fences: m.fences.map((x, i) => (i % 2 ? { ...x, hp: 0 } : x)),
      traps: m.traps.map((x, i) => (i % 2 ? { ...x, spent: true } : x)),
      units: m.units.map((x, i) => (i % 2 ? { ...x, hp: 0 } : x)),
    };
    const out = loadLayout(s, surv, sc);
    for (const p of out.formation.fences) expect(surv.fences.find((x) => x.ref === p.ref)!.hp).toBeGreaterThan(0);
    for (const p of out.formation.traps) expect(surv.traps.find((x) => x.ref === p.ref)!.spent).toBe(false);
    for (const p of out.formation.posts) expect(surv.units.find((x) => x.ref === p.ref)!.hp).toBeGreaterThan(0);
    expect(out.leftOut.length).toBeGreaterThan(0);
  });
});

describe("loadLayout property test", () => {
  const m = fullPack();
  it("is deterministic, valid, and accounts for every stored piece, over 240 seeded cases", () => {
    let seed = 987654321;
    const rnd = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return Math.floor(seed / 65536) % n;
    };
    for (let i = 0; i < 240; i++) {
      let f: Formation = { v: FORMATION_VERSION, fences: [], traps: [], posts: [] };
      const segs = [...new Set(Array.from({ length: 3 + rnd(m.fences.length - 2) }, () => rnd(RING_SEGMENTS.length)))].sort((a, b) => a - b).slice(0, m.fences.length);
      f = { ...f, fences: segs.map((s, k) => ({ ref: m.fences[k]!.ref, segment: s })) };
      const ok = (g: Formation) => {
        const r = validateFormation(m, g, () => true);
        return r.ok || r.issues.every((x) => x.code === "unit_not_posted");
      };
      for (const t of m.traps) {
        if (rnd(4) === 0) continue;
        const g = { ...f, traps: [...f.traps, { ref: t.ref, cell: INTERIOR_POST_CELLS[rnd(INTERIOR_POST_CELLS.length)]! }] };
        if (ok(g)) f = g;
      }
      for (const u of m.units) {
        if (rnd(4) === 0) continue;
        const g = { ...f, posts: [...f.posts, { ref: u.ref, cell: INTERIOR_POST_CELLS[rnd(INTERIOR_POST_CELLS.length)]!, stance: DEFAULT_DEFENSIVE_STANCE }] };
        if (ok(g)) f = g;
      }
      const from = ENTRY_EDGES[rnd(4)]!;
      const to = ENTRY_EDGES[rnd(4)]!;
      const s = saveLayout(f, m, facing(from));
      const surv: Manifest = {
        ...m,
        fences: m.fences.map((x) => (rnd(5) === 0 ? { ...x, hp: 0 } : { ...x, hp: 1 + rnd(x.maxHp) })),
        traps: m.traps.map((x) => (rnd(4) === 0 ? { ...x, spent: true } : x)).filter(() => rnd(8) !== 0),
        units: m.units.map((x) => (rnd(4) === 0 ? { ...x, hp: 0 } : x)).filter(() => rnd(8) !== 0),
      };
      const a = loadLayout(s, surv, facing(to));
      const b = loadLayout(s, surv, facing(to));
      expect(JSON.stringify(a), `case ${i}`).toBe(JSON.stringify(b));
      const v = validateFormation(surv, a.formation, () => true);
      if (!v.ok) expect(v.issues.map((x) => x.code).filter((c) => c !== "unit_not_posted"), `case ${i}`).toEqual([]);
      const placed = a.formation.fences.length + a.formation.traps.length + a.formation.posts.length;
      expect(placed + a.leftOut.length, `case ${i}`).toBe(s.fences.length + s.traps.length + s.posts.length);
    }
  });
});

describe("storage", () => {
  const m = fullPack();
  const s = saveLayout(arrange(m), m, scoutOf({ east: 2, south: 1 }));
  it("serializeLayout and layoutFromJson round trip", () => {
    expect(layoutFromJson(JSON.parse(serializeLayout(s)))).toEqual(s);
    expect(serializeLayout(layoutFromJson(JSON.parse(serializeLayout(s))))).toBe(serializeLayout(s));
  });
  it("throws ParseError on a wrong version, a bad main edge or a non-integer cell", () => {
    const j = JSON.parse(serializeLayout(s));
    expect(() => layoutFromJson({ ...j, v: 2 })).toThrow(ParseError);
    expect(() => layoutFromJson({ ...j, mainEdge: "up" })).toThrow(ParseError);
    expect(() => layoutFromJson({ ...j, traps: [{ cell: { x: 1.5, y: 2 }, typeId: "trap.spike_pit" }] })).toThrow(ParseError);
  });
});

describe("savedSidesFacing", () => {
  it("turns the saved raider sides by the difference of main edges, in ENTRY_EDGES order", () => {
    const s = saved({ raiders: { north: 3, east: 1, south: 0, west: 0 } });
    expect(savedSidesFacing(s, scoutOf({ south: 2 }))).toEqual(["south", "west"]);
    expect(savedSidesFacing(s, scoutOf({ north: 2 }))).toEqual(["north", "east"]);
  });
});

describe("layoutHints", () => {
  const m = fullPack();
  const north = scoutOf({ north: 3, east: 1 });
  const mainSegs = RING_SEGMENTS.filter((s) => s.edge === "north");
  const fenceMain = (skip = -1): Formation => ({ ...EMPTY_FORMATION, fences: mainSegs.filter((s) => s.index !== skip).map((s, k) => ({ ref: m.fences[k]!.ref, segment: s.index })) });

  it("no hints for a scout with no units", () => {
    expect(layoutHints(EMPTY_FORMATION, scoutOf({}), ["east"])).toEqual([]);
  });
  it("gap_faces_main when a main-edge segment has no fence, carrying the raider counts", () => {
    expect(layoutHints(fenceMain(mainSegs[0]!.index), north, [])).toEqual([{ code: "gap_faces_main", edge: "north", raiders: 3, total: 4 }]);
    expect(layoutHints(fenceMain(), north, [])).toEqual([]);
  });
  it("trap_unused_side per trap on a side with no raiders, in ref order, then direction_changed", () => {
    const south = INTERIOR_POST_CELLS.filter((c) => sideOfCell(c) === "south");
    const east = INTERIOR_POST_CELLS.find((c) => sideOfCell(c) === "east")!;
    const f: Formation = { ...fenceMain(), traps: [{ ref: "t2", cell: south[1]! }, { ref: "t1", cell: south[0]! }, { ref: "t3", cell: east }] };
    expect(layoutHints(f, north, ["south"])).toEqual([
      { code: "trap_unused_side", ref: "t1", edge: "south" },
      { code: "trap_unused_side", ref: "t2", edge: "south" },
      { code: "direction_changed", was: ["south"], now: ["north", "east"] },
    ]);
  });
  it("no direction_changed when the sides match or none were saved", () => {
    expect(layoutHints(fenceMain(), north, ["north", "east"])).toEqual([]);
    expect(layoutHints(fenceMain(), north, [])).toEqual([]);
  });
  it("is pure: a frozen formation is unchanged", () => {
    const f = normalizeFormation({ ...fenceMain(3), traps: [{ ref: "t1", cell: INTERIOR_POST_CELLS[0]! }] });
    const before = JSON.stringify(f);
    layoutHints(f, north, ["west"]);
    expect(JSON.stringify(f)).toBe(before);
  });
});
