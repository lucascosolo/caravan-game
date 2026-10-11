/**
 * Content validation — runs on load (index.ts) so a dangling category reference or a
 * missing field fails at import time, not in the middle of a fight. Pure checks over
 * authored data; nothing here generates values.
 */
import { ABILITY_ARCHETYPES, isAbilityArchetype, type Ability } from "./abilities.js";
import { AFFINITY_CATEGORIES, AFFINITY_MATRIX, isAffinityCategory } from "./affinity.js";
import { FENCE_CATEGORIES, isFenceCategory, type FenceTierType } from "./fences.js";
import { REGION_IDS, isRegionId } from "./regions.js";
import type { SiegeType } from "./siege.js";
import { TRAP_CATEGORIES, isTrapCategory, type TrapType } from "./traps.js";
import { TUNABLES } from "./tunables.js";
import type { LivingUnitType } from "./units.js";

export interface ContentBundle {
  readonly units: readonly LivingUnitType[];
  readonly traps: readonly TrapType[];
  readonly siege: readonly SiegeType[];
  readonly fences: readonly FenceTierType[];
}

export class ContentValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Content failed validation (${problems.length} problem(s)):\n  - ${problems.join("\n  - ")}`);
    this.name = "ContentValidationError";
  }
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);
const isPosInt = (n: unknown): n is number => isInt(n) && n > 0;
const isNonEmptyString = (s: unknown): s is string => typeof s === "string" && s.trim().length > 0;

/** Returns a list of problems; empty means valid. */
export function validateContent(content: ContentBundle): string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const dup = (id: string): void => {
    if (seenIds.has(id)) problems.push(`duplicate id '${id}'`);
    seenIds.add(id);
  };

  // ── registry-level consistency ────────────────────────────────────────────────────
  if (AFFINITY_CATEGORIES.length !== TUNABLES.AFFINITY_CATEGORIES)
    problems.push(`AFFINITY_CATEGORIES has ${AFFINITY_CATEGORIES.length} entries, TUNABLES says ${TUNABLES.AFFINITY_CATEGORIES}`);
  if (ABILITY_ARCHETYPES.length !== TUNABLES.ABILITY_ARCHETYPE_COUNT)
    problems.push(`ABILITY_ARCHETYPES has ${ABILITY_ARCHETYPES.length} entries, TUNABLES says ${TUNABLES.ABILITY_ARCHETYPE_COUNT}`);
  if (REGION_IDS.length !== TUNABLES.REGION_COUNT)
    problems.push(`REGIONS has ${REGION_IDS.length} entries, TUNABLES.REGION_COUNT is ${TUNABLES.REGION_COUNT}`);
  for (const dealer of AFFINITY_CATEGORIES) {
    for (const receiver of AFFINITY_CATEGORIES) {
      const outcome = AFFINITY_MATRIX[dealer]?.[receiver];
      if (outcome !== "advantage" && outcome !== "neutral" && outcome !== "disadvantage")
        problems.push(`AFFINITY_MATRIX[${dealer}][${receiver}] missing or invalid`);
    }
  }

  // ── living units ──────────────────────────────────────────────────────────────────
  if (content.units.length !== TUNABLES.LIVING_UNITS_PER_REGION * TUNABLES.REGION_COUNT)
    problems.push(`expected ${TUNABLES.LIVING_UNITS_PER_REGION * TUNABLES.REGION_COUNT} living units, found ${content.units.length}`);
  for (const regionId of REGION_IDS) {
    const n = content.units.filter((u) => u.regionId === regionId).length;
    if (n !== TUNABLES.LIVING_UNITS_PER_REGION)
      problems.push(`region '${regionId}' has ${n} units, expected ${TUNABLES.LIVING_UNITS_PER_REGION}`);
  }
  for (const u of content.units) {
    const where = `unit '${String(u.id)}'`;
    dup(String(u.id));
    if (!isNonEmptyString(u.id) || !isNonEmptyString(u.displayName) || !isNonEmptyString(u.flavor))
      problems.push(`${where}: id, displayName and flavor are required`);
    if (!isRegionId(u.regionId)) problems.push(`${where}: unknown region '${String(u.regionId)}'`);
    else if (!String(u.id).startsWith(`${u.regionId}.`)) problems.push(`${where}: id must be prefixed with its region`);
    if (!isAffinityCategory(u.affinity)) problems.push(`${where}: unknown affinity '${String(u.affinity)}'`);
    for (const [field, lo, hi] of [
      ["offense", TUNABLES.BASE_OFFENSE_MIN, TUNABLES.BASE_OFFENSE_MAX],
      ["defense", TUNABLES.BASE_DEFENSE_MIN, TUNABLES.BASE_DEFENSE_MAX],
      ["hp", TUNABLES.UNIT_HP_MIN, TUNABLES.UNIT_HP_MAX],
      ["moveSpeed", TUNABLES.MOVE_SPEED_MIN, TUNABLES.MOVE_SPEED_MAX],
      ["attackCooldown", TUNABLES.ATTACK_COOLDOWN_MIN, TUNABLES.ATTACK_COOLDOWN_MAX],
    ] as const) {
      const v = u[field];
      if (!isInt(v)) problems.push(`${where}: ${field} must be an integer`);
      else if (v < lo || v > hi) problems.push(`${where}: ${field}=${v} outside ${lo}..${hi}`);
    }
    for (const field of ["attackRange", "aggroRadius", "leashDistance"] as const) {
      if (!isPosInt(u[field])) problems.push(`${where}: ${field} must be a positive integer (fixed-point cells)`);
    }
    // Reachability: anything it notices (aggro) it must be able to hit by chasing at most
    // its leash and then attacking at its range. Ranged sentries legitimately have
    // aggro > leash; melee units may not.
    if (isInt(u.aggroRadius) && isInt(u.leashDistance) && isInt(u.attackRange) && u.leashDistance + u.attackRange < u.aggroRadius)
      problems.push(`${where}: aggroRadius exceeds leashDistance + attackRange — it would notice attackers it can never reach`);
    problems.push(...validateAbility(u.ability, where));
  }

  // ── traps ─────────────────────────────────────────────────────────────────────────
  if (content.traps.length !== TUNABLES.TRAP_TYPES)
    problems.push(`expected ${TUNABLES.TRAP_TYPES} trap types, found ${content.traps.length}`);
  for (const t of content.traps) {
    const where = `trap '${String(t.id)}'`;
    dup(String(t.id));
    if (!isNonEmptyString(t.displayName) || !isNonEmptyString(t.flavor)) problems.push(`${where}: displayName and flavor are required`);
    if (!String(t.id).startsWith("trap.")) problems.push(`${where}: id must start with 'trap.'`);
    if (!isTrapCategory(t.category)) problems.push(`${where}: unknown trap category '${String(t.category)}'`);
    if (!isAffinityCategory(t.affinity)) problems.push(`${where}: unknown affinity '${String(t.affinity)}'`);
    if (!isInt(t.damage) || t.damage < TUNABLES.TRAP_DAMAGE_MIN || t.damage > TUNABLES.TRAP_DAMAGE_MAX)
      problems.push(`${where}: damage=${String(t.damage)} outside ${TUNABLES.TRAP_DAMAGE_MIN}..${TUNABLES.TRAP_DAMAGE_MAX}`);
    if (t.effect !== null) {
      if (t.effect.kind === "slow") {
        if (!isPosInt(t.effect.magnitude) || !isPosInt(t.effect.duration)) problems.push(`${where}: slow effect needs integer magnitude and duration`);
      } else if (t.effect.kind === "root") {
        if (!isPosInt(t.effect.duration)) problems.push(`${where}: root effect needs an integer duration`);
      } else {
        problems.push(`${where}: unknown effect kind '${String((t.effect as { kind: unknown }).kind)}'`);
      }
    }
  }

  // ── fences ────────────────────────────────────────────────────────────────────────
  if (content.fences.length !== TUNABLES.FENCE_TIERS)
    problems.push(`expected ${TUNABLES.FENCE_TIERS} fence tiers, found ${content.fences.length}`);
  const tiers = new Set<number>();
  for (const f of content.fences) {
    const where = `fence '${String(f.id)}'`;
    dup(String(f.id));
    if (!isNonEmptyString(f.displayName) || !isNonEmptyString(f.flavor)) problems.push(`${where}: displayName and flavor are required`);
    if (!String(f.id).startsWith("fence.")) problems.push(`${where}: id must start with 'fence.'`);
    if (!isFenceCategory(f.category)) problems.push(`${where}: unknown fence category '${String(f.category)}'`);
    if (!isPosInt(f.segmentHp)) problems.push(`${where}: segmentHp must be a positive integer`);
    if (!isPosInt(f.tier) || f.tier > TUNABLES.FENCE_TIERS) problems.push(`${where}: tier must be 1..${TUNABLES.FENCE_TIERS}`);
    if (tiers.has(f.tier)) problems.push(`${where}: duplicate tier ${f.tier}`);
    tiers.add(f.tier);
  }
  if (!content.fences.some((f) => f.segmentHp === TUNABLES.FENCE_SEGMENT_HP_DEFAULT))
    problems.push(`no fence tier has FENCE_SEGMENT_HP_DEFAULT (${TUNABLES.FENCE_SEGMENT_HP_DEFAULT}) HP`);

  // ── siege ─────────────────────────────────────────────────────────────────────────
  if (content.siege.length !== TUNABLES.SIEGE_TYPES)
    problems.push(`expected ${TUNABLES.SIEGE_TYPES} siege types, found ${content.siege.length}`);
  const usedFenceCats = new Set<string>();
  const usedTrapCats = new Set<string>();
  for (const s of content.siege) {
    const where = `siege '${String(s.id)}'`;
    dup(String(s.id));
    if (!isNonEmptyString(s.displayName) || !isNonEmptyString(s.flavor)) problems.push(`${where}: displayName and flavor are required`);
    if (!String(s.id).startsWith("siege.")) problems.push(`${where}: id must start with 'siege.'`);
    const c = s.counters;
    if (!c) {
      problems.push(`${where}: must counter something`);
    } else if (c.kind === "fence") {
      if (!isFenceCategory(c.category)) problems.push(`${where}: counters unknown fence category '${String(c.category)}'`);
      if (usedFenceCats.has(c.category)) problems.push(`${where}: fence category '${c.category}' is countered by more than one piece`);
      usedFenceCats.add(c.category);
    } else if (c.kind === "trap") {
      if (!isTrapCategory(c.category)) problems.push(`${where}: counters unknown trap category '${String(c.category)}'`);
      if (usedTrapCats.has(c.category)) problems.push(`${where}: trap category '${c.category}' is countered by more than one piece`);
      usedTrapCats.add(c.category);
    } else {
      problems.push(`${where}: counter kind must be 'fence' or 'trap'`);
    }
  }
  // Every category a player can build with must have an answer, or siege choice collapses.
  for (const cat of FENCE_CATEGORIES) if (!usedFenceCats.has(cat)) problems.push(`fence category '${cat}' has no siege counter`);
  for (const cat of TRAP_CATEGORIES) if (!usedTrapCats.has(cat)) problems.push(`trap category '${cat}' has no siege counter`);

  return problems;
}

function validateAbility(a: Ability | undefined, where: string): string[] {
  const p: string[] = [];
  if (!a || typeof a !== "object") return [`${where}: ability is required (exactly one)`];
  if (!isAbilityArchetype(a.archetype)) return [`${where}: unknown ability archetype '${String((a as { archetype: unknown }).archetype)}'`];
  if (!isNonEmptyString(a.displayName) || !isNonEmptyString(a.description)) p.push(`${where}: ability displayName and description are required`);
  if (!isInt(a.cooldown) || a.cooldown < TUNABLES.ABILITY_COOLDOWN_MIN || a.cooldown > TUNABLES.ABILITY_COOLDOWN_MAX)
    p.push(`${where}: ability cooldown ${String(a.cooldown)} outside ${TUNABLES.ABILITY_COOLDOWN_MIN}..${TUNABLES.ABILITY_COOLDOWN_MAX} ms`);
  const need = (field: string, v: unknown): void => {
    if (!isPosInt(v)) p.push(`${where}: ability.${field} must be a positive integer`);
  };
  switch (a.archetype) {
    case "burst_radius":
      need("radius", a.radius);
      need("damageMult", a.damageMult);
      break;
    case "heavy_strike":
      need("damageMult", a.damageMult);
      break;
    case "heal_radius":
      need("radius", a.radius);
      need("healFraction", a.healFraction);
      need("charges", a.charges);
      if (isInt(a.charges) && a.charges !== TUNABLES.HEAL_CHARGES_PER_BATTLE)
        p.push(`${where}: heal charges ${a.charges} != HEAL_CHARGES_PER_BATTLE (${TUNABLES.HEAL_CHARGES_PER_BATTLE}) — the healer bound is a design constraint, not per-unit flavour`);
      break;
    case "self_buff":
      need("damageBonus", a.damageBonus);
      need("duration", a.duration);
      break;
    case "dash":
      need("distance", a.distance);
      break;
    case "structure_breaker":
      need("fenceDamageMult", a.fenceDamageMult);
      break;
  }
  // No stray fields: a proc chance or target roll must not be smuggled in as extra data.
  const allowed = new Set(["archetype", "displayName", "description", "cooldown", "radius", "damageMult", "healFraction", "charges", "damageBonus", "duration", "distance", "fenceDamageMult"]);
  for (const key of Object.keys(a)) if (!allowed.has(key)) p.push(`${where}: ability has unexpected field '${key}'`);
  return p;
}

/** Throws ContentValidationError if anything is wrong. Called once at module load. */
export function assertContentValid(content: ContentBundle): void {
  const problems = validateContent(content);
  if (problems.length > 0) throw new ContentValidationError(problems);
}
