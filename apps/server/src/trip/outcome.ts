/**
 * THE SEAM between the trip loop (chunk 15) and the resolver's outcome (chunk 13).
 *
 * Chunk 13 (end conditions, depth-scaled loot, the replay log) is not built yet. The trip
 * loop consumes a fight's result through exactly two things defined here:
 *
 *   EncounterOutcome       what the trip loop needs to know about one resolved encounter:
 *                          how it ended, how deep the party got, and the attrition the
 *                          caravan carries forward (the shape @caravan/circle's
 *                          applyEncounterOutcome — `applyAttritionOutcome` on the server —
 *                          already folds into the manifest).
 *   EncounterResolver      `resolve(input) → EncounterOutcome`, a PURE function of the job's
 *                          snapshotted input (formation, survivors as committed, the scouted
 *                          party). `resolveEncounter` runs one and validates what it returns.
 *
 * Production: `productionEncounterResolver` refuses (TODO(chunk-13)); the job handler stays
 * gated by chunk 02's ENCOUNTER_RESOLUTION_WIRED = false, so no encounter is resolved by
 * anything but a real resolver. Tests use a deterministic double (test/trip-double.ts)
 * registered explicitly with the worker. Chunk 13 replaces the production resolver's body
 * with an adapter over @caravan/resolver (toBattlefield(survivors, formation) + party →
 * simulate → this shape) and flips the flag. Nothing in the trip loop changes then.
 *
 * Pure module: no I/O, no clock, no randomness, no floats.
 */
import {
  assertEncounterOutcome,
  formationFromJson,
  manifestFromJson,
  partyFromJson,
  type EncounterOutcome as AttritionOutcome,
  type Formation,
  type Manifest,
  type Party,
} from "@caravan/circle";
import { FIXED_ONE } from "@caravan/content";

/** The three end conditions (chunk 13). Same vocabulary as chunk 04's progression. */
export const ENCOUNTER_OUTCOME_KINDS = ["caravan_held", "caravan_overrun", "stalemate"] as const;
export type EncounterOutcomeKind = (typeof ENCOUNTER_OUTCOME_KINDS)[number];

/**
 * One resolved encounter, as the trip loop consumes it.
 *
 *   kind        caravan_held     the attacking party was wiped; the caravan may bank or push
 *               caravan_overrun  an attacker reached the core; the trip ends (chunk 19's losses)
 *               stalemate        tick cap; the attackers withdrew; the caravan may bank or push
 *   depth       how deep the party got, fixed-point: 0 … FIXED_ONE (1024 = reached the core).
 *               Chunk 13 defines the metric (DEPTH_METRIC) and scales the PARTY OWNER's loot
 *               by it; the caravan's encounter Coin does not depend on it. An overrun is
 *               always FIXED_ONE.
 *   units       remaining HP per posted unit ref (instance id); 0 = died this encounter.
 *               Omitted units are unchanged.
 *   spentTraps  refs of traps that fired this encounter.
 *   fences      remaining HP per placed fence ref; 0 = destroyed. Omitted = unchanged.
 *
 * `units`/`spentTraps`/`fences` are exactly @caravan/circle's attrition outcome; the trip
 * loop hands them to `applyOutcome` (chunk 07), which is monotone — nothing rises.
 */
export interface EncounterOutcome {
  readonly kind: EncounterOutcomeKind;
  readonly depth: number;
  readonly units: readonly { readonly ref: string; readonly hp: number }[];
  readonly spentTraps: readonly string[];
  readonly fences: readonly { readonly ref: string; readonly hp: number }[];
}

export class EncounterOutcomeError extends Error {
  constructor(message: string) {
    super(`encounter outcome refused: ${message}`);
    this.name = "EncounterOutcomeError";
  }
}

/** Closed-shape check: exactly the five keys, integer depth in range, attrition well-formed. */
export function assertTripEncounterOutcome(o: unknown): asserts o is EncounterOutcome {
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new EncounterOutcomeError("must be an object");
  const obj = o as Record<string, unknown>;
  const keys = Object.keys(obj).sort().join(",");
  if (keys !== "depth,fences,kind,spentTraps,units") throw new EncounterOutcomeError(`keys must be exactly depth, fences, kind, spentTraps, units; got ${keys}`);
  if (!(ENCOUNTER_OUTCOME_KINDS as readonly unknown[]).includes(obj["kind"])) throw new EncounterOutcomeError(`unknown kind ${JSON.stringify(obj["kind"])}`);
  const depth = obj["depth"];
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > FIXED_ONE) {
    throw new EncounterOutcomeError(`depth must be an integer in 0..${FIXED_ONE} (fixed-point), got ${JSON.stringify(depth)}`);
  }
  if (obj["kind"] === "caravan_overrun" && depth !== FIXED_ONE) throw new EncounterOutcomeError(`an overrun reached the core: depth must be ${FIXED_ONE}`);
  try {
    assertEncounterOutcome(attritionOf(obj as unknown as EncounterOutcome));
  } catch (err) {
    throw new EncounterOutcomeError(err instanceof Error ? err.message : String(err));
  }
}

/** The attrition part, in the exact shape `applyOutcome` / `applyAttritionOutcome` takes. */
export function attritionOf(o: EncounterOutcome): AttritionOutcome {
  return { units: o.units, spentTraps: o.spentTraps, fences: o.fences };
}

/** Did the caravan survive (and so may bank or push)? */
export function caravanSurvived(kind: EncounterOutcomeKind): boolean {
  return kind !== "caravan_overrun";
}

/**
 * What a resolver is given: the job's snapshotted input, parsed. Everything here was frozen
 * at commit (formation, survivors as they stood at commit) or at menu generation (the
 * party the defender scouted). Nothing live; no account, no Coin, no entitlement.
 */
export interface EncounterResolverInput {
  readonly tripId: string;
  readonly encounterIndex: number;
  readonly formation: Formation;
  readonly survivors: Manifest;
  readonly party: Party;
}

export interface EncounterResolver {
  /** For the job result record (which resolver produced the outcome). */
  readonly name: string;
  /** PURE and deterministic: the same input yields the same outcome, always. */
  resolve(input: EncounterResolverInput): EncounterOutcome;
}

/**
 * An outcome may only touch what was IN THE FIGHT (chunk 07 QA S2, checked again by
 * applyOutcome at settle): posted units, laid traps, placed fence segments.
 */
export function assertOutcomeWithinFight(input: EncounterResolverInput, o: EncounterOutcome): void {
  const posts = new Set(input.formation.posts.map((p) => p.ref));
  const traps = new Set(input.formation.traps.map((t) => t.ref));
  const fences = new Set(input.formation.fences.map((f) => f.ref));
  const bad = [
    ...o.units.filter((u) => !posts.has(u.ref)).map((u) => `unit '${u.ref}' was not posted`),
    ...o.spentTraps.filter((r) => !traps.has(r)).map((r) => `trap '${r}' was not laid`),
    ...o.fences.filter((f) => !fences.has(f.ref)).map((f) => `fence '${f.ref}' was not placed`),
  ];
  if (bad.length > 0) throw new EncounterOutcomeError(`names things that were not in the fight: ${bad.join("; ")}`);
}

/** Run a resolver and refuse anything malformed it returns. */
export function resolveEncounter(resolver: EncounterResolver, input: EncounterResolverInput): EncounterOutcome {
  const out = resolver.resolve(input);
  assertTripEncounterOutcome(out);
  assertOutcomeWithinFight(input, out);
  // Canonical copy: fixed key order, no aliasing of the resolver's own objects.
  return {
    kind: out.kind,
    depth: out.depth,
    units: out.units.map((u) => ({ ref: u.ref, hp: u.hp })),
    spentTraps: [...out.spentTraps],
    fences: out.fences.map((f) => ({ ref: f.ref, hp: f.hp })),
  };
}

/**
 * The trip loop enqueues the committed (canonical) formation with the survivors snapshot it
 * was committed against as ONE extra key, `survivors` (trip/service.ts commitEncounter), so
 * a pure handler can rebuild everything the resolver needs from the job input alone.
 */
export const JOB_SURVIVORS_KEY = "survivors" as const;

/** Parse a job input (EncounterJobInput) into the resolver's input. Throws on anything malformed. */
export function resolverInputFromJob(input: Record<string, unknown>): EncounterResolverInput {
  const f = input["formation"];
  if (f === null || typeof f !== "object" || Array.isArray(f)) throw new EncounterOutcomeError("job input has no formation");
  const { [JOB_SURVIVORS_KEY]: survivors, ...formationJson } = f as Record<string, unknown>;
  if (survivors === undefined) {
    throw new EncounterOutcomeError("job input was not enqueued by the trip loop (no survivors snapshot alongside the formation)");
  }
  const party = input["party"] as Record<string, unknown> | undefined;
  if (!party || typeof party !== "object") throw new EncounterOutcomeError("job input has no party snapshot");
  const tripId = input["tripId"];
  const encounterIndex = input["encounterIndex"];
  if (typeof tripId !== "string" || typeof encounterIndex !== "number") throw new EncounterOutcomeError("job input has no trip id / encounter index");
  return {
    tripId,
    encounterIndex,
    formation: formationFromJson(formationJson),
    survivors: manifestFromJson(survivors),
    party: partyFromJson(party["composition"]),
  };
}

/**
 * PRODUCTION resolver. Not wired: chunk 13 implements it over @caravan/resolver.
 * TODO(chunk-13): toBattlefield(input.survivors, input.formation) + input.party → simulate →
 * map the end condition, depth and per-entity remaining HP / spent traps to EncounterOutcome.
 */
export const productionEncounterResolver: EncounterResolver = {
  name: "resolver",
  resolve(input) {
    throw new EncounterOutcomeError(
      `no resolver adapter: chunk 13 maps @caravan/resolver's outcome to EncounterOutcome (encounter ${input.tripId}/${input.encounterIndex})`,
    );
  },
};
