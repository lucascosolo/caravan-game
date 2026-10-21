/**
 * The placement lattice (chunk 07; GUARDRAILS "The simulation model").
 *
 * OWNED BY THE RESOLVER since chunk 10 (orchestrator decision "who owns the battlefield
 * geometry"): the lattice constants, the `Cell` / `FixedPoint` types, the one
 * lattice→continuous conversion (`cellCenter`), the core, the round wagon circle with its
 * wagon cells (chunk 50), the entry bands and the reachability helper all live in
 * `@caravan/resolver`'s battlefield.ts and are RE-EXPORTED here unchanged, so every
 * consumer of @caravan/circle keeps the same names. A stored replay depends on this
 * geometry, which is why the resolver (versioned by RESOLVER_VERSION) is its home.
 *
 * What stays here: the Set-based `isCoreReachableFrom` signature chunk 07's tests and
 * validation use (with `neighbours4`, the 4-connected step set — chunk 07 QA D2), the
 * registry mirrors `RING_ANCHOR_CELLS` / `PATH_CONNECTIVITY`, `isRingOrAnchorCell` (the
 * whole ring nothing may be placed on), and the import-time assertion that
 * @caravan/content's registry mirror of the geometry (GRID_WIDTH, PERIMETER_SEGMENTS, …)
 * agrees with the resolver's — an edit in one place without the other fails loudly before
 * anything is built on it.
 */
import { TUNABLES } from "@caravan/content";
import {
  CORE_CELLS,
  CORE_SIZE,
  ENTRY_BAND_DEPTH,
  GRID_HEIGHT,
  GRID_WIDTH,
  MIN_ATTACK_COOLDOWN_MS,
  PATH_CONNECTIVITY as RESOLVER_PATH_CONNECTIVITY,
  PERIMETER_SEGMENTS,
  RING_ANCHORS,
  RING_ANCHOR_COUNT,
  RING_ORDER,
  RING_SEGMENTS,
  WAGON_RING_INDICES,
  isInsideRing,
  cellKey,
  isAnchorCell,
  isAnyEntryCell,
  isCoreCell,
  isCoreReachableFrom as resolverIsCoreReachableFrom,
  isInBounds,
  isRingCell,
  type Cell,
} from "@caravan/resolver";

export {
  CORE_CELLS,
  CORE_CENTER,
  CORE_CENTER_CELL,
  CORE_ORIGIN,
  CORE_SIZE,
  ENTRY_BAND_DEPTH,
  ENTRY_EDGES,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  GRID_HEIGHT,
  GRID_WIDTH,
  HALF_CELL,
  INTERIOR_POST_CELLS,
  PERIMETER_SEGMENTS,
  RING_ANCHORS,
  RING_ANCHOR_COUNT,
  RING_ORDER,
  RING_SEGMENTS,
  WAGON_RING_INDICES,
  isInsideRing,
  cellCenter,
  cellDistSq,
  cellFromKey,
  cellKey,
  cellOf,
  compareCells,
  distSq,
  entryBand,
  fixedSq,
  isAnchorCell,
  isAnyEntryCell,
  isCell,
  isCoreCell,
  isEntryCell,
  isEntryEdge,
  isInBounds,
  isRingCell,
  isRingSegmentIndex,
  ringIndexAt,
  ringSegment,
  sameCell,
  type Cell,
  type EntryEdge,
  type FixedPoint,
  type RingSegment,
} from "@caravan/resolver";

/**
 * Registry mirror of the wagon-cell count (chunk 50): six two-cell wagons, and the resolver's
 * RING_ANCHOR_COUNT / RING_ANCHORS.length must agree (asserted below).
 */
export const RING_ANCHOR_CELLS: number = TUNABLES.RING_ANCHOR_CELLS;

/** Which way a wagon's length runs on screen (its two cells in clockwise ring order): drawing only, never resolver input. */
export type WagonFacing = "ne" | "se" | "sw" | "nw";

export interface Wagon {
  readonly cells: readonly [Cell, Cell];
  readonly facing: WagonFacing;
}

/** Facing of each wagon, from the fixture: +x → se, −x → nw, +y → sw, −y → ne. A circle test checks it against round-ring.json. */
const FACING_BY_STEP: Readonly<Record<string, WagonFacing>> = { "1,0": "se", "-1,0": "nw", "0,1": "sw", "0,-1": "ne" };

/** The six wagons of the round wagon circle (chunk 50), in ring order, for the renderer. */
export const WAGONS: readonly Wagon[] = WAGON_RING_INDICES.map(([a, b]) => {
  const p = RING_ORDER[a]!;
  const q = RING_ORDER[b]!;
  return { cells: [p, q] as const, facing: FACING_BY_STEP[`${q.x - p.x},${q.y - p.y}`]! };
});

/** The whole ring: fence positions plus the wagon cells. Nothing else may be placed here. */
export function isRingOrAnchorCell(cell: Cell): boolean {
  return isRingCell(cell) || isAnchorCell(cell);
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Reachability on the lattice graph. PATH_CONNECTIVITY = 4 (QA D2, shared with chunk 10's
// pathfinder): orthogonal steps only, so two diagonally touching blocked cells seal the
// corner between them. The wagon cells are ALWAYS blocked, whatever the caller passes.
// This is a VALIDATION helper — "the core is reachable in principle from every edge" — not
// the resolver's pathfinder (which also breaks through fences). Deterministic: explicit
// queue order, neighbours in a fixed order.
// ─────────────────────────────────────────────────────────────────────────────────────

export const PATH_CONNECTIVITY: number = TUNABLES.PATH_CONNECTIVITY;

/** Orthogonal neighbours in a fixed order (north, west, east, south): the 4-connected step set. */
export function neighbours4(cell: Cell): readonly Cell[] {
  return [
    { x: cell.x, y: cell.y - 1 },
    { x: cell.x - 1, y: cell.y },
    { x: cell.x + 1, y: cell.y },
    { x: cell.x, y: cell.y + 1 },
  ];
}

const ANCHOR_KEYS: ReadonlySet<number> = new Set(RING_ANCHORS.map(cellKey));

/** The chunk 07 signature over the resolver's walk (same neighbour order as `neighbours4`). */
export function isCoreReachableFrom(start: Cell, blocked: ReadonlySet<number>): boolean {
  return resolverIsCoreReachableFrom(start, (k) => blocked.has(k) || ANCHOR_KEYS.has(k));
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Configuration sanity. These are not balance checks; they catch a tunables edit that
// would make the registry disagree with the resolver's geometry, at import time.
// ─────────────────────────────────────────────────────────────────────────────────────

(function assertLatticeCoherent(): void {
  const fail = (why: string): never => {
    throw new Error(`@caravan/circle lattice configuration is incoherent: ${why}`);
  };
  const mirror: readonly [string, number, number][] = [
    ["GRID_WIDTH", TUNABLES.GRID_WIDTH, GRID_WIDTH],
    ["GRID_HEIGHT", TUNABLES.GRID_HEIGHT, GRID_HEIGHT],
    ["CORE_SIZE", TUNABLES.CORE_SIZE, CORE_SIZE],
    ["PERIMETER_SEGMENTS", TUNABLES.PERIMETER_SEGMENTS, PERIMETER_SEGMENTS],
    ["RING_ANCHOR_CELLS", TUNABLES.RING_ANCHOR_CELLS, RING_ANCHOR_COUNT],
    ["ENTRY_BAND_DEPTH", TUNABLES.ENTRY_BAND_DEPTH, ENTRY_BAND_DEPTH],
    ["PATH_CONNECTIVITY", TUNABLES.PATH_CONNECTIVITY, RESOLVER_PATH_CONNECTIVITY],
    // QA-13 N4: the resolver refuses an attack cooldown below content's minimum (the log-size budget).
    ["ATTACK_COOLDOWN_MIN", TUNABLES.ATTACK_COOLDOWN_MIN, MIN_ATTACK_COOLDOWN_MS],
  ];
  for (const [name, registry, resolver] of mirror) {
    if (registry !== resolver) fail(`TUNABLES.${name} is ${registry} but the resolver's geometry has ${resolver}`);
  }
  if (RING_ANCHOR_CELLS !== RING_ANCHORS.length) fail(`RING_ANCHOR_CELLS is ${RING_ANCHOR_CELLS} but the wagon circle has ${RING_ANCHORS.length} wagon cells`);
  if (RING_SEGMENTS.length !== PERIMETER_SEGMENTS || RING_SEGMENTS.length + RING_ANCHORS.length !== RING_ORDER.length) {
    fail(`PERIMETER_SEGMENTS is ${PERIMETER_SEGMENTS} but the ${RING_ORDER.length}-cell ring has ${RING_SEGMENTS.length} fence positions beside ${RING_ANCHORS.length} wagon cells`);
  }
  if (PATH_CONNECTIVITY !== 4) fail(`PATH_CONNECTIVITY is ${PATH_CONNECTIVITY}; only 4-connected pathing (no corner cutting) is implemented`);
  if (!(TUNABLES.FENCE_MATERIAL_BUDGET < PERIMETER_SEGMENTS)) {
    fail(`FENCE_MATERIAL_BUDGET (${TUNABLES.FENCE_MATERIAL_BUDGET}) must be below PERIMETER_SEGMENTS (${PERIMETER_SEGMENTS}) so gaps are forced`);
  }
  for (const s of RING_SEGMENTS) {
    if (!isInBounds(s.cell)) fail(`ring segment ${s.index} is out of bounds`);
    if (isCoreCell(s.cell)) fail(`ring segment ${s.index} overlaps the core`);
    if (isAnyEntryCell(s.cell)) fail(`ring segment ${s.index} lies in an entry band`);
    if (isAnchorCell(s.cell)) fail(`ring segment ${s.index} sits on an anchor`);
  }
  for (const a of RING_ANCHORS) {
    if (!isInBounds(a)) fail("an anchor is out of bounds");
    if (isCoreCell(a) || isAnyEntryCell(a)) fail("an anchor overlaps the core or an entry band");
  }
  for (const c of CORE_CELLS) {
    if (!isInBounds(c)) fail("core is out of bounds");
    if (isAnyEntryCell(c)) fail("core lies in an entry band");
  }
  if (CORE_SIZE < 1 || !CORE_CELLS.every(isInsideRing)) fail("ring must enclose the core");
})();
