/**
 * Lattice pathfinding and route smoothing (chunk 10, PATHING / PATH_TIE_BREAK /
 * PATH_SMOOTHING / FENCE_BLOCKS_PATHING / PATH_CONNECTIVITY).
 *
 * The LATTICE is the coarse pathing graph; movement is continuous (movement.ts). Three
 * pieces, all integer arithmetic:
 *
 *   1. `findPath` — A* on the 4-connected lattice (PATH_CONNECTIVITY = 4: no diagonal
 *      moves, so no corner cutting is possible). Step cost is one cell (STEP_COST, in
 *      fixed-point cells). An intact fence segment is impassable EXCEPT as a breach edge:
 *      stepping orthogonally INTO its cell costs STEP_COST plus the caller's breach cost —
 *      the distance the unit could have walked in the ticks it takes to destroy the
 *      segment. "Walk around" vs "break through" is therefore one cost comparison. Anchors
 *      (ring corners) and cells off the lattice are never passable.
 *
 *      PATH_TIE_BREAK: among open cells with equal f, the one with the LOWER ROW is
 *      expanded first, then the LOWER COLUMN — i.e. the lower cell key. Neighbours are
 *      relaxed in the fixed order north, west, east, south, and a neighbour's cameFrom is
 *      replaced only by a STRICTLY cheaper route. The heuristic is Manhattan distance,
 *      consistent for a 4-connected unit-cost graph, so the first expansion of the goal is
 *      optimal and the tie-break alone decides between equal-cost routes.
 *
 *   2. `losClear` — conservative integer line of sight between two continuous points: the
 *      set of cells the segment passes through is enumerated exactly (a supercover walk
 *      comparing boundary-crossing times as cross-multiplied fractions, never divided),
 *      and a segment that passes exactly through a cell corner is treated as touching all
 *      three cells beyond the corner. No cell touched may be blocked.
 *
 *   3. `smoothPath` — string pulling: from the unit's actual position, the lattice route
 *      is walked forward and each waypoint is the last cell centre still in line of sight
 *      before the first cell that is not (deterministic, O(n) LOS tests). Breach cells are
 *      HARD waypoints: smoothing never skips the cell adjacent to the segment, never crosses
 *      the segment, and restarts after it.
 */
import { COST_INFINITE, FIXED_POINT_SCALE } from "./fixed.js";
import { GRID_HEIGHT, GRID_WIDTH, cellCenter, cellKey, type Cell, type Fixed, type FixedPoint } from "./battlefield.js";

/** Cost of one orthogonal lattice step, in fixed-point cells (1.0). */
export const STEP_COST = FIXED_POINT_SCALE;

/** Grid cell content for pathing. */
export const CELL_FREE = -1;
/** Permanently impassable (a wagon anchor). */
export const CELL_ANCHOR = -2;
/** Any value ≥ 0 is the index of the intact fence segment occupying the cell. */

/** One entry per cell (by cellKey): CELL_FREE, CELL_ANCHOR, or an intact fence index. */
export type PathGrid = Int32Array;

export function emptyGrid(): PathGrid {
  return new Int32Array(GRID_WIDTH * GRID_HEIGHT).fill(CELL_FREE);
}

export interface PathStep {
  readonly cell: Cell;
  /** The fence index this step breaks through, or −1 for a free cell. */
  readonly breach: number;
}

const NEIGHBOUR_DX = [0, -1, 1, 0]; // north, west, east, south
const NEIGHBOUR_DY = [-1, 0, 0, 1];

/**
 * A* from `start` to `goal`. Returns the steps AFTER `start` up to and including `goal`
 * (empty when start === goal), or null when no route exists even by breaching (only
 * possible when the goal is an anchor, off-lattice, or sealed by anchors).
 *
 * `breachCost(fenceIndex)` is the extra cost of stepping into that intact segment's cell;
 * return COST_INFINITE for "cannot breach".
 */
export function findPath(grid: PathGrid, start: Cell, goal: Cell, breachCost: (fenceIndex: number) => number): PathStep[] | null {
  const n = GRID_WIDTH * GRID_HEIGHT;
  const startKey = cellKey(start);
  const goalKey = cellKey(goal);
  if (startKey === goalKey) return [];
  const goalContent = grid[goalKey] ?? CELL_ANCHOR;
  if (goalContent === CELL_ANCHOR) return null;

  const g = new Int32Array(n).fill(COST_INFINITE);
  const f = new Int32Array(n).fill(COST_INFINITE);
  const cameFrom = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap: number[] = []; // cell keys; ordered by (f, key)

  const less = (a: number, b: number): boolean => {
    const fa = f[a]!;
    const fb = f[b]!;
    return fa !== fb ? fa < fb : a < b;
  };
  const push = (key: number): void => {
    heap.push(key);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      const t = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = t;
      i = p;
    }
  };
  const pop = (): number => {
    const head = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!)) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!)) m = r;
        if (m === i) break;
        const t = heap[i]!;
        heap[i] = heap[m]!;
        heap[m] = t;
        i = m;
      }
    }
    return head;
  };
  const heuristic = (x: number, y: number): number => (Math.abs(x - goal.x) + Math.abs(y - goal.y)) * STEP_COST;

  g[startKey] = 0;
  f[startKey] = heuristic(start.x, start.y);
  push(startKey);

  while (heap.length > 0) {
    const cur = pop();
    if (closed[cur] === 1) continue;
    closed[cur] = 1;
    if (cur === goalKey) break;
    const cx = cur % GRID_WIDTH;
    const cy = Math.floor(cur / GRID_WIDTH);
    const gc = g[cur]!;
    for (let d = 0; d < 4; d++) {
      const nx = cx + NEIGHBOUR_DX[d]!;
      const ny = cy + NEIGHBOUR_DY[d]!;
      if (nx < 0 || ny < 0 || nx >= GRID_WIDTH || ny >= GRID_HEIGHT) continue;
      const nk = ny * GRID_WIDTH + nx;
      if (closed[nk] === 1) continue;
      const content = grid[nk]!;
      if (content === CELL_ANCHOR) continue;
      let stepCost = STEP_COST;
      if (content >= 0) {
        const extra = breachCost(content);
        if (extra >= COST_INFINITE) continue;
        stepCost += extra;
      }
      const ng = gc + stepCost;
      if (ng < g[nk]!) {
        g[nk] = ng;
        f[nk] = ng + heuristic(nx, ny);
        cameFrom[nk] = cur;
        push(nk);
      }
    }
  }

  if (closed[goalKey] !== 1) return null;
  const steps: PathStep[] = [];
  for (let k = goalKey; k !== startKey; k = cameFrom[k]!) {
    const content = grid[k]!;
    steps.push({ cell: { x: k % GRID_WIDTH, y: Math.floor(k / GRID_WIDTH) }, breach: content >= 0 ? content : -1 });
  }
  steps.reverse();
  return steps;
}

function blockedAt(grid: PathGrid, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= GRID_WIDTH || cy >= GRID_HEIGHT) return true;
  return grid[cy * GRID_WIDTH + cx]! !== CELL_FREE;
}

/**
 * Whether the straight segment a→b crosses only free cells (see header). Both endpoints
 * are continuous fixed-point positions; the walk is exact integer arithmetic.
 */
export function losClear(grid: PathGrid, a: FixedPoint, b: FixedPoint): boolean {
  const S = FIXED_POINT_SCALE;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const adx = Math.abs(dx);
  const ady = Math.abs(dy);
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
  let cx = Math.floor(a.x / S);
  let cy = Math.floor(a.y / S);
  const ex = Math.floor(b.x / S);
  const ey = Math.floor(b.y / S);
  if (blockedAt(grid, cx, cy)) return false;
  // At most one boundary crossing per cell per axis; bound the walk defensively.
  for (let guard = 0; guard < 2 * (GRID_WIDTH + GRID_HEIGHT) + 4; guard++) {
    if (cx === ex && cy === ey) return true;
    // Distance along each axis from the start to the next boundary ahead of the current cell.
    const bx = stepX > 0 ? (cx + 1) * S - a.x : stepX < 0 ? a.x - cx * S : -1;
    const by = stepY > 0 ? (cy + 1) * S - a.y : stepY < 0 ? a.y - cy * S : -1;
    // Compare crossing times bx/adx vs by/ady without dividing: cross-multiply.
    let goX: boolean;
    let goY: boolean;
    if (stepX === 0) {
      goX = false;
      goY = true;
    } else if (stepY === 0) {
      goX = true;
      goY = false;
    } else {
      const tx = bx * ady;
      const ty = by * adx;
      goX = tx <= ty;
      goY = ty <= tx;
    }
    if (goX && goY) {
      // Exactly through a corner: conservative — all three cells beyond it must be free.
      if (blockedAt(grid, cx + stepX, cy) || blockedAt(grid, cx, cy + stepY) || blockedAt(grid, cx + stepX, cy + stepY)) return false;
      cx += stepX;
      cy += stepY;
    } else if (goX) {
      cx += stepX;
      if (blockedAt(grid, cx, cy)) return false;
    } else {
      cy += stepY;
      if (blockedAt(grid, cx, cy)) return false;
    }
  }
  return false;
}

export interface Waypoint {
  readonly x: Fixed;
  readonly y: Fixed;
  /** The fence index to break through to enter this cell, or −1. */
  readonly breach: number;
}

/**
 * String-pull a lattice route into continuous waypoints (see header). `from` is the unit's
 * actual position. The result never crosses a blocked cell: every consecutive pair of
 * points has line of sight, except the pair ending at a breach waypoint, which is the
 * adjacent cell → the fence cell itself.
 */
export function smoothPath(grid: PathGrid, from: FixedPoint, steps: readonly PathStep[]): Waypoint[] {
  const out: Waypoint[] = [];
  let anchor: FixedPoint = from;
  let i = 0;
  while (i < steps.length) {
    // The free run: steps[i .. runEnd), followed by an optional breach step at runEnd.
    let runEnd = i;
    while (runEnd < steps.length && steps[runEnd]!.breach < 0) runEnd++;
    // Smooth the free run.
    while (i < runEnd) {
      let last = i; // steps[i] is adjacent to the anchor's cell, always reachable
      let j = i + 1;
      while (j < runEnd && losClear(grid, anchor, cellCenter(steps[j]!.cell))) {
        last = j;
        j++;
      }
      const c = cellCenter(steps[last]!.cell);
      out.push({ x: c.x, y: c.y, breach: -1 });
      anchor = c;
      i = last + 1;
    }
    if (runEnd < steps.length) {
      const b = steps[runEnd]!;
      const c = cellCenter(b.cell);
      out.push({ x: c.x, y: c.y, breach: b.breach });
      anchor = c;
      i = runEnd + 1;
    }
  }
  return out;
}
