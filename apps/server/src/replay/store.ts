/**
 * Chunk 13 — stored replays (`encounter_log`, migration 013).
 *
 * The worker writes the resolver's log here in the SAME transaction as the job's completion
 * and its ledger events (QA-15 S2): gzip-compressed JSON of the ReplayLog
 * (packages/resolver/src/replay.ts), with the resolver version, the log format, the sizes and
 * the sha256s of the input snapshots it was resolved from. The job's input — formation,
 * survivors, party snapshot — is immutable in resolution_job, so the log is stored ALONGSIDE
 * the layout and loadout snapshots without copying them, and a party owner editing the party
 * afterwards cannot change what a replay shows.
 *
 * LOG_RETENTION (content tunables): a row is pruned once it is older than
 * LOG_RETENTION_DAYS AND not among its caravan's newest LOG_RETENTION_MIN_PER_CARAVAN — the
 * "whichever is larger" of the two windows. The prune runs for the caravan just written to,
 * inside the same transaction; nothing ticks in the background.
 *
 * WRITE ONCE, BY THE RESOLUTION PATH ONLY (QA-13 S4, migration 016). The app role has no
 * INSERT, UPDATE or DELETE on encounter_log. A row goes in through `encounter_log_write`
 * (SECURITY DEFINER: the caller must hold the job's live lease at its attempt; the insert guard
 * checks caravan, defender, party owner, resolver version and content hash against the job, and
 * stamps created_at; a second write for one job is a unique violation — never DO NOTHING, so a
 * row planted earlier can never stand in for the real log) and leaves through
 * `encounter_log_prune` (the retention rule on the database clock, with the window read from
 * the constant `encounter_log_retention` row, which a test pins to the tunables).
 */
import { TUNABLES } from "@caravan/content";
import { gunzipSync, gzipSync } from "node:zlib";
import type pg from "pg";
import type { Queryable } from "../db/pool.js";
import type { LeaseFence } from "../jobs/queue.js";
import type { EncounterLogArtifact } from "../jobs/worker.js";

export const LOG_ENCODING = "gzip" as const;

export interface EncounterLogRow {
  job_id: string;
  caravan_id: string;
  defender_account_id: string;
  party_owner_account_id: string;
  resolver_version: number;
  log_format: number;
  encoding: string;
  log: Buffer;
  raw_bytes: number;
  stored_bytes: number;
  log_sha256: string;
  formation_sha256: string;
  survivors_sha256: string;
  party_sha256: string;
  content_hash: string;
  created_at: Date;
}

/** gzip at a fixed level: the same text always compresses to the same bytes on one zlib. */
export function compressLog(text: string): Buffer {
  return gzipSync(Buffer.from(text, "utf8"), { level: 9 });
}

export function decompressLog(row: Pick<EncounterLogRow, "encoding" | "log">): string {
  if (row.encoding !== LOG_ENCODING) throw new Error(`unknown log encoding '${row.encoding}'`);
  return gunzipSync(row.log).toString("utf8");
}

/**
 * Write a completed encounter's log (once) and prune the caravan's expired logs, both through the
 * owner's definer functions, inside the completion transaction. `fence` is the worker's lease.
 */
/** Returns the stored (compressed) size in bytes. */
export async function storeEncounterLog(client: pg.PoolClient, a: EncounterLogArtifact, fence: LeaseFence): Promise<number> {
  const stored = compressLog(a.text);
  await client.query(
    `SELECT encounter_log_write($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [a.jobId, fence.workerId, fence.attempts, a.caravanId, a.defenderAccountId, a.partyOwnerAccountId, a.resolverVersion, a.logFormat, LOG_ENCODING, stored, Buffer.byteLength(a.text, "utf8"), a.sha256, a.formationSha256, a.survivorsSha256, a.partySha256, a.contentHash],
  );
  return stored.length;
}

/**
 * LOG_RETENTION for one caravan (encounter_log_prune): COMPACT (PHASE-2 §36, migration 022) the
 * caravan's logs older than the retention days that are not among its newest N, and any log over
 * LOG_SIZE_BUDGET, to their results summary (encounter_log_summary), by the database clock. Only
 * completed jobs' logs (the summary is read from the job's result). Returns the number of rows
 * compacted. The window and the budget are the constant row, never a parameter.
 */
export async function pruneEncounterLogs(db: Queryable, caravanId: string): Promise<number> {
  const res = await db.query<{ n: number }>("SELECT encounter_log_prune($1) AS n", [caravanId]);
  return res.rows[0]?.n ?? 0;
}

/**
 * PHASE-2 §36: the scheduled retention sweep's one step (encounter_log_retention_sweep) — the
 * same rule as the prune, across every caravan, oldest first, at most `limit` (1..5000) rows.
 * Returns the number compacted; the caller loops while it returns `limit`.
 */
export async function sweepEncounterLogRetention(db: Queryable, limit: number): Promise<number> {
  const res = await db.query<{ n: number }>("SELECT encounter_log_retention_sweep($1) AS n", [limit]);
  return res.rows[0]?.n ?? 0;
}

/** The retention row the database enforces (a test pins it to TUNABLES). */
export async function encounterLogRetention(db: Queryable): Promise<{ days: number; minPerCaravan: number; sizeBudgetBytes: number }> {
  const res = await db.query<{ days: number; min_per_caravan: number; size_budget_bytes: number }>("SELECT days, min_per_caravan, size_budget_bytes FROM encounter_log_retention WHERE singleton");
  const r = res.rows[0];
  if (!r) throw new Error("encounter_log_retention is empty");
  return { days: r.days, minPerCaravan: r.min_per_caravan, sizeBudgetBytes: r.size_budget_bytes };
}

/** Whether the database's retention row equals the tunables (LOG_RETENTION_DAYS, LOG_RETENTION_MIN_PER_CARAVAN, LOG_SIZE_BUDGET_BYTES). */
export function retentionMatchesTunables(r: { days: number; minPerCaravan: number; sizeBudgetBytes?: number }): boolean {
  return (
    r.days === TUNABLES.LOG_RETENTION_DAYS &&
    r.minPerCaravan === TUNABLES.LOG_RETENTION_MIN_PER_CARAVAN &&
    (r.sizeBudgetBytes === undefined || r.sizeBudgetBytes === TUNABLES.LOG_SIZE_BUDGET_BYTES)
  );
}

/** A compacted replay's results summary (migration 022). */
export interface EncounterLogSummaryRow {
  job_id: string;
  caravan_id: string;
  defender_account_id: string;
  party_owner_account_id: string;
  reason: "retention" | "size_budget";
  resolver_version: number;
  log_format: number;
  raw_bytes: number;
  stored_bytes: number;
  log_sha256: string;
  content_hash: string;
  log_created_at: Date;
  compacted_at: Date;
  summary: { outcome: Record<string, unknown> | null; tally: Record<string, unknown> | null };
}

export async function findEncounterLogSummary(db: Queryable, jobId: string): Promise<EncounterLogSummaryRow | null> {
  const res = await db.query<EncounterLogSummaryRow>("SELECT * FROM encounter_log_summary WHERE job_id = $1", [jobId]);
  return res.rows[0] ?? null;
}

export async function findEncounterLog(db: Queryable, jobId: string): Promise<EncounterLogRow | null> {
  const res = await db.query<EncounterLogRow>("SELECT * FROM encounter_log WHERE job_id = $1", [jobId]);
  return res.rows[0] ?? null;
}
