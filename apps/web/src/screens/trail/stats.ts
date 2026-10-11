/**
 * Display helpers for the formation screen (chunk 08): the stat block of a posted unit
 * and of a scouted attacker, read from @caravan/content and the party/manifest entry.
 * Numbers are formatted here and nowhere else; the client never computes with them.
 *
 * Two stat profiles, always both (GUARDRAILS, "never a single blended power number"):
 * `emphasis` says which the caller is drawing bigger — defense for a posted unit, offense
 * for an attacker.
 */
import { FENCE_TIERS, FIXED_POINT_SCALE, LIVING_UNIT_TYPES, TRAP_TYPES, getFenceTier, getTrapType, getUnitType, mergeStatMult, type Ability, type AffinityCategory } from "@caravan/content";
import type { Manifest, ManifestUnit } from "@caravan/circle";
import { fixedToText, millisToText } from "../webs/catalogue.ts";
import { STRINGS } from "../../strings.ts";
import type { ScoutedUnit } from "./scoutTypes.ts";

export interface StatLine {
  readonly label: string;
  readonly value: string;
}

export interface UnitCard {
  readonly ref: string;
  readonly typeId: string;
  readonly displayName: string;
  readonly affinity: AffinityCategory;
  readonly mergeLevel: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly offense: number;
  readonly defense: number;
  readonly emphasis: "offense" | "defense";
  readonly lines: readonly StatLine[];
  readonly ability: { readonly name: string; readonly description: string; readonly lines: readonly StatLine[]; readonly charges: number | null };
  /** In cells, for the scene's circles. */
  readonly aggroRadius: number;
  readonly leashDistance: number;
  readonly attackRange: number;
}

const S = STRINGS.webs.stat;
const T = STRINGS.trail;

export function cellsText(fixed: number): string {
  return T.cells(fixedToText(fixed));
}

function abilityOf(a: Ability): UnitCard["ability"] {
  const lines: StatLine[] = [{ label: S.cooldown, value: millisToText(a.cooldown) }];
  let charges: number | null = null;
  switch (a.archetype) {
    case "burst_radius":
      lines.push({ label: T.abilityRadius, value: cellsText(a.radius) }, { label: S.damage, value: T.abilityOneHit(fixedToText(a.damageMult)) });
      break;
    case "heavy_strike":
      lines.push({ label: S.damage, value: T.abilityOneHit(fixedToText(a.damageMult)) });
      break;
    case "heal_radius":
      lines.push({ label: T.abilityRadius, value: cellsText(a.radius) }, { label: T.abilityHeals, value: T.abilityHealsValue(fixedToText(a.healFraction * 100)) }, { label: S.charges, value: T.abilityCharges(a.charges) });
      charges = a.charges;
      break;
    case "self_buff":
      lines.push({ label: T.abilityBonus, value: T.abilityBonusValue(fixedToText(a.damageBonus)) }, { label: T.abilityDuration, value: millisToText(a.duration) });
      break;
    case "dash":
      lines.push({ label: T.abilityDistance, value: cellsText(a.distance) });
      break;
    case "structure_breaker":
      lines.push({ label: T.abilityFenceDamage, value: T.abilityOneHit(fixedToText(a.fenceDamageMult)) });
      break;
  }
  return { name: a.displayName, description: a.description, lines, charges };
}

/** A posted (defending) unit: defense emphasized; aggro and leash shown since coverage is the puzzle. */
export function defenderCard(u: ManifestUnit): UnitCard | null {
  const t = getUnitType(u.typeId);
  if (!t) return null;
  return {
    ref: u.ref,
    typeId: u.typeId,
    displayName: t.displayName,
    affinity: t.affinity,
    mergeLevel: u.mergeLevel,
    hp: u.hp,
    maxHp: u.maxHp,
    // Ratings never merge-scale (chunk 03 QA B1; chunk 09 QA X1 made `toBattlefield` hand the
    // resolver the unscaled defense). Merge scales HP and damage output only: `hp` / `maxHp`
    // above are the manifest's, already at this merge level.
    offense: t.offense,
    defense: t.defense,
    emphasis: "defense",
    lines: [
      // Merge scales each hit's OUTPUT (the resolver's DAMAGE_ROUNDING_ORDER step 3), never the rating (QA S1).
      { label: T.damagePerHit, value: T.damagePerHitValue(fixedToText(mergeStatMult(u.mergeLevel)), u.mergeLevel) },
      { label: T.speed, value: T.speedValue(fixedToText(t.moveSpeed)) },
      { label: S.attackRange, value: cellsText(t.attackRange) },
      { label: S.attackCooldown, value: millisToText(t.attackCooldown) },
      { label: T.aggro, value: cellsText(t.aggroRadius) },
      { label: T.leash, value: cellsText(t.leashDistance) },
    ],
    ability: abilityOf(t.ability),
    aggroRadius: t.aggroRadius / FIXED_POINT_SCALE,
    leashDistance: t.leashDistance / FIXED_POINT_SCALE,
    attackRange: t.attackRange / FIXED_POINT_SCALE,
  };
}

/**
 * A scouted attacker: every field of the server's `ScoutUnit`, offense emphasized (it is
 * `ratingInUse`); defense shown beside it for comparison. `hp` is its max HP at this merge
 * level — a standing party is a template and always arrives whole.
 */
export function attackerCard(u: ScoutedUnit): UnitCard {
  return {
    ref: u.ref,
    typeId: u.typeId,
    displayName: u.displayName,
    affinity: u.affinity,
    mergeLevel: u.mergeLevel,
    hp: u.hp,
    maxHp: u.hp,
    offense: u.offense,
    defense: u.defense,
    emphasis: "offense",
    lines: [
      // The server's scout view carries the multiplier at this merge level (QA S1).
      { label: T.damagePerHit, value: T.damagePerHitValue(fixedToText(u.damagePerHitMult), u.mergeLevel) },
      { label: T.speed, value: T.speedValue(fixedToText(u.moveSpeed)) },
      { label: S.attackRange, value: cellsText(u.attackRange) },
      { label: S.attackCooldown, value: millisToText(u.attackCooldown) },
    ],
    ability: abilityOf(u.ability),
    aggroRadius: 0,
    leashDistance: 0,
    attackRange: u.attackRange / FIXED_POINT_SCALE,
  };
}

/**
 * Every id a server issue may name on this screen → the name the player sees (chunk 08
 * QA S8 / S15): manifest refs (a unit by its type and HP, a trap by its type, a segment by
 * its number) and content type ids. Fed to shell/issues.ts `humanizeIssue`.
 */
export function manifestNames(m: Manifest): ReadonlyMap<string, string> {
  const names = new Map<string, string>();
  for (const t of LIVING_UNIT_TYPES) names.set(t.id, t.displayName);
  for (const t of TRAP_TYPES) names.set(t.id, t.displayName);
  for (const t of FENCE_TIERS) names.set(t.id, t.displayName);
  const sameType = (typeId: string) => m.units.filter((u) => u.typeId === typeId).length;
  m.units.forEach((u) => {
    const name = getUnitType(u.typeId)?.displayName ?? T.unknownThing;
    names.set(u.ref, sameType(u.typeId) > 1 ? T.unitNamed(name, m.units.filter((x) => x.typeId === u.typeId).indexOf(u) + 1) : name);
  });
  m.traps.forEach((t) => {
    const name = getTrapType(t.typeId)?.displayName ?? T.unknownThing;
    const same = m.traps.filter((x) => x.typeId === t.typeId);
    names.set(t.ref, same.length > 1 ? T.unitNamed(name, same.indexOf(t) + 1) : name);
  });
  m.fences.forEach((f, i) => names.set(f.ref, T.segmentNamed(i + 1, getFenceTier(f.tierId)?.displayName ?? T.unknownThing)));
  return names;
}
