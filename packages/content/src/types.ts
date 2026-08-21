/**
 * Content pool types (chunk 03's domain). Only what chunk 09 (standing raid
 * party) needs to reference is modeled here: a small seed roster, not the full
 * 8-per-region web. Fully authoring chunk 03's content is a separate task.
 */

export type RegionId = "desert" | "high_plains" | "mountain" | "badlands";
export type AffinityCategory = "grit" | "powder" | "beast";
export type FenceCategory = "timber" | "stone" | "wire";
export type TrapCategory = "snare" | "blast" | "pit";

export type Stance = "nearest" | "traps" | "core";
export const STANCES: readonly Stance[] = ["nearest", "traps", "core"];

export type ApproachEdge = "north" | "south" | "east" | "west";
export const APPROACH_EDGES: readonly ApproachEdge[] = ["north", "south", "east", "west"];

/**
 * A living unit type. Offense and defense are independently authored per
 * chunk 03 — never derived from one another. All rates/distances are
 * fixed-point integers with the scale documented per field; nothing here is a
 * float.
 */
export interface LivingUnitType {
  readonly id: string;
  readonly region: RegionId;
  readonly name: string;
  readonly affinity: AffinityCategory;
  readonly offense: number;
  readonly defense: number;
  readonly hp: number;
  /** Fixed-point, milli-cells per second. */
  readonly moveSpeedMilli: number;
  /** Fixed-point, milli-cells. */
  readonly attackRangeMilli: number;
  /** Fixed-point, milliseconds. */
  readonly attackCooldownMilli: number;
  /** Fixed-point, milli-cells. */
  readonly aggroRadiusMilli: number;
  /** Fixed-point, milli-cells. */
  readonly leashDistanceMilli: number;
  readonly abilityId: string;
}

export interface SiegeType {
  readonly id: string;
  readonly name: string;
  /** Siege is offense-only and counters *specific* categories — never a flat
   * damage buff (GUARDRAILS.md #4 / chunk 03). Both may be null for a siege
   * piece that only counters one axis. */
  readonly countersFenceCategory: FenceCategory | null;
  readonly countersTrapCategory: TrapCategory | null;
}

export interface TrapType {
  readonly id: string;
  readonly name: string;
  readonly category: TrapCategory;
  readonly damage: number;
}

export type ContentTypeKind = "living_unit" | "siege" | "trap";
