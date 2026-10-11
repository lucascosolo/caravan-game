/**
 * Chunk 13 — the replay of a resolved encounter, for BOTH participants:
 *
 *   GET /me/encounters/:jobId/replay
 *
 * The caravan's player (the defender, who was present) gets it as a record and post-mortem;
 * the standing party's OWNER (who never was) gets it as the only way to see where their party
 * struck and how it did — the King of Thieves feedback loop. Anyone else gets 404, exactly as
 * for an id that does not exist (no existence oracle).
 *
 * The body carries the stored log (LOG_FORMAT, packages/resolver/src/replay.ts) as it was
 * written — nothing is re-simulated, the resolver is never called here — plus the labels a
 * renderer needs to draw it (content display names for every unit, segment and trap; which
 * side the viewer is on; the party version that fought), the outcome with its loot, and the
 * resolver version. A log in a format this server's reader cannot read is returned marked
 * `renderable: false` with the reason, never silently misrendered; a log the reader rejects
 * (truncated, altered) is marked the same way. A pruned log (LOG_RETENTION) is 410. A fight
 * resolved with no log at all (chunk 22: the dev/test double records none) is 200
 * `renderable: false` with `log: null`, `stored: null`, `logFormat: null`, `resolverVersion:
 * null`, empty labels and NO_LOG_REASON — never mistaken for an expired replay.
 */
import { getFenceTier, getTrapType, getUnitType } from "@caravan/content";
import { READABLE_REPLAY_FORMATS, RESOLVER_VERSION, readReplay, type ReplayLog } from "@caravan/resolver";
import type { FastifyInstance } from "fastify";
import { JOB_KIND_ENCOUNTER_RESOLUTION, getJob } from "../jobs/queue.js";
import type { EncounterJobInput } from "../jobs/handlers/encounterResolution.js";
import { decompressLog, findEncounterLog } from "../replay/store.js";
import { AppError } from "../services/errors.js";
import { requireAuth } from "./require-auth.js";

const JOB_ID = /^encounter:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9]\d{0,5}$/;

/** The one-sentence DEPTH_METRIC, as the UI should say it. */
export const DEPTH_EXPLAINED = "How far the deepest raider got: the share of its straight-line distance to the core that it closed.";

/** Chunk 22: why a fight resolved without a stored log (the test double) has no replay. */
export const NO_LOG_REASON = "no replay log was recorded for this fight";

const notFound = () => new AppError(404, "no_replay", "replay not found");

export async function replayRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { jobId: string } }>("/me/encounters/:jobId/replay", { preHandler: requireAuth }, async (req) => {
    const me = req.auth!.account.id;
    const jobId = req.params.jobId;
    if (!JOB_ID.test(jobId)) throw notFound();
    const job = await getJob(app.db, jobId);
    if (!job || job.kind !== JOB_KIND_ENCOUNTER_RESOLUTION) throw notFound();
    const input = job.input as EncounterJobInput;
    const viewer = input.defenderAccountId === me ? "caravan" : input.partyOwnerAccountId === me ? "party_owner" : null;
    if (viewer === null) throw notFound();
    if (job.status !== "completed") throw new AppError(409, "not_resolved", `encounter ${jobId} is ${job.status}, not resolved yet`);
    const result = (job.result ?? {}) as { outcome?: Record<string, unknown>; replay?: unknown };
    const row = await findEncounterLog(app.db, jobId);
    if (!row) {
      // Chunk 22: a fight resolved WITHOUT a log (the dev/test double, `CARAVAN_TEST_RESOLVER=double`,
      // records none: its job result has no `replay` stamp) is not "expired" — it never had a
      // replay. Answer it as not renderable, with the outcome, so the client says so truthfully.
      // A job whose result names a stored log that is gone was pruned (LOG_RETENTION): 410.
      if (result.replay) throw new AppError(410, "replay_expired", "this replay is past its retention window");
      return {
        jobId,
        viewer,
        tripId: input.tripId,
        encounterIndex: input.encounterIndex,
        resolverVersion: null,
        currentResolverVersion: RESOLVER_VERSION,
        logFormat: null,
        renderable: false,
        reason: NO_LOG_REASON,
        outcome: result.outcome ?? null,
        depthExplained: DEPTH_EXPLAINED,
        party: { partyId: input.party.partyId, partyHash: input.party.hash, partySavedAt: input.party.savedAt },
        labels: { units: [], fences: [], traps: [] },
        stored: null,
        log: null,
      };
    }

    const log = JSON.parse(decompressLog(row)) as ReplayLog;
    let renderable = READABLE_REPLAY_FORMATS.includes(row.log_format);
    let reason: string | null = renderable ? null : `log format v${row.log_format} (resolver v${row.resolver_version}) is not readable by this server's replay reader (reads ${READABLE_REPLAY_FORMATS.join(", ")})`;
    if (renderable) {
      try {
        readReplay(log);
      } catch (err) {
        renderable = false;
        reason = err instanceof Error ? err.message : String(err);
      }
    }
    return {
      jobId,
      viewer,
      tripId: input.tripId,
      encounterIndex: input.encounterIndex,
      resolverVersion: row.resolver_version,
      currentResolverVersion: RESOLVER_VERSION,
      logFormat: row.log_format,
      renderable,
      reason,
      outcome: result.outcome ?? null,
      depthExplained: DEPTH_EXPLAINED,
      // The party version that fought (chunk 09 QA N3), from the job's snapshot — never the live row.
      party: { partyId: input.party.partyId, partyHash: input.party.hash, partySavedAt: input.party.savedAt },
      labels: {
        units: log.units.map((u) => ({ ...u, displayName: getUnitType(u.typeId)?.displayName ?? u.typeId, ability: getUnitType(u.typeId)?.ability.displayName ?? null })),
        fences: log.fences.map((f) => ({ ...f, displayName: getFenceTier(f.tierId)?.displayName ?? f.tierId })),
        traps: log.traps.map((t) => ({ ...t, displayName: getTrapType(t.typeId)?.displayName ?? t.typeId })),
      },
      stored: { rawBytes: row.raw_bytes, storedBytes: row.stored_bytes, encoding: row.encoding, sha256: row.log_sha256, contentHash: row.content_hash, createdAt: row.created_at.toISOString() },
      log,
    };
  });
}
