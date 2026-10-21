/**
 * Saved layouts (chunk 51), server side. The pure rules are @caravan/circle's layout.ts; this
 * file reads and writes the caravan's last layout (table caravan_layout, migration 032, keyed by
 * caravan, slot 0) around the trip loop:
 *
 *   rememberLayout  after a commit: the committed formation, normalised to its encounter's main
 *                   edge, becomes the caravan's last layout
 *   autoLoadDraft   after a choose: with no draft yet, the last layout turned to face the chosen
 *                   party becomes the draft, through the ordinary draft path (saveFormation), and
 *                   only when it validates; an existing draft is never replaced
 *   layoutView      what the formation read carries beside the draft: the loaded formation, what
 *                   was left out and why, the sides it was made against, and whether hints show
 *
 * Nothing here reads billing or spend state; the hint switch is the caravan's banked-trip count.
 */
import {
  ParseError,
  formationFromJson,
  layoutFromJson,
  loadLayout,
  manifestFromJson,
  saveLayout,
  savedSidesFacing,
  serializeFormation,
  serializeLayout,
  type EntryEdge,
  type LeftOut,
  type LoadedLayout,
  type SavedLayout,
} from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { BATTLEFIELD_VERSION } from "@caravan/resolver";
import type pg from "pg";
import type { Queryable } from "../db/pool.js";
import type { CaravanRow } from "../db/types.js";
import { chosenCandidate } from "../matchmaking/service.js";
import { findOpenTrip } from "../matchmaking/trips.js";
import { findFormation, findOpenManifest } from "./repo.js";
import { CircleValidationError, manifestFromRow, saveFormation } from "./service.js";

export const LAYOUT_HINTS_UNTIL_BANKS: number = TUNABLES.LAYOUT_HINTS_UNTIL_BANKS;
if (!Number.isInteger(LAYOUT_HINTS_UNTIL_BANKS) || LAYOUT_HINTS_UNTIL_BANKS < 0) throw new Error("TUNABLES.LAYOUT_HINTS_UNTIL_BANKS must be a non-negative integer");

export interface LayoutView {
  loaded: unknown;
  leftOut: readonly LeftOut[];
  savedSides: readonly EntryEdge[];
  hintsOn: boolean;
  unavailable: LoadedLayout["unavailable"];
}

/** Hints show while the caravan has banked fewer than LAYOUT_HINTS_UNTIL_BANKS trips (voided and overrun trips do not count). */
export async function layoutHintsOn(db: Queryable, caravanId: string): Promise<boolean> {
  const res = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM trip WHERE caravan_id = $1 AND end_reason = 'banked'", [caravanId]);
  return (res.rows[0]?.n ?? 0) < LAYOUT_HINTS_UNTIL_BANKS;
}

/** The caravan's last layout, or null. A row saved under another battlefield version keeps that version, so loadLayout refuses it. */
async function lastLayout(db: Queryable, caravanId: string): Promise<SavedLayout | null> {
  const res = await db.query<{ layout: unknown; battlefield_version: number }>("SELECT layout, battlefield_version FROM caravan_layout WHERE caravan_id = $1 AND slot = 0", [caravanId]);
  const row = res.rows[0];
  if (!row) return null;
  try {
    const saved = layoutFromJson(row.layout);
    return row.battlefield_version === BATTLEFIELD_VERSION ? saved : { ...saved, battlefieldVersion: row.battlefield_version };
  } catch (err) {
    if (err instanceof ParseError) return null;
    throw err;
  }
}

/** After encounter n is committed: its formation, against the survivors it was committed with and the chosen scout, becomes the last layout. */
export async function rememberLayout(client: pg.PoolClient, caravan: CaravanRow, encounterIndex: number): Promise<void> {
  const trip = await findOpenTrip(client, caravan.id);
  if (!trip) return;
  const chosen = await chosenCandidate(client, trip.id, encounterIndex);
  const row = await findFormation(client, trip.manifest_id, encounterIndex);
  if (!chosen || !row?.committed_at || !row.survivors_snapshot) return;
  const layout = saveLayout(formationFromJson(row.formation), manifestFromJson(row.survivors_snapshot), chosen.scout);
  await client.query(
    `INSERT INTO caravan_layout (caravan_id, slot, layout, battlefield_version) VALUES ($1, 0, $2::jsonb, $3)
     ON CONFLICT (caravan_id, slot) DO UPDATE SET layout = EXCLUDED.layout, battlefield_version = EXCLUDED.battlefield_version, updated_at = now()`,
    [caravan.id, serializeLayout(layout), layout.battlefieldVersion],
  );
}

/** The last layout turned to face encounter n's chosen party, from the current survivors; null when there is nothing to load against. */
async function loadedFor(db: Queryable, caravan: CaravanRow, encounterIndex: number): Promise<{ saved: SavedLayout; loaded: LoadedLayout; scout: Parameters<typeof loadLayout>[2] } | null> {
  const trip = await findOpenTrip(db, caravan.id);
  if (!trip) return null;
  const manifest = await findOpenManifest(db, caravan.id);
  const chosen = await chosenCandidate(db, trip.id, encounterIndex);
  const saved = await lastLayout(db, caravan.id);
  if (!manifest || !chosen || !saved) return null;
  return { saved, loaded: loadLayout(saved, manifestFromRow(manifest).survivors, chosen.scout), scout: chosen.scout };
}

/** After a choose: with no draft for encounter n, the loaded layout becomes the draft when it validates. */
export async function autoLoadDraft(client: pg.PoolClient, caravan: CaravanRow, encounterIndex: number): Promise<void> {
  const manifest = await findOpenManifest(client, caravan.id);
  if (!manifest || manifest.encounters_resolved + 1 !== encounterIndex) return;
  if (await findFormation(client, manifest.id, encounterIndex)) return;
  const l = await loadedFor(client, caravan, encounterIndex);
  if (!l || l.loaded.unavailable) return;
  try {
    await saveFormation(client, caravan, encounterIndex, JSON.parse(serializeFormation(l.loaded.formation)));
  } catch (err) {
    if (!(err instanceof CircleValidationError)) throw err;
  }
}

/** What the formation read carries for encounter n: null when nothing is saved, nothing is chosen, or n is committed. */
export async function layoutView(db: Queryable, caravan: CaravanRow, encounterIndex: number): Promise<LayoutView | null> {
  const manifest = await findOpenManifest(db, caravan.id);
  if (!manifest) return null;
  const row = await findFormation(db, manifest.id, encounterIndex);
  if (row?.committed_at) return null;
  const l = await loadedFor(db, caravan, encounterIndex);
  if (!l) return null;
  return {
    loaded: JSON.parse(serializeFormation(l.loaded.formation)),
    leftOut: l.loaded.leftOut,
    savedSides: l.loaded.unavailable ? [] : savedSidesFacing(l.saved, l.scout),
    hintsOn: await layoutHintsOn(db, caravan.id),
    unavailable: l.loaded.unavailable,
  };
}
