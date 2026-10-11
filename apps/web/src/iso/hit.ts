/**
 * Pure hit testing over a scene state: which entity, if any, is under a world point. Kept
 * out of scene.ts so it is testable without PixiJS. Board units (town) win over posts win
 * over traps win over fences win over attackers (the things the player can move come
 * first); within a kind, the nearest wins, ties by id order so the answer is stable.
 */
import type { HitResult, IsoSceneState } from "./types.ts";
import { TILE_W, canvasToWorld, cellToWorld, worldToCanvas, type Camera, type WorldPoint } from "./projection.ts";

/** How close (in cells) a point must be to a marker's centre to count as touching it. */
export const HIT_RADIUS = 0.6;

/** Minimum touch radius in SCREEN pixels (chunk 08 QA S10): a marker is never harder to hit than a 44px target. */
export const MIN_HIT_RADIUS_PX = 22;

/** `radius` is in cells; IsoCanvas passes max(HIT_RADIUS, MIN_HIT_RADIUS_PX at the current zoom). */
export function hitTest(state: IsoSceneState, p: WorldPoint, radius: number = HIT_RADIUS): HitResult | null {
  const r2 = radius * radius;
  const nearest = <T extends { readonly id: string; readonly pos: WorldPoint }>(list: readonly T[]): T | null => {
    let best: T | null = null;
    let bestD = Infinity;
    for (const e of [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const dx = e.pos.x - p.x;
      const dy = e.pos.y - p.y;
      const d = dx * dx + dy * dy;
      if (d <= r2 && d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  };
  const unit = nearest(state.boardUnits ?? []);
  if (unit) return { kind: "unit", id: unit.id };
  const post = nearest(state.posts);
  if (post) return { kind: "post", id: post.id };
  const trap = nearest(state.traps);
  if (trap) return { kind: "trap", id: trap.id };
  const cx = Math.floor(p.x);
  const cy = Math.floor(p.y);
  const fence = [...state.fences].sort((a, b) => (a.id < b.id ? -1 : 1)).find((f) => f.cell.x === cx && f.cell.y === cy);
  if (fence) return { kind: "fence", id: fence.id };
  const attacker = nearest(state.attackers);
  if (attacker) return { kind: "attacker", id: attacker.id };
  return null;
}

/**
 * The same priorities, measured in SCREEN pixels under a camera (chunk 08 QA S10): an
 * entity is touched when its marker centre is within `radiusPx` of the pointer ON SCREEN.
 * A world-space radius is anisotropic after the 2:1 projection (half as tall as it is wide),
 * so a radius 22px across would be only 11px up and down; this one is a circle on the
 * glass. A fence is touched when the pointer is on its cell OR within `radiusPx` of it.
 */
export function hitTestScreen(state: IsoSceneState, canvas: { readonly x: number; readonly y: number }, cam: Camera, radiusPx: number): HitResult | null {
  const r2 = radiusPx * radiusPx;
  const d2 = (pos: WorldPoint): number => {
    const s = worldToCanvas(cam, pos);
    return (s.x - canvas.x) ** 2 + (s.y - canvas.y) ** 2;
  };
  const nearest = <T extends { readonly id: string }>(list: readonly T[], posOf: (e: T) => WorldPoint): T | null => {
    let best: T | null = null;
    let bestD = Infinity;
    for (const e of [...list].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const d = d2(posOf(e));
      if (d <= r2 && d < bestD) {
        best = e;
        bestD = d;
      }
    }
    return best;
  };
  const unit = nearest(state.boardUnits ?? [], (e) => e.pos);
  if (unit) return { kind: "unit", id: unit.id };
  const post = nearest(state.posts, (e) => e.pos);
  if (post) return { kind: "post", id: post.id };
  const trap = nearest(state.traps, (e) => e.pos);
  if (trap) return { kind: "trap", id: trap.id };
  const w = canvasToWorld(cam, canvas.x, canvas.y);
  const cx = Math.floor(w.x);
  const cy = Math.floor(w.y);
  const onCell = [...state.fences].sort((a, b) => (a.id < b.id ? -1 : 1)).find((f) => f.cell.x === cx && f.cell.y === cy);
  if (onCell) return { kind: "fence", id: onCell.id };
  const fence = nearest(state.fences, (f) => cellToWorld(f.cell));
  if (fence) return { kind: "fence", id: fence.id };
  const attacker = nearest(state.attackers, (e) => e.pos);
  if (attacker) return { kind: "attacker", id: attacker.id };
  return null;
}

/** The screen hit radius at a zoom: never below MIN_HIT_RADIUS_PX, never below a marker's own size. */
export function hitRadiusPx(zoom: number): number {
  return Math.max(MIN_HIT_RADIUS_PX, HIT_RADIUS * (TILE_W / 2) * zoom);
}
