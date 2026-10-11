/**
 * CARRY-FORWARD ATTRITION (chunk 07; chunk 15 "no repair, no resupply, no healing").
 *
 * After an encounter resolves, the resolver's outcome (chunk 13) says what the caravan has
 * left: each unit's remaining HP, which traps fired, each fence segment's remaining HP.
 * `applyEncounterOutcome` folds that into the manifest and returns the manifest the NEXT
 * encounter is arranged from.
 *
 * It is MONOTONE. Nothing here can raise an HP, un-spend a trap or rebuild a segment, and
 * an outcome that tries is a programming error (thrown), not a player error. A trap spent
 * at encounter 2 is still spent at encounter 3 because `spent` only ever flips to true.
 * Entries an outcome does not mention are unchanged — they carry forward as they were.
 */
import { freezeManifest, type Manifest } from "./manifest.js";

export interface EncounterOutcome {
  /** Remaining HP per unit ref. Omitted units are unchanged. 0 = died. */
  readonly units: readonly { readonly ref: string; readonly hp: number }[];
  /** Refs of traps that fired this encounter. */
  readonly spentTraps: readonly string[];
  /** Remaining HP per fence ref. Omitted segments are unchanged. 0 = destroyed. */
  readonly fences: readonly { readonly ref: string; readonly hp: number }[];
}

export class AttritionError extends Error {
  constructor(message: string) {
    super(`encounter outcome refused: ${message}`);
    this.name = "AttritionError";
  }
}

export function applyEncounterOutcome(manifest: Manifest, outcome: EncounterOutcome): Manifest {
  const unitHp = new Map<string, number>();
  for (const { ref, hp } of outcome.units) {
    if (unitHp.has(ref)) throw new AttritionError(`unit '${ref}' reported twice`);
    unitHp.set(ref, hp);
  }
  const fenceHp = new Map<string, number>();
  for (const { ref, hp } of outcome.fences) {
    if (fenceHp.has(ref)) throw new AttritionError(`fence '${ref}' reported twice`);
    fenceHp.set(ref, hp);
  }
  const spent = new Set(outcome.spentTraps);

  const units = manifest.units.map((u) => {
    const hp = unitHp.get(u.ref);
    unitHp.delete(u.ref);
    if (hp === undefined) return u;
    if (!Number.isInteger(hp) || hp < 0) throw new AttritionError(`unit '${u.ref}' hp ${String(hp)} is not a non-negative integer`);
    if (hp > u.hp) throw new AttritionError(`unit '${u.ref}' hp would rise ${u.hp} → ${hp}; there is no healing mid-trip`);
    return { ...u, hp };
  });
  const traps = manifest.traps.map((t) => {
    if (!spent.has(t.ref)) return t;
    spent.delete(t.ref);
    return t.spent ? t : { ...t, spent: true };
  });
  const fences = manifest.fences.map((f) => {
    const hp = fenceHp.get(f.ref);
    fenceHp.delete(f.ref);
    if (hp === undefined) return f;
    if (!Number.isInteger(hp) || hp < 0) throw new AttritionError(`fence '${f.ref}' hp ${String(hp)} is not a non-negative integer`);
    if (hp > f.hp) throw new AttritionError(`fence '${f.ref}' hp would rise ${f.hp} → ${hp}; there is no repair mid-trip`);
    return { ...f, hp };
  });

  const unknown = [...unitHp.keys(), ...spent, ...fenceHp.keys()];
  if (unknown.length > 0) throw new AttritionError(`refs not in the manifest: ${unknown.join(", ")}`);

  return freezeManifest({ v: manifest.v, units, traps, fences });
}

/** What the player still has, for the stakes preview before bank-or-push (GUARDRAILS §4). */
export function manifestSummary(m: Manifest): {
  readonly unitsAlive: number;
  readonly unitsDead: number;
  readonly trapsUnspent: number;
  readonly trapsSpent: number;
  readonly fencesIntact: number;
  readonly fencesDestroyed: number;
} {
  const unitsAlive = m.units.filter((u) => u.hp > 0).length;
  const trapsUnspent = m.traps.filter((t) => !t.spent).length;
  const fencesIntact = m.fences.filter((f) => f.hp > 0).length;
  return {
    unitsAlive,
    unitsDead: m.units.length - unitsAlive,
    trapsUnspent,
    trapsSpent: m.traps.length - trapsUnspent,
    fencesIntact,
    fencesDestroyed: m.fences.length - fencesIntact,
  };
}
