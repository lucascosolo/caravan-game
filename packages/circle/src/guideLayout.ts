/**
 * The onboarding guide's arrangement (chunk 24; final play-test review round 3: at EVERY encounter
 * of the guided trip), as PURE functions over a Manifest and a Formation. Shared by the web
 * client's guided checklist (apps/web onboarding/arrangeGuide.ts re-exports this file) and the
 * balance harness, so the harness models exactly the layout the guide's "do it for me" makes.
 *
 * The layout (read off the CHOSEN party's scout and the manifest as it stands, survivors only):
 *   1. main side = the side most raiders start on (ties: ENTRY_EDGES order north, east, south,
 *      west; no units: the party's first scouted edge, else north);
 *   2. the gap = the middle ring position of that side; every other position on that side is
 *      fenced with the healthiest intact segments still in the wagon (then by ref);
 *   3. every living, unposted unit is posted, in manifest order, on the legal cell nearest the
 *      cell two steps inward from the gap (squared distance, then row, then column), keeping the
 *      cell one step inward free; default stance (guard);
 *   4. the first unspent, unplaced trap is laid on the legal cell nearest one step inward from
 *      the gap, avoiding posted cells;
 *   5. the rest of the fence: the main side, then the other sides by raiders (most first, ties
 *      in ENTRY_EDGES order), each side in ring order, gap left open, until the wagon is empty.
 * Destroyed segments, spent traps and dead units are simply absent from what can be placed, so
 * the same rule serves encounter 1 and a pushed encounter 2 with its carried-forward losses.
 *
 * Legality is @caravan/circle's own `validateFormation` (a suggested drop is kept only when it
 * raises no issue about the dropped thing), so the guide suggests only what the player could do
 * by hand and the server validates the commit as for any other arrangement. It is a teaching
 * shape, not a solver: nothing here predicts or simulates the fight.
 */
import { DEFAULT_DEFENSIVE_STANCE, EMPTY_FORMATION, FORMATION_VERSION, validateFormation, type Formation } from "./formation.js";
import { ENTRY_EDGES, GRID_HEIGHT, GRID_WIDTH, RING_SEGMENTS, isAnyEntryCell, isCell, isCoreCell, isRingOrAnchorCell, ringIndexAt, ringSegment, sameCell, type Cell, type EntryEdge } from "./lattice.js";
import { isFenceIntact, isUnitAlive, type Manifest } from "./manifest.js";

/** What the layout reads of the chosen party: each raider's entry edge, and the edges it uses. */
export interface GuideScoutLike {
  readonly units: readonly { readonly edge: EntryEdge }[];
  readonly edges: readonly EntryEdge[];
}

const INWARD: Readonly<Record<EntryEdge, Cell>> = { north: { x: 0, y: 1 }, south: { x: 0, y: -1 }, east: { x: -1, y: 0 }, west: { x: 1, y: 0 } };
const add = (a: Cell, b: Cell, k: number): Cell => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const d2 = (a: Cell, b: Cell): number => (a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y);

// ── the reading ──────────────────────────────────────────────────────────────────────

export interface EdgeCount {
  readonly edge: EntryEdge;
  readonly raiders: number;
}

/** Raiders per entry edge, most first; ties keep ENTRY_EDGES order. */
export function raidersByEdge(scout: GuideScoutLike): readonly EdgeCount[] {
  return ENTRY_EDGES.map((edge) => ({ edge, raiders: scout.units.filter((u) => u.edge === edge).length })).sort((a, b) => b.raiders - a.raiders || ENTRY_EDGES.indexOf(a.edge) - ENTRY_EDGES.indexOf(b.edge));
}

/** The side most raiders start on (the first edge the party uses when none is scouted with units). */
export function mainEdge(scout: GuideScoutLike): EntryEdge {
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

/** Cells `k` steps inward from the gap: 1 = where the trap goes, 2 = where the post goes. */
export function inwardFromGap(edge: EntryEdge, k: number): Cell {
  return add(ringSegment(gapSegment(edge)).cell, INWARD[edge], k);
}

// ── placement primitives (the same rules as the client's placement model) ───────────

/** A cell a trap or post may occupy: on the lattice, off the ring/anchors, the core and the entry bands. */
export function isGuidePlaceableCell(cell: Cell): boolean {
  return isCell(cell) && !isRingOrAnchorCell(cell) && !isCoreCell(cell) && !isAnyEntryCell(cell);
}

export function fenceAtSegment(f: Formation, segment: number): string | null {
  return f.fences.find((p) => p.segment === segment)?.ref ?? null;
}

function unplacedFenceRefs(m: Manifest, f: Formation): readonly string[] {
  const placed = new Set(f.fences.map((p) => p.ref));
  return m.fences
    .filter((x) => isFenceIntact(x) && !placed.has(x.ref))
    .sort((a, b) => b.hp - a.hp || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .map((x) => x.ref);
}
function unplacedTrapRefs(m: Manifest, f: Formation): readonly string[] {
  const placed = new Set(f.traps.map((p) => p.ref));
  return m.traps.filter((t) => !t.spent && !placed.has(t.ref)).map((t) => t.ref);
}
function unpostedUnitRefs(m: Manifest, f: Formation): readonly string[] {
  const placed = new Set(f.posts.map((p) => p.ref));
  return m.units.filter((u) => isUnitAlive(u) && !placed.has(u.ref)).map((u) => u.ref);
}

/** Codes about the whole arrangement, never about one drop (the same set the client's drop refusal ignores). */
const NOT_ABOUT_THIS_DROP = new Set(["unit_not_posted", "type_locked"]);

function kindOf(m: Manifest, ref: string): "fence" | "trap" | "post" | null {
  if (m.fences.some((x) => x.ref === ref)) return "fence";
  if (m.traps.some((x) => x.ref === ref)) return "trap";
  if (m.units.some((x) => x.ref === ref)) return "post";
  return null;
}

/** Whether `ref` may be dropped on `cell`: circle's validateFormation raises no issue about it. */
export function guideDropOk(m: Manifest, f: Formation, ref: string, cell: Cell): boolean {
  const kind = kindOf(m, ref);
  if (!kind) return false;
  const rest: Formation = { v: FORMATION_VERSION, fences: f.fences.filter((p) => p.ref !== ref), traps: f.traps.filter((p) => p.ref !== ref), posts: f.posts.filter((p) => p.ref !== ref) };
  let h: Formation;
  if (kind === "fence") {
    const seg = ringIndexAt(cell);
    if (seg === null) return false;
    h = { ...rest, fences: [...rest.fences, { ref, segment: seg }] };
  } else {
    if (!isCell(cell)) return false;
    if (kind === "trap") h = { ...rest, traps: [...rest.traps, { ref, cell: { x: cell.x, y: cell.y } }] };
    else {
      const stance = f.posts.find((p) => p.ref === ref)?.stance ?? DEFAULT_DEFENSIVE_STANCE;
      h = { ...rest, posts: [...rest.posts, { ref, cell: { x: cell.x, y: cell.y }, stance }] };
    }
  }
  const res = validateFormation(m, h, () => true);
  if (res.ok) return true;
  return !res.issues.some((i) => i.subject === ref && !NOT_ABOUT_THIS_DROP.has(i.code));
}

const occupied = (f: Formation, cell: Cell, ref: string): boolean => {
  const who = f.traps.find((t) => sameCell(t.cell, cell))?.ref ?? f.posts.find((p) => sameCell(p.cell, cell))?.ref ?? null;
  return who !== null && who !== ref;
};

function withFence(f: Formation, ref: string, segment: number): Formation {
  const who = fenceAtSegment(f, segment);
  if (who !== null && who !== ref) return f;
  return { v: FORMATION_VERSION, fences: [...f.fences.filter((p) => p.ref !== ref), { ref, segment }], traps: f.traps, posts: f.posts };
}
function withTrap(f: Formation, ref: string, cell: Cell): Formation {
  if (!isGuidePlaceableCell(cell) || occupied(f, cell, ref)) return f;
  return { v: FORMATION_VERSION, fences: f.fences, traps: [...f.traps.filter((p) => p.ref !== ref), { ref, cell: { x: cell.x, y: cell.y } }], posts: f.posts };
}
function withPost(f: Formation, ref: string, cell: Cell): Formation {
  if (!isGuidePlaceableCell(cell) || occupied(f, cell, ref)) return f;
  const s = f.posts.find((p) => p.ref === ref)?.stance ?? DEFAULT_DEFENSIVE_STANCE;
  return { v: FORMATION_VERSION, fences: f.fences, traps: f.traps, posts: [...f.posts.filter((p) => p.ref !== ref), { ref, cell: { x: cell.x, y: cell.y }, stance: s }] };
}
function without(f: Formation, ref: string): Formation {
  return { v: FORMATION_VERSION, fences: f.fences.filter((p) => p.ref !== ref), traps: f.traps.filter((p) => p.ref !== ref), posts: f.posts.filter((p) => p.ref !== ref) };
}

/**
 * The legal cell for `ref` nearest `target` (squared distance, then row, then column — a total
 * order), avoiding `reserved` cells; null when nowhere is legal. Legality is circle's.
 */
export function nearestLegalCell(m: Manifest, f: Formation, ref: string, target: Cell, reserved: readonly Cell[] = []): Cell | null {
  const cells: Cell[] = [];
  for (let y = 0; y < GRID_HEIGHT; y++) for (let x = 0; x < GRID_WIDTH; x++) if (isGuidePlaceableCell({ x, y })) cells.push({ x, y });
  cells.sort((a, b) => d2(a, target) - d2(b, target) || a.y - b.y || a.x - b.x);
  for (const c of cells) {
    if (reserved.some((r) => r.x === c.x && r.y === c.y)) continue;
    if (guideDropOk(m, f, ref, c)) return c;
  }
  return null;
}

// ── the checklist's state ────────────────────────────────────────────────────────────

/** Presentation tunables for the guide's checks (not balance numbers: they only decide when a step reads as done). */
export const GUIDE_POST_NEAR_GAP_CELLS = 3;
export const GUIDE_TRAP_NEAR_GAP_CELLS = 2;

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

export function arrangeStatus(m: Manifest, f: Formation, scout: GuideScoutLike): ArrangeStatus {
  const edge = mainEdge(scout);
  const gap = gapSegment(edge);
  const gapCell = ringSegment(gap).cell;
  const wanted = sideSegments(edge).filter((s) => s !== gap);
  const fenced = wanted.filter((s) => fenceAtSegment(f, s) !== null).length;
  const fenceLeft = unplacedFenceRefs(m, f).length;
  const posts = f.posts.filter((p) => d2(p.cell, gapCell) <= GUIDE_POST_NEAR_GAP_CELLS * GUIDE_POST_NEAR_GAP_CELLS);
  const traps = f.traps.filter((t) => d2(t.cell, gapCell) <= GUIDE_TRAP_NEAR_GAP_CELLS * GUIDE_TRAP_NEAR_GAP_CELLS);
  const freeTraps = unplacedTrapRefs(m, f);
  const unposted = unpostedUnitRefs(m, f);
  const trapCell = inwardFromGap(edge, 1);
  const postCell = inwardFromGap(edge, 2);
  const firstUnposted = unposted[0];
  const nextPost = firstUnposted ? cellFor(m, f, firstUnposted, postCell, [trapCell]) : null;
  const firstTrap = freeTraps[0];
  const nextTrap = traps.length === 0 && firstTrap ? cellFor(m, f, firstTrap, trapCell, f.posts.map((p) => p.cell)) : null;
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
export function applyMainFence(m: Manifest, f: Formation, scout: GuideScoutLike): Formation {
  const edge = mainEdge(scout);
  const gap = gapSegment(edge);
  let out = f;
  for (const s of sideSegments(edge)) {
    if (s === gap || fenceAtSegment(out, s) !== null) continue;
    const ref = unplacedFenceRefs(m, out)[0];
    if (!ref) break;
    if (guideDropOk(m, out, ref, ringSegment(s).cell)) out = withFence(out, ref, s);
  }
  return out;
}

/** Take whatever fence stands on the gap back into the wagon. */
export function applyOpenGap(f: Formation, scout: GuideScoutLike): Formation {
  const ref = fenceAtSegment(f, gapSegment(mainEdge(scout)));
  return ref ? without(f, ref) : f;
}

/** Post every living, unposted unit as near the spot behind the gap as circle allows, keeping the trap's cell free. */
export function applyPosts(m: Manifest, f: Formation, scout: GuideScoutLike): Formation {
  const edge = mainEdge(scout);
  const target = inwardFromGap(edge, 2);
  const keep = inwardFromGap(edge, 1);
  let out = f;
  for (const u of m.units.filter(isUnitAlive)) {
    if (out.posts.some((p) => p.ref === u.ref)) continue;
    const cell = nearestLegalCell(m, out, u.ref, target, [keep]);
    if (cell) out = withPost(out, u.ref, cell);
  }
  return out;
}

/** Lay the first unplaced, unspent trap just inside the gap. */
export function applyTrap(m: Manifest, f: Formation, scout: GuideScoutLike): Formation {
  const t = unplacedTrapRefs(m, f)[0];
  if (!t) return f;
  const cell = nearestLegalCell(m, f, t, inwardFromGap(mainEdge(scout), 1), f.posts.map((p) => p.cell));
  return cell ? withTrap(f, t, cell) : f;
}

/** The remaining segments on the other sides, most raiders first, each side in ring order; the gap stays open. */
export function applyRestOfFence(m: Manifest, f: Formation, scout: GuideScoutLike): Formation {
  const edge = mainEdge(scout);
  const gap = gapSegment(edge);
  const order = [edge, ...raidersByEdge(scout).map((e) => e.edge).filter((e) => e !== edge)];
  let out = f;
  for (const e of order) {
    for (const s of sideSegments(e)) {
      if (s === gap || fenceAtSegment(out, s) !== null) continue;
      const ref = unplacedFenceRefs(m, out)[0];
      if (!ref) return out;
      if (guideDropOk(m, out, ref, ringSegment(s).cell)) out = withFence(out, ref, s);
    }
  }
  return out;
}

/**
 * The whole guided layout, every step in the checklist's order (fence the main side leaving the
 * gap, post, trap, the rest of the fence), from `from` (default: the empty ground). This is what
 * tapping each "do it for me" button in turn produces, and what the balance harness models.
 */
export function guidedFormation(m: Manifest, scout: GuideScoutLike, from: Formation = EMPTY_FORMATION): Formation {
  let f = applyMainFence(m, from, scout);
  f = applyOpenGap(f, scout);
  f = applyPosts(m, f, scout);
  f = applyTrap(m, f, scout);
  return applyRestOfFence(m, f, scout);
}
