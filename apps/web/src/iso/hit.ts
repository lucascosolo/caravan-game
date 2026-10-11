/**
 * Pure hit testing over a scene state: which entity, if any, is under a world point. Kept
 * out of scene.ts so it is testable without PixiJS. Posts win over traps win over fences
 * win over attackers (the things the player can move come first); within a kind, the
 * nearest wins, ties by id order so the answer is stable.
 */
import type { HitResult, IsoSceneState } from "./types.ts";
import type { WorldPoint } from "./projection.ts";

/** How close (in cells) a point must be to a marker's centre to count as touching it. */
export const HIT_RADIUS = 0.6;

export function hitTest(state: IsoSceneState, p: WorldPoint): HitResult | null {
  const r2 = HIT_RADIUS * HIT_RADIUS;
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
