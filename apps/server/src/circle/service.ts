/**
 * Wagon circle service (chunk 07): the server-side boundary where every rule is enforced
 * — slot caps, material budget, access, manifest membership, overlaps, bounds, the two
 * lifetimes and carry-forward. The pure rules live in @caravan/circle; this file applies
 * them to a caravan's rows inside transactions and maps failures to HTTP errors.
 *
 *   lockManifest        town → trail: pack and lock the loadout (one open manifest per caravan)
 *   saveFormation       draft the arrangement for the NEXT encounter; re-save freely
 *   commitFormation     freeze it; the stored canonical snapshot is what gets resolved
 *   applyOutcome        fold a resolved encounter's attrition into `survivors` (no route:
 *                       only the resolution path — chunk 13/15 — may report an outcome)
 *   closeManifest       trip end (chunk 15 calls it on bank or overrun)
 *
 * Nothing here touches caravan.state or the trip cap: chunk 15 owns trip start/end and
 * composes these calls inside its own transaction.
 */
import {
  applyEncounterOutcome,
  formationFromJson,
  formationGaps,
  manifestFromJson,
  manifestSummary,
  packManifest,
  ParseError,
  serializeFormation,
  serializeManifest,
  toBattlefield,
  validateFormation,
  type Battlefield,
  type EncounterOutcome,
  type Formation,
  type Issue,
  type Manifest,
} from "@caravan/circle";
import { createHash } from "node:crypto";
import type pg from "pg";
import type { CaravanRow } from "../db/types.js";
import { listUnitInstancesForCaravan } from "../repo/unitInstances.js";
import { AppError, badRequest, conflict } from "../services/errors.js";
import { accessCheckFor, type AccessOwner } from "./access.js";
import {
  closeManifestRow,
  commitFormationRow,
  findFormation,
  findManifestById,
  findOpenManifest,
  insertManifest,
  listFormations,
  updateSurvivors,
  upsertDraftFormation,
  type WagonFormationRow,
  type WagonManifestRow,
} from "./repo.js";

export const notFound = (code: string, message: string) => new AppError(404, code, message);

export interface PackRequest {
  /** unit_instance ids owned by the caravan. */
  readonly units: readonly string[];
  /** Trap type ids. */
  readonly traps: readonly string[];
  readonly fence: { readonly tierId: string; readonly count: number } | null;
}

export interface ManifestView {
  id: string;
  caravanId: string;
  encountersResolved: number;
  createdAt: string;
  closedAt: string | null;
  packed: Manifest;
  survivors: Manifest;
  summary: ReturnType<typeof manifestSummary>;
  formations: { encounterIndex: number; hash: string; committedAt: string | null }[];
}

export interface FormationView {
  manifestId: string;
  encounterIndex: number;
  formation: Formation;
  hash: string;
  gaps: readonly number[];
  committedAt: string | null;
}

export function formationHash(canonical: string): string {
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function ownerOf(caravan: CaravanRow): AccessOwner {
  return { accountId: caravan.account_id, caravanId: caravan.id, regionId: caravan.region_id };
}

/** A 400 that carries the full issue list, so the UI can show every problem at once. */
export class CircleValidationError extends AppError {
  constructor(
    code: string,
    message: string,
    public readonly issues: readonly Issue[],
  ) {
    super(400, code, message);
    this.name = "CircleValidationError";
  }
}

function invalid(code: string, message: string, issues: readonly Issue[]): CircleValidationError {
  return new CircleValidationError(code, message, issues);
}

export function manifestFromRow(row: WagonManifestRow): { packed: Manifest; survivors: Manifest } {
  return { packed: manifestFromJson(row.packed), survivors: manifestFromJson(row.survivors) };
}

export async function manifestView(db: pg.Pool | pg.PoolClient, row: WagonManifestRow): Promise<ManifestView> {
  const { packed, survivors } = manifestFromRow(row);
  const formations = await listFormations(db, row.id);
  return {
    id: row.id,
    caravanId: row.caravan_id,
    encountersResolved: row.encounters_resolved,
    createdAt: row.created_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
    packed,
    survivors,
    summary: manifestSummary(survivors),
    formations: formations.map((f) => ({ encounterIndex: f.encounter_index, hash: f.formation_hash, committedAt: f.committed_at ? f.committed_at.toISOString() : null })),
  };
}

function formationView(row: WagonFormationRow): FormationView {
  const formation = formationFromJson(row.formation);
  return {
    manifestId: row.manifest_id,
    encounterIndex: row.encounter_index,
    formation,
    hash: row.formation_hash,
    gaps: formationGaps(formation),
    committedAt: row.committed_at ? row.committed_at.toISOString() : null,
  };
}

/**
 * Pack and lock. Units must be instances the caravan owns (bounded stakes: a trip can only
 * risk what was packed, and only this caravan's units can be packed). Refuses if the
 * caravan already has an open manifest.
 */
export async function lockManifest(client: pg.PoolClient, caravan: CaravanRow, req: PackRequest): Promise<WagonManifestRow> {
  await client.query("SELECT id FROM caravan WHERE id = $1 FOR UPDATE", [caravan.id]);
  if (await findOpenManifest(client, caravan.id)) {
    throw conflict("manifest_open", "this caravan already has a locked manifest; it is on a trip");
  }
  const owned = new Map((await listUnitInstancesForCaravan(client, caravan.id)).map((u) => [u.id, u]));
  const units = [];
  for (const id of req.units) {
    const row = owned.get(id);
    if (!row) throw badRequest("unknown_unit", `unit instance '${id}' is not in this caravan's roster`);
    units.push({ instanceId: row.id, typeId: row.unit_type_id, mergeLevel: row.merge_level });
  }
  const packed = packManifest({ units, traps: req.traps, fence: req.fence }, accessCheckFor(ownerOf(caravan)));
  if (!packed.ok) throw invalid("invalid_manifest", "the loadout cannot be packed", packed.issues);
  return insertManifest(client, { caravanId: caravan.id, packedJson: serializeManifest(packed.value) });
}

export async function getOpenManifest(db: pg.Pool | pg.PoolClient, caravanId: string): Promise<WagonManifestRow> {
  const row = await findOpenManifest(db, caravanId);
  if (!row) throw notFound("no_open_manifest", "this caravan is in town with nothing packed");
  return row;
}

function requireNextEncounter(manifest: WagonManifestRow, encounterIndex: number): void {
  if (!Number.isInteger(encounterIndex) || encounterIndex < 1) throw badRequest("bad_encounter", "encounter index must be a positive integer");
  if (manifest.closed_at) throw conflict("manifest_closed", "this trip has ended");
  const next = manifest.encounters_resolved + 1;
  if (encounterIndex !== next) {
    throw conflict("wrong_encounter", `the caravan is arranging for encounter ${next}, not ${encounterIndex}`);
  }
}

/** Draft (or re-draft) the formation for the next encounter. Validated against what survives. */
export async function saveFormation(
  client: pg.PoolClient,
  caravan: CaravanRow,
  encounterIndex: number,
  body: unknown,
): Promise<FormationView> {
  let formation: Formation;
  try {
    formation = formationFromJson(body);
  } catch (err) {
    if (err instanceof ParseError) throw badRequest("malformed_formation", err.message);
    throw err;
  }
  const manifest = await findOpenManifest(client, caravan.id, true);
  if (!manifest) throw notFound("no_open_manifest", "this caravan is in town with nothing packed");
  requireNextEncounter(manifest, encounterIndex);
  const existing = await findFormation(client, manifest.id, encounterIndex, true);
  if (existing?.committed_at) throw conflict("formation_committed", "this encounter's formation is committed and cannot change");
  const { survivors } = manifestFromRow(manifest);
  const res = validateFormation(survivors, formation, accessCheckFor(ownerOf(caravan)));
  if (!res.ok) throw invalid("invalid_formation", "the formation is not legal", res.issues);
  const canonical = serializeFormation(res.value);
  const row = await upsertDraftFormation(client, { manifestId: manifest.id, encounterIndex, formationJson: canonical, hash: formationHash(canonical) });
  return formationView(row);
}

export async function getFormation(db: pg.Pool | pg.PoolClient, caravan: CaravanRow, encounterIndex: number): Promise<FormationView> {
  const manifest = await getOpenManifest(db, caravan.id);
  const row = await findFormation(db, manifest.id, encounterIndex);
  if (!row) throw notFound("no_formation", `no formation for encounter ${encounterIndex}`);
  return formationView(row);
}

/**
 * Commit: re-validate the draft against the current survivors (they cannot have changed
 * without an outcome, but the check is cheap and the boundary is here), then freeze.
 * Idempotent: committing an already-committed formation returns it unchanged.
 */
export async function commitFormation(client: pg.PoolClient, caravan: CaravanRow, encounterIndex: number): Promise<FormationView> {
  const manifest = await findOpenManifest(client, caravan.id, true);
  if (!manifest) throw notFound("no_open_manifest", "this caravan is in town with nothing packed");
  requireNextEncounter(manifest, encounterIndex);
  const draft = await findFormation(client, manifest.id, encounterIndex, true);
  if (!draft) throw conflict("no_draft", "arrange the circle before committing it");
  if (draft.committed_at) return formationView(draft);
  const { survivors } = manifestFromRow(manifest);
  const res = validateFormation(survivors, formationFromJson(draft.formation), accessCheckFor(ownerOf(caravan)));
  if (!res.ok) throw invalid("invalid_formation", "the formation is not legal", res.issues);
  const canonical = serializeFormation(res.value);
  if (formationHash(canonical) !== draft.formation_hash) throw new Error("stored formation does not match its hash");
  return formationView(await commitFormationRow(client, manifest.id, encounterIndex));
}

/** The resolver's view of a committed encounter. */
export async function battlefieldForEncounter(db: pg.Pool | pg.PoolClient, manifestId: string, encounterIndex: number): Promise<Battlefield> {
  const manifest = await findManifestById(db, manifestId);
  if (!manifest) throw notFound("no_manifest", "manifest not found");
  const row = await findFormation(db, manifestId, encounterIndex);
  if (!row?.committed_at) throw conflict("not_committed", "only a committed formation can be resolved");
  return toBattlefield(manifestFromRow(manifest).survivors, formationFromJson(row.formation));
}

/**
 * Fold a resolved encounter into the manifest. NOT exposed as a route: the only legitimate
 * source of an outcome is the resolution job (chunks 13/15), never a client. Requires the
 * encounter's formation to be committed and to be the next unresolved one.
 */
export async function applyOutcome(
  client: pg.PoolClient,
  manifestId: string,
  encounterIndex: number,
  outcome: EncounterOutcome,
): Promise<WagonManifestRow> {
  const manifest = await findManifestById(client, manifestId, true);
  if (!manifest) throw notFound("no_manifest", "manifest not found");
  requireNextEncounter(manifest, encounterIndex);
  const row = await findFormation(client, manifestId, encounterIndex);
  if (!row?.committed_at) throw conflict("not_committed", "an outcome can only be applied to a committed formation");
  const next = applyEncounterOutcome(manifestFromRow(manifest).survivors, outcome);
  return updateSurvivors(client, { manifestId, survivorsJson: serializeManifest(next), encountersResolved: encounterIndex });
}

/** Trip end. Chunk 15 decides when; the restore-on-bank refit happens in town, not here. */
export async function closeManifest(client: pg.PoolClient, manifestId: string): Promise<WagonManifestRow> {
  const manifest = await findManifestById(client, manifestId, true);
  if (!manifest) throw notFound("no_manifest", "manifest not found");
  if (manifest.closed_at) return manifest;
  return closeManifestRow(client, manifestId);
}
