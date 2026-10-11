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
 * WRITE ONCE, BY THE RESOLUTION PATH ONLY (QA-13 S4, migration 015). The app role has no
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
export async function storeEncounterLog(client: pg.PoolClient, a: EncounterLogArtifact, fence: LeaseFence): Promise<void> {
  const stored = compressLog(a.text);
  await client.query(
    `SELECT encounter_log_write($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [a.jobId, fence.workerId, fence.attempts, a.caravanId, a.defenderAccountId, a.partyOwnerAccountId, a.resolverVersion, a.logFormat, LOG_ENCODING, stored, Buffer.byteLength(a.text, "utf8"), a.sha256, a.formationSha256, a.survivorsSha256, a.partySha256, a.contentHash],
  );
}

/**
 * LOG_RETENTION for one caravan (encounter_log_prune): delete logs older than the retention
 * days that are not among the caravan's newest N, by the database clock. Returns the number of
 * rows removed. The window is the constant row, never a parameter.
 */
export async function pruneEncounterLogs(db: Queryable, caravanId: string): Promise<number> {
  const res = await db.query<{ n: number }>("SELECT encounter_log_prune($1) AS n", [caravanId]);
  return res.rows[0]?.n ?? 0;
}

/** The retention row the database enforces (a test pins it to TUNABLES). */
export async function encounterLogRetention(db: Queryable): Promise<{ days: number; minPerCaravan: number }> {
  const res = await db.query<{ days: number; min_per_caravan: number }>("SELECT days, min_per_caravan FROM encounter_log_retention WHERE singleton");
  const r = res.rows[0];
  if (!r) throw new Error("encounter_log_retention is empty");
  return { days: r.days, minPerCaravan: r.min_per_caravan };
}

/** Whether the database's retention row equals the tunables (LOG_RETENTION_DAYS, LOG_RETENTION_MIN_PER_CARAVAN). */
export function retentionMatchesTunables(r: { days: number; minPerCaravan: number }): boolean {
  return r.days === TUNABLES.LOG_RETENTION_DAYS && r.minPerCaravan === TUNABLES.LOG_RETENTION_MIN_PER_CARAVAN;
}

export async function findEncounterLog(db: Queryable, jobId: string): Promise<EncounterLogRow | null> {
  const res = await db.query<EncounterLogRow>("SELECT * FROM encounter_log WHERE job_id = $1", [jobId]);
  return res.rows[0] ?? null;
}
