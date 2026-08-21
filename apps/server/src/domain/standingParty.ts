import {
  APPROACH_EDGES,
  STANCES,
  TUNABLES,
  findLivingUnitType,
  findSiegeType,
  hasAccess,
  type ApproachEdge,
  type FenceCategory,
  type Stance,
  type TrapCategory,
  type UnlockedAccess,
} from "@caravan/content";
import type { UnitInstance } from "./account.js";

/**
 * The standing raid party domain model — chunk 09. See roadmap/chunks/09 and
 * GUARDRAILS.md #0: this is the passive, offense side. It is a **template**:
 * `StandingParty` objects are never mutated in place. Every edit produces a
 * brand new object with `version` incremented; nothing that already holds a
 * reference to an older `StandingParty` (a stored snapshot, an in-flight
 * resolution) is ever affected by a later edit. That immutable-update
 * discipline is what makes "editing later can't touch an in-flight
 * resolution" true by construction rather than by a lock.
 */

export interface LatticeCell {
  readonly x: number;
  readonly y: number;
}

export interface PartyUnitSlot {
  readonly slotIndex: number;
  readonly unitInstanceId: string;
  readonly stance: Stance;
  readonly edge: ApproachEdge;
  readonly startPosition: LatticeCell;
}

export interface PartySiegeSlot {
  readonly slotIndex: number;
  readonly siegeTypeId: string;
  readonly edge: ApproachEdge;
  readonly startPosition: LatticeCell;
}

export interface StandingParty {
  readonly id: string;
  readonly accountId: string;
  /** Bumped on every edit. Not used for optimistic-lock rejection in MVP
   * (PARTY_EDIT_COOLDOWN is none — edits are free and instant) but every
   * snapshot records the version it was taken from, so history stays legible. */
  readonly version: number;
  readonly unitSlots: readonly PartyUnitSlot[];
  readonly siegeSlots: readonly PartySiegeSlot[];
}

export function createEmptyParty(id: string, accountId: string): StandingParty {
  return { id, accountId, version: 0, unitSlots: [], siegeSlots: [] };
}

function nextSlotIndex(slots: readonly { slotIndex: number }[]): number {
  return slots.reduce((max, s) => Math.max(max, s.slotIndex + 1), 0);
}

export function addUnitSlot(
  party: StandingParty,
  input: { unitInstanceId: string; stance: Stance; edge: ApproachEdge; startPosition: LatticeCell },
): StandingParty {
  const slot: PartyUnitSlot = { slotIndex: nextSlotIndex(party.unitSlots), ...input };
  return { ...party, version: party.version + 1, unitSlots: [...party.unitSlots, slot] };
}

export function addSiegeSlot(
  party: StandingParty,
  input: { siegeTypeId: string; edge: ApproachEdge; startPosition: LatticeCell },
): StandingParty {
  const slot: PartySiegeSlot = { slotIndex: nextSlotIndex(party.siegeSlots), ...input };
  return { ...party, version: party.version + 1, siegeSlots: [...party.siegeSlots, slot] };
}

export function removeUnitSlot(party: StandingParty, slotIndex: number): StandingParty {
  return {
    ...party,
    version: party.version + 1,
    unitSlots: party.unitSlots.filter((s) => s.slotIndex !== slotIndex),
  };
}

export function removeSiegeSlot(party: StandingParty, slotIndex: number): StandingParty {
  return {
    ...party,
    version: party.version + 1,
    siegeSlots: party.siegeSlots.filter((s) => s.slotIndex !== slotIndex),
  };
}

export function setUnitStance(party: StandingParty, slotIndex: number, stance: Stance): StandingParty {
  return {
    ...party,
    version: party.version + 1,
    unitSlots: party.unitSlots.map((s) => (s.slotIndex === slotIndex ? { ...s, stance } : s)),
  };
}

export class PartyValidationError extends Error {
  constructor(public readonly violations: readonly string[]) {
    super(`Standing party invalid: ${violations.join("; ")}`);
    this.name = "PartyValidationError";
  }
}

function isInStartBand(edge: ApproachEdge, cell: LatticeCell): boolean {
  const band = TUNABLES.START_POSITION_BAND;
  const w = TUNABLES.GRID_WIDTH;
  const h = TUNABLES.GRID_HEIGHT;
  if (cell.x < 0 || cell.x >= w || cell.y < 0 || cell.y >= h) return false;
  switch (edge) {
    case "north":
      return cell.y < band;
    case "south":
      return cell.y >= h - band;
    case "west":
      return cell.x < band;
    case "east":
      return cell.x >= w - band;
  }
}

/**
 * Server-side validation — the only place any of this is enforced (client
 * caps are a courtesy, per GUARDRAILS.md #2/#3). Collects every violation
 * instead of failing on the first, so a caller can show a complete picture.
 */
export function validateParty(
  party: StandingParty,
  ctx: {
    unitInstancesById: ReadonlyMap<string, UnitInstance>;
    /** Caravan ids that belong to the party's own account — a unit instance
     * referenced by the party must live on one of these. */
    ownedCaravanIds: ReadonlySet<string>;
    access: UnlockedAccess;
  },
): void {
  const violations: string[] = [];

  if (party.unitSlots.length > TUNABLES.PARTY_SLOT_CAP) {
    violations.push(`unit slots ${party.unitSlots.length} exceed PARTY_SLOT_CAP ${TUNABLES.PARTY_SLOT_CAP}`);
  }
  if (party.siegeSlots.length > TUNABLES.SIEGE_SLOT_CAP) {
    violations.push(`siege slots ${party.siegeSlots.length} exceed SIEGE_SLOT_CAP ${TUNABLES.SIEGE_SLOT_CAP}`);
  }

  const seenUnitSlotIndex = new Set<number>();
  for (const slot of party.unitSlots) {
    if (seenUnitSlotIndex.has(slot.slotIndex)) {
      violations.push(`duplicate unit slotIndex ${slot.slotIndex}`);
    }
    seenUnitSlotIndex.add(slot.slotIndex);

    if (!STANCES.includes(slot.stance)) {
      violations.push(`slot ${slot.slotIndex}: invalid stance ${String(slot.stance)}`);
    }
    if (!APPROACH_EDGES.includes(slot.edge)) {
      violations.push(`slot ${slot.slotIndex}: invalid edge ${String(slot.edge)}`);
    } else if (!isInStartBand(slot.edge, slot.startPosition)) {
      violations.push(`slot ${slot.slotIndex}: start position outside START_POSITION_BAND for edge ${slot.edge}`);
    }

    const unit = ctx.unitInstancesById.get(slot.unitInstanceId);
    if (!unit) {
      violations.push(`slot ${slot.slotIndex}: unit instance ${slot.unitInstanceId} does not exist`);
    } else {
      if (!ctx.ownedCaravanIds.has(unit.caravanId)) {
        violations.push(`slot ${slot.slotIndex}: unit instance ${slot.unitInstanceId} is not owned by this account`);
      }
      const type = findLivingUnitType(unit.typeId);
      if (!type) {
        violations.push(`slot ${slot.slotIndex}: unknown living unit type ${unit.typeId}`);
      } else if (!hasAccess(ctx.access, "living_unit", type.id)) {
        violations.push(`slot ${slot.slotIndex}: living unit type ${type.id} is not unlocked`);
      }
    }
  }

  const seenSiegeSlotIndex = new Set<number>();
  for (const slot of party.siegeSlots) {
    if (seenSiegeSlotIndex.has(slot.slotIndex)) {
      violations.push(`duplicate siege slotIndex ${slot.slotIndex}`);
    }
    seenSiegeSlotIndex.add(slot.slotIndex);

    if (!APPROACH_EDGES.includes(slot.edge)) {
      violations.push(`siege slot ${slot.slotIndex}: invalid edge ${String(slot.edge)}`);
    } else if (!isInStartBand(slot.edge, slot.startPosition)) {
      violations.push(`siege slot ${slot.slotIndex}: start position outside START_POSITION_BAND for edge ${slot.edge}`);
    }

    const siege = findSiegeType(slot.siegeTypeId);
    if (!siege) {
      violations.push(`siege slot ${slot.slotIndex}: unknown siege type ${slot.siegeTypeId}`);
    } else if (!hasAccess(ctx.access, "siege", siege.id)) {
      violations.push(`siege slot ${slot.slotIndex}: siege type ${siege.id} is not unlocked`);
    }
  }

  if (violations.length > 0) {
    throw new PartyValidationError(violations);
  }
}

// --- Snapshot ---------------------------------------------------------

export interface PartySnapshotUnit {
  readonly slotIndex: number;
  readonly unitInstanceId: string;
  readonly typeId: string;
  readonly mergeLevel: number;
  readonly offense: number;
  readonly defense: number;
  readonly hp: number;
  readonly stance: Stance;
  readonly edge: ApproachEdge;
  readonly startPosition: LatticeCell;
}

export interface PartySnapshotSiege {
  readonly slotIndex: number;
  readonly siegeTypeId: string;
  readonly countersFenceCategory: FenceCategory | null;
  readonly countersTrapCategory: TrapCategory | null;
  readonly edge: ApproachEdge;
  readonly startPosition: LatticeCell;
}

/**
 * The frozen artifact taken "at the point [the party] is served" (chunk 09,
 * criterion 3). Stats are resolved and embedded here rather than referenced
 * by id, so a later merge-level change or roster edit can never retroactively
 * alter a snapshot that has already been handed to the resolver or stored in
 * a replay. This is also exactly the shape shown to a scouting opponent and
 * to the owner's own preview — one serializer, both callers, so they cannot
 * drift apart (chunk 09 criterion 8 / QA "legibility, both directions").
 */
export interface PartySnapshot {
  readonly partyId: string;
  readonly partyVersionAtSnapshot: number;
  readonly takenAt: string;
  readonly units: readonly PartySnapshotUnit[];
  readonly siege: readonly PartySnapshotSiege[];
}

/**
 * Resolves one slot's display/sim row. This is the single mapping both
 * `snapshotParty` (frozen, stored) and `toPartyView` (live, for the builder
 * and the scouting screen) run through — one function, two callers, so the
 * two views are field-for-field identical by construction rather than by
 * discipline (chunk 09 criterion 8).
 */
function resolveUnitRow(
  slot: PartyUnitSlot,
  unitInstancesById: ReadonlyMap<string, UnitInstance>,
): PartySnapshotUnit {
  const instance = unitInstancesById.get(slot.unitInstanceId);
  if (!instance) {
    throw new Error(`unit instance ${slot.unitInstanceId} not found`);
  }
  const type = findLivingUnitType(instance.typeId);
  if (!type) {
    throw new Error(`unit type ${instance.typeId} not found`);
  }
  return {
    slotIndex: slot.slotIndex,
    unitInstanceId: slot.unitInstanceId,
    typeId: type.id,
    mergeLevel: instance.mergeLevel,
    offense: type.offense,
    defense: type.defense,
    hp: type.hp,
    stance: slot.stance,
    edge: slot.edge,
    startPosition: slot.startPosition,
  };
}

function resolveSiegeRow(slot: PartySiegeSlot): PartySnapshotSiege {
  const type = findSiegeType(slot.siegeTypeId);
  if (!type) {
    throw new Error(`siege type ${slot.siegeTypeId} not found`);
  }
  return {
    slotIndex: slot.slotIndex,
    siegeTypeId: type.id,
    countersFenceCategory: type.countersFenceCategory,
    countersTrapCategory: type.countersTrapCategory,
    edge: slot.edge,
    startPosition: slot.startPosition,
  };
}

export function snapshotParty(
  party: StandingParty,
  unitInstancesById: ReadonlyMap<string, UnitInstance>,
  takenAt: string,
): PartySnapshot {
  const units = [...party.unitSlots]
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((slot) => resolveUnitRow(slot, unitInstancesById));

  const siege = [...party.siegeSlots].sort((a, b) => a.slotIndex - b.slotIndex).map(resolveSiegeRow);

  return {
    partyId: party.id,
    partyVersionAtSnapshot: party.version,
    takenAt,
    units,
    siege,
  };
}

/**
 * The party exactly as it will be shown: to its owner in the builder, and to
 * every opponent who scouts it before arranging their circle. Both callers
 * must use this one function — never re-derive a display view independently,
 * or the two can drift and violate criterion 8 / the "legibility, both
 * directions" QA check.
 */
export interface PartyView {
  readonly partyId: string;
  readonly partyVersion: number;
  readonly units: readonly PartySnapshotUnit[];
  readonly siege: readonly PartySnapshotSiege[];
}

export function toPartyView(party: StandingParty, unitInstancesById: ReadonlyMap<string, UnitInstance>): PartyView {
  const units = [...party.unitSlots]
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((slot) => resolveUnitRow(slot, unitInstancesById));

  const siege = [...party.siegeSlots].sort((a, b) => a.slotIndex - b.slotIndex).map(resolveSiegeRow);

  return { partyId: party.id, partyVersion: party.version, units, siege };
}

/**
 * Deterministic byte-string for a snapshot — used by the "party configuration
 * must serialize deterministically... snapshotted per encounter and must
 * byte-compare" QA check. Every producer above builds objects in a fixed key
 * order and sorts arrays by `slotIndex`, so `JSON.stringify` is already
 * stable; this just names that guarantee at the one place tests should call.
 */
export function canonicalSnapshotBytes(snapshot: PartySnapshot): string {
  return JSON.stringify(snapshot);
}
