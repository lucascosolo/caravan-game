/**
 * Row access for the wagon circle tables (migration 004). Plain SQL; the lock semantics
 * live in the database triggers and in service.ts, not here.
 */
import type { Queryable } from "../db/pool.js";

export interface WagonManifestRow {
  id: string;
  caravan_id: string;
  packed: Record<string, unknown>;
  survivors: Record<string, unknown>;
  encounters_resolved: number;
  created_at: Date;
  closed_at: Date | null;
}

export interface WagonFormationRow {
  manifest_id: string;
  encounter_index: number;
  formation: Record<string, unknown>;
  formation_hash: string;
  updated_at: Date;
  committed_at: Date | null;
}

export async function insertManifest(db: Queryable, input: { caravanId: string; packedJson: string }): Promise<WagonManifestRow> {
  const res = await db.query<WagonManifestRow>(
    `INSERT INTO wagon_manifest (caravan_id, packed, survivors) VALUES ($1, $2::jsonb, $2::jsonb) RETURNING *`,
    [input.caravanId, input.packedJson],
  );
  return res.rows[0]!;
}

export async function findOpenManifest(db: Queryable, caravanId: string, forUpdate = false): Promise<WagonManifestRow | null> {
  const res = await db.query<WagonManifestRow>(
    `SELECT * FROM wagon_manifest WHERE caravan_id = $1 AND closed_at IS NULL${forUpdate ? " FOR UPDATE" : ""}`,
    [caravanId],
  );
  return res.rows[0] ?? null;
}

export async function findManifestById(db: Queryable, id: string, forUpdate = false): Promise<WagonManifestRow | null> {
  const res = await db.query<WagonManifestRow>(`SELECT * FROM wagon_manifest WHERE id = $1${forUpdate ? " FOR UPDATE" : ""}`, [id]);
  return res.rows[0] ?? null;
}

/** The only writer of `survivors`: folds one encounter's attrition in and advances the counter. */
export async function updateSurvivors(
  db: Queryable,
  input: { manifestId: string; survivorsJson: string; encountersResolved: number },
): Promise<WagonManifestRow> {
  const res = await db.query<WagonManifestRow>(
    `UPDATE wagon_manifest SET survivors = $2::jsonb, encounters_resolved = $3 WHERE id = $1 RETURNING *`,
    [input.manifestId, input.survivorsJson, input.encountersResolved],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`wagon_manifest ${input.manifestId} not found`);
  return row;
}

export async function closeManifestRow(db: Queryable, manifestId: string): Promise<WagonManifestRow> {
  const res = await db.query<WagonManifestRow>(
    `UPDATE wagon_manifest SET closed_at = now() WHERE id = $1 AND closed_at IS NULL RETURNING *`,
    [manifestId],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`wagon_manifest ${manifestId} not found or already closed`);
  return row;
}

export async function findFormation(db: Queryable, manifestId: string, encounterIndex: number, forUpdate = false): Promise<WagonFormationRow | null> {
  const res = await db.query<WagonFormationRow>(
    `SELECT * FROM wagon_formation WHERE manifest_id = $1 AND encounter_index = $2${forUpdate ? " FOR UPDATE" : ""}`,
    [manifestId, encounterIndex],
  );
  return res.rows[0] ?? null;
}

export async function listFormations(db: Queryable, manifestId: string): Promise<WagonFormationRow[]> {
  const res = await db.query<WagonFormationRow>(
    `SELECT * FROM wagon_formation WHERE manifest_id = $1 ORDER BY encounter_index`,
    [manifestId],
  );
  return res.rows;
}

/** Insert or re-save a draft. The trigger refuses this once the row is committed. */
export async function upsertDraftFormation(
  db: Queryable,
  input: { manifestId: string; encounterIndex: number; formationJson: string; hash: string },
): Promise<WagonFormationRow> {
  const res = await db.query<WagonFormationRow>(
    `INSERT INTO wagon_formation (manifest_id, encounter_index, formation, formation_hash)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (manifest_id, encounter_index)
     DO UPDATE SET formation = EXCLUDED.formation, formation_hash = EXCLUDED.formation_hash
     RETURNING *`,
    [input.manifestId, input.encounterIndex, input.formationJson, input.hash],
  );
  return res.rows[0]!;
}

export async function commitFormationRow(db: Queryable, manifestId: string, encounterIndex: number): Promise<WagonFormationRow> {
  const res = await db.query<WagonFormationRow>(
    `UPDATE wagon_formation SET committed_at = now() WHERE manifest_id = $1 AND encounter_index = $2 AND committed_at IS NULL RETURNING *`,
    [manifestId, encounterIndex],
  );
  const row = res.rows[0];
  if (!row) throw new Error(`wagon_formation ${manifestId}/${encounterIndex} not found or already committed`);
  return row;
}
