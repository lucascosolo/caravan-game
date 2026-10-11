/**
 * Deterministic TEST DOUBLE for the trip loop's resolver seam (src/trip/outcome.ts) until
 * chunk 13 wires @caravan/resolver. Test-only: production never imports this file.
 *
 * Pure: the outcome is a function of (encounter index → plan) and the job input alone —
 * the committed formation and the survivors it was committed with. No clock, no randomness.
 */
import { FIXED_ONE } from "@caravan/content";
import { JOB_KIND_ENCOUNTER_RESOLUTION } from "../src/jobs/queue.js";
import { makeEncounterResolutionHandler } from "../src/jobs/handlers/encounterResolution.js";
import type { HandlerRegistry } from "../src/jobs/worker.js";
import type { EncounterOutcome, EncounterOutcomeKind, EncounterResolver } from "../src/trip/outcome.js";

export interface EncounterPlan {
  kind: EncounterOutcomeKind;
  /** HP taken from every posted unit (floored at 0). */
  unitDamage?: number;
  /** Posted unit refs that die outright. */
  kill?: string[];
  /** How many of the laid traps fire, in placement order. */
  spendTraps?: number;
  /** HP taken from every placed fence segment (floored at 0). */
  fenceDamage?: number;
  depth?: number;
  /** Escape hatch for negative tests: rewrite the outcome before it is returned. */
  tamper?: (o: EncounterOutcome) => unknown;
}

export function plannedResolver(plans: Record<number, EncounterPlan>, fallback: EncounterPlan = { kind: "caravan_held" }): EncounterResolver {
  return {
    name: "test-double",
    resolve(input) {
      const plan = plans[input.encounterIndex] ?? fallback;
      const hp = new Map(input.survivors.units.map((u) => [u.ref, u.hp]));
      const fenceHp = new Map(input.survivors.fences.map((f) => [f.ref, f.hp]));
      const out: EncounterOutcome = {
        kind: plan.kind,
        depth: plan.depth ?? (plan.kind === "caravan_overrun" ? FIXED_ONE : plan.kind === "stalemate" ? 256 : 512),
        units: input.formation.posts.map((p) => ({ ref: p.ref, hp: plan.kill?.includes(p.ref) ? 0 : Math.max(0, hp.get(p.ref)! - (plan.unitDamage ?? 0)) })),
        spentTraps: input.formation.traps.slice(0, plan.spendTraps ?? 0).map((t) => t.ref),
        fences: input.formation.fences.map((f) => ({ ref: f.ref, hp: Math.max(0, fenceHp.get(f.ref)! - (plan.fenceDamage ?? 0)) })),
      };
      return (plan.tamper ? plan.tamper(out) : out) as EncounterOutcome;
    },
  };
}

export function doubleHandlers(plans: Record<number, EncounterPlan>, fallback?: EncounterPlan): HandlerRegistry {
  return { [JOB_KIND_ENCOUNTER_RESOLUTION]: makeEncounterResolutionHandler(plannedResolver(plans, fallback)) };
}
