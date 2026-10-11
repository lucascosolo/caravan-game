/**
 * Damage and targeting (chunk 11). Pure integer arithmetic; every division is a floor
 * (fixed.ts rounding mode).
 *
 * DAMAGE_FORMULA (PROJECT.md §11, fixed by design):
 *     hit = floor(o × o / (o + d))
 * where o is the DEALER's rating and d the RECEIVER's rating.
 *
 * DAMAGE_SLOTS — which number fills which slot, in every direction. Each unit brings ONE
 * rating to a fight (`UnitState.rating`): an attacker its `offense`, a posted unit its
 * `defense`. So:
 *   attacker → posted unit : o = attacker.offense,  d = post.defense
 *   posted unit → attacker : o = post.defense,      d = attacker.offense
 *   anything → fence       : o = attacker.offense,  d = 0  (a segment has no rating; hit = o)
 *   trap → attacker        : flat trap.damage (no formula), then the affinity step below
 * The other rating is never read: a posted unit's offense and an attacker's defense do not
 * exist inside the resolver (state.ts sets them to 0 and `rating` is the only field combat
 * reads).
 *
 * DAMAGE_ROUNDING_ORDER — fixed, because the order of floors changes outcomes:
 *   1. the formula, floored;
 *   2. × affinity multiplier (AFFINITY_MATRIX[dealer][receiver] → advantage / neutral /
 *      disadvantage multiplier from the input), floored (AFFINITY_APPLICATION);
 *   3. × the dealer's merge multiplier (MERGE_STAT_MULT_BY_LEVEL[mergeLevel]), floored —
 *      chunk 03 QA B1: the multiplier scales damage OUTPUT and max HP, never a rating;
 *   3b. × the dealer's self-buff multiplier (chunk 12 SELF_BUFF: FIXED_ONE + damageBonus)
 *      while its buff is in force (cast tick < tick ≤ buffEndTick) — every hit it deals, unit
 *      or fence. ONE FLOOR (chunk 12 QA S3): steps 3 and 3b are a single product,
 *      floor(value × mergeMult × buffMult), never floor(floor(value × mergeMult) × buffMult)
 *      (fixed.ts `scaleInt2`); absent (×1.0, step 3 alone) otherwise;
 *   3c. × the ABILITY multiplier, ability hits only (chunk 12: burst_radius / heavy_strike
 *      `damageMult` on a unit; structure_breaker's combined fence multiplier, which already
 *      includes siege ADDITIVELY and replaces step 4 — abilities.ts), floored. It multiplies
 *      the MERGED hit: no ability field scales with merge level (chunk 03 QA S1), the merged
 *      hit already carries it;
 *   4. × the siege multiplier, fence hits only (hooks.ts `siegeFenceMult`), floored;
 *   5. minimum 1 (DAMAGE_MINIMUM): every hit that lands does at least one point, so no
 *      matchup is a stalemate by rounding and every breach terminates;
 *   6. FENCE_HIT_SEGMENT_CAP (chunk 12 QA D1), fence hits only: one unit takes at most
 *      `fenceHitCap` = max(1, floor(segment max HP × fenceHitSegmentCap)) — ×0.50 by default —
 *      from one segment PER TICK, summed over every fence hit it lands that tick: its phase-6
 *      hit (buffed or not, siege or not) and its phase-7 structure breaker together. A hit is
 *      clipped to the room left (`fenceHitRoom`); a breaker with no room left this tick does
 *      not fire (it waits — abilities.ts). So a full segment of any tier, at any merge level,
 *      with any siege, buff or ability, needs at least two blows from one unit, on two
 *      different ticks. Siege stays ×4; the cap, not the multiplier, prices the breach.
 * Traps skip steps 1, 3, 3b, 3c and 4 (they are not units and carry no merge level).
 *
 * ATTACK_TARGET_SELECTION: a unit hits the NEAREST living enemy unit within its reach
 * (REACH rule: squared centre distance ≤ (attackRange + unitRadius)²); an exact tie goes to
 * the LOWER unit id. This is the same for every stance on both sides, with no exception —
 * a stance drives movement and acquisition, never what gets hit (chunk 07 QA D1, chunk 11
 * QA D1): a `reserve` post that has not been released yet still fires at an attacker in
 * reach; it only does not acquire or move. Selection is independent of the unit's movement
 * target: a `core` attacker walking past a guard in reach fires at it, and a guard pursuing
 * one attacker hits whichever attacker is nearest.
 *
 * ATTACK_PRIORITY (chunk 11 QA D2) — an attacker that is BREACHING a fence this tick (it
 * stands at the segment and phase 6 would hit it) switches to a unit only if that unit can
 * reach it back: the candidates are the enemies within the attacker's reach that also have
 * the attacker within THEIR reach (`threatInReach`; nearest, lowest id on a tie). It fights
 * back against what is hurting it; a post that cannot touch it does not shield the fence.
 * With no such threat it keeps hitting the fence. A non-breaching attacker, and every
 * posted unit, uses the plain nearest-in-reach rule above.
 */
import { cellDistSq, cellOf, type AffinityCategory } from "./battlefield.js";
import { scaleInt, scaleInt2, type Fixed } from "./fixed.js";
import type { FenceState, SimState, UnitState } from "./state.js";

/** The multiplier for damage of category `dealer` landing on a unit of category `receiver`. */
export function affinityMult(state: SimState, dealer: AffinityCategory, receiver: AffinityCategory): Fixed {
  const outcome = state.affinityMatrix[dealer][receiver];
  if (outcome === "advantage") return state.affinityAdvantageMult;
  if (outcome === "disadvantage") return state.affinityDisadvantageMult;
  return state.affinityNeutralMult;
}

/** Step 1: floor(o² / (o + d)). o ≥ 1 by input validation, so the divisor is never 0. */
export function formulaDamage(o: number, d: number): number {
  return Math.floor((o * o) / (o + d));
}

/** Step 5. */
export function atLeastOne(damage: number): number {
  return damage < 1 ? 1 : damage;
}

/**
 * Whether `u`'s self buff is in force for hits dealt this tick (step 3b): ticks
 * cast + 1 … cast + buffTicks, i.e. buffEndTick − buffTicks < tick ≤ buffEndTick.
 */
export function buffActive(state: SimState, u: UnitState): boolean {
  return state.tick <= u.buffEndTick && state.tick > u.buffEndTick - u.buffTicks;
}

/** Steps 3 and 3b: the dealer's merge multiplier, and its buff while in force — one floor (QA S3). */
export function dealtOutput(state: SimState, dealer: UnitState, value: number): number {
  return buffActive(state, dealer) ? scaleInt2(value, dealer.mergeMult, dealer.buffMult) : scaleInt(value, dealer.mergeMult);
}

/** Step 6: the most one unit may take from `fence` in one tick, all its fence hits summed. */
export function fenceHitCap(state: SimState, fence: FenceState): number {
  return atLeastOne(scaleInt(fence.maxHp, state.fenceHitSegmentCap));
}

/** Step 6: what `u` may still take from `fence` this tick (the cap less what it already took this tick). */
export function fenceHitRoom(state: SimState, u: UnitState, fence: FenceState): number {
  const dealt = u.fenceHitTick === state.tick && u.fenceHitIndex === fence.index ? u.fenceHitDealt : 0;
  const cap = fenceHitCap(state, fence);
  return cap > dealt ? cap - dealt : 0;
}

/** Step 6: land `damage` (already clipped to `fenceHitRoom`) from `u` on `fence` and count it against this tick's cap. */
export function landFenceHit(state: SimState, u: UnitState, fence: FenceState, damage: number): void {
  if (u.fenceHitTick !== state.tick || u.fenceHitIndex !== fence.index) {
    u.fenceHitTick = state.tick;
    u.fenceHitIndex = fence.index;
    u.fenceHitDealt = 0;
  }
  u.fenceHitDealt += damage;
  fence.hp = fence.hp - damage < 0 ? 0 : fence.hp - damage;
}

/** Steps 1, 2, 3, 3b of DAMAGE_ROUNDING_ORDER for unit vs unit (no minimum yet). */
function unitHitBeforeMinimum(state: SimState, dealer: UnitState, receiver: UnitState): number {
  const base = formulaDamage(dealer.rating, receiver.rating);
  const withAffinity = scaleInt(base, affinityMult(state, dealer.affinity, receiver.affinity));
  return dealtOutput(state, dealer, withAffinity);
}

/** One hit from `dealer` on `receiver` (unit vs unit): steps 1, 2, 3, 3b, 5 of DAMAGE_ROUNDING_ORDER. */
export function hitDamage(state: SimState, dealer: UnitState, receiver: UnitState): number {
  return atLeastOne(unitHitBeforeMinimum(state, dealer, receiver));
}

/**
 * One ABILITY hit on a unit (burst_radius, heavy_strike): the same pipeline as a normal hit
 * with step 3c — × `abilityMult` applied to the merged (and, in principle, buffed) hit,
 * floored — then the minimum of 1. "×3.0 of a normal hit" means exactly this.
 */
export function abilityHitDamage(state: SimState, dealer: UnitState, receiver: UnitState, abilityMult: Fixed): number {
  return atLeastOne(scaleInt(unitHitBeforeMinimum(state, dealer, receiver), abilityMult));
}

/** Squared centre distance between two units. */
export function unitDistSq(a: UnitState, b: UnitState): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * ATTACK_TARGET_SELECTION: the nearest living enemy within `u`'s reach, lowest id on a tie,
 * or null. A unit whose HP reached 0 earlier this tick is still `alive` until phase 8 and
 * is still a valid target (SIMULTANEOUS_DAMAGE: every hit this tick is resolved against
 * start-of-tick life).
 */
export function nearestEnemyInReach(state: SimState, u: UnitState): UnitState | null {
  const from = u.side === "attacker" ? state.attackerCount : 0;
  const to = u.side === "attacker" ? state.units.length : state.attackerCount;
  let best: UnitState | null = null;
  let bestD = 0;
  for (let id = from; id < to; id++) {
    const v = state.units[id]!;
    if (!v.alive) continue;
    const d = unitDistSq(u, v);
    if (d > u.reachSq) continue;
    if (best === null || d < bestD) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

/**
 * ATTACK_PRIORITY (see header): the nearest living enemy within `u`'s reach that also has
 * `u` within its own reach, lowest id on a tie, or null. Used for a breaching attacker.
 */
export function threatInReach(state: SimState, u: UnitState): UnitState | null {
  const from = u.side === "attacker" ? state.attackerCount : 0;
  const to = u.side === "attacker" ? state.units.length : state.attackerCount;
  let best: UnitState | null = null;
  let bestD = 0;
  for (let id = from; id < to; id++) {
    const v = state.units[id]!;
    if (!v.alive) continue;
    const d = unitDistSq(u, v);
    if (d > u.reachSq || d > v.reachSq) continue;
    if (best === null || d < bestD) {
      best = v;
      bestD = d;
    }
  }
  return best;
}

/** Whether an attacker's unit target is inside its reach (attackRange + unitRadius, inclusive) — MOVEMENT_HOLD (tick.ts). */
export function engaged(state: SimState, u: UnitState): boolean {
  if (u.target === null || u.target.kind !== "unit") return false;
  const d = state.units[u.target.id]!;
  return d.alive && unitDistSq(u, d) <= u.reachSq;
}

/**
 * The fence `u` is breaching this tick and could hit now, or null: an attacker standing
 * short of an intact, not-yet-destroyed segment (phase 3 set `breaching`; a segment brought
 * to 0 HP earlier in this phase is skipped, phase 8 clears it) whose cell is orthogonally
 * adjacent to the segment's (FENCE_BREACH_RANGE).
 */
export function breachableFence(state: SimState, u: UnitState): FenceState | null {
  if (u.side !== "attacker" || u.breaching < 0) return null;
  const fence = state.fences[u.breaching]!;
  if (!fence.intact || fence.hp <= 0) return null;
  if (cellDistSq(cellOf({ x: u.x, y: u.y }), fence.cell) !== 1) return null;
  return fence;
}
