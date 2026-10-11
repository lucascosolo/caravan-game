/**
 * The placement lattice (chunk 07; GUARDRAILS "The simulation model").
 *
 * OWNED BY THE RESOLVER since chunk 10 (orchestrator decision "who owns the battlefield
 * geometry"): the lattice constants, the `Cell` / `FixedPoint` types, the one
 * lattice→continuous conversion (`cellCenter`), the core, the ring with its four permanent
 * anchors, the entry bands and the reachability helper all live in
 * `@caravan/resolver`'s battlefield.ts and are RE-EXPORTED here unchanged, so every
 * consumer of @caravan/circle keeps the same names. A stored replay depends on this
 * geometry, which is why the resolver (versioned by RESOLVER_VERSION) is its home.
 *
 * What stays here: the Set-based `isCoreReachableFrom` signature chunk 07's tests and
 * validation use (with `neighbours4`, the 4-connected step set — chunk 07 QA D2), the
 * registry mirrors `RING_ANCHOR_CELLS` / `PATH_CONNECTIVITY`, `isRingOrAnchorCell` (the
 * whole square nothing may be placed on), and the import-time assertion that
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
  INPUT_BOUNDS,
  PATH_CONNECTIVITY as RESOLVER_PATH_CONNECTIVITY,
  PERIMETER_RING_RADIUS,
  PERIMETER_SEGMENTS,
  RING_ANCHORS,
  RING_ANCHOR_COUNT,
  RING_SEGMENTS,
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
  PERIMETER_RING_RADIUS,
  PERIMETER_SEGMENTS,
  RING_ANCHORS,
  RING_ANCHOR_COUNT,
  RING_SEGMENTS,
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
 * Registry mirror of the anchor count (chunk 07 QA D2): a square ring has exactly four
 * corners, and the resolver's RING_ANCHOR_COUNT / RING_ANCHORS.length must agree (asserted
 * below).
 */
export const RING_ANCHOR_CELLS: number = TUNABLES.RING_ANCHOR_CELLS;

/** The whole square: fence positions plus the four anchors. Nothing else may be placed here. */
export function isRingOrAnchorCell(cell: Cell): boolean {
  return isRingCell(cell) || isAnchorCell(cell);
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Reachability on the lattice graph. PATH_CONNECTIVITY = 4 (QA D2, shared with chunk 10's
// pathfinder): orthogonal steps only, so two diagonally touching blocked cells seal the
// corner between them. The four anchors are ALWAYS blocked, whatever the caller passes.
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
    ["PERIMETER_RING_RADIUS", TUNABLES.PERIMETER_RING_RADIUS, PERIMETER_RING_RADIUS],
    ["PERIMETER_SEGMENTS", TUNABLES.PERIMETER_SEGMENTS, PERIMETER_SEGMENTS],
    ["RING_ANCHOR_CELLS", TUNABLES.RING_ANCHOR_CELLS, RING_ANCHOR_COUNT],
    ["ENTRY_BAND_DEPTH", TUNABLES.ENTRY_BAND_DEPTH, ENTRY_BAND_DEPTH],
    ["PATH_CONNECTIVITY", TUNABLES.PATH_CONNECTIVITY, RESOLVER_PATH_CONNECTIVITY],
    // QA-13 N4: the resolver refuses an attack cooldown below content's minimum (the log-size budget).
    ["ATTACK_COOLDOWN_MIN", TUNABLES.ATTACK_COOLDOWN_MIN, INPUT_BOUNDS.minAttackCooldownMs],
  ];
  for (const [name, registry, resolver] of mirror) {
    if (registry !== resolver) fail(`TUNABLES.${name} is ${registry} but the resolver's geometry has ${resolver}`);
  }
  if (RING_ANCHOR_CELLS !== RING_ANCHORS.length) fail(`RING_ANCHOR_CELLS is ${RING_ANCHOR_CELLS} but a square ring has ${RING_ANCHORS.length} corners`);
  if (RING_SEGMENTS.length !== PERIMETER_SEGMENTS) {
    fail(`PERIMETER_SEGMENTS is ${PERIMETER_SEGMENTS} but a ring of radius ${PERIMETER_RING_RADIUS} has ${RING_SEGMENTS.length} fence positions (8 × radius − ${RING_ANCHOR_CELLS} anchors)`);
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
  if (CORE_SIZE < 1 || PERIMETER_RING_RADIUS <= Math.trunc(CORE_SIZE / 2)) fail("ring must enclose the core");
})();
