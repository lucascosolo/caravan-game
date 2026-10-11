/**
 * Cosmetic ownership and the equip preference (PHASE-2 §28, minimal version, chunk 20).
 * ACCOUNT-level (GUARDRAILS §5). A preference and nothing else: no formation, manifest,
 * party, job or resolver input references these rows or could carry their content
 * (packages/circle/test/no-cosmetic-field.test.ts); the client reads the equip map to
 * decide what to DRAW. Only an owned cosmetic can be equipped (FK), one per slot.
 */
import { COSMETIC_KINDS, COSMETIC_TYPES, cosmeticEquipSlot, getCosmeticType, isCosmeticKind, isUnitTypeId, weekIndexAt, type CosmeticKind } from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import { AppError, badRequest, conflict } from "../services/errors.js";
import { cosmeticView, nextOffer, type CosmeticView } from "./offers.js";

const notFound = (code: string, message: string) => new AppError(404, code, message);

export interface OwnedCosmeticView extends CosmeticView {
  purchaseId: string;
  grantedAt: string;
  equipped: boolean;
}

export interface CatalogEntryView extends CosmeticView {
  owned: boolean;
  /** When it is next on offer from the current week, within a year, or null. */
  nextOffer: { weekIndex: number; tier: number } | null;
}

export interface CosmeticsView {
  kinds: readonly CosmeticKind[];
  owned: OwnedCosmeticView[];
  /** slot → cosmetic id. */
  equipped: Record<string, string>;
  catalog: CatalogEntryView[];
}

interface OwnershipRow {
  cosmetic_id: string;
  kind: string;
  purchase_id: string;
  granted_at: Date;
}
interface EquipRow {
  slot: string;
  cosmetic_id: string;
}

export async function readEquipped(db: Queryable, accountId: string): Promise<Record<string, string>> {
  const res = await db.query<EquipRow>("SELECT slot, cosmetic_id FROM cosmetic_equip WHERE account_id = $1 ORDER BY slot", [accountId]);
  const out: Record<string, string> = {};
  for (const r of res.rows) out[r.slot] = r.cosmetic_id;
  return out;
}

export async function listCosmetics(db: Queryable, accountId: string, nowMs: number): Promise<CosmeticsView> {
  const week = weekIndexAt(nowMs);
  const owned = await db.query<OwnershipRow>("SELECT cosmetic_id, kind, purchase_id, granted_at FROM cosmetic_ownership WHERE account_id = $1 ORDER BY cosmetic_id", [accountId]);
  const equipped = await readEquipped(db, accountId);
  const equippedIds = new Set(Object.values(equipped));
  const ownedIds = new Set(owned.rows.map((r) => r.cosmetic_id));
  const ownedViews: OwnedCosmeticView[] = [];
  for (const r of owned.rows) {
    const c = getCosmeticType(r.cosmetic_id);
    // A row for a cosmetic no longer in the catalog is still owned; it simply cannot be drawn. Skip, never throw.
    if (!c) continue;
    ownedViews.push({ ...cosmeticView(c), purchaseId: r.purchase_id, grantedAt: r.granted_at.toISOString(), equipped: equippedIds.has(c.id) });
  }
  return {
    kinds: COSMETIC_KINDS,
    owned: ownedViews,
    equipped,
    catalog: COSMETIC_TYPES.map((c) => ({ ...cosmeticView(c), owned: ownedIds.has(c.id), nextOffer: nextOffer(c.id, week) })),
  };
}

/** Equip an owned cosmetic in its slot, replacing whatever was there. */
export async function equipCosmetic(db: Queryable, accountId: string, cosmeticId: unknown): Promise<{ slot: string; cosmeticId: string; equipped: Record<string, string> }> {
  if (typeof cosmeticId !== "string") throw badRequest("invalid_cosmetic", "cosmeticId must be a string");
  const c = getCosmeticType(cosmeticId);
  if (!c) throw notFound("unknown_cosmetic", `no cosmetic '${cosmeticId}'`);
  const owned = await db.query("SELECT 1 FROM cosmetic_ownership WHERE account_id = $1 AND cosmetic_id = $2", [accountId, c.id]);
  if ((owned.rowCount ?? 0) === 0) throw conflict("not_owned", `cosmetic '${c.id}' is not owned by this account`);
  const slot = cosmeticEquipSlot(c);
  await db.query(
    `INSERT INTO cosmetic_equip (account_id, slot, cosmetic_id) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, slot) DO UPDATE SET cosmetic_id = EXCLUDED.cosmetic_id, updated_at = now()`,
    [accountId, slot, c.id],
  );
  return { slot, cosmeticId: c.id, equipped: await readEquipped(db, accountId) };
}

/** A slot is a kind, or `unit_skin:<living unit type id>`. */
export function isEquipSlot(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v.startsWith("unit_skin:")) return isUnitTypeId(v.slice("unit_skin:".length));
  return isCosmeticKind(v) && v !== "unit_skin";
}

/** Clear a slot. Idempotent: clearing an empty slot is fine. */
export async function unequipSlot(db: Queryable, accountId: string, slot: unknown): Promise<{ slot: string; cleared: boolean; equipped: Record<string, string> }> {
  if (!isEquipSlot(slot)) throw badRequest("invalid_slot", "slot must be a cosmetic kind or unit_skin:<unit type id>");
  const res = await db.query("DELETE FROM cosmetic_equip WHERE account_id = $1 AND slot = $2", [accountId, slot]);
  return { slot, cleared: (res.rowCount ?? 0) > 0, equipped: await readEquipped(db, accountId) };
}
