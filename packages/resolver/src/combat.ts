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
 *   4. × the siege multiplier, fence hits only (hooks.ts `siegeFenceMult`), floored;
 *   5. minimum 1 (DAMAGE_MINIMUM): every hit that lands does at least one point, so no
 *      matchup is a stalemate by rounding and every breach terminates.
 * Traps skip steps 1, 3 and 4 (they are not units and carry no merge level).
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
import type { AffinityCategory } from "./battlefield.js";
import { scaleInt, type Fixed } from "./fixed.js";
import type { SimState, UnitState } from "./state.js";

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

/** One hit from `dealer` on `receiver` (unit vs unit): steps 1, 2, 3, 5 of DAMAGE_ROUNDING_ORDER. */
export function hitDamage(state: SimState, dealer: UnitState, receiver: UnitState): number {
  const base = formulaDamage(dealer.rating, receiver.rating);
  const withAffinity = scaleInt(base, affinityMult(state, dealer.affinity, receiver.affinity));
  return atLeastOne(scaleInt(withAffinity, dealer.mergeMult));
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
