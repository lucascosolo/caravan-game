/**
 * DEV / TEST ONLY (chunk 23): `CARAVAN_TEST_RESOLVER=double` installs chunk 15's
 * deterministic test double (src/dev/tripDouble.ts) as the encounter resolver and runs the job
 * worker inline, so a running server can carry a whole trip end to end — the Playwright trip
 * e2e needs it — before chunk 13 wires @caravan/resolver. Chunk 13 replaces the double with
 * the real resolver (`productionEncounterResolver`) and flips ENCOUNTER_RESOLUTION_WIRED; this
 * flag then only exists to make e2e outcomes predictable.
 *
 * REFUSED IN PRODUCTION: with NODE_ENV=production the server will not start with the flag
 * set (an operator cannot quietly hand players scripted fights). Unset, nothing here runs and
 * every encounter job is left to the production handler, which parks while the resolver is
 * unwired.
 *
 * The plan is fixed (no knobs from the environment): every encounter is HELD; each posted
 * unit takes DOUBLE_UNIT_DAMAGE, the first laid trap fires at encounter 1 and every placed
 * fence segment at encounter 1 is broken — so a pushed trip visibly carries attrition into
 * encounter 2. At encounter 2 the posted unit with the lowest ref dies (chunk 23 QA D3), so
 * the e2e sees a death the caravan survives: the de-merge on bank and in the overrun stakes.
 * One script overrides the table (chunk 24 QA S5, DOUBLE_SCRIPT): an encounter-1 circle with
 * no fence at all is overrun, so the onboarding e2e can walk the overrun path.
 * The double is pure (index → plan, plus the job input), so the fight's outcome is still a
 * function of the job input alone.
 */
import { doubleHandlers, type EncounterPlan, type EncounterScript } from "./tripDouble.js";
import { drain } from "../jobs/worker.js";
import type { HandlerRegistry, WorkerOptions } from "../jobs/worker.js";
import type pg from "pg";

export const TEST_RESOLVER_ENV = "CARAVAN_TEST_RESOLVER";
/** Tunable for the e2e only (not balance): HP each posted unit loses per encounter. */
export const DOUBLE_UNIT_DAMAGE = 150;
/** How long the inline worker waits after a commit before resolving, so the client shows "resolving". */
export const INLINE_WORKER_DELAY_MS = 400;

export const DOUBLE_PLANS: Record<number, EncounterPlan> = {
  1: { kind: "caravan_held", unitDamage: DOUBLE_UNIT_DAMAGE, spendTraps: 1, fenceDamage: 1_000_000 },
  2: { kind: "caravan_held", unitDamage: DOUBLE_UNIT_DAMAGE, killLowestRefPosts: 1 },
};
export const DOUBLE_FALLBACK: EncounterPlan = { kind: "caravan_held", unitDamage: DOUBLE_UNIT_DAMAGE };

/**
 * Chunk 24 QA S5: the e2e's way to the common real-resolver path (an overrun at encounter 1),
 * read off the committed arrangement alone (pure): an encounter-1 circle with NO fence placed
 * is overrun. If it also laid a trap, the posted unit with the lowest ref dies in that fight
 * (so it is de-merged and comes home, the "survivor" branch); otherwise every posted unit is
 * still standing at the collapse and is lost outright. Every other arrangement follows
 * DOUBLE_PLANS, so the trip e2e (which fences encounter 1) is unchanged.
 */
export const DOUBLE_SCRIPT: EncounterScript = (input) => {
  if (input.encounterIndex !== 1 || input.formation.fences.length > 0) return null;
  return { kind: "caravan_overrun", killLowestRefPosts: input.formation.traps.length > 0 ? 1 : 0, spendTraps: input.formation.traps.length };
};

export interface InlineEncounterWorker {
  readonly name: string;
  readonly handlers: HandlerRegistry;
  readonly delayMs: number;
}

export class TestResolverRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestResolverRefusedError";
  }
}

/**
 * Read the flag. Null when unset. Throws when set in production or to an unknown value, so
 * the process refuses to start rather than run with a resolver nobody asked for.
 */
export function inlineWorkerFromEnv(env: Readonly<Record<string, string | undefined>>): InlineEncounterWorker | null {
  const v = env[TEST_RESOLVER_ENV];
  if (v === undefined || v === "") return null;
  if (env["NODE_ENV"] === "production") {
    throw new TestResolverRefusedError(`${TEST_RESOLVER_ENV}=${v} is refused when NODE_ENV=production: the test double never resolves real players' fights`);
  }
  if (v !== "double") throw new TestResolverRefusedError(`${TEST_RESOLVER_ENV} must be "double" (got "${v}")`);
  return { name: "test-double", handlers: doubleHandlers(DOUBLE_PLANS, DOUBLE_FALLBACK, DOUBLE_SCRIPT), delayMs: INLINE_WORKER_DELAY_MS };
}

/**
 * Resolve every ready job now (after the configured delay). Errors are reported, never thrown into a request.
 * `hooks` (chunk 15 QA S4/D3): the trip loop's settle / void hooks, run by the worker (WorkerOptions).
 */
export function scheduleInlineDrain(pool: pg.Pool, worker: InlineEncounterWorker, onError: (err: unknown) => void, hooks: Pick<WorkerOptions, "afterCompleted" | "afterParked"> = {}): void {
  setTimeout(() => {
    drain(pool, { workerId: `inline-${worker.name}`, handlers: worker.handlers, retryBackoffMs: () => 0, ...hooks, onHookError: onError }).catch(onError);
  }, worker.delayMs);
}
