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

/**
 * A posted defending unit. Radii are in cells and are what the resolver MEASURES (chunk 08
 * QA B2/N11): `aggroRadius` and `attackRange` are REACH (the type's radius + UNIT_RADIUS),
 * `leashDistance` is the post-to-unit-centre leash. Drawn as continuous circles when `showRadii`.
 */
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
  /** The party builder (chunk 17) highlights the unit being edited; the trail never sets it. */
  readonly selected?: boolean;
}

/** A siege piece shown at its party's edge (siege has no cell of its own in the model). */
export interface SiegeEntity {
  readonly id: string;
  readonly typeId: string;
  readonly edge: EntryEdgeName;
  /** Where along the edge to draw it, 0..1. */
  readonly along: number;
}

/**
 * A unit sitting on the home town's merge board (chunk 17). Completely static: it has no
 * stance, no radii, no HP and never moves on its own. `dimmed` marks a unit that cannot
 * take the current drop (wrong type or level); `target` marks the one under the ghost.
 */
export interface BoardUnitEntity {
  readonly id: string;
  readonly pos: WorldPoint;
  readonly typeId: string;
  readonly mergeLevel: number;
  readonly selected?: boolean;
  readonly dimmed?: boolean;
  readonly target?: boolean;
}

/** A town building: inert scenery drawn at a cell with a footprint (chunk 17). Never simulated. */
export interface StructureEntity {
  readonly id: string;
  readonly kind: "building" | "mine" | "corral";
  readonly cell: { readonly x: number; readonly y: number };
  /** Cells wide / deep. */
  readonly w: number;
  readonly h: number;
  readonly label: string;
}

/**
 * The mine's ambient state (chunk 17, MINE_ANIMATION): `active` drives a slow cosmetic turn
 * of the head-frame wheel; it is OFF at the storage cap. Nothing here counts anything: the
 * balance is the server's lazily-computed number, not a per-second tick.
 */
export interface MineState {
  readonly active: boolean;
}

/** What is being dragged right now. The lattice is visible iff this is non-null. */
export interface DragGhost {
  readonly kind: "fence" | "trap" | "post" | "unit" | "attacker";
  readonly typeId: string;
  /** Snapped target; null while the pointer is off the lattice. */
  readonly cell: { readonly x: number; readonly y: number } | null;
  /** Whether a drop here would be accepted (ring position free / cell placeable). */
  readonly valid: boolean;
  /** For a post: the circles to preview while dragging. */
  readonly radii?: { readonly aggroRadius: number; readonly leashDistance: number; readonly attackRange: number; readonly stance: PostEntity["stance"] };
}

/**
 * A unit in a battle REPLAY (chunk 22): wherever the stored log's interpolation puts it after
 * the tick being shown (`readReplay(log).frame(t)`, lerped between ticks by the player for
 * smoothness). Either side; the attacker carries the same dashed ring as a scouted attacker,
 * so the two sides differ by shape, not colour alone. No radii: the log does not carry them.
 * Dead units are simply not in the list.
 */
export interface ReplayUnitEntity {
  readonly id: string;
  readonly pos: WorldPoint;
  readonly typeId: string;
  readonly level: number;
  readonly side: "attacker" | "defender";
  /** 0..1, from the log's HP (rows copied, never derived). */
  readonly hpFraction: number;
  /**
   * Chunk 22 QA D1: the stance it fought with, from the job's snapshots (the server's labels):
   * a post's guard / hold / reserve, a raider's nearest / traps / core. Drawn as a small glyph
   * under the marker; absent when the server named none.
   */
  readonly stance?: "guard" | "hold" | "reserve" | "nearest" | "traps" | "core";
  /** Chunk 22 QA N5: the unit whose feed line the player tapped — drawn with a bright ring. */
  readonly highlighted?: boolean;
}

/**
 * A short-lived marker over something a log row just reported (chunk 22): a hit (a line from
 * the attacker to its target), a fence hit (a dashed line to the segment), a trap springing, a
 * unit falling, a fence breaking, an ability firing, the core reached. Told apart by SHAPE
 * (line, dashed line, ring, cross, square, star, diamond) as well as colour. `age` 0 → just
 * happened, 1 → fading out. Drawn ABOVE the units (chunk 22 QA S5).
 */
export interface ReplayMarkEntity {
  readonly id: string;
  readonly pos: WorldPoint;
  readonly kind: "trap" | "death" | "fence" | "ability" | "core" | "hit" | "fence_hit";
  readonly age: number;
  /** A hit / fence hit: where the blow came from (the attacker's position at that tick, from the reader's frame). */
  readonly from?: WorldPoint;
}

export interface ThreatOverlay {
  /** Edges this party enters from (SHOW_THREAT_OVERLAY). */
  readonly entryEdges: readonly EntryEdgeName[];
  /** Ring positions left open. Informational: drawn as a soft marker, never a warning colour. */
  readonly gapCells: readonly { readonly x: number; readonly y: number }[];
}

export interface IsoSceneState {
  readonly fences: readonly FenceEntity[];
  /** Replay (C3): segments the log has broken by this tick, drawn as broken runs where they stood. Never hit-tested. */
  readonly brokenFences?: readonly FenceEntity[];
  readonly traps: readonly TrapEntity[];
  readonly posts: readonly PostEntity[];
  readonly attackers: readonly AttackerEntity[];
  readonly siege: readonly SiegeEntity[];
  readonly drag: DragGhost | null;
  readonly threat: ThreatOverlay | null;
  /** SHOW_AGGRO_LEASH_OVERLAY: continuous circles at true radii for every post. */
  readonly showRadii: boolean;
  /**
   * Chunk 08 QA D5: something is selected for tap-to-place. That counts as "being placed":
   * the lattice shows (and, for a fence, the ring targets) exactly as during a drag.
   */
  readonly placing?: "fence" | "trap" | "post" | null;
  // ── chunk 17 (home town): all optional so the circle and the replay are unchanged ──
  readonly boardUnits?: readonly BoardUnitEntity[];
  readonly structures?: readonly StructureEntity[];
  readonly mine?: MineState | null;
  /** The merge board's cells; outlined only while a unit is being dragged. */
  readonly boardCells?: readonly { readonly x: number; readonly y: number }[];
  // ── chunk 22 (battle replay): all optional so the circle and the town are unchanged ──
  readonly replayUnits?: readonly ReplayUnitEntity[];
  readonly marks?: readonly ReplayMarkEntity[];
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
  readonly kind: "fence" | "trap" | "post" | "attacker" | "unit";
  readonly id: string;
}
