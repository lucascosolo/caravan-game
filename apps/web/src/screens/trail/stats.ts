/**
 * Display helpers for the formation screen (chunk 08): the stat block of a posted unit
 * and of a scouted attacker, read from @caravan/content and the party/manifest entry.
 * Numbers are formatted here and nowhere else; the client never computes with them.
 *
 * Two stat profiles, always both (GUARDRAILS, "never a single blended power number"):
 * `emphasis` says which the caller is drawing bigger — defense for a posted unit, offense
 * for an attacker.
 */
import { FIXED_POINT_SCALE, getUnitType, mergeStatMult, scaleInt, type Ability, type AffinityCategory } from "@caravan/content";
import type { ManifestUnit } from "@caravan/circle";
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
      lines.push({ label: "Radius", value: cellsText(a.radius) }, { label: S.damage, value: `×${fixedToText(a.damageMult)} one hit` });
      break;
    case "heavy_strike":
      lines.push({ label: S.damage, value: `×${fixedToText(a.damageMult)} one hit` });
      break;
    case "heal_radius":
      lines.push({ label: "Radius", value: cellsText(a.radius) }, { label: "Heals", value: `${fixedToText(a.healFraction * 100)}% of max HP` }, { label: S.charges, value: T.abilityCharges(a.charges) });
      charges = a.charges;
      break;
    case "self_buff":
      lines.push({ label: "Bonus damage", value: `+${fixedToText(a.damageBonus)}` }, { label: "Duration", value: millisToText(a.duration) });
      break;
    case "dash":
      lines.push({ label: "Distance", value: cellsText(a.distance) });
      break;
    case "structure_breaker":
      lines.push({ label: "Fence damage", value: `×${fixedToText(a.fenceDamageMult)} one hit` });
      break;
  }
  return { name: a.displayName, description: a.description, lines, charges };
}

/** A posted (defending) unit: defense emphasized; aggro and leash shown since coverage is the puzzle. */
export function defenderCard(u: ManifestUnit): UnitCard | null {
  const t = getUnitType(u.typeId);
  if (!t) return null;
  const mult = mergeStatMult(u.mergeLevel);
  return {
    ref: u.ref,
    typeId: u.typeId,
    displayName: t.displayName,
    affinity: t.affinity,
    mergeLevel: u.mergeLevel,
    hp: u.hp,
    maxHp: u.maxHp,
    offense: t.offense,
    // What the battlefield carries for a post (chunk 07 toBattlefield): defense × merge multiplier.
    defense: scaleInt(t.defense, mult),
    emphasis: "defense",
    lines: [
      { label: S.moveSpeed, value: fixedToText(t.moveSpeed) },
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
      { label: S.moveSpeed, value: fixedToText(u.moveSpeed) },
      { label: S.attackRange, value: cellsText(u.attackRange) },
      { label: S.attackCooldown, value: millisToText(u.attackCooldown) },
    ],
    ability: abilityOf(u.ability),
    aggroRadius: 0,
    leashDistance: 0,
    attackRange: u.attackRange / FIXED_POINT_SCALE,
  };
}
