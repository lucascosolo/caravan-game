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
 */
import { TUNABLES } from "@caravan/content";
import { gunzipSync, gzipSync } from "node:zlib";
import type pg from "pg";
import type { Queryable } from "../db/pool.js";
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

/** Insert (idempotent on job id: a completed job's log is written once) and prune this caravan's expired logs. */
export async function storeEncounterLog(client: pg.PoolClient, a: EncounterLogArtifact): Promise<void> {
  const stored = compressLog(a.text);
  await client.query(
    `INSERT INTO encounter_log (job_id, caravan_id, defender_account_id, party_owner_account_id, resolver_version, log_format, encoding, log,
                                raw_bytes, stored_bytes, log_sha256, formation_sha256, survivors_sha256, party_sha256, content_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
     ON CONFLICT (job_id) DO NOTHING`,
    [a.jobId, a.caravanId, a.defenderAccountId, a.partyOwnerAccountId, a.resolverVersion, a.logFormat, LOG_ENCODING, stored, Buffer.byteLength(a.text, "utf8"), stored.length, a.sha256, a.formationSha256, a.survivorsSha256, a.partySha256, a.contentHash],
  );
  await pruneEncounterLogs(client, a.caravanId);
}

/**
 * LOG_RETENTION for one caravan: delete logs older than LOG_RETENTION_DAYS that are not among
 * the caravan's newest LOG_RETENTION_MIN_PER_CARAVAN. `asOf` defaults to the database clock.
 * Returns the number of rows removed.
 */
export async function pruneEncounterLogs(db: Queryable, caravanId: string, asOf?: Date): Promise<number> {
  const res = await db.query(
    `DELETE FROM encounter_log l
      WHERE l.caravan_id = $1
        AND l.created_at < COALESCE($2::timestamptz, now()) - make_interval(days => $3::int)
        AND l.job_id NOT IN (
          SELECT job_id FROM encounter_log WHERE caravan_id = $1 ORDER BY created_at DESC, job_id DESC LIMIT $4::int
        )`,
    [caravanId, asOf ?? null, TUNABLES.LOG_RETENTION_DAYS, TUNABLES.LOG_RETENTION_MIN_PER_CARAVAN],
  );
  return res.rowCount ?? 0;
}

export async function findEncounterLog(db: Queryable, jobId: string): Promise<EncounterLogRow | null> {
  const res = await db.query<EncounterLogRow>("SELECT * FROM encounter_log WHERE job_id = $1", [jobId]);
  return res.rows[0] ?? null;
}
