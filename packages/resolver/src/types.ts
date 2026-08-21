/**
 * Resolver-facing types.
 *
 * This package is the pure deterministic simulation described in AGENTS.md and
 * roadmap/chunks/10-13. Those chunks (tick engine, combat, abilities, full replay
 * format) are not yet built — this file defines the narrow slice chunk 09 (the
 * standing raid party) needs to call *something* deterministic when a party is
 * served into a trip. Everything here is intentionally a stub shape, not a
 * finished resolver: `resolveEncounter` in index.ts stands in for the real
 * tick-by-tick engine until chunks 10-13 land.
 *
 * Hard rules that already apply, even to the stub (see GUARDRAILS.md #1):
 * - No floats. All rates/distances/damage are fixed-point integers.
 * - No Math.random, no Date.now, no wall-clock or I/O of any kind.
 * - No banned math (sin/cos/atan2/exp/pow/sqrt).
 * - Pure function: (input) -> output, nothing else observed or touched.
 */

export type Stance = "nearest" | "traps" | "core";
export type ApproachEdge = "north" | "south" | "east" | "west";

/** A single fixed-point lattice cell coordinate. Integers only. */
export interface LatticeCell {
  readonly x: number;
  readonly y: number;
}

/** One living unit as it will exist at the moment of resolution — a frozen copy. */
export interface ResolverUnit {
  readonly slotIndex: number;
  readonly unitInstanceId: string;
  readonly typeId: string;
  readonly mergeLevel: number;
  readonly offense: number;
  readonly defense: number;
  readonly hp: number;
  readonly stance: Stance;
  readonly edge: ApproachEdge;
  readonly startPosition: LatticeCell;
}

/** One siege item as it will exist at the moment of resolution — a frozen copy. */
export interface ResolverSiege {
  readonly slotIndex: number;
  readonly typeId: string;
  readonly countersFenceCategory: string | null;
  readonly countersTrapCategory: string | null;
  readonly edge: ApproachEdge;
  readonly startPosition: LatticeCell;
}

/**
 * The attacking side's frozen input: the standing party as it looked the instant
 * it was served. This is exactly the party's `PartySnapshot` shape (apps/server),
 * duplicated here as a plain structural type so the resolver package stays free of
 * any dependency on the server package.
 */
export interface AttackingPartyInput {
  readonly partyId: string;
  readonly snapshotVersion: number;
  readonly units: readonly ResolverUnit[];
  readonly siege: readonly ResolverSiege[];
}

/**
 * The defending side's frozen input. The real shape is chunk 07's wagon circle
 * formation; until that chunk exists this is a minimal synthetic stand-in
 * strong enough to exercise deterministic outcomes (wipe / overrun / stalemate)
 * for chunk 09's tests.
 */
export interface DefendingSideInput {
  readonly tripId: string;
  readonly totalDefense: number;
  readonly coreDistance: number;
}

export interface EncounterInput {
  readonly attackingParty: AttackingPartyInput;
  readonly defendingSide: DefendingSideInput;
}

export type EncounterOutcome = "wipe" | "overrun" | "stalemate";

/**
 * One entry in the tick log. Per chunk 13 the log records events/waypoints, not
 * per-tick state — the renderer interpolates between them and never decides
 * anything. This stub emits a small, fixed set of event kinds sufficient to prove
 * the log is deterministic and self-sufficient; the real event vocabulary is
 * chunk 13's job.
 */
export type TickEvent =
  | { readonly kind: "unit_advance"; readonly tick: number; readonly unitInstanceId: string; readonly toward: LatticeCell }
  | { readonly kind: "unit_attack"; readonly tick: number; readonly attackerUnitInstanceId: string; readonly damage: number }
  | { readonly kind: "outcome"; readonly tick: number; readonly outcome: EncounterOutcome };

export const RESOLVER_VERSION = "0.0.1-stub";

export interface EncounterResult {
  readonly resolverVersion: string;
  readonly outcome: EncounterOutcome;
  /** Fixed-point fraction, scaled by 1000 (0 = start edge, 1000 = core). */
  readonly depthFractionMilli: number;
  readonly tickLog: readonly TickEvent[];
}
