/**
 * What a node grants, for display: the type's name, flavor and FULL stat block, read from
 * @caravan/content (pure, public, the same data the server validates against). Shown for
 * every node, locked ones included (SHOW_LOCKED_NODE_STATS: legibility, GUARDRAILS §4).
 *
 * This file formats numbers for humans. Fixed-point values are converted to decimal text
 * here and nowhere else; the client never computes with them.
 */
import {
  FIXED_POINT_SCALE,
  getFenceTier,
  getSiegeType,
  getTrapType,
  getUnitType,
  type Ability,
  type AffinityCategory,
} from "@caravan/content";
import { STRINGS } from "../../strings.ts";

export type GrantKind = "unit" | "trap" | "fence" | "siege";

export interface StatLine {
  readonly label: string;
  readonly value: string;
}

export interface GrantedType {
  readonly kind: GrantKind;
  readonly kindLabel: string;
  readonly id: string;
  readonly displayName: string;
  readonly flavor: string;
  readonly affinity: AffinityCategory | null;
  readonly stats: readonly StatLine[];
}

/** Fixed (1/1024 units) → decimal text with up to two places, integer arithmetic only. */
export function fixedToText(value: number): string {
  const hundredths = Math.round((value * 100) / FIXED_POINT_SCALE);
  const whole = Math.trunc(hundredths / 100);
  const frac = Math.abs(hundredths % 100);
  if (frac === 0) return String(whole);
  const fracText = frac < 10 ? `0${frac}` : String(frac);
  return `${whole}.${fracText.replace(/0$/, "")}`;
}

/** Millis → seconds text. */
export function millisToText(ms: number): string {
  return STRINGS.webs.seconds(fixedToText(Math.round((ms * FIXED_POINT_SCALE) / 1000)));
}

const S = STRINGS.webs.stat;

function abilityLines(a: Ability): StatLine[] {
  const lines: StatLine[] = [
    { label: S.ability, value: `${a.displayName} — ${a.description}` },
    { label: S.cooldown, value: millisToText(a.cooldown) },
  ];
  switch (a.archetype) {
    case "burst_radius":
      lines.push({ label: "Radius (cells)", value: fixedToText(a.radius) }, { label: "Damage", value: `×${fixedToText(a.damageMult)} one hit` });
      break;
    case "heavy_strike":
      lines.push({ label: "Damage", value: `×${fixedToText(a.damageMult)} one hit` });
      break;
    case "heal_radius":
      lines.push(
        { label: "Radius (cells)", value: fixedToText(a.radius) },
        { label: "Heals", value: `${fixedToText(a.healFraction * 100)}% of max HP` },
        { label: S.charges, value: String(a.charges) },
      );
      break;
    case "self_buff":
      lines.push({ label: "Bonus damage", value: `+${fixedToText(a.damageBonus)}` }, { label: "Duration", value: millisToText(a.duration) });
      break;
    case "dash":
      lines.push({ label: "Distance (cells)", value: fixedToText(a.distance) });
      break;
    case "structure_breaker":
      lines.push({ label: "Fence damage", value: `×${fixedToText(a.fenceDamageMult)} one hit` });
      break;
  }
  return lines;
}

export function describeType(id: string): GrantedType {
  const unit = getUnitType(id);
  if (unit) {
    return {
      kind: "unit",
      kindLabel: STRINGS.webs.kindUnit,
      id,
      displayName: unit.displayName,
      flavor: unit.flavor,
      affinity: unit.affinity,
      stats: [
        { label: S.offense, value: String(unit.offense) },
        { label: S.defense, value: String(unit.defense) },
        { label: S.hp, value: String(unit.hp) },
        { label: S.moveSpeed, value: fixedToText(unit.moveSpeed) },
        { label: S.attackRange, value: fixedToText(unit.attackRange) },
        { label: S.attackCooldown, value: millisToText(unit.attackCooldown) },
        { label: S.aggroRadius, value: fixedToText(unit.aggroRadius) },
        { label: S.leashDistance, value: fixedToText(unit.leashDistance) },
        ...abilityLines(unit.ability),
      ],
    };
  }
  const trap = getTrapType(id);
  if (trap) {
    const effect =
      trap.effect === null
        ? S.effectNone
        : trap.effect.kind === "root"
          ? `Root for ${millisToText(trap.effect.duration)}`
          : `Slow ×${fixedToText(trap.effect.magnitude)} for ${millisToText(trap.effect.duration)}`;
    return {
      kind: "trap",
      kindLabel: STRINGS.webs.kindTrap,
      id,
      displayName: trap.displayName,
      flavor: trap.flavor,
      affinity: trap.affinity,
      stats: [
        { label: S.category, value: trap.category },
        { label: S.damage, value: String(trap.damage) },
        { label: S.effect, value: effect },
      ],
    };
  }
  const fence = getFenceTier(id);
  if (fence) {
    return {
      kind: "fence",
      kindLabel: STRINGS.webs.kindFence,
      id,
      displayName: fence.displayName,
      flavor: fence.flavor,
      affinity: null,
      stats: [
        { label: S.fenceTier, value: String(fence.tier) },
        { label: S.category, value: fence.category },
        { label: S.segmentHp, value: String(fence.segmentHp) },
      ],
    };
  }
  const siege = getSiegeType(id);
  if (siege) {
    return {
      kind: "siege",
      kindLabel: STRINGS.webs.kindSiege,
      id,
      displayName: siege.displayName,
      flavor: siege.flavor,
      affinity: null,
      stats: [{ label: S.counters, value: `${siege.counters.category} ${siege.counters.kind}s` }],
    };
  }
  // A node id the content package does not know: show the id rather than hide the node.
  return { kind: "unit", kindLabel: "", id, displayName: id, flavor: "", affinity: null, stats: [] };
}

export function displayNameOf(id: string): string {
  return getUnitType(id)?.displayName ?? getTrapType(id)?.displayName ?? getFenceTier(id)?.displayName ?? getSiegeType(id)?.displayName ?? id;
}
