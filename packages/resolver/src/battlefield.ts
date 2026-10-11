/**
 * The battlefield geometry and the resolver's input view of the wagon circle (chunk 10,
 * moved here from @caravan/circle under the orchestrator's decision "the resolver owns the
 * battlefield input type, the lattice constants and the single lattice→continuous
 * conversion"; @caravan/circle re-exports everything in this file).
 *
 * TWO SPACES, kept distinct on purpose (GUARDRAILS "The simulation model"):
 *   - The LATTICE: integer cells. Everything placed snaps to it — fence segments, traps,
 *     unit posts, attacker entry positions — and the coarse pathfinder routes on it. It
 *     NEVER constrains movement during a battle and is shown in the UI only while
 *     something is being placed.
 *   - The SIMULATION SPACE: continuous, fixed-point (`Fixed`, 1/FIXED_POINT_SCALE cell).
 *     Units move freely in it. A placed cell becomes a continuous tick-zero position
 *     through `cellCenter` — defined here, once.
 *
 * THE PLAYFIELD IS FLAT. There is no elevation, terrain, cover or scenery anywhere in this
 * model; a cell is an (x, y) pair and nothing else, and `assertBattlefield` refuses any
 * extra key by name. Nothing here is account-level: no account id, Coin, purchase or
 * entitlement state can reach the resolver through this structure (GUARDRAILS §2).
 *
 * The lattice constants are literals here, not tunables: the geometry is part of what a
 * stored replay means, so it changes only with RESOLVER_VERSION. @caravan/content keeps
 * the same numbers in its registry for the UI and the circle model; @caravan/circle asserts
 * at import time that the two agree.
 *
 * Everything here is integer arithmetic. The one distance metric is Euclidean, compared
 * as squared distance — never `sqrt`.
 */
import { FIXED_POINT_SCALE, HALF_CELL, type Fixed, type Millis } from "./fixed.js";

export { FIXED_POINT_SCALE, HALF_CELL };
export type { Fixed, Millis };

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

// ─────────────────────────────────────────────────────────────────────────────────────
// Lattice constants. Fixed with the resolver version (see header).
// ─────────────────────────────────────────────────────────────────────────────────────

export const GRID_WIDTH = 32;
export const GRID_HEIGHT = 32;
/** The caravan core is a CORE_SIZE × CORE_SIZE block at the lattice centre, not player-placed. */
export const CORE_SIZE = 3;
/** Chebyshev radius of the fence ring around the core centre, in cells. */
export const PERIMETER_RING_RADIUS = 4;
/**
 * Segments forming the buyable ring: the 8 × radius cells of the ring square MINUS its four
 * corners, which are permanent wagon anchors (chunk 07 QA decision). Each segment is
 * independently placed or left as a gap.
 */
export const PERIMETER_SEGMENTS = 28;
/** The four ring corners: always-blocked wagon anchors, never fence segments, never breakable. */
export const RING_ANCHOR_COUNT = 4;
/** Attackers start in the outermost ENTRY_BAND_DEPTH cells of their chosen edge. */
export const ENTRY_BAND_DEPTH = 2;

/** Width and height of the field in fixed-point units. A position is in [0, FIELD_WIDTH). */
export const FIELD_WIDTH: Fixed = (GRID_WIDTH * FIXED_POINT_SCALE) as Fixed;
export const FIELD_HEIGHT: Fixed = (GRID_HEIGHT * FIXED_POINT_SCALE) as Fixed;

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

/** Stable total order on cells: lower row first, then lower column (PATH_TIE_BREAK). */
export function compareCells(a: Cell, b: Cell): number {
  return a.y - b.y || a.x - b.x;
}

/** A cell's unique integer key, for indexing and ordering. */
export function cellKey(cell: Cell): number {
  return cell.y * GRID_WIDTH + cell.x;
}

/** Inverse of cellKey. */
export function cellFromKey(key: number): Cell {
  return { x: key % GRID_WIDTH, y: Math.floor(key / GRID_WIDTH) };
}

/**
 * LATTICE → CONTINUOUS, defined once. A placed cell's tick-zero position is its centre:
 * coordinate × scale + half a cell.
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
 * units. Max on the field ≈ 2 × (32 × 1024)² ≈ 2.1 × 10⁹ — a safe integer. Compare against
 * a squared radius (`fixedSq(r)`); never take a root.
 */
export function distSq(a: FixedPoint, b: FixedPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Squared Euclidean distance between two cells, in cells². */
export function cellDistSq(a: Cell, b: Cell): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The caravan core — the objective. Fixed at the lattice centre in MVP.
// ─────────────────────────────────────────────────────────────────────────────────────

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

export function isCoreCell(cell: Cell): boolean {
  return cell.x >= CORE_ORIGIN.x && cell.x < CORE_ORIGIN.x + CORE_SIZE && cell.y >= CORE_ORIGIN.y && cell.y < CORE_ORIGIN.y + CORE_SIZE;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// The fence ring: PERIMETER_SEGMENTS positions around the core, each independently
// occupied by a fence segment or left as a gap. A gap is a legitimate choice, never an
// error — the material budget (in @caravan/content, below PERIMETER_SEGMENTS) forces them.
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

/**
 * The ring square is the set of cells at Chebyshev distance PERIMETER_RING_RADIUS from the
 * core centre. Its four CORNERS are the wagon anchors (RING_ANCHORS): permanently blocked,
 * never placed, never breakable. The remaining cells are the segments, walked clockwise
 * from the cell right of the north-west corner: north side left→right, east side
 * top→bottom, south side right→left, west side bottom→top. Each side contributes
 * 2 × radius − 1 cells, so the ring has 8 × radius − 4 segments.
 */
export const RING_ANCHORS: readonly Cell[] = (() => {
  const r = PERIMETER_RING_RADIUS;
  const c = CORE_CENTER_CELL;
  return [
    { x: c.x - r, y: c.y - r }, // north-west
    { x: c.x + r, y: c.y - r }, // north-east
    { x: c.x + r, y: c.y + r }, // south-east
    { x: c.x - r, y: c.y + r }, // south-west
  ];
})();

export const RING_SEGMENTS: readonly RingSegment[] = (() => {
  const r = PERIMETER_RING_RADIUS;
  const c = CORE_CENTER_CELL;
  const left = c.x - r;
  const right = c.x + r;
  const topRow = c.y - r;
  const bottom = c.y + r;
  const out: RingSegment[] = [];
  const push = (cell: Cell, edge: EntryEdge) => out.push({ index: out.length, cell, edge });
  for (let x = left + 1; x < right; x++) push({ x, y: topRow }, "north");
  for (let y = topRow + 1; y < bottom; y++) push({ x: right, y }, "east");
  for (let x = right - 1; x > left; x--) push({ x, y: bottom }, "south");
  for (let y = bottom - 1; y > topRow; y--) push({ x: left, y }, "west");
  return out;
})();

export function isAnchorCell(cell: Cell): boolean {
  return RING_ANCHORS.some((a) => a.x === cell.x && a.y === cell.y);
}

/** Ring index by cell key, −1 off the ring. Plain typed array: no Map (lint rule). */
const RING_INDEX_BY_KEY: Int32Array = (() => {
  const table = new Int32Array(GRID_WIDTH * GRID_HEIGHT).fill(-1);
  for (const s of RING_SEGMENTS) table[cellKey(s.cell)] = s.index;
  return table;
})();

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
  if (!isInBounds(cell)) return null;
  const i = RING_INDEX_BY_KEY[cellKey(cell)] ?? -1;
  return i < 0 ? null : i;
}

export function isRingCell(cell: Cell): boolean {
  return ringIndexAt(cell) !== null;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Entry edges. Attackers may approach from any side or split across several; the circle
// has no safe rear. Each edge's entry band is its outermost ENTRY_BAND_DEPTH cells.
// ─────────────────────────────────────────────────────────────────────────────────────

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
// Reachability on the lattice graph (4-connected). A VALIDATION helper — "the core is
// reachable in principle from every edge" — not the resolver's pathfinder (path.ts), which
// also breaks through. Deterministic: explicit queue order, neighbours in a fixed order.
// ─────────────────────────────────────────────────────────────────────────────────────

export function isCoreReachableFrom(start: Cell, isBlocked: (key: number) => boolean): boolean {
  if (!isInBounds(start) || isBlocked(cellKey(start))) return false;
  const seen = new Uint8Array(GRID_WIDTH * GRID_HEIGHT);
  seen[cellKey(start)] = 1;
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
      if (seen[k] === 1 || isBlocked(k)) continue;
      seen[k] = 1;
      queue.push(n);
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Content-shaped data the resolver receives as plain input. These mirror the shapes in
// @caravan/content structurally (same field names, same brands) so content values are
// assignable without the resolver importing anything. A circle test pins them equal.
// ─────────────────────────────────────────────────────────────────────────────────────

export const AFFINITY_CATEGORIES = ["grit", "powder", "beast"] as const;
export type AffinityCategory = (typeof AFFINITY_CATEGORIES)[number];
export const FENCE_CATEGORIES = ["timber", "wire", "stone"] as const;
export type FenceCategory = (typeof FENCE_CATEGORIES)[number];
export const TRAP_CATEGORIES = ["groundwork", "powder"] as const;
export type TrapCategory = (typeof TRAP_CATEGORIES)[number];

export type TrapEffect =
  | { readonly kind: "slow"; readonly magnitude: Fixed; readonly duration: Millis }
  | { readonly kind: "root"; readonly duration: Millis };

export const ABILITY_ARCHETYPES = ["burst_radius", "heavy_strike", "heal_radius", "self_buff", "dash", "structure_breaker"] as const;
export type AbilityArchetype = (typeof ABILITY_ARCHETYPES)[number];

interface AbilityBase {
  readonly displayName: string;
  readonly description: string;
  readonly cooldown: Millis;
}
export interface BurstRadiusAbility extends AbilityBase {
  readonly archetype: "burst_radius";
  readonly radius: Fixed;
  readonly damageMult: Fixed;
}
export interface HeavyStrikeAbility extends AbilityBase {
  readonly archetype: "heavy_strike";
  readonly damageMult: Fixed;
}
export interface HealRadiusAbility extends AbilityBase {
  readonly archetype: "heal_radius";
  readonly radius: Fixed;
  readonly healFraction: Fixed;
  readonly charges: number;
}
export interface SelfBuffAbility extends AbilityBase {
  readonly archetype: "self_buff";
  readonly damageBonus: Fixed;
  readonly duration: Millis;
}
export interface DashAbility extends AbilityBase {
  readonly archetype: "dash";
  readonly distance: Fixed;
}
export interface StructureBreakerAbility extends AbilityBase {
  readonly archetype: "structure_breaker";
  readonly fenceDamageMult: Fixed;
}
export type Ability = BurstRadiusAbility | HeavyStrikeAbility | HealRadiusAbility | SelfBuffAbility | DashAbility | StructureBreakerAbility;

// ─────────────────────────────────────────────────────────────────────────────────────
// The battlefield: the wagon circle as the resolver sees it. Built by @caravan/circle's
// toBattlefield from a committed formation and its manifest; consumed here.
// ─────────────────────────────────────────────────────────────────────────────────────

export interface BattlefieldFence {
  readonly ref: string;
  readonly segment: number;
  readonly cell: Cell;
  readonly pos: FixedPoint;
  readonly tierId: string;
  readonly category: FenceCategory;
  readonly hp: number;
  readonly maxHp: number;
}

export interface BattlefieldTrap {
  readonly ref: string;
  readonly cell: Cell;
  readonly pos: FixedPoint;
  readonly typeId: string;
  readonly category: TrapCategory;
  readonly affinity: AffinityCategory;
  readonly damage: number;
  readonly effect: TrapEffect | null;
}

/** A posted unit's defensive stance (formation v2; behaviour is chunk 11). Default `guard`. */
export const POST_STANCES = ["guard", "hold", "reserve"] as const;
export type PostStance = (typeof POST_STANCES)[number];

export interface BattlefieldPost {
  readonly ref: string;
  readonly typeId: string;
  readonly mergeLevel: number;
  /** Carried through for chunk 11; chunk 10 reads it nowhere. */
  readonly stance: PostStance;
  /** The post: fixed origin of the leash. */
  readonly cell: Cell;
  /** Tick-zero position. The unit moves freely from here during the fight. */
  readonly pos: FixedPoint;
  readonly hp: number;
  readonly maxHp: number;
  readonly affinity: AffinityCategory;
  /** The DEFENSE rating, scaled by merge level — posted units never use offense. */
  readonly defense: number;
  readonly moveSpeed: Fixed;
  readonly attackRange: Fixed;
  readonly attackCooldown: Millis;
  readonly aggroRadius: Fixed;
  readonly leashDistance: Fixed;
  readonly ability: Ability;
}

export interface BattlefieldEntry {
  readonly edge: EntryEdge;
  /** The band of cells an attacking party may start in on this edge. */
  readonly cells: readonly Cell[];
}

export interface Battlefield {
  readonly v: 1;
  readonly grid: { readonly width: number; readonly height: number };
  readonly core: { readonly cells: readonly Cell[]; readonly center: FixedPoint };
  /** Permanently impassable cells: the four wagon anchors at the ring corners. Never breakable. */
  readonly anchors: readonly Cell[];
  /** All four edges, always. A party may be split across any of them. */
  readonly entries: readonly BattlefieldEntry[];
  readonly fences: readonly BattlefieldFence[];
  readonly traps: readonly BattlefieldTrap[];
  readonly posts: readonly BattlefieldPost[];
}

export const BATTLEFIELD_VERSION = 1 as const;

// ─────────────────────────────────────────────────────────────────────────────────────
// Runtime shape guard. The type system keeps extra fields out of code; this keeps them
// out of data (a battlefield that came through JSON). Every object level has an explicit
// allowed-key set; anything else — `elevation`, `terrain`, `scenery`, `cover`, `height`,
// `accountId`, whatever — is refused by name.
// ─────────────────────────────────────────────────────────────────────────────────────

export const BATTLEFIELD_KEYS = {
  battlefield: ["v", "grid", "core", "anchors", "entries", "fences", "traps", "posts"],
  grid: ["width", "height"],
  core: ["cells", "center"],
  point: ["x", "y"],
  entry: ["edge", "cells"],
  fence: ["ref", "segment", "cell", "pos", "tierId", "category", "hp", "maxHp"],
  trap: ["ref", "cell", "pos", "typeId", "category", "affinity", "damage", "effect"],
  post: ["ref", "typeId", "mergeLevel", "stance", "cell", "pos", "hp", "maxHp", "affinity", "defense", "moveSpeed", "attackRange", "attackCooldown", "aggroRadius", "leashDistance", "ability"],
} as const;

export class BattlefieldShapeError extends Error {
  constructor(message: string) {
    super(`battlefield shape refused: ${message}`);
    this.name = "BattlefieldShapeError";
  }
}

/** Exactly the allowed keys, all present. Key order is irrelevant here (membership only). */
export function onlyKeys(v: unknown, where: string, allowed: readonly string[], fail: (m: string) => never): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(`${where} must be an object`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${where} carries unknown key '${k}'`);
  for (const k of allowed) if (!(k in o)) fail(`${where} is missing '${k}'`);
  return o;
}

export function eachOf(v: unknown, where: string, fail: (m: string) => never): unknown[] {
  if (!Array.isArray(v)) fail(`${where} must be an array`);
  return v as unknown[];
}

export function assertPoint(v: unknown, where: string, fail: (m: string) => never): void {
  const o = onlyKeys(v, where, BATTLEFIELD_KEYS.point, fail);
  for (const k of BATTLEFIELD_KEYS.point) if (!Number.isSafeInteger(o[k])) fail(`${where}.${k} must be an integer`);
}

export function assertCell(v: unknown, where: string, fail: (m: string) => never): void {
  onlyKeys(v, where, BATTLEFIELD_KEYS.point, fail);
  if (!isCell(v)) fail(`${where} is not a lattice cell`);
}

/** Every number anywhere in the value is a safe integer. */
export function assertIntegersOnly(v: unknown, where: string, fail: (m: string) => never): void {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) fail(`${where} is not an integer (${String(v)})`);
  } else if (Array.isArray(v)) v.forEach((x, i) => assertIntegersOnly(x, `${where}[${i}]`, fail));
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) assertIntegersOnly(x, `${where}.${k}`, fail);
}

const shapeFail = (m: string): never => {
  throw new BattlefieldShapeError(m);
};

/** Throws unless `v` is exactly a Battlefield: closed keys at every level, integers only. */
export function assertBattlefield(v: unknown): asserts v is Battlefield {
  const fail = shapeFail;
  const b = onlyKeys(v, "battlefield", BATTLEFIELD_KEYS.battlefield, fail);
  if (b.v !== BATTLEFIELD_VERSION) fail(`version ${String(b.v)}`);
  onlyKeys(b.grid, "grid", BATTLEFIELD_KEYS.grid, fail);
  const core = onlyKeys(b.core, "core", BATTLEFIELD_KEYS.core, fail);
  eachOf(core.cells, "core.cells", fail).forEach((c, i) => assertCell(c, `core.cells[${i}]`, fail));
  assertPoint(core.center, "core.center", fail);
  eachOf(b.anchors, "anchors", fail).forEach((c, i) => assertCell(c, `anchors[${i}]`, fail));
  eachOf(b.entries, "entries", fail).forEach((e, i) => {
    const o = onlyKeys(e, `entries[${i}]`, BATTLEFIELD_KEYS.entry, fail);
    eachOf(o.cells, `entries[${i}].cells`, fail).forEach((c, j) => assertCell(c, `entries[${i}].cells[${j}]`, fail));
  });
  eachOf(b.fences, "fences", fail).forEach((f, i) => {
    const o = onlyKeys(f, `fences[${i}]`, BATTLEFIELD_KEYS.fence, fail);
    assertCell(o.cell, `fences[${i}].cell`, fail);
    assertPoint(o.pos, `fences[${i}].pos`, fail);
  });
  eachOf(b.traps, "traps", fail).forEach((t, i) => {
    const o = onlyKeys(t, `traps[${i}]`, BATTLEFIELD_KEYS.trap, fail);
    assertCell(o.cell, `traps[${i}].cell`, fail);
    assertPoint(o.pos, `traps[${i}].pos`, fail);
  });
  eachOf(b.posts, "posts", fail).forEach((p, i) => {
    const o = onlyKeys(p, `posts[${i}]`, BATTLEFIELD_KEYS.post, fail);
    if (typeof o.stance !== "string" || !(POST_STANCES as readonly string[]).includes(o.stance)) fail(`posts[${i}].stance must be one of ${POST_STANCES.join(", ")}`);
    assertCell(o.cell, `posts[${i}].cell`, fail);
    assertPoint(o.pos, `posts[${i}].pos`, fail);
  });
  assertIntegersOnly(v, "battlefield", fail);
}
