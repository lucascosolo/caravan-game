/**
 * The one-tap "raise my party" rule (final play-test review round 4 D2), PURE and shared by the
 * web client (the guide's raise and the party-down banner, apps/web onboarding prefillParty) and the
 * server's `suggested` party (apps/server party/service.ts suggestParty).
 *
 * Round 4 found every raised party a north-edge `nearest` clone, so every live encounter had one
 * answer ("fence north"). The raise now varies, deterministically — a fixed function of the roster:
 *
 *   - EDGES: each caravan has two starter edges, adjacent on the compass, picked from its id
 *     (`starterEdges`): a 32-bit FNV-1a hash of the id picks the first of ENTRY_EDGES, the next one
 *     clockwise is the second. Raised units alternate between them by their place in the party
 *     (even places the first edge, odd the second), so a refill continues the alternation.
 *   - STANCE from the unit type's role (`raiseStance`), read off its one ability:
 *       dash                               -> `core`   (a runner: straight for the wagons)
 *       structure_breaker, burst_radius    -> `traps`  (it clears what is laid in the circle)
 *       anything else                      -> `nearest`
 *   - CELL: spread along the edge's outer row, as the party builder places a unit
 *     (`raiseCell`, the builder's defaultCell).
 *
 * Only units are added; a saved unit is never moved or changed, and the party is never cut.
 * Presentation of a default, not balance: the player edits any of it in the party builder.
 */
import { LIVING_UNIT_TYPES } from "@caravan/content";
import { ENTRY_EDGES, GRID_HEIGHT, GRID_WIDTH, type Cell, type EntryEdge } from "./lattice.js";
import type { PartyConfig, TargetingStance } from "./party.js";

/** A roster unit as the raise reads it. */
export interface RaiseRosterUnit {
  readonly instanceId: string;
  readonly caravanId: string;
  readonly typeId: string;
  readonly unlocked: boolean;
}

/** 32-bit FNV-1a over the string's UTF-16 code units. Integer only. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The caravan's two starter edges: adjacent on the compass, picked from its id. */
export function starterEdges(caravanId: string): readonly [EntryEdge, EntryEdge] {
  const i = fnv1a(caravanId) % ENTRY_EDGES.length;
  return [ENTRY_EDGES[i]!, ENTRY_EDGES[(i + 1) % ENTRY_EDGES.length]!];
}

/** A unit type's raised stance, from its role (its one ability's archetype). Unknown types: `nearest`. */
export function raiseStance(typeId: string): TargetingStance {
  const t = LIVING_UNIT_TYPES.find((x) => x.id === typeId);
  switch (t?.ability.archetype) {
    case "dash":
      return "core";
    case "structure_breaker":
    case "burst_radius":
      return "traps";
    default:
      return "nearest";
  }
}

/** The n-th unit's cell on `edge`'s band: spread along the band, on its outer row (the builder's default). */
export function raiseCell(edge: EntryEdge, n: number): Cell {
  const along = 2 + ((n * 3) % (GRID_WIDTH - 4));
  switch (edge) {
    case "north":
      return { x: along, y: 0 };
    case "south":
      return { x: along, y: GRID_HEIGHT - 1 };
    case "west":
      return { x: 0, y: along };
    case "east":
      return { x: GRID_WIDTH - 1, y: along };
  }
}

/**
 * BALANCE-LOG pass 8 (folds pass 7's open item): the order "Raise my party" (the guide) and the
 * server's `suggested` party take roster units in — round-robin over the roster's unit types, in
 * the order each type first appears, each type's own units in roster order. With
 * SUGGESTED_PARTY_MAX 4 a fresh roster (3 + 3 of two starter types, plus the refugee) raises 2 + 2
 * instead of 3 + 1: a Mountain raise is 2 Grizzlies and 2 Trappers, not 3 Grizzlies; a Badlands
 * raise mixes Gunslingers and Bounty Hunters. Measured with the guided layout against the 56 fresh
 * guided packs of `scripts/balance/low-bands.ts` (BALANCE-LOG pass 8). Pure and stable.
 */
export function raiseOrder<T extends { readonly typeId: string }>(roster: readonly T[]): T[] {
  const types: string[] = [];
  const byType = new Map<string, T[]>();
  for (const r of roster) {
    let list = byType.get(r.typeId);
    if (!list) {
      list = [];
      byType.set(r.typeId, list);
      types.push(r.typeId);
    }
    list.push(r);
  }
  const out: T[] = [];
  for (let k = 0; out.length < roster.length; k++) for (const t of types) {
    const u = byType.get(t)![k];
    if (u) out.push(u);
  }
  return out;
}

/**
 * The raised units: the saved ones untouched, then every unlocked roster unit not in the party yet,
 * in `raiseOrder` (round-robin over unit types, BALANCE-LOG pass 8), up to `max` (a saved party
 * already larger is never cut). Siege is the caller's.
 */
export function raiseUnits(config: PartyConfig, roster: readonly RaiseRosterUnit[], max: number): PartyConfig["units"] {
  const units = [...config.units];
  const have = new Set(units.map((u) => u.ref));
  for (const r of raiseOrder(roster)) {
    if (units.length >= max) break;
    if (!r.unlocked || have.has(r.instanceId)) continue;
    const pair = starterEdges(r.caravanId);
    const edge = pair[units.length % 2]!;
    const n = units.filter((u) => u.edge === edge).length;
    units.push({ ref: r.instanceId, stance: raiseStance(r.typeId), edge, cell: raiseCell(edge, n) });
    have.add(r.instanceId);
  }
  return units;
}
