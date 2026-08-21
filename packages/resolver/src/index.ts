import {
  RESOLVER_VERSION,
  type EncounterInput,
  type EncounterResult,
  type EncounterOutcome,
  type TickEvent,
  type ResolverUnit,
} from "./types.js";

export * from "./types.js";

/** Flat per-siege-slot offense contribution. Placeholder until chunk 11 wires real
 * fence/trap counter math; tracked here as an obviously-tunable stub constant. */
const SIEGE_OFFENSE_BONUS = 40;

/** Truncating integer division. Both operands are always integers here, and
 * IEEE-754 division is bit-exact and platform-independent for integer inputs
 * within the safe integer range, so this stays inside the "no float drift" rule
 * (the ban is on transcendental functions, not on exact integer arithmetic). */
function idiv(a: number, b: number): number {
  return Math.trunc(a / b);
}

function totalOffense(units: readonly ResolverUnit[], siegeCount: number): number {
  let sum = 0;
  for (const unit of units) {
    sum += unit.offense;
  }
  sum += siegeCount * SIEGE_OFFENSE_BONUS;
  return sum;
}

/**
 * Stub for the real chunk 10-13 tick engine. Deterministic, pure, fixed-point:
 * given the same input it always produces the same outcome and the same tick
 * log, which is exactly what chunk 09's tests need to exercise (template
 * semantics, replay fidelity, symmetrical replay) without waiting on the real
 * combat resolver. Replace the body when chunks 10-13 land; the input/output
 * contract (`EncounterInput` -> `EncounterResult`) is designed to survive that
 * swap unchanged.
 *
 * Tie-break rule (see GUARDRAILS.md #1): aggregate offense strictly greater
 * than total defense is required for an overrun. An exact tie favors the
 * defender, matching the stalemate-favors-the-caravan convention used
 * elsewhere in the design.
 */
export function resolveEncounter(input: EncounterInput): EncounterResult {
  const { attackingParty, defendingSide } = input;
  const offense = totalOffense(attackingParty.units, attackingParty.siege.length);
  const defense = defendingSide.totalDefense;

  let outcome: EncounterOutcome;
  let depthFractionMilli: number;

  if (offense > defense) {
    outcome = "overrun";
    depthFractionMilli = 1000;
  } else if (offense * 2 >= defense) {
    outcome = "stalemate";
    depthFractionMilli = defense > 0 ? idiv(offense * 1000, defense) : 0;
  } else {
    outcome = "wipe";
    depthFractionMilli = defense > 0 ? idiv(offense * 1000, defense) : 0;
  }

  const tickLog: TickEvent[] = [];
  let tick = 0;
  for (const unit of attackingParty.units) {
    tickLog.push({ kind: "unit_advance", tick, unitInstanceId: unit.unitInstanceId, toward: { x: 16, y: 16 } });
    tick += 1;
  }
  for (const unit of attackingParty.units) {
    tickLog.push({ kind: "unit_attack", tick, attackerUnitInstanceId: unit.unitInstanceId, damage: unit.offense });
    tick += 1;
  }
  tickLog.push({ kind: "outcome", tick, outcome });

  return {
    resolverVersion: RESOLVER_VERSION,
    outcome,
    depthFractionMilli,
    tickLog,
  };
}
