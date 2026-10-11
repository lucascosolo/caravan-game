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
 * side the viewer is on; the party version that fought), the outcome with its loot and the
 * owner's loot share, and the resolver version.
 *
 * Status, in order (QA-13 S1 / N1 / N2):
 *   - not yet resolved                         → 409 not_resolved (poll again)
 *   - parked (resolution unavailable)           → 409 resolution_unavailable (stop polling)
 *   - resolved, but no tick log was recorded     → 200, renderable: false, log: null, NO_LOG_REASON,
 *     `resolvedBy` (a resolver that writes none — the dev/test double), empty labels
 *   - resolved, log COMPACTED (PHASE-2 §36)      → 200, renderable: false, log: null, COMPACTED_REASON, and
 *     `compacted: {reason, compactedAt, logCreatedAt, tally}` — the results summary the
 *     retention job kept (encounter_log_summary, migration 022); outcome / depth as always
 *   - resolved with a log that is gone and no summary (pruned before migration 022)
 *                                                → 410 replay_expired (LOG_RETENTION)
 *   - otherwise                                  → 200 with the log; renderable says whether this
 *     server's reader accepts it, and `reason` why not.
 *
 * AUTHENTICITY (QA-13 S3): before the reader runs, the stored text's sha256 must equal both the
 * row's `log_sha256` and the sha256 the job's IMMUTABLE result recorded at completion
 * (`result.replay.sha256`), and the row's log_format / resolver_version must be the ones in the
 * log body. Any mismatch — or a body that will not decompress or parse — is `renderable: false`
 * with the reason, never a 500 and never a silently misrendered fight. The reader's verdict is
 * cached per verified sha256 (a stored log never changes), and the response is gzip-compressed
 * when the client accepts it (N3).
 *
 * Chunk 22 QA additions (no change to the resolver or the log format):
 *   - D1: `labels.siege` (the party's siege pieces, from the job's PARTY SNAPSHOT: type, display
 *     name, what each counters) and `labels.units[].stance` (each raider's targeting stance from
 *     the party snapshot, each post's defensive stance from the FORMATION snapshot, matched by the
 *     log label's `ref`), `labels.traps[].category` (what a siege piece can counter);
 *   - S8 / D3: `settled`, what this encounter settled for the VIEWER, itemized from the ledger
 *     events the job caused (replay/settled.ts) — never from the log;
 *   - N10: the party owner's body carries no `tripId`, no `stored` block and no caravan attrition
 *     in `outcome` (refs are still inside the sealed log, which cannot change without a format bump);
 *   - D2: `GET /me/encounters`, the caravan's fights within retention, newest first (replay/recent.ts).
 */
import { getFenceTier, getSiegeType, getTrapType, getUnitType } from "@caravan/content";
import { DEPTH_SCALE, READABLE_REPLAY_FORMATS, RESOLVER_VERSION, readReplay, type ReplayLog } from "@caravan/resolver";
import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { JOB_KIND_ENCOUNTER_RESOLUTION, getJob } from "../jobs/queue.js";
import type { EncounterJobInput } from "../jobs/handlers/encounterResolution.js";
import { recentFights } from "../replay/recent.js";
import { settledForEncounter } from "../replay/settled.js";
import { decompressLog, findEncounterLog, findEncounterLogSummary, type EncounterLogSummaryRow } from "../replay/store.js";
import { AppError } from "../services/errors.js";
import { partyLootShare } from "../trip/loot.js";
import type { EncounterOutcomeKind } from "../trip/outcome.js";
import { requireAuth } from "./require-auth.js";

const JOB_ID = /^encounter:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:[1-9]\d{0,5}$/;

/**
 * DEPTH_METRIC, machine-readable (N5): the player-facing sentence lives in the web client's
 * strings (apps/web/src/strings.ts `replay.depthExplained`), not here.
 */
export const DEPTH_MEASURE = { scale: DEPTH_SCALE, measuredFrom: "ring_line", lootCurve: "depth_pow_1_5" } as const;

/** Chunk 22 / QA-13 S1: why a fight resolved without a stored log (the dev/test double) has no replay. */
export const NO_LOG_REASON = "no replay log was recorded for this fight";

const NO_LABELS = { units: [], fences: [], traps: [] } as const;

/** PHASE-2 §36: why a compacted fight has no tick log (the web client words it for the player). */
export const COMPACTED_REASON = "this replay's tick log was compacted to its results summary (log retention)";

/** The compacted summary as the route sends it: the stored tally, with the deepest raider's display name. */
function compactedView(s: EncounterLogSummaryRow) {
  const t = s.summary.tally as (Record<string, unknown> & { deepest?: { u: number; side: string; typeId: string } | null }) | null;
  const deepest = t?.deepest ?? null;
  return {
    reason: s.reason,
    compactedAt: s.compacted_at.toISOString(),
    logCreatedAt: s.log_created_at.toISOString(),
    tally: t ? { ...t, deepest: deepest ? { ...deepest, displayName: getUnitType(deepest.typeId)?.displayName ?? deepest.typeId } : null } : null,
  };
}

const notFound = () => new AppError(404, "no_replay", "replay not found");

/** The reader's verdict per verified sha256 (N3). Bounded; a stored log never changes. */
const VERDICTS = new Map<string, string | null>();
const VERDICT_CACHE_MAX = 512;
function readerVerdict(sha: string, log: unknown): string | null {
  const hit = VERDICTS.get(sha);
  if (hit !== undefined) return hit;
  let reason: string | null = null;
  try {
    readReplay(log);
  } catch (err) {
    reason = err instanceof Error ? err.message : String(err);
  }
  if (VERDICTS.size >= VERDICT_CACHE_MAX) VERDICTS.delete(VERDICTS.keys().next().value as string);
  VERDICTS.set(sha, reason);
  return reason;
}

/** D1: the party's siege pieces as fought (the job's party snapshot), with what each counters. */
function siegeLabels(input: EncounterJobInput): { typeId: string; displayName: string; counters: { kind: string; category: string } | null }[] {
  const comp = (input.party?.composition ?? {}) as { siege?: { typeId?: unknown }[] };
  return (Array.isArray(comp.siege) ? comp.siege : []).flatMap((s) => {
    if (typeof s?.typeId !== "string") return [];
    const type = getSiegeType(s.typeId);
    return [{ typeId: s.typeId, displayName: type?.displayName ?? s.typeId, counters: type ? { kind: type.counters.kind, category: type.counters.category } : null }];
  });
}

/** D1: every fighter's stance by instance ref — raiders from the party snapshot, posts from the formation snapshot. */
function stancesByRef(input: EncounterJobInput): Map<string, string> {
  const out = new Map<string, string>();
  const comp = (input.party?.composition ?? {}) as { units?: { ref?: unknown; stance?: unknown }[] };
  for (const u of Array.isArray(comp.units) ? comp.units : []) if (typeof u?.ref === "string" && typeof u.stance === "string") out.set(`attacker|${u.ref}`, u.stance);
  for (const p of (input.formation?.posts ?? []) as { ref?: unknown; stance?: unknown }[]) if (typeof p?.ref === "string" && typeof p.stance === "string") out.set(`defender|${p.ref}`, p.stance);
  return out;
}

/** N10: what the party's owner is told about the outcome — never the caravan's attrition (its unit refs, traps, fences). */
const OWNER_OUTCOME_KEYS: readonly string[] = ["kind", "depth", "endTick", "loot", "end", "deepestUnit", "resolverVersion"];

interface StoredResult {
  outcome?: Record<string, unknown>;
  resolver?: string;
  replay?: { sha256?: string } | null;
}

export async function replayRoutes(app: FastifyInstance): Promise<void> {
  // D2: the caravan's fights still kept by the retention rule, newest first.
  app.get("/me/encounters", { preHandler: requireAuth }, async (req) => recentFights(app.db, req.auth!.account.id));

  app.get<{ Params: { jobId: string } }>("/me/encounters/:jobId/replay", { preHandler: requireAuth }, async (req, reply) => {
    const me = req.auth!.account.id;
    const jobId = req.params.jobId;
    if (!JOB_ID.test(jobId)) throw notFound();
    const job = await getJob(app.db, jobId);
    if (!job || job.kind !== JOB_KIND_ENCOUNTER_RESOLUTION) throw notFound();
    const input = job.input as EncounterJobInput;
    const viewer = input.defenderAccountId === me ? "caravan" : input.partyOwnerAccountId === me ? "party_owner" : null;
    if (viewer === null) throw notFound();
    if (job.status === "parked") throw new AppError(409, "resolution_unavailable", `encounter ${jobId} could not be resolved and will not be: no replay will exist`);
    if (job.status !== "completed") throw new AppError(409, "not_resolved", `encounter ${jobId} is ${job.status}, not resolved yet`);

    const result = (job.result ?? {}) as StoredResult;
    const outcome = result.outcome ?? null;
    const kind = typeof outcome?.["kind"] === "string" ? (outcome["kind"] as EncounterOutcomeKind) : null;
    const depth = typeof outcome?.["depth"] === "number" ? (outcome["depth"] as number) : null;
    let lootShare: number | null = null;
    if (kind !== null && depth !== null) {
      try {
        lootShare = partyLootShare(kind, depth);
      } catch {
        lootShare = null;
      }
    }
    const owner = viewer === "party_owner";
    const shownOutcome = outcome && owner ? Object.fromEntries(Object.entries(outcome).filter(([k]) => OWNER_OUTCOME_KEYS.includes(k))) : outcome;
    const settled = await settledForEncounter(app.db, { jobId, tripId: input.tripId, encounterIndex: input.encounterIndex, viewer, accountId: me });
    const siege = siegeLabels(input);
    const base = {
      jobId,
      viewer,
      tripId: owner ? null : input.tripId,
      encounterIndex: input.encounterIndex,
      currentResolverVersion: RESOLVER_VERSION,
      outcome: shownOutcome,
      depth: { ...DEPTH_MEASURE, value: depth, lootShare },
      // The party version that fought (chunk 09 QA N3), from the job's snapshot — never the live row.
      party: { partyId: input.party.partyId, partyHash: input.party.hash, partySavedAt: input.party.savedAt },
      settled,
    };
    const noLabels = { ...NO_LABELS, siege };
    const send = (body: unknown) => {
      // N3: compress the (up to a few hundred KB) JSON when the client accepts gzip.
      const accepts = String(req.headers["accept-encoding"] ?? "");
      if (!/\bgzip\b/.test(accepts)) return body;
      reply.header("content-encoding", "gzip").header("content-type", "application/json; charset=utf-8").header("vary", "accept-encoding");
      return reply.send(gzipSync(Buffer.from(JSON.stringify(body), "utf8")));
    };

    // S1: a resolver that records no tick log (the dev/test double) — honest, not "expired".
    if (!result.replay) {
      return send({
        ...base,
        resolverVersion: null,
        logFormat: null,
        renderable: false,
        reason: NO_LOG_REASON,
        resolvedBy: result.resolver ?? null,
        labels: noLabels,
        stored: null,
        log: null,
      });
    }
    const row = await findEncounterLog(app.db, jobId);
    if (!row) {
      // PHASE-2 §36: past retention (or over the size budget) the log is compacted to its summary.
      const s = await findEncounterLogSummary(app.db, jobId);
      if (!s) throw new AppError(410, "replay_expired", "this replay is past its retention window");
      return send({
        ...base,
        resolverVersion: s.resolver_version,
        logFormat: s.log_format,
        renderable: false,
        reason: COMPACTED_REASON,
        labels: noLabels,
        // As for a stored log: the storage metadata is the caravan side's only.
        stored: owner ? null : { rawBytes: s.raw_bytes, storedBytes: s.stored_bytes, encoding: null, sha256: s.log_sha256, contentHash: s.content_hash, createdAt: s.log_created_at.toISOString() },
        compacted: compactedView(s),
        log: null,
      });
    }

    const stored = owner ? null : { rawBytes: row.raw_bytes, storedBytes: row.stored_bytes, encoding: row.encoding, sha256: row.log_sha256, contentHash: row.content_hash, createdAt: row.created_at.toISOString() };
    const unrenderable = (reason: string, log: unknown = null) =>
      send({ ...base, resolverVersion: row.resolver_version, logFormat: row.log_format, renderable: false, reason, labels: noLabels, stored, log });

    // N1: an undecodable body is a verdict, not a 500.
    let text: string;
    let log: ReplayLog;
    try {
      text = decompressLog(row);
      log = JSON.parse(text) as ReplayLog;
    } catch (err) {
      return unrenderable(`the stored log cannot be decoded: ${err instanceof Error ? err.message : String(err)}`);
    }
    // S3: the text must be the one the job's completion recorded.
    const sha = createHash("sha256").update(text).digest("hex");
    if (sha !== row.log_sha256 || sha !== result.replay.sha256) {
      return unrenderable(`the stored log's sha256 ${sha.slice(0, 12)}… does not match the one recorded when the encounter was resolved (${String(result.replay.sha256).slice(0, 12)}…): it was altered`);
    }
    if (log === null || typeof log !== "object" || log.v !== row.log_format || log.resolverVersion !== row.resolver_version) {
      return unrenderable(`the stored log's format / resolver version do not match its row (v${row.log_format}, resolver v${row.resolver_version})`);
    }
    if (!READABLE_REPLAY_FORMATS.includes(row.log_format)) {
      return unrenderable(`log format v${row.log_format} (resolver v${row.resolver_version}) is not readable by this server's replay reader (reads ${READABLE_REPLAY_FORMATS.join(", ")})`, log);
    }
    const reason = readerVerdict(sha, log);
    if (reason !== null) return unrenderable(reason, log);
    const stances = stancesByRef(input);
    return send({
      ...base,
      resolverVersion: row.resolver_version,
      logFormat: row.log_format,
      renderable: true,
      reason: null,
      labels: {
        units: log.units.map((u) => ({
          ...u,
          displayName: getUnitType(u.typeId)?.displayName ?? u.typeId,
          ability: getUnitType(u.typeId)?.ability.displayName ?? null,
          stance: stances.get(`${u.side}|${u.ref}`) ?? null,
        })),
        fences: log.fences.map((f) => ({ ...f, displayName: getFenceTier(f.tierId)?.displayName ?? f.tierId })),
        traps: log.traps.map((t) => ({ ...t, displayName: getTrapType(t.typeId)?.displayName ?? t.typeId, category: getTrapType(t.typeId)?.category ?? null })),
        siege,
      },
      stored,
      log,
    });
  });
}
