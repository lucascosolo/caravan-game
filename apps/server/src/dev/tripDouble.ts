/**
 * Deterministic TEST DOUBLE for the trip loop's resolver seam (src/trip/outcome.ts). Chunk 13
 * wired @caravan/resolver into production (DEFAULT_HANDLERS); the double stays for the tests
 * that need a PLANNED outcome (a given unit dies, a heal is refused…). It returns no replay
 * log. Dev / test only: it lives under src/dev/ (chunk 23 QA N5) so the dev flag's module
 * (src/dev/testResolver.ts) never reaches into test/; the server suite imports it from here.
 * Nothing reaches it in production: testResolver.ts refuses to start with the flag set and
 * NODE_ENV=production, and without the flag no handler built here is ever installed.
 *
 * Pure: the outcome is a function of (encounter index → plan) and the job input alone —
 * the committed formation and the survivors it was committed with. No clock, no randomness.
 */
import { FIXED_ONE } from "@caravan/content";
import { JOB_KIND_ENCOUNTER_RESOLUTION } from "../jobs/queue.js";
import { makeEncounterResolutionHandler } from "../jobs/handlers/encounterResolution.js";
import type { HandlerRegistry } from "../jobs/worker.js";
import type { EncounterOutcomeKind, EncounterResolver, ResolvedFight } from "../trip/outcome.js";

export interface EncounterPlan {
  kind: EncounterOutcomeKind;
  /** HP taken from every posted unit (floored at 0). */
  unitDamage?: number;
  /** Posted unit refs that die outright. */
  kill?: string[];
  /**
   * Kill the first N posted units in ascending ref order (a ref-free script for a running
   * server, where the refs are not known in advance; chunk 23 QA D3). Deterministic: the
   * order is the refs' own string order, never placement or insertion order.
   */
  killLowestRefPosts?: number;
  /** How many of the laid traps fire, in placement order. */
  spendTraps?: number;
  /** HP taken from every placed fence segment (floored at 0). */
  fenceDamage?: number;
  depth?: number;
  /** Escape hatch for negative tests: rewrite the outcome before it is returned. */
  tamper?: (o: ResolvedFight) => unknown;
}

export function plannedResolver(plans: Record<number, EncounterPlan>, fallback: EncounterPlan = { kind: "caravan_held" }): EncounterResolver {
  return {
    name: "test-double",
    resolve(input) {
      const plan = plans[input.encounterIndex] ?? fallback;
      const hp = new Map(input.survivors.units.map((u) => [u.ref, u.hp]));
      const fenceHp = new Map(input.survivors.fences.map((f) => [f.ref, f.hp]));
      const killed = new Set(plan.kill ?? []);
      const byRef = input.formation.posts.map((p) => p.ref).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      for (const ref of byRef.slice(0, plan.killLowestRefPosts ?? 0)) killed.add(ref);
      const out: ResolvedFight = {
        kind: plan.kind,
        depth: plan.depth ?? (plan.kind === "caravan_overrun" ? FIXED_ONE : plan.kind === "stalemate" ? 256 : 512),
        endTick: plan.kind === "stalemate" ? 3599 : 600,
        units: input.formation.posts.map((p) => ({ ref: p.ref, hp: killed.has(p.ref) ? 0 : Math.max(0, hp.get(p.ref)! - (plan.unitDamage ?? 0)) })),
        spentTraps: input.formation.traps.slice(0, plan.spendTraps ?? 0).map((t) => t.ref),
        fences: input.formation.fences.map((f) => ({ ref: f.ref, hp: Math.max(0, fenceHp.get(f.ref)! - (plan.fenceDamage ?? 0)) })),
      };
      return { outcome: (plan.tamper ? plan.tamper(out) : out) as ResolvedFight, log: null };
    },
  };
}

export function doubleHandlers(plans: Record<number, EncounterPlan>, fallback?: EncounterPlan): HandlerRegistry {
  return { [JOB_KIND_ENCOUNTER_RESOLUTION]: makeEncounterResolutionHandler(plannedResolver(plans, fallback)) };
}
