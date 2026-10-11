/**
 * Chunk 13 — the PRODUCTION encounter resolver: an adapter over @caravan/resolver behind the
 * trip loop's seam (trip/outcome.ts). It builds the resolver's three inputs from the job's
 * snapshots alone —
 *     battlefield = toBattlefield(survivors, formation)   (the circle as committed, at the HP it carried in)
 *     party       = toResolverParty(party)                (the scouted standing party, full HP: a template)
 *     tunables    = resolverTunables()                    (the registry values the resolver reads)
 * — calls `resolve`, and maps the result to the seam's shape: the end condition and depth
 * (normalized by the resolver to an integer 0..1024, QA-15 N8), the tick it ended on, and the
 * attrition (remaining HP per posted unit, the traps that fired, remaining HP per placed
 * segment). It also returns the tick log, encoded as the stored replay (LOG_FORMAT), which the
 * worker writes to `encounter_log` (QA-15 S2). Loot is NOT computed here: resolveEncounter
 * derives it from kind and depth for every resolver alike (trip/loot.ts).
 *
 * CONTENT PINNING (QA-15 S3). The job input names unit / trap / fence / siege TYPES; their
 * stats come from @caravan/content when the job runs. So the enqueuer stamps
 * RESOLUTION_CONTENT_HASH — sha256 of the stats of every content table the adapter reads plus
 * the resolver tunables (never the copy, QA-13 D3) — into the job input, and this adapter refuses a job whose stamp differs
 * from its own (ContentHashMismatchError): a deploy that changed a stat between commit and
 * resolution can never resolve a fight against numbers the defender did not scout. The
 * handler re-throws the refusal as RETRYABLE, so a worker on the matching content can still
 * take the job; after the attempt budget it parks (QA-15 D3's void path).
 *
 * Pure apart from hashing: no clock, no database, no account state reaches the resolver.
 */
import { createHash } from "node:crypto";
import { resolutionContent, resolverTunables, toBattlefield, toResolverParty } from "@caravan/circle";
import { encodeReplay, resolve, type ReplayLog } from "@caravan/resolver";
import { canonicalJson, type Json } from "../ledger/events.js";
import type { EncounterResolver, EncounterResolverInput, ResolvedFight } from "./outcome.js";

/**
 * sha256 (hex) of the content STATS + tunables a resolution reads (QA-13 D3: copy — display
 * names, flavor, ability descriptions — is not hashed, so a copy-only deploy parks nothing).
 * `content` defaults to the live tables; tests pass an edited copy.
 */
export function resolutionContentHash(content?: Parameters<typeof resolutionContent>[0]): string {
  return createHash("sha256")
    .update(canonicalJson(resolutionContent(content) as unknown as Json))
    .digest("hex");
}

/** Stamped at enqueue, checked at resolve. */
export const RESOLUTION_CONTENT_HASH: string = resolutionContentHash();

export class ContentHashMismatchError extends Error {
  constructor(readonly expected: string | null, readonly actual: string) {
    super(`content/tunables hash mismatch: the job was committed against content ${expected ?? "(none stamped)"}, this server resolves with ${actual}; refusing to fight it with different numbers`);
    this.name = "ContentHashMismatchError";
  }
}

/** Build the resolver input from the job's snapshots (exported for tests and the replay probe). */
export function resolverInputOf(input: EncounterResolverInput) {
  return { battlefield: toBattlefield(input.survivors, input.formation), party: toResolverParty(input.party), tunables: resolverTunables() };
}

/** Run the resolver on the job's snapshots: the seam's outcome shape plus the stored replay. */
export function resolveWithResolver(input: EncounterResolverInput): { outcome: ResolvedFight; log: ReplayLog } {
  if (input.contentHash !== RESOLUTION_CONTENT_HASH) throw new ContentHashMismatchError(input.contentHash, RESOLUTION_CONTENT_HASH);
  const out = resolve(resolverInputOf(input));
  const defenders = out.units.filter((u) => u.side === "defender");
  const outcome: ResolvedFight = {
    kind: out.outcome.kind,
    depth: out.outcome.depth,
    endTick: out.outcome.endTick,
    units: defenders.map((u) => ({ ref: u.ref, hp: u.hp })),
    spentTraps: out.traps.filter((t) => t.spent).map((t) => t.ref),
    fences: out.fences.map((f) => ({ ref: f.ref, hp: f.hp })),
  };
  return { outcome, log: encodeReplay(out) };
}

export const resolverAdapter: EncounterResolver = {
  name: "resolver",
  resolve: resolveWithResolver,
};
