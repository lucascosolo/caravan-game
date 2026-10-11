/**
 * The "outfit the caravan" model (chunk 17, open question 1 decided as proposed): PURE
 * edits over a draft loadout and the meters against its caps. The caps are the same
 * tunables the server's packer (@caravan/circle `packManifest`) enforces; this file only
 * MEASURES the draft against them so the player sees where they stand. Whether a loadout
 * packs is the server's answer, shown exactly — a draft over a cap is warned about, not
 * silently trimmed.
 *
 * What rides out is all that can be lost on the trip (GUARDRAILS, bounded stakes): the
 * roster left in town and banked Coin are never at risk. A merged unit takes ONE
 * deployment slot whatever its level — the slot-efficiency merging buys.
 */
import { RING_SEGMENTS } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import type { PackManifestRequest } from "../../api/types.ts";

export const UNIT_CAP: number = TUNABLES.DEPLOYMENT_SLOT_CAP;
export const TRAP_CAP: number = TUNABLES.TRAP_SLOT_CAP;
export const FENCE_BUDGET: number = TUNABLES.FENCE_MATERIAL_BUDGET;
export const RING_POSITIONS: number = RING_SEGMENTS.length;

export interface OutfitDraft {
  /** unit_instance ids, in the order chosen. */
  readonly units: readonly string[];
  /** Trap type ids; a type may repeat (each copy is one trap slot). */
  readonly traps: readonly string[];
  readonly fence: { readonly tierId: string; readonly count: number } | null;
}

export const EMPTY_OUTFIT: OutfitDraft = { units: [], traps: [], fence: null };

export function toggleUnit(d: OutfitDraft, id: string): OutfitDraft {
  return { ...d, units: d.units.includes(id) ? d.units.filter((u) => u !== id) : [...d.units, id] };
}

export function addTrap(d: OutfitDraft, typeId: string): OutfitDraft {
  return { ...d, traps: [...d.traps, typeId] };
}

/** Remove one copy of `typeId` (the last one added). */
export function removeTrap(d: OutfitDraft, typeId: string): OutfitDraft {
  const i = d.traps.lastIndexOf(typeId);
  if (i < 0) return d;
  return { ...d, traps: [...d.traps.slice(0, i), ...d.traps.slice(i + 1)] };
}

export function trapCount(d: OutfitDraft, typeId: string): number {
  return d.traps.filter((t) => t === typeId).length;
}

/** Choose a fence tier (null = no fence). A newly chosen tier starts at the full budget. */
export function setFenceTier(d: OutfitDraft, tierId: string | null): OutfitDraft {
  if (tierId === null) return { ...d, fence: null };
  return { ...d, fence: { tierId, count: d.fence?.count ?? FENCE_BUDGET } };
}

export function setFenceCount(d: OutfitDraft, count: number): OutfitDraft {
  if (!d.fence) return d;
  const n = Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
  return { ...d, fence: { tierId: d.fence.tierId, count: n } };
}

export interface Meter {
  readonly chosen: number;
  readonly cap: number;
  /** How far over the cap the draft is (0 when within it). */
  readonly over: number;
}

const meter = (chosen: number, cap: number): Meter => ({ chosen, cap, over: Math.max(0, chosen - cap) });

export interface OutfitMeters {
  readonly units: Meter;
  readonly traps: Meter;
  readonly fence: Meter;
  /** No living unit chosen: the server refuses an empty manifest. */
  readonly noUnits: boolean;
  /** Any cap exceeded. */
  readonly anyOver: boolean;
}

export function outfitMeters(d: OutfitDraft): OutfitMeters {
  const units = meter(d.units.length, UNIT_CAP);
  const traps = meter(d.traps.length, TRAP_CAP);
  const fence = meter(d.fence?.count ?? 0, FENCE_BUDGET);
  return { units, traps, fence, noUnits: d.units.length === 0, anyOver: units.over + traps.over + fence.over > 0 };
}

/** The body for `POST /caravans/:id/manifest`, exactly what the player chose. */
export function packRequest(d: OutfitDraft): PackManifestRequest {
  return { units: [...d.units], traps: [...d.traps], fence: d.fence && d.fence.count > 0 ? { tierId: d.fence.tierId, count: d.fence.count } : null };
}
