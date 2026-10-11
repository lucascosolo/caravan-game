/**
 * The placement lattice (chunk 07; GUARDRAILS "The simulation model").
 *
 * TWO SPACES, kept distinct on purpose:
 *   - The LATTICE: integer cells. Everything placed snaps to it — fence segments, traps,
 *     unit posts, attacker entry positions. It is a placement grid and the coarse pathing
 *     graph; it NEVER constrains movement during a battle and is shown in the UI only while
 *     something is being placed.
 *   - The SIMULATION SPACE: continuous, fixed-point (`Fixed`, 1/FIXED_POINT_SCALE cell).
 *     Units move freely in it during resolution. A placed cell becomes a continuous
 *     tick-zero position through `cellCenter` — defined here, once, and reused by the
 *     resolver rather than reinvented (brief: SPAWN_POSITION).
 *
 * The playfield is FLAT. There is no elevation, terrain, cover or scenery anywhere in this
 * model; a cell is an (x, y) pair and nothing else. See resolverInput.ts for the test that
 * pins this.
 *
 * Everything here is integer arithmetic. The one distance metric is Euclidean, compared as
 * squared distance (brief: DISTANCE_METRIC) — never `sqrt`.
 */
import { FIXED_POINT_SCALE, TUNABLES, type Fixed } from "@caravan/content";

/** A lattice cell. Integers in [0, GRID_WIDTH) × [0, GRID_HEIGHT). Nothing else — no height. */
export interface Cell {
  readonly x: number;
  readonly y: number;
}

/** A continuous position in simulation space, fixed-point cells. */
export interface FixedPoint {
  readonly x: Fixed;
  readonly y: Fixed;
}

export const GRID_WIDTH: number = TUNABLES.GRID_WIDTH;
export const GRID_HEIGHT: number = TUNABLES.GRID_HEIGHT;

/** Half a cell in fixed point: the offset from a cell's corner to its centre. */
export const HALF_CELL: Fixed = Math.trunc(FIXED_POINT_SCALE / 2) as Fixed;

export function isInBounds(cell: Cell): boolean {
  return (
    Number.isInteger(cell.x) &&
    Number.isInteger(cell.y) &&
    cell.x >= 0 &&
    cell.y >= 0 &&
    cell.x < GRID_WIDTH &&
    cell.y < GRID_HEIGHT
  );
}

/** Structural guard for untrusted input: exactly {x, y} with in-bounds integers. */
export function isCell(value: unknown): value is Cell {
  if (value === null || typeof value !== "object") return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !("x" in value) || !("y" in value)) return false;
  const { x, y } = value as { x: unknown; y: unknown };
  return typeof x === "number" && typeof y === "number" && isInBounds({ x, y });
}

export function sameCell(a: Cell, b: Cell): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Stable total order on cells: lower row first, then lower column (chunk 10 PATH_TIE_BREAK). */
export function compareCells(a: Cell, b: Cell): number {
  return a.y - b.y || a.x - b.x;
}

/** A cell's unique integer key, for sets and ordering. */
export function cellKey(cell: Cell): number {
  return cell.y * GRID_WIDTH + cell.x;
}

/**
 * LATTICE → CONTINUOUS, defined once (brief: SPAWN_POSITION). A placed cell's tick-zero
 * position is its centre: coordinate × scale + half a cell.
 */
export function cellCenter(cell: Cell): FixedPoint {
  return {
    x: (cell.x * FIXED_POINT_SCALE + HALF_CELL) as Fixed,
    y: (cell.y * FIXED_POINT_SCALE + HALF_CELL) as Fixed,
  };
}

/** CONTINUOUS → LATTICE: the cell containing a position (floor). Inverse of cellCenter. */
export function cellOf(p: FixedPoint): Cell {
  return { x: Math.floor(p.x / FIXED_POINT_SCALE), y: Math.floor(p.y / FIXED_POINT_SCALE) };
}

/**
 * Squared Euclidean distance between two continuous positions, in (1/FIXED_POINT_SCALE)²
 * units. Max on a 32-cell grid ≈ 2 × (32 × 1024)² ≈ 2.1 × 10⁹ — a safe integer. Compare
 * against a squared radius (`fixedSq(r)`); never take a root.
 */
export function distSq(a: FixedPoint, b: FixedPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Square a fixed-point length so it can be compared with `distSq`. */
export function fixedSq(length: Fixed): number {
  return length * length;
}

/** Squared Euclidean distance between two cells, in cells². */
export function cellDistSq(a: Cell, b: Cell): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The caravan core — the objective. Fixed at the lattice centre in MVP, not player-placed.
// ─────────────────────────────────────────────────────────────────────────────────────

export const CORE_SIZE: number = TUNABLES.CORE_SIZE;
/** Top-left cell of the core block: the block is centred as well as integers allow. */
export const CORE_ORIGIN: Cell = {
  x: Math.trunc((GRID_WIDTH - CORE_SIZE) / 2),
  y: Math.trunc((GRID_HEIGHT - CORE_SIZE) / 2),
};
/** The core's cells, in compareCells order. */
export const CORE_CELLS: readonly Cell[] = (() => {
  const cells: Cell[] = [];
  for (let y = 0; y < CORE_SIZE; y++) for (let x = 0; x < CORE_SIZE; x++) cells.push({ x: CORE_ORIGIN.x + x, y: CORE_ORIGIN.y + y });
  return cells;
})();
/** The cell at the middle of the core; the ring is centred on it. */
export const CORE_CENTER_CELL: Cell = {
  x: CORE_ORIGIN.x + Math.trunc(CORE_SIZE / 2),
  y: CORE_ORIGIN.y + Math.trunc(CORE_SIZE / 2),
};
/** The core's continuous centre: what "reaching the core" is measured against. */
export const CORE_CENTER: FixedPoint = cellCenter(CORE_CENTER_CELL);

const CORE_KEYS: ReadonlySet<number> = new Set(CORE_CELLS.map(cellKey));
export function isCoreCell(cell: Cell): boolean {
  return CORE_KEYS.has(cellKey(cell));
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The fence ring: PERIMETER_SEGMENTS positions around the core, each independently
// occupied by a fence segment or left as a gap. A gap is a legitimate choice, never an
// error — the material budget (FENCE_MATERIAL_BUDGET < PERIMETER_SEGMENTS) forces them.
// ─────────────────────────────────────────────────────────────────────────────────────

export const ENTRY_EDGES = ["north", "east", "south", "west"] as const;
export type EntryEdge = (typeof ENTRY_EDGES)[number];

export function isEntryEdge(value: unknown): value is EntryEdge {
  return typeof value === "string" && (ENTRY_EDGES as readonly string[]).includes(value);
}

export interface RingSegment {
  /** 0..PERIMETER_SEGMENTS-1, clockwise from the north-west corner. */
  readonly index: number;
  readonly cell: Cell;
  /** The side of the circle this segment faces. Corners belong to the side their run starts on. */
  readonly edge: EntryEdge;
}

export const PERIMETER_RING_RADIUS: number = TUNABLES.PERIMETER_RING_RADIUS;
export const PERIMETER_SEGMENTS: number = TUNABLES.PERIMETER_SEGMENTS;

/**
 * The ring is the square of cells at Chebyshev distance PERIMETER_RING_RADIUS from the
 * core centre, walked clockwise from its north-west corner: north side left→right, east
 * side top→bottom, south side right→left, west side bottom→top. Each side contributes
 * 2 × radius cells (its starting corner included, its ending corner excluded), so the ring
 * has exactly 8 × radius segments.
 */
export const RING_SEGMENTS: readonly RingSegment[] = (() => {
  const r = PERIMETER_RING_RADIUS;
  const c = CORE_CENTER_CELL;
  const left = c.x - r;
  const right = c.x + r;
  const top = c.y - r;
  const bottom = c.y + r;
  const out: RingSegment[] = [];
  const push = (cell: Cell, edge: EntryEdge) => out.push({ index: out.length, cell, edge });
  for (let x = left; x < right; x++) push({ x, y: top }, "north");
  for (let y = top; y < bottom; y++) push({ x: right, y }, "east");
  for (let x = right; x > left; x--) push({ x, y: bottom }, "south");
  for (let y = bottom; y > top; y--) push({ x: left, y }, "west");
  return out;
})();

const RING_INDEX_BY_KEY: ReadonlyMap<number, number> = new Map(RING_SEGMENTS.map((s) => [cellKey(s.cell), s.index]));

export function isRingSegmentIndex(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < PERIMETER_SEGMENTS;
}

export function ringSegment(index: number): RingSegment {
  const seg = RING_SEGMENTS[index];
  if (!seg) throw new RangeError(`ring segment ${String(index)} is outside 0..${PERIMETER_SEGMENTS - 1}`);
  return seg;
}

/** The ring index at a cell, or null if the cell is not on the ring. */
export function ringIndexAt(cell: Cell): number | null {
  return RING_INDEX_BY_KEY.get(cellKey(cell)) ?? null;
}

export function isRingCell(cell: Cell): boolean {
  return RING_INDEX_BY_KEY.has(cellKey(cell));
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Entry edges. Attackers may approach from any side or split across several; the circle
// has no safe rear. Each edge's entry band is its outermost ENTRY_BAND_DEPTH cells.
// ─────────────────────────────────────────────────────────────────────────────────────

export const ENTRY_BAND_DEPTH: number = TUNABLES.ENTRY_BAND_DEPTH;

export function isEntryCell(cell: Cell, edge: EntryEdge): boolean {
  if (!isInBounds(cell)) return false;
  switch (edge) {
    case "north":
      return cell.y < ENTRY_BAND_DEPTH;
    case "south":
      return cell.y >= GRID_HEIGHT - ENTRY_BAND_DEPTH;
    case "west":
      return cell.x < ENTRY_BAND_DEPTH;
    case "east":
      return cell.x >= GRID_WIDTH - ENTRY_BAND_DEPTH;
  }
}

/** Every cell of an edge's entry band, in compareCells order. */
export function entryBand(edge: EntryEdge): readonly Cell[] {
  const cells: Cell[] = [];
  for (let y = 0; y < GRID_HEIGHT; y++) for (let x = 0; x < GRID_WIDTH; x++) if (isEntryCell({ x, y }, edge)) cells.push({ x, y });
  return cells;
}

/** Whether any entry band contains the cell (so nothing of the caravan's may be placed there). */
export function isAnyEntryCell(cell: Cell): boolean {
  return ENTRY_EDGES.some((e) => isEntryCell(cell, e));
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Reachability on the lattice graph (4-connected). This is a VALIDATION helper — "the core
// is reachable in principle from every edge" — not the resolver's pathfinder (chunk 10).
// Deterministic: explicit queue order, cells visited in compareCells order.
// ─────────────────────────────────────────────────────────────────────────────────────

export function isCoreReachableFrom(start: Cell, blocked: ReadonlySet<number>): boolean {
  if (!isInBounds(start) || blocked.has(cellKey(start))) return false;
  const seen = new Set<number>([cellKey(start)]);
  const queue: Cell[] = [start];
  for (let head = 0; head < queue.length; head++) {
    const cur = queue[head]!;
    if (isCoreCell(cur)) return true;
    const next: Cell[] = [
      { x: cur.x, y: cur.y - 1 },
      { x: cur.x - 1, y: cur.y },
      { x: cur.x + 1, y: cur.y },
      { x: cur.x, y: cur.y + 1 },
    ];
    for (const n of next) {
      if (!isInBounds(n)) continue;
      const k = cellKey(n);
      if (seen.has(k) || blocked.has(k)) continue;
      seen.add(k);
      queue.push(n);
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Configuration sanity. These are not balance checks; they catch a tunables edit that
// would make the lattice incoherent, at import time, before anything is built on it.
// ─────────────────────────────────────────────────────────────────────────────────────

(function assertLatticeCoherent(): void {
  const fail = (why: string): never => {
    throw new Error(`@caravan/circle lattice configuration is incoherent: ${why}`);
  };
  if (RING_SEGMENTS.length !== PERIMETER_SEGMENTS) {
    fail(`PERIMETER_SEGMENTS is ${PERIMETER_SEGMENTS} but a ring of radius ${PERIMETER_RING_RADIUS} has ${RING_SEGMENTS.length} segments (8 × radius)`);
  }
  if (!(TUNABLES.FENCE_MATERIAL_BUDGET < PERIMETER_SEGMENTS)) {
    fail(`FENCE_MATERIAL_BUDGET (${TUNABLES.FENCE_MATERIAL_BUDGET}) must be below PERIMETER_SEGMENTS (${PERIMETER_SEGMENTS}) so gaps are forced`);
  }
  for (const s of RING_SEGMENTS) {
    if (!isInBounds(s.cell)) fail(`ring segment ${s.index} is out of bounds`);
    if (isCoreCell(s.cell)) fail(`ring segment ${s.index} overlaps the core`);
    if (isAnyEntryCell(s.cell)) fail(`ring segment ${s.index} lies in an entry band`);
  }
  for (const c of CORE_CELLS) {
    if (!isInBounds(c)) fail("core is out of bounds");
    if (isAnyEntryCell(c)) fail("core lies in an entry band");
  }
  if (CORE_SIZE < 1 || PERIMETER_RING_RADIUS <= Math.trunc(CORE_SIZE / 2)) fail("ring must enclose the core");
})();
