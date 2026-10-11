/**
 * The MANIFEST — what the caravan packed for a trip (chunk 07, "The two lifetimes").
 *
 * Lifetime: the whole trip. Packed in town before departure and locked at trip start;
 * nothing is added, resupplied, repaired or healed until the trip ends. The manifest at
 * encounter N is what survived encounters 1..N-1, so it carries each entry's CURRENT state
 * (unit hp, trap spent, fence segment hp). The only function that moves that state is
 * `applyEncounterOutcome` in attrition.ts, and it only ever moves it downward.
 *
 * The manifest is the loadout constraint a formation is built within. A formation
 * references manifest entries by `ref`; it never owns units. See formation.ts.
 *
 * This structure is CARAVAN-level (GUARDRAILS §5): it is a caravan's units and the
 * caravan's trip. It carries no account identity and no Coin.
 *
 * There is deliberately NO function here that adds to a manifest. Packing produces a
 * deep-frozen object; the server stores the packed loadout in an immutable column.
 */
import {
  TUNABLES,
  getFenceTier,
  getTrapType,
  getUnitType,
  mergeStatMult,
  scaleInt,
} from "@caravan/content";
import { issue, type Issue, type Validation } from "./issues.js";

/** The ONLY gate on which types may be packed or placed: the unlock web (GUARDRAILS §3). */
export type AccessCheck = (typeId: string) => boolean;

export interface ManifestUnit {
  /** The caravan's unit instance id. Unique within the manifest. */
  readonly ref: string;
  readonly typeId: string;
  readonly mergeLevel: number;
  /** Max HP at this merge level; what a bank restores to. */
  readonly maxHp: number;
  /** Current HP. 0 means dead for the rest of the trip. */
  readonly hp: number;
}

export interface ManifestTrap {
  /** `t<n>`, assigned at pack time. */
  readonly ref: string;
  readonly typeId: string;
  /** Single-trigger: once true it stays true for the rest of the trip. */
  readonly spent: boolean;
}

export interface ManifestFence {
  /** `f<n>`, assigned at pack time. One unit of fence material = one ring segment. */
  readonly ref: string;
  readonly tierId: string;
  readonly maxHp: number;
  /** Current HP. 0 means destroyed for the rest of the trip. */
  readonly hp: number;
}

export interface Manifest {
  readonly v: 1;
  readonly units: readonly ManifestUnit[];
  readonly traps: readonly ManifestTrap[];
  readonly fences: readonly ManifestFence[];
}

export const MANIFEST_VERSION = 1 as const;

/** What the player asks to pack, in town. Validated against caps and access. */
export interface PackInput {
  readonly units: readonly { readonly instanceId: string; readonly typeId: string; readonly mergeLevel: number }[];
  /** Trap type ids, one per trap carried. */
  readonly traps: readonly string[];
  /** Fence material: one tier, `count` segments. Null packs no fence. */
  readonly fence: { readonly tierId: string; readonly count: number } | null;
}

export function isUnitAlive(u: ManifestUnit): boolean {
  return u.hp > 0;
}
export function isFenceIntact(f: ManifestFence): boolean {
  return f.hp > 0;
}

export function manifestUnit(m: Manifest, ref: string): ManifestUnit | undefined {
  return m.units.find((u) => u.ref === ref);
}
export function manifestTrap(m: Manifest, ref: string): ManifestTrap | undefined {
  return m.traps.find((t) => t.ref === ref);
}
export function manifestFence(m: Manifest, ref: string): ManifestFence | undefined {
  return m.fences.find((f) => f.ref === ref);
}

/**
 * Pack a manifest: enforce the slot caps (bounded stakes), the material budget, and the
 * access gate, and derive each entry's starting state from content. Returns issues rather
 * than throwing — every problem at once, for the UI.
 */
export function packManifest(input: PackInput, isUnlocked: AccessCheck): Validation<Manifest> {
  const issues: Issue[] = [];

  // Living units: the deployment slot cap is what bounds a catastrophic trip to the packed
  // loadout rather than the whole roster in town (GUARDRAILS "Bounded stakes").
  if (input.units.length > TUNABLES.DEPLOYMENT_SLOT_CAP) {
    issues.push(issue("slot_cap_units", `a caravan carries at most ${TUNABLES.DEPLOYMENT_SLOT_CAP} living units; ${input.units.length} packed`));
  }
  const seenUnits = new Set<string>();
  const units: ManifestUnit[] = [];
  for (const u of input.units) {
    if (seenUnits.has(u.instanceId)) {
      issues.push(issue("duplicate_unit", `unit ${u.instanceId} packed twice`, u.instanceId));
      continue;
    }
    seenUnits.add(u.instanceId);
    const type = getUnitType(u.typeId);
    if (!type) {
      issues.push(issue("unknown_type", `unknown living-unit type '${u.typeId}'`, u.typeId));
      continue;
    }
    if (!isUnlocked(u.typeId)) {
      issues.push(issue("type_locked", `living-unit type '${u.typeId}' is not unlocked`, u.typeId));
      continue;
    }
    if (!Number.isInteger(u.mergeLevel) || u.mergeLevel < TUNABLES.MERGE_LEVEL_MIN || u.mergeLevel > TUNABLES.MERGE_LEVEL_MAX) {
      issues.push(issue("bad_merge_level", `merge level ${String(u.mergeLevel)} is outside ${TUNABLES.MERGE_LEVEL_MIN}..${TUNABLES.MERGE_LEVEL_MAX}`, u.instanceId));
      continue;
    }
    const maxHp = scaleInt(type.hp, mergeStatMult(u.mergeLevel));
    units.push({ ref: u.instanceId, typeId: u.typeId, mergeLevel: u.mergeLevel, maxHp, hp: maxHp });
  }

  // Traps.
  if (input.traps.length > TUNABLES.TRAP_SLOT_CAP) {
    issues.push(issue("slot_cap_traps", `a caravan carries at most ${TUNABLES.TRAP_SLOT_CAP} traps; ${input.traps.length} packed`));
  }
  const traps: ManifestTrap[] = [];
  input.traps.forEach((typeId, i) => {
    if (!getTrapType(typeId)) {
      issues.push(issue("unknown_type", `unknown trap type '${typeId}'`, typeId));
      return;
    }
    if (!isUnlocked(typeId)) {
      issues.push(issue("type_locked", `trap type '${typeId}' is not unlocked`, typeId));
      return;
    }
    traps.push({ ref: `t${i}`, typeId, spent: false });
  });

  // Fence material. The budget is below a full ring by design: gaps are forced.
  const fences: ManifestFence[] = [];
  if (input.fence) {
    const { tierId, count } = input.fence;
    const tier = getFenceTier(tierId);
    if (!Number.isInteger(count) || count < 0) {
      issues.push(issue("bad_count", `fence segment count must be a non-negative integer, got ${String(count)}`));
    } else if (count > TUNABLES.FENCE_MATERIAL_BUDGET) {
      issues.push(issue("fence_budget", `a caravan carries at most ${TUNABLES.FENCE_MATERIAL_BUDGET} fence segments; ${count} packed`));
    }
    if (!tier) {
      issues.push(issue("unknown_type", `unknown fence tier '${tierId}'`, tierId));
    } else if (!isUnlocked(tierId)) {
      issues.push(issue("type_locked", `fence tier '${tierId}' is not unlocked`, tierId));
    } else if (issues.every((x) => x.code !== "bad_count" && x.code !== "fence_budget")) {
      for (let i = 0; i < count; i++) fences.push({ ref: `f${i}`, tierId, maxHp: tier.segmentHp, hp: tier.segmentHp });
    }
  }

  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: freezeManifest({ v: MANIFEST_VERSION, units, traps, fences }) };
}

/** Deep-freeze so nothing downstream can mutate a manifest in place. */
export function freezeManifest(m: Manifest): Manifest {
  for (const u of m.units) Object.freeze(u);
  for (const t of m.traps) Object.freeze(t);
  for (const f of m.fences) Object.freeze(f);
  Object.freeze(m.units);
  Object.freeze(m.traps);
  Object.freeze(m.fences);
  return Object.freeze(m);
}

/**
 * Structural check for a manifest that came back from storage: shape, integers, unique
 * refs, hp within [0, maxHp]. Throws — a malformed stored manifest is a bug, not a player
 * error.
 */
export function assertManifest(m: Manifest): void {
  const fail = (why: string): never => {
    throw new TypeError(`malformed manifest: ${why}`);
  };
  if (m.v !== MANIFEST_VERSION) fail(`version ${String(m.v)}`);
  const refs = new Set<string>();
  const takeRef = (ref: unknown) => {
    if (typeof ref !== "string" || ref.length === 0) fail("empty ref");
    if (refs.has(ref as string)) fail(`duplicate ref ${String(ref)}`);
    refs.add(ref as string);
  };
  for (const u of m.units) {
    takeRef(u.ref);
    if (!getUnitType(u.typeId)) fail(`unknown unit type ${u.typeId}`);
    if (!Number.isInteger(u.mergeLevel)) fail(`merge level ${String(u.mergeLevel)}`);
    if (!Number.isInteger(u.maxHp) || !Number.isInteger(u.hp) || u.hp < 0 || u.hp > u.maxHp) fail(`unit ${u.ref} hp ${String(u.hp)}/${String(u.maxHp)}`);
  }
  for (const t of m.traps) {
    takeRef(t.ref);
    if (!getTrapType(t.typeId)) fail(`unknown trap type ${t.typeId}`);
    if (typeof t.spent !== "boolean") fail(`trap ${t.ref} spent flag`);
  }
  for (const f of m.fences) {
    takeRef(f.ref);
    if (!getFenceTier(f.tierId)) fail(`unknown fence tier ${f.tierId}`);
    if (!Number.isInteger(f.maxHp) || !Number.isInteger(f.hp) || f.hp < 0 || f.hp > f.maxHp) fail(`fence ${f.ref} hp ${String(f.hp)}/${String(f.maxHp)}`);
  }
}
