/**
 * The guided arrangement at encounter 1 (chunk 24, PHASE-2 §24: "place this fence, leave this
 * gap, post this unit here, now scout why"). PURE functions over the same `Manifest` /
 * `Formation` the formation screen edits, built only from chunk 08's placement model: every
 * suggested drop goes through `placement.ts` (`dropRefusal`, i.e. @caravan/circle's own
 * `validateFormation`), so the guide can only suggest what the player could do by hand, and
 * the server re-validates the commit exactly as for any other arrangement.
 *
 * The suggestion is a teaching shape, not a solver: fence the side most raiders start on,
 * leave its middle position open, lay the trap just inside that gap and post the unit behind
 * it. It is read off the scouted party only; nothing here predicts or simulates the fight.
 */
import { ENTRY_EDGES, GRID_HEIGHT, GRID_WIDTH, RING_SEGMENTS, isUnitAlive, ringSegment, type Cell, type EntryEdge, type Formation, type Manifest } from "@caravan/circle";
import type { ScoutedParty } from "../screens/trail/scoutTypes.ts";
import { dropRefusal, fenceAtSegment, isPlaceableCell, nextFenceRef, placeFence, placePost, placeTrap, remove, unplacedFences, unplacedTraps, unpostedUnits } from "../screens/trail/placement.ts";

/** Presentation tunables for the guide's checks (not balance numbers: they only decide when a step reads as done). */
export const GUIDE_POST_NEAR_GAP_CELLS = 3;
export const GUIDE_TRAP_NEAR_GAP_CELLS = 2;

const INWARD: Readonly<Record<EntryEdge, Cell>> = { north: { x: 0, y: 1 }, south: { x: 0, y: -1 }, east: { x: -1, y: 0 }, west: { x: 1, y: 0 } };

export interface EdgeCount {
  readonly edge: EntryEdge;
  readonly raiders: number;
}

/** Raiders per entry edge, most first; ties keep ENTRY_EDGES order. */
export function raidersByEdge(scout: ScoutedParty): readonly EdgeCount[] {
  return ENTRY_EDGES.map((edge) => ({ edge, raiders: scout.units.filter((u) => u.edge === edge).length })).sort((a, b) => b.raiders - a.raiders || ENTRY_EDGES.indexOf(a.edge) - ENTRY_EDGES.indexOf(b.edge));
}

/** The side most raiders start on (the first edge the party uses when none is scouted with units). */
export function mainEdge(scout: ScoutedParty): EntryEdge {
  const top = raidersByEdge(scout)[0]!;
  return top.raiders > 0 ? top.edge : (scout.edges[0] ?? "north");
}

/** Ring positions on one side, in ring order. */
export function sideSegments(edge: EntryEdge): readonly number[] {
  return RING_SEGMENTS.filter((s) => s.edge === edge).map((s) => s.index);
}

/** The position left open on `edge`: the middle of that side. */
export function gapSegment(edge: EntryEdge): number {
  const side = sideSegments(edge);
  return side[Math.floor(side.length / 2)]!;
}

const add = (a: Cell, b: Cell, k: number): Cell => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const d2 = (a: Cell, b: Cell): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

/** Cells `k` steps inward from the gap: 1 = where the trap goes, 2 = where the post goes. */
export function inwardFromGap(edge: EntryEdge, k: number): Cell {
  return add(ringSegment(gapSegment(edge)).cell, INWARD[edge], k);
}

/**
 * The legal cell for `ref` nearest `target` (squared distance, then row, then column — a total
 * order), avoiding `reserved` cells; null when nowhere is legal. Legality is circle's.
 */
export function nearestLegalCell(m: Manifest, f: Formation, ref: string, target: Cell, reserved: readonly Cell[] = []): Cell | null {
  const cells: Cell[] = [];
  for (let y = 0; y < GRID_HEIGHT; y++) for (let x = 0; x < GRID_WIDTH; x++) if (isPlaceableCell({ x, y })) cells.push({ x, y });
  cells.sort((a, b) => d2(a, target) - d2(b, target) || a.y - b.y || a.x - b.x);
  for (const c of cells) {
    if (reserved.some((r) => r.x === c.x && r.y === c.y)) continue;
    if (dropRefusal(m, f, ref, c) === null) return c;
  }
  return null;
}

export interface ArrangeStatus {
  readonly edge: EntryEdge;
  readonly raidersOnEdge: number;
  readonly raidersTotal: number;
  readonly gap: number;
  readonly gapCell: Cell;
  /** Every position on the side but the gap is fenced, or the wagon has no intact segment left to place there. */
  readonly fenceDone: boolean;
  readonly gapOpen: boolean;
  readonly postDone: boolean;
  /** Living units not yet posted (all must be, to commit). */
  readonly unposted: number;
  /** A trap lies near the gap, or none is left to lay. */
  readonly trapDone: boolean;
  readonly trapAvailable: boolean;
  /** Intact fence segments still in the wagon. */
  readonly fenceLeft: number;
  /** The suggested drop for the next post, and for the first trap (null when none is needed or legal). */
  readonly nextPost: { readonly ref: string; readonly cell: Cell } | null;
  readonly nextTrap: { readonly ref: string; readonly cell: Cell } | null;
}

export function arrangeStatus(m: Manifest, f: Formation, scout: ScoutedParty): ArrangeStatus {
  const edge = mainEdge(scout);
  const gap = gapSegment(edge);
  const gapCell = ringSegment(gap).cell;
  const wanted = sideSegments(edge).filter((s) => s !== gap);
  const fenced = wanted.filter((s) => fenceAtSegment(f, s) !== null).length;
  const fenceLeft = unplacedFences(m, f).length;
  const posts = f.posts.filter((p) => d2(p.cell, gapCell) <= GUIDE_POST_NEAR_GAP_CELLS ** 2);
  const traps = f.traps.filter((t) => d2(t.cell, gapCell) <= GUIDE_TRAP_NEAR_GAP_CELLS ** 2);
  const freeTraps = unplacedTraps(m, f);
  const unposted = unpostedUnits(m, f);
  const trapCell = inwardFromGap(edge, 1);
  const postCell = inwardFromGap(edge, 2);
  const firstUnposted = unposted[0];
  const nextPost = firstUnposted ? cellFor(m, f, firstUnposted.ref, postCell, [trapCell]) : null;
  const firstTrap = freeTraps[0];
  const nextTrap = traps.length === 0 && firstTrap ? cellFor(m, f, firstTrap.ref, trapCell, f.posts.map((p) => p.cell)) : null;
  return {
    edge,
    raidersOnEdge: scout.units.filter((u) => u.edge === edge).length,
    raidersTotal: scout.units.length,
    gap,
    gapCell,
    fenceDone: fenced === wanted.length || (fenced > 0 && fenceLeft === 0),
    gapOpen: fenceAtSegment(f, gap) === null,
    postDone: posts.length > 0,
    unposted: unposted.length,
    trapDone: traps.length > 0 || freeTraps.length === 0,
    trapAvailable: traps.length > 0 || freeTraps.length > 0,
    fenceLeft,
    nextPost,
    nextTrap,
  };
}

function cellFor(m: Manifest, f: Formation, ref: string, target: Cell, reserved: readonly Cell[]): { ref: string; cell: Cell } | null {
  const cell = nearestLegalCell(m, f, ref, target, reserved);
  return cell ? { ref, cell } : null;
}

// ── the "do it for me" edits (each returns a new Formation; refused drops change nothing) ──

/** Fence every position on the main side except the gap, healthiest segments first. */
export function applyMainFence(m: Manifest, f: Formation, scout: ScoutedParty): Formation {
  const edge = mainEdge(scout);
  const gap = gapSegment(edge);
  let out = f;
  for (const s of sideSegments(edge)) {
    if (s === gap || fenceAtSegment(out, s) !== null) continue;
    const ref = nextFenceRef(m, out);
    if (!ref) break;
    if (dropRefusal(m, out, ref, ringSegment(s).cell) === null) out = placeFence(out, ref, s);
  }
  return out;
}

/** Take whatever fence stands on the gap back into the wagon. */
export function applyOpenGap(f: Formation, scout: ScoutedParty): Formation {
  const ref = fenceAtSegment(f, gapSegment(mainEdge(scout)));
  return ref ? remove(f, ref) : f;
}

/** Post every living, unposted unit as near the spot behind the gap as circle allows, keeping the trap's cell free. */
export function applyPosts(m: Manifest, f: Formation, scout: ScoutedParty): Formation {
  const edge = mainEdge(scout);
  const target = inwardFromGap(edge, 2);
  const keep = inwardFromGap(edge, 1);
  let out = f;
  for (const u of m.units.filter(isUnitAlive)) {
    if (out.posts.some((p) => p.ref === u.ref)) continue;
    const cell = nearestLegalCell(m, out, u.ref, target, [keep]);
    if (cell) out = placePost(out, u.ref, cell);
  }
  return out;
}

/** Lay the first unplaced, unspent trap just inside the gap. */
export function applyTrap(m: Manifest, f: Formation, scout: ScoutedParty): Formation {
  const t = unplacedTraps(m, f)[0];
  if (!t) return f;
  const cell = nearestLegalCell(m, f, t.ref, inwardFromGap(mainEdge(scout), 1), f.posts.map((p) => p.cell));
  return cell ? placeTrap(f, t.ref, cell) : f;
}

/** The remaining segments on the other sides, most raiders first, each side in ring order; the gap stays open. */
export function applyRestOfFence(m: Manifest, f: Formation, scout: ScoutedParty): Formation {
  const edge = mainEdge(scout);
  const gap = gapSegment(edge);
  const order = [edge, ...raidersByEdge(scout).map((e) => e.edge).filter((e) => e !== edge)];
  let out = f;
  for (const e of order) {
    for (const s of sideSegments(e)) {
      if (s === gap || fenceAtSegment(out, s) !== null) continue;
      const ref = nextFenceRef(m, out);
      if (!ref) return out;
      if (dropRefusal(m, out, ref, ringSegment(s).cell) === null) out = placeFence(out, ref, s);
    }
  }
  return out;
}
