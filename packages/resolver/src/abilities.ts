/**
 * Phase 7 — unit abilities (chunk 12). Exactly one ability per unit, drawn from SIX
 * archetypes; per-type variation is values only (the ability's data), so this file has six
 * cases and nothing else — no branch on a unit's type, ref, side-specific roster or merge
 * level (a test greps for it). Fully deterministic: no chance, no random target, no variance.
 * Pure integer arithmetic; every division a floor (fixed.ts).
 *
 * ABILITY_COOLDOWN (state.ts `abilityFields`): cooldownTicks = msToTicks(cooldown). The
 * ability may fire on any tick ≥ `abilityReadyTick`; after firing on tick t the next ready
 * tick is t + cooldownTicks. ABILITY_FIRST_USE_DELAY: the first ready tick is
 * floor(cooldownTicks × firstUse / 1.0), firstUse = abilityFirstUseDelayMult (×1.0: the full
 * cooldown, so a 9 s ability first fires on tick 180 at the earliest, the 181st tick) for
 * every archetype except the structure breaker, whose first use is
 * STRUCTURE_BREAKER_FIRST_USE_MULT (×0.25, QA-12 D2: a 12 s breaker first readies on tick 60)
 * — FENCE_HIT_SEGMENT_CAP keeps an early swing safe. A per-archetype value (state.ts
 * `abilityFields`), never a per-type one.
 *
 * ABILITY_TRIGGER_RULE: an ability fires on the FIRST tick on which it is ready AND its
 * targeting condition (below) is satisfiable; otherwise it waits, already ready, and is
 * re-tested every tick. There is no charge-up. The cooldown (and a heal's charge) is spent
 * when the firing APPLIES, not when it is decided; a decided firing whose effect would be
 * void by then is SKIPPED — nothing logged, nothing spent, still ready next tick
 * (ABILITY_SKIP_VOID, QA-12 N1/N2): a dash or a self buff whose caster is at 0 HP at apply
 * time (brought there earlier in phase 7 or before it), and a heal whose every target is at
 * 0 HP by step (b). A burst or heavy strike whose targets were brought to 0 earlier in step
 * (a) still lands and is spent (it fired at living targets, against the start-of-phase
 * state; its damage is simply absorbed by a unit already dying). Otherwise a caster at 0 HP
 * that is still `alive` (killed earlier this tick — it dies in phase 8) fires like every
 * other unit (SIMULTANEOUS_DAMAGE, chunk 11): a strike, burst, breaker or heal can fire on
 * the tick its caster dies.
 *
 * ABILITY_SKIPS_ZERO_HP: no ability ever targets a unit already at 0 HP (it dies in phase 8),
 * and such a unit does not make a condition satisfiable. Units are otherwise targeted while
 * `alive`, exactly as phase 6 does.
 *
 * ABILITY_RESOLUTION_ORDER — decide, then apply:
 *   1. DECIDE. Every living unit is visited in ASCENDING UNIT ID; a ready unit whose condition
 *      holds fires: its targets are chosen now, against the state as it stands at the start
 *      of phase 7 (positions after phases 3/5, HP after phases 4/6). Nothing is mutated while
 *      deciding, so no firing can change another's targets — order cannot leak into choice.
 *   2. APPLY, damage first — (a) every firing that is NOT a heal, in ascending caster id
 *      (burst, heavy strike, structure breaker, self buff, dash — an attacker's dash springs
 *      the traps on its path right there); then (b) every heal, in ascending caster id.
 *      ABILITY_SKIP_VOID (above) is checked as each firing applies.
 *   HEAL_VS_DAMAGE_SAME_TICK (pinned by a test): a heal can NEVER save a unit from damage that
 *   lands on the same tick, whatever the two units' ids. Damage from phases 4 and 6 is
 *   already in before phase 7, and ability damage is applied before any heal, so a unit
 *   brought to 0 HP at any point in the tick stays at 0 — a heal reaching it restores 0 and
 *   it dies in phase 8. A heal applies to the HP left after ALL of the tick's damage. This is
 *   the "losses still bite" reading (chunk 12 healer rules 3) and keeps outcomes independent of
 *   which unit happens to hold the lower id (refs are names, not tactics).
 *
 * The six archetypes — condition, targets (TARGET_ORDER: the archetype's own rule, then
 * ascending unit id), effect. REACH is the chunk 11 rule: squared centre distance ≤
 * (radius + unitRadius)², INCLUSIVE.
 *
 *   burst_radius      condition: ≥ 1 living enemy with HP > 0 within (radius + unitRadius) of
 *                     the caster. Targets: ALL of them, ascending id. Effect per target:
 *                     combat.ts `abilityHitDamage` with `damageMult` — formula → affinity →
 *                     merge → (buff) → × damageMult → min 1, each floored.
 *   heavy_strike      condition: an enemy the caster could hit right now — the nearest living
 *                     enemy with HP > 0 within its attack reach, lowest id on a tie; a caster
 *                     that is breaching considers only enemies that have IT in reach
 *                     (ATTACK_PRIORITY, chunk 11 QA D2), the same rule as phase 6. One target,
 *                     the same pipeline with × damageMult (×3.0 of the MERGED hit by default).
 *   heal_radius       condition: charges > 0 and ≥ 1 living ally (same side, the caster
 *                     included) with 0 < HP < its HEAL_CEILING within (radius + unitRadius).
 *                     Targets: all of them, ascending id. Effect: + floor(maxHp × healFraction),
 *                     capped at the target's HEAL_CEILING, applied in step (b). HEAL_CEILING =
 *                     the HP the target brought INTO this battle (`startHp`, ≤ max HP): healing
 *                     undoes damage taken in THIS fight only, never damage carried forward from
 *                     an earlier encounter — otherwise a fresh satchel at the start of each
 *                     fight would top the caravan up between encounters, which healer rule 4
 *                     forbids (and the attrition test caught: without it a healer circle came
 *                     out of a weak encounter HIGHER than it went in). NO OVERHEAL follows
 *                     (startHp ≤ maxHp). A target at 0 HP by then gets
 *                     0 (NO REVIVAL — death, and with it the per-death merge regression the
 *                     server applies to a unit that died, is never reversed: a dead unit is
 *                     `alive = false`, never a target, and phase 8 is the only writer of
 *                     `alive`). One charge is spent per firing. HEAL_CHARGES: `charges` per
 *                     battle from the ability data, never regenerating; every resolve() builds
 *                     fresh state, so charges reset per encounter and cannot be banked. HP the
 *                     unit ends the fight with is what the output reports — nothing tops it up.
 *   self_buff         condition: the caster has something to hit right now — an enemy with
 *                     HP > 0 in its attack reach, or (attackers) the fence it is breaching.
 *                     Effect: its hits deal × (1 + damageBonus) (combat.ts step 3b) on ticks
 *                     t+1 … t+durationTicks (`buffEndTick` = t + durationTicks; the cast tick's
 *                     phase 6 has already run). SELF_BUFF_REFRESH: non-stacking — a firing while
 *                     a buff is in force REPLACES it: the end becomes t + durationTicks (never
 *                     extended beyond one full duration from now, never a larger multiplier).
 *                     With content's values (duration < cooldown) it cannot overlap anyway.
 *   dash              condition: the caster can move along a route right now — it is not
 *                     at 0 HP (DASH_NOT_DYING: a dying unit's last strike lands, it does not
 *                     run), it has
 *                     waypoints, the next one is not an intact breach segment, it is not
 *                     rooted (a dash never breaks a root; a slow does not shorten it), and it is
 *                     not engaged (an attacker whose unit target is in reach holds; a posted
 *                     unit dashes only while `pursuing` and out of reach of its target — `hold`
 *                     posts and unreleased `reserve` posts never move, so never dash), and the
 *                     dash would cover ground (DASH_NEVER_EMPTY: a trial run of the step on a
 *                     restored copy of the unit's movement fields moves it > 0 — not blocked
 *                     by an intact breach segment next, not pinned at its leash). At apply
 *                     time a caster at 0 HP (brought there earlier in phase 7) does not dash
 *                     (ABILITY_SKIP_VOID).
 *                     Effect: move `distance` further along the CURRENT route by the movement
 *                     leg rule (move.ts `advance`), landing on and consuming waypoints, stopping
 *                     short of an intact breach segment. The route is a smoothed path that never
 *                     crosses an intact fence or anchor cell (LOS_LEG_MARGIN), and `advance`
 *                     refuses any step into or across a blocked cell, so a dash NEVER passes
 *                     through an intact fence or anchor. A pursuing post's dash is clamped at its
 *                     leash (posted.ts LEASH_CLAMP; it disengages on its next phase 5 if it
 *                     still wants to go further). DASH_SPRINGS_TRAPS (QA-12 B1): an attacker's
 *                     dash polyline (start, every waypoint landed on, end) is tested against
 *                     the traps IMMEDIATELY, inside phase 7 right after its own dash, with
 *                     every phase-4 rule (traps.ts `springTraps`: swept-segment test, ascending
 *                     trap index, TRAP_SKIPS_ZERO_HP, siege nullify, spent on firing) — so a
 *                     dash can never carry a unit over a trap, and that holds on the tick-cap
 *                     tick too. Dashes apply in ascending caster id, so two attackers dashing
 *                     over the same trap on one tick: the lower id springs it. Only AFTER that,
 *                     and only if the dasher's HP is still > 0, a dash ending on a core cell
 *                     records `core_reached` on the dash tick (a unit a trap kills on its dash
 *                     never reaches the core).
 *   structure_breaker condition: the caster is an attacker breaching a segment it can hit now
 *                     (orthogonally adjacent, intact, HP > 0 — combat.ts `breachableFence`)
 *                     AND it has room left under FENCE_HIT_SEGMENT_CAP this tick (combat.ts
 *                     `fenceHitRoom` ≥ 1 — its phase-6 hit this tick counts). Posted units never
 *                     hit fence, so a posted breaker never fires (an intended lopsidedness).
 *                     Target: that segment. STRUCTURE_BREAKER_DAMAGE:
 *                       merged = floor(rating × mergeMult [× buffMult while in force]) — one floor
 *                       mult   = fenceDamageMult + (siegeFenceDamageMult − 1.0) if the party's
 *                                siege counters the segment's category, else fenceDamageMult
 *                       damage = min(max(1, floor(merged × mult)), room)
 *                       room   = fenceHitCap − what the caster already dealt the segment this tick
 *                       fenceHitCap = max(1, floor(maxHp × fenceHitSegmentCap))
 *                     SIEGE_ADDITIVE: the two BONUSES add (×5 and ×4 → ×8), they never
 *                     multiply (×20). FENCE_HIT_SEGMENT_CAP (×0.50 by default, QA-12 D1, combat.ts
 *                     step 6) is ONE rule for every fence hit, not a breaker rule: a unit takes
 *                     at most half a segment's MAX HP from it PER TICK, its phase-6 hit (normal,
 *                     buffed, siege-multiplied) and its phase-7 breaker summed. A segment at full
 *                     HP therefore needs at least two blows from one unit on two different ticks
 *                     (several units breaching one segment each have their own allowance). The
 *                     uncapped worst case — a level-5 Buffalo Bull, offense 120, ×5 with stone
 *                     siege — would be floor(292 × 8) = 2336 against a 1000-HP Stacked Stone
 *                     segment; its normal siege hit alone would be 1168. Both are clipped to 500.
 *                     Affinity never applies (a segment has none).
 *
 * MERGE: no ability field scales with merge level (chunk 03 QA S1). Radii, distances,
 * durations, cooldowns and charges are the data's at every level; damage abilities multiply
 * the merged hit; heals are a fraction of the TARGET's max HP. Merge level never changes the
 * archetype, adds an ability, or changes which branch below runs.
 *
 * TWO PROFILES: a posted unit fires the same ability as the same type in a raid party, its
 * hits scored on its DEFENSE rating (`UnitState.rating`), exactly as its normal hits are.
 *
 * Siege has no abilities: siege pieces are not units and never enter this phase.
 */
import { cellOf, isCoreCell } from "./battlefield.js";
import { abilityHitDamage, atLeastOne, breachableFence, dealtOutput, engaged, fenceHitRoom, landFenceHit, unitDistSq } from "./combat.js";
import { FIXED_ONE, scaleInt, type Fixed } from "./fixed.js";
import type { AbilityEffectLog, LogEvent } from "./log.js";
import { advanceMeasured } from "./move.js";
import { advanceWithinLeash } from "./posted.js";
import type { SimState, UnitState } from "./state.js";
import { springTraps } from "./traps.js";

/** One decided firing: the caster and its targets (unit ids, or one fence index for structure_breaker). */
interface Firing {
  readonly caster: UnitState;
  readonly targets: readonly number[];
}

/** The id range [from, to) of `u`'s enemies. */
function enemyRange(state: SimState, u: UnitState): readonly [number, number] {
  return u.side === "attacker" ? [state.attackerCount, state.units.length] : [0, state.attackerCount];
}

/**
 * The enemy `u` could hit right now (phase 6's selection, ABILITY_SKIPS_ZERO_HP applied):
 * nearest living enemy with HP > 0 within its attack reach, lowest id on a tie; a breacher
 * considers only enemies that also have it within THEIR reach (ATTACK_PRIORITY).
 */
export function strikeTarget(state: SimState, u: UnitState): UnitState | null {
  const threatsOnly = breachableFence(state, u) !== null;
  const [from, to] = enemyRange(state, u);
  let best: UnitState | null = null;
  let bestD = 0;
  for (let id = from; id < to; id++) {
    const v = state.units[id]!;
    if (!v.alive || v.hp === 0) continue;
    const d = unitDistSq(u, v);
    if (d > u.reachSq || (threatsOnly && d > v.reachSq)) continue;
    if (best === null || d < bestD) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

/** Move `u` by a dash of `budget` (attackers: plain leg rule; posted units: leash-clamped). Returns the distance used. */
function dashStep(state: SimState, u: UnitState, budget: number): number {
  return u.side === "attacker" ? advanceMeasured(state, u, budget).used : advanceWithinLeash(state, u, budget).used;
}

/**
 * The distance a dash of `budget` would cover now, without changing anything: the step is run
 * on the live unit and every field it can touch is restored (pure; deterministic).
 */
function trialDash(state: SimState, u: UnitState, budget: number): number {
  const x = u.x;
  const y = u.y;
  const waypoints = u.waypoints.slice();
  const legX = u.legX;
  const legY = u.legY;
  const legLen = u.legLen;
  const legProgress = u.legProgress;
  const pathDirty = u.pathDirty;
  const breaching = u.breaching;
  const sweep = u.sweep;
  u.sweep = [{ x, y }];
  const used = dashStep(state, u, budget);
  u.x = x;
  u.y = y;
  u.waypoints = waypoints;
  u.legX = legX;
  u.legY = legY;
  u.legLen = legLen;
  u.legProgress = legProgress;
  u.pathDirty = pathDirty;
  u.breaching = breaching;
  u.sweep = sweep;
  return used;
}

/** Whether `u` could move along its route this instant (dash condition; see header). */
export function canDash(state: SimState, u: UnitState, distance: number): boolean {
  // DASH_NOT_DYING: a caster already at 0 HP (it dies in phase 8) fires a strike or a burst
  // like any dying unit's last hit, but does not move: its movement phase is over.
  if (u.hp === 0 || u.rootRemaining > 0 || u.waypoints.length === 0) return false;
  if (u.side === "attacker") {
    if (engaged(state, u)) return false;
  } else {
    if (u.postMode !== "pursuing" || u.target === null || u.target.kind !== "unit") return false;
    const v = state.units[u.target.id]!;
    if (!v.alive || unitDistSq(u, v) <= u.reachSq) return false;
  }
  // DASH_NEVER_EMPTY: it must actually cover ground (not blocked by an intact breach segment
  // next, not pinned at its leash).
  return trialDash(state, u, distance) > 0;
}

/** The targets `u`'s ability would take now, or null when its condition is not satisfiable. */
function decide(state: SimState, u: UnitState): number[] | null {
  const a = u.ability;
  switch (a.archetype) {
    case "burst_radius": {
      const [from, to] = enemyRange(state, u);
      const out: number[] = [];
      for (let id = from; id < to; id++) {
        const v = state.units[id]!;
        if (v.alive && v.hp > 0 && unitDistSq(u, v) <= u.abilityRadiusSq) out.push(id);
      }
      return out.length > 0 ? out : null;
    }
    case "heavy_strike": {
      const v = strikeTarget(state, u);
      return v === null ? null : [v.id];
    }
    case "heal_radius": {
      if (u.abilityCharges <= 0) return null;
      const [from, to] = u.side === "attacker" ? [0, state.attackerCount] : [state.attackerCount, state.units.length];
      const out: number[] = [];
      for (let id = from; id < to; id++) {
        const v = state.units[id]!;
        if (v.alive && v.hp > 0 && v.hp < v.startHp && unitDistSq(u, v) <= u.abilityRadiusSq) out.push(id);
      }
      return out.length > 0 ? out : null;
    }
    case "self_buff":
      return strikeTarget(state, u) !== null || breachableFence(state, u) !== null ? [u.id] : null;
    case "dash":
      return canDash(state, u, a.distance) ? [u.id] : null;
    case "structure_breaker": {
      const f = breachableFence(state, u);
      return f === null || fenceHitRoom(state, u, f) < 1 ? null : [f.index];
    }
  }
}

/** STRUCTURE_BREAKER_DAMAGE (see header): additive with siege, min 1, clipped to the caster's FENCE_HIT_SEGMENT_CAP room this tick. */
export function structureBreakerDamage(state: SimState, u: UnitState, fenceIndex: number, fenceDamageMult: Fixed): number {
  const fence = state.fences[fenceIndex]!;
  const mult = (fence.siegeCountered ? fenceDamageMult + state.siegeFenceDamageMult - FIXED_ONE : fenceDamageMult) as Fixed;
  const raw = atLeastOne(scaleInt(dealtOutput(state, u, u.rating), mult));
  const room = fenceHitRoom(state, u, fence);
  return raw < room ? raw : room;
}

function unitEffect(v: UnitState, amount: number): AbilityEffectLog {
  return { kind: "unit", id: v.id, amount, hp: v.hp };
}

/** Step 2(a): one non-heal firing. Returns false when it is skipped (ABILITY_SKIP_VOID). */
function applyNonHeal(state: SimState, f: Firing, log: LogEvent[]): boolean {
  const u = f.caster;
  const a = u.ability;
  const t = state.tick;
  switch (a.archetype) {
    case "burst_radius":
    case "heavy_strike": {
      const tg: AbilityEffectLog[] = [];
      for (const id of f.targets) {
        const v = state.units[id]!;
        const damage = abilityHitDamage(state, u, v, a.damageMult);
        v.hp = v.hp - damage < 0 ? 0 : v.hp - damage;
        tg.push(unitEffect(v, damage));
      }
      log.push({ t, k: "ability", u: u.id, a: a.archetype, tg });
      return true;
    }
    case "structure_breaker": {
      const fence = state.fences[f.targets[0]!]!;
      // Decided with room ≥ 1, and nothing earlier in phase 7 touches this caster's allowance.
      const damage = structureBreakerDamage(state, u, fence.index, a.fenceDamageMult);
      landFenceHit(state, u, fence, damage);
      log.push({ t, k: "ability", u: u.id, a: "structure_breaker", tg: [{ kind: "fence", id: fence.index, amount: damage, hp: fence.hp }] });
      return true;
    }
    case "self_buff": {
      if (u.hp === 0) return false; // ABILITY_SKIP_VOID: a dying caster's buff would never carry a hit
      u.buffEndTick = t + u.buffTicks;
      log.push({ t, k: "ability", u: u.id, a: "self_buff", tg: [unitEffect(u, u.buffTicks)], until: u.buffEndTick });
      return true;
    }
    case "dash": {
      if (u.hp === 0) return false; // ABILITY_SKIP_VOID (DASH_NOT_DYING at apply time, QA-12 N1)
      u.sweep = [{ x: u.x, y: u.y }];
      const used = dashStep(state, u, a.distance);
      log.push({ t, k: "ability", u: u.id, a: "dash", tg: [unitEffect(u, used)], x: u.x, y: u.y });
      if (u.side === "attacker") {
        // DASH_SPRINGS_TRAPS: the dash path meets the traps now, then (if it survived) the core.
        springTraps(state, u, log);
        if (u.hp > 0 && u.reachedCoreTick < 0 && isCoreCell(cellOf({ x: u.x, y: u.y }))) {
          u.reachedCoreTick = t;
          log.push({ t, k: "core_reached", u: u.id });
        }
      }
      return true;
    }
    case "heal_radius":
      return false; // step (b)
  }
}

/** Step 2(b): one heal. Returns false when it is skipped (ABILITY_SKIP_VOID: every target at 0 HP). */
function applyHeal(state: SimState, f: Firing, log: LogEvent[]): boolean {
  const u = f.caster;
  const a = u.ability;
  if (a.archetype !== "heal_radius") return false;
  if (f.targets.every((id) => state.units[id]!.hp === 0)) return false;
  u.abilityCharges--;
  const tg: AbilityEffectLog[] = [];
  for (const id of f.targets) {
    const v = state.units[id]!;
    let amount = 0;
    if (v.hp > 0) {
      const heal = scaleInt(v.maxHp, a.healFraction);
      const room = v.startHp > v.hp ? v.startHp - v.hp : 0; // HEAL_CEILING (≤ maxHp: no overheal)
      amount = heal < room ? heal : room;
      v.hp += amount;
    }
    tg.push(unitEffect(v, amount));
  }
  log.push({ t: state.tick, k: "ability", u: u.id, a: "heal_radius", tg, charges: u.abilityCharges });
  return true;
}

/** The cooldown is spent when a firing applies (ABILITY_SKIP_VOID: a skipped firing stays ready). */
function spend(state: SimState, f: Firing): void {
  f.caster.abilityReadyTick = state.tick + f.caster.abilityCooldownTicks;
}

export function abilityPhase(state: SimState, log: LogEvent[]): void {
  const firings: Firing[] = [];
  for (const u of state.units) {
    if (!u.alive || state.tick < u.abilityReadyTick) continue;
    const targets = decide(state, u);
    if (targets === null) continue; // ABILITY_TRIGGER_RULE: wait, already ready
    firings.push({ caster: u, targets });
  }
  for (const f of firings) if (f.caster.ability.archetype !== "heal_radius" && applyNonHeal(state, f, log)) spend(state, f);
  for (const f of firings) if (f.caster.ability.archetype === "heal_radius" && applyHeal(state, f, log)) spend(state, f);
}
