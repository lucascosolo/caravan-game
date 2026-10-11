/**
 * What the shared isometric scene draws (chunk 08). The three places — the wagon circle
 * on the trail (chunk 08), the home town (chunk 17), the battle replay (chunk 22) — build
 * one of these from their own state and hand it to `IsoScene.update`. The scene owns no
 * game state and never decides anything; it draws what it is given.
 *
 * Positions are WORLD points (continuous cells, see projection.ts). A placed thing sits at
 * its cell's centre; a replayed unit sits wherever the log's interpolation puts it. The
 * scene does not care which.
 */
import type { WorldPoint } from "./projection.ts";

export type EntryEdgeName = "north" | "east" | "south" | "west";

/** A fence segment on a ring position. `hp`/`maxHp` draw the damage state. */
export interface FenceEntity {
  readonly id: string;
  readonly cell: { readonly x: number; readonly y: number };
  readonly tierId: string;
  readonly hp: number;
  readonly maxHp: number;
  readonly selected?: boolean;
}

export interface TrapEntity {
  readonly id: string;
  readonly pos: WorldPoint;
  readonly typeId: string;
  readonly spent?: boolean;
  readonly selected?: boolean;
}

/** A posted defending unit. Radii are in cells; drawn as continuous circles when `showRadii`. */
export interface PostEntity {
  readonly id: string;
  readonly pos: WorldPoint;
  readonly typeId: string;
  readonly mergeLevel: number;
  readonly stance: "guard" | "hold" | "reserve";
  readonly hpFraction: number;
  readonly aggroRadius: number;
  readonly leashDistance: number;
  readonly attackRange: number;
  readonly selected?: boolean;
}

/** A scouted attacker at its start position (or, in replay, wherever it is now). */
export interface AttackerEntity {
  readonly id: string;
  readonly pos: WorldPoint;
  readonly typeId: string;
  readonly mergeLevel: number;
  readonly stance: "nearest" | "traps" | "core";
  readonly hpFraction: number;
}

/** A siege piece shown at its party's edge (siege has no cell of its own in the model). */
export interface SiegeEntity {
  readonly id: string;
  readonly typeId: string;
  readonly edge: EntryEdgeName;
  /** Where along the edge to draw it, 0..1. */
  readonly along: number;
}

/** What is being dragged right now. The lattice is visible iff this is non-null. */
export interface DragGhost {
  readonly kind: "fence" | "trap" | "post";
  readonly typeId: string;
  /** Snapped target; null while the pointer is off the lattice. */
  readonly cell: { readonly x: number; readonly y: number } | null;
  /** Whether a drop here would be accepted (ring position free / cell placeable). */
  readonly valid: boolean;
  /** For a post: the circles to preview while dragging. */
  readonly radii?: { readonly aggroRadius: number; readonly leashDistance: number; readonly attackRange: number; readonly stance: PostEntity["stance"] };
}

export interface ThreatOverlay {
  /** Edges this party enters from (SHOW_THREAT_OVERLAY). */
  readonly entryEdges: readonly EntryEdgeName[];
  /** Ring positions left open. Informational: drawn as a soft marker, never a warning colour. */
  readonly gapCells: readonly { readonly x: number; readonly y: number }[];
}

export interface IsoSceneState {
  readonly fences: readonly FenceEntity[];
  readonly traps: readonly TrapEntity[];
  readonly posts: readonly PostEntity[];
  readonly attackers: readonly AttackerEntity[];
  readonly siege: readonly SiegeEntity[];
  readonly drag: DragGhost | null;
  readonly threat: ThreatOverlay | null;
  /** SHOW_AGGRO_LEASH_OVERLAY: continuous circles at true radii for every post. */
  readonly showRadii: boolean;
}

export const EMPTY_SCENE: IsoSceneState = {
  fences: [],
  traps: [],
  posts: [],
  attackers: [],
  siege: [],
  drag: null,
  threat: null,
  showRadii: true,
};

/** What a hit test returns: the nearest entity under a world point, if any. */
export interface HitResult {
  readonly kind: "fence" | "trap" | "post" | "attacker";
  readonly id: string;
}
