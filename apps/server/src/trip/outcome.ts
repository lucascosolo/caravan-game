/**
 * THE SEAM between the trip loop (chunk 15) and the resolver's outcome (chunk 13).
 *
 * The trip loop consumes a fight's result through exactly two things defined here:
 *
 *   EncounterOutcome       what the trip loop needs to know about one resolved encounter:
 *                          how it ended (and on which tick), how deep the party got, what the
 *                          party's OWNER earns from it (loot — reported, credited elsewhere),
 *                          and the attrition the caravan carries forward (the shape
 *                          @caravan/circle's applyEncounterOutcome — `applyAttritionOutcome` on
 *                          the server — folds into the manifest).
 *   EncounterResolver      `resolve(input) → { outcome, log }`, a PURE function of the job's
 *                          snapshotted input (formation, survivors as committed, the scouted
 *                          party, the content stamp). `resolveEncounter` runs one, validates
 *                          what it returns and adds the loot.
 *
 * Production (chunk 13): `productionEncounterResolver` is the adapter over @caravan/resolver
 * (trip/resolverAdapter.ts); chunk 02's ENCOUNTER_RESOLUTION_WIRED is true. Tests may still
 * register the deterministic double (test/trip-double.ts) explicitly with the worker.
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
import type { ReplayLog } from "@caravan/resolver";
import { partyLootForEncounter } from "./loot.js";

/** The three end conditions (chunk 13). Same vocabulary as chunk 04's progression. */
export const ENCOUNTER_OUTCOME_KINDS = ["caravan_held", "caravan_overrun", "stalemate"] as const;
export type EncounterOutcomeKind = (typeof ENCOUNTER_OUTCOME_KINDS)[number];

/**
 * One resolved encounter, as the trip loop consumes it.
 *
 *   kind        caravan_held     the attacking party was wiped; the caravan may bank or push
 *               caravan_overrun  an attacker reached the core; the trip ends (chunk 19's losses)
 *               stalemate        tick cap; the attackers withdrew; the caravan may bank or push
 *   depth       how deep the party got, an integer 0 … FIXED_ONE (1024 = reached the core):
 *               the resolver's DEPTH_METRIC (v8, QA-13 D1), "how far the deepest raider got
 *               inside the wagon circle: the share of the distance from the ring's outer edge to
 *               the core that it closed" (0 outside the ring line). Only an overrun is 1024.
 *               It scales the PARTY OWNER's loot; the caravan's encounter Coin does not depend on it.
 *   endTick     the tick the end condition was met on (TICK_CAP − 1 for a stalemate).
 *   loot        the party owner's loot for this encounter (trip/loot.ts): full on an overrun,
 *               full × depth^1.5 on a wipe, 0 on a stalemate; full = the encounter's Coin value.
 *               REPORTED here and in the events; credited by the settle path (chunk 19), never
 *               by the resolver.
 *   units       remaining HP per posted unit ref (instance id); 0 = died this encounter.
 *               Omitted units are unchanged.
 *   spentTraps  refs of traps that fired this encounter.
 *   fences      remaining HP per placed fence ref; 0 = destroyed. Omitted = unchanged.
 *
 * `units`/`spentTraps`/`fences` are exactly @caravan/circle's attrition outcome; the trip
 * loop hands them to `applyOutcome` (chunk 07), which is monotone — nothing rises.
 */
export interface EncounterOutcome extends ResolvedFight {
  readonly loot: number;
}

/** What a resolver returns: everything in EncounterOutcome but the loot (derived from kind and depth). */
export interface ResolvedFight {
  readonly kind: EncounterOutcomeKind;
  readonly depth: number;
  readonly endTick: number;
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

const OUTCOME_KEYS = "depth,endTick,fences,kind,loot,spentTraps,units";
const FIGHT_KEYS = "depth,endTick,fences,kind,spentTraps,units";

/** Closed-shape check of a stored outcome: exactly the seven keys, integer depth / endTick / loot in range, attrition well-formed. */
export function assertTripEncounterOutcome(o: unknown): asserts o is EncounterOutcome {
  assertShape(o, OUTCOME_KEYS);
  const loot = (o as Record<string, unknown>)["loot"];
  if (typeof loot !== "number" || !Number.isSafeInteger(loot) || loot < 0) throw new EncounterOutcomeError(`loot must be a non-negative integer, got ${JSON.stringify(loot)}`);
  if ((o as EncounterOutcome).kind === "stalemate" && loot !== 0) throw new EncounterOutcomeError("a stalemate earns the party owner nothing");
}

/** Closed-shape check of what a resolver returns (no loot: resolveEncounter derives it). */
export function assertResolvedFight(o: unknown): asserts o is ResolvedFight {
  assertShape(o, FIGHT_KEYS);
}

function assertShape(o: unknown, expected: string): void {
  if (o === null || typeof o !== "object" || Array.isArray(o)) throw new EncounterOutcomeError("must be an object");
  const obj = o as Record<string, unknown>;
  const keys = Object.keys(obj).sort().join(",");
  if (keys !== expected) throw new EncounterOutcomeError(`keys must be exactly ${expected.split(",").join(", ")}; got ${keys}`);
  const endTick = obj["endTick"];
  if (typeof endTick !== "number" || !Number.isSafeInteger(endTick) || endTick < 0) throw new EncounterOutcomeError(`endTick must be a non-negative integer, got ${JSON.stringify(endTick)}`);
  if (!(ENCOUNTER_OUTCOME_KINDS as readonly unknown[]).includes(obj["kind"])) throw new EncounterOutcomeError(`unknown kind ${JSON.stringify(obj["kind"])}`);
  const depth = obj["depth"];
  if (typeof depth !== "number" || !Number.isInteger(depth) || depth < 0 || depth > FIXED_ONE) {
    throw new EncounterOutcomeError(`depth must be an integer in 0..${FIXED_ONE} (fixed-point), got ${JSON.stringify(depth)}`);
  }
  if (obj["kind"] === "caravan_overrun" && depth !== FIXED_ONE) throw new EncounterOutcomeError(`an overrun reached the core: depth must be ${FIXED_ONE}`);
  try {
    assertEncounterOutcome(attritionOf(obj as unknown as ResolvedFight));
  } catch (err) {
    throw new EncounterOutcomeError(err instanceof Error ? err.message : String(err));
  }
}

/** The attrition part, in the exact shape `applyOutcome` / `applyAttritionOutcome` takes. */
export function attritionOf(o: ResolvedFight): AttritionOutcome {
  return { units: o.units, spentTraps: o.spentTraps, fences: o.fences };
}

/** Did the caravan survive (and so may bank or push)? */
export function caravanSurvived(kind: EncounterOutcomeKind): boolean {
  return kind !== "caravan_overrun";
}

/**
 * What a resolver is given: the job's snapshotted input, parsed. Everything here was frozen
 * at commit (formation, survivors as they stood at commit, the content stamp) or at menu
 * generation (the party the defender scouted). Nothing live; no account, no Coin, no entitlement.
 */
export interface EncounterResolverInput {
  readonly tripId: string;
  readonly encounterIndex: number;
  readonly formation: Formation;
  readonly survivors: Manifest;
  readonly party: Party;
  /** QA-15 S3: the content + tunables hash stamped at enqueue (null on a job enqueued without one). */
  readonly contentHash: string | null;
}

export interface EncounterResolver {
  /** For the job result record (which resolver produced the outcome). */
  readonly name: string;
  /** PURE and deterministic: the same input yields the same fight and the same log, always. `log` is null for a resolver with no replay (the test double). */
  resolve(input: EncounterResolverInput): { readonly outcome: ResolvedFight; readonly log: ReplayLog | null };
}

/**
 * An outcome may only touch what was IN THE FIGHT (chunk 07 QA S2, checked again by
 * applyOutcome at settle): posted units, laid traps, placed fence segments.
 */
export function assertOutcomeWithinFight(input: EncounterResolverInput, o: ResolvedFight): void {
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

/**
 * Run a resolver, refuse anything malformed it returns, and add the party owner's loot
 * (trip/loot.ts, from kind and depth and the encounter's Coin value — the same rule for
 * every resolver). Returns the outcome and the resolver's replay log (null if it has none).
 */
export function resolveEncounter(resolver: EncounterResolver, input: EncounterResolverInput): { outcome: EncounterOutcome; log: ReplayLog | null } {
  const { outcome: out, log } = resolver.resolve(input);
  assertResolvedFight(out);
  assertOutcomeWithinFight(input, out);
  // Canonical copy: fixed key order, no aliasing of the resolver's own objects.
  const outcome: EncounterOutcome = {
    kind: out.kind,
    depth: out.depth,
    endTick: out.endTick,
    loot: partyLootForEncounter(out.kind, out.depth, input.encounterIndex),
    units: out.units.map((u) => ({ ref: u.ref, hp: u.hp })),
    spentTraps: [...out.spentTraps],
    fences: out.fences.map((f) => ({ ref: f.ref, hp: f.hp })),
  };
  assertTripEncounterOutcome(outcome);
  return { outcome, log };
}

/**
 * QA-15 N3: the trip loop enqueues the committed (canonical) formation and, as its own
 * TOP-LEVEL job-input key, the survivors snapshot it was committed against
 * (trip/service.ts commitEncounter), so a pure handler can rebuild everything the resolver
 * needs from the job input alone. The content stamp is `contentHash` (QA-15 S3).
 */
export const JOB_SURVIVORS_KEY = "survivors" as const;
export const JOB_CONTENT_HASH_KEY = "contentHash" as const;

/** Parse a job input (EncounterJobInput) into the resolver's input. Throws on anything malformed. */
export function resolverInputFromJob(input: Record<string, unknown>): EncounterResolverInput {
  const f = input["formation"];
  if (f === null || typeof f !== "object" || Array.isArray(f)) throw new EncounterOutcomeError("job input has no formation");
  const survivors = input[JOB_SURVIVORS_KEY];
  if (survivors === undefined || survivors === null || typeof survivors !== "object") {
    throw new EncounterOutcomeError("job input was not enqueued by the trip loop (no top-level survivors snapshot)");
  }
  const party = input["party"] as Record<string, unknown> | undefined;
  if (!party || typeof party !== "object") throw new EncounterOutcomeError("job input has no party snapshot");
  const tripId = input["tripId"];
  const encounterIndex = input["encounterIndex"];
  if (typeof tripId !== "string" || typeof encounterIndex !== "number") throw new EncounterOutcomeError("job input has no trip id / encounter index");
  const contentHash = input[JOB_CONTENT_HASH_KEY];
  return {
    tripId,
    encounterIndex,
    formation: formationFromJson(f),
    survivors: manifestFromJson(survivors),
    party: partyFromJson(party["composition"]),
    contentHash: typeof contentHash === "string" ? contentHash : null,
  };
}

export { resolverAdapter as productionEncounterResolver } from "./resolverAdapter.js";
