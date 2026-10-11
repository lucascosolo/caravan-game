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
 * validation use, and the import-time assertion that @caravan/content's registry mirror of
 * the geometry (GRID_WIDTH, PERIMETER_SEGMENTS, …) agrees with the resolver's — an edit in
 * one place without the other fails loudly before anything is built on it.
 */
import { TUNABLES } from "@caravan/content";
import {
  CORE_CELLS,
  CORE_SIZE,
  ENTRY_BAND_DEPTH,
  GRID_HEIGHT,
  GRID_WIDTH,
  PERIMETER_RING_RADIUS,
  PERIMETER_SEGMENTS,
  RING_ANCHORS,
  RING_SEGMENTS,
  cellKey,
  isAnyEntryCell,
  isCoreCell,
  isCoreReachableFrom as resolverIsCoreReachableFrom,
  isInBounds,
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
 * Reachability on the 4-connected lattice graph with a Set of blocked cell keys — the
 * chunk 07 signature. The ring anchors are ALWAYS blocked in addition to `blocked`.
 * A VALIDATION helper, not the resolver's pathfinder (which also breaks through fences).
 */
export function isCoreReachableFrom(start: Cell, blocked: ReadonlySet<number>): boolean {
  const anchorKeys = RING_ANCHORS.map(cellKey);
  return resolverIsCoreReachableFrom(start, (k) => blocked.has(k) || anchorKeys.includes(k));
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
    ["RING_ANCHORS", TUNABLES.RING_ANCHORS, RING_ANCHORS.length],
    ["ENTRY_BAND_DEPTH", TUNABLES.ENTRY_BAND_DEPTH, ENTRY_BAND_DEPTH],
  ];
  for (const [name, registry, resolver] of mirror) {
    if (registry !== resolver) fail(`TUNABLES.${name} is ${registry} but the resolver's geometry has ${resolver}`);
  }
  if (RING_SEGMENTS.length !== PERIMETER_SEGMENTS) {
    fail(`PERIMETER_SEGMENTS is ${PERIMETER_SEGMENTS} but a ring of radius ${PERIMETER_RING_RADIUS} has ${RING_SEGMENTS.length} segments (8 × radius − 4 anchors)`);
  }
  if (!(TUNABLES.FENCE_MATERIAL_BUDGET < PERIMETER_SEGMENTS)) {
    fail(`FENCE_MATERIAL_BUDGET (${TUNABLES.FENCE_MATERIAL_BUDGET}) must be below PERIMETER_SEGMENTS (${PERIMETER_SEGMENTS}) so gaps are forced`);
  }
  for (const s of RING_SEGMENTS) {
    if (!isInBounds(s.cell)) fail(`ring segment ${s.index} is out of bounds`);
    if (isCoreCell(s.cell)) fail(`ring segment ${s.index} overlaps the core`);
    if (isAnyEntryCell(s.cell)) fail(`ring segment ${s.index} lies in an entry band`);
  }
  for (const a of RING_ANCHORS) {
    if (!isInBounds(a) || isCoreCell(a) || isAnyEntryCell(a)) fail("an anchor is out of bounds, on the core, or in an entry band");
  }
  for (const c of CORE_CELLS) {
    if (!isInBounds(c)) fail("core is out of bounds");
    if (isAnyEntryCell(c)) fail("core lies in an entry band");
  }
  if (CORE_SIZE < 1 || PERIMETER_RING_RADIUS <= Math.trunc(CORE_SIZE / 2)) fail("ring must enclose the core");
})();
