/**
 * The onboarding guide's reading of the scout and its bank-or-push advice (final play-test review
 * round 3, S1), as PURE functions shared by the web client (apps/web onboarding TrailGuide) and the
 * balance harness (scripts/balance/first-trip.ts and the CI slice apps/server/test/balance-sweep.test.ts),
 * so the harness measures exactly what the guide tells a new player to do.
 *
 * Every input is a plain structural shape the server's own scout view (`scoutParty`, what a
 * candidate card shows) and stakes preview (GET …/trip/preview) already carry. `guideStakesOf`
 * builds the preview's units / traps / fences from a survivors manifest, the same projection the
 * server's preview makes.
 *
 * Presentation only. Nothing here changes a fight, picks for the player or decides anything the
 * server decides: it reads what the player is shown and says what the guide would do.
 */
import { TUNABLES } from "@caravan/content";
import type { Manifest } from "./manifest.js";

/** A raider as the scout shows it: its reach (fixed-point, 1024 = 1 cell) and its HP. */
export interface ScoutRaiderLike {
  readonly attackRange: number;
  readonly hp: number;
}
/** A served party as the scout shows it. */
export interface ScoutPartyLike {
  readonly units: readonly ScoutRaiderLike[];
  readonly siege: readonly unknown[];
}

/**
 * A raider "shoots from range" when it can hit from at least this many cells — far enough to stand
 * outside the fence ring and reach a post inside it. A Grizzly's 1.2-cell swipe or a Homesteader's
 * 1.5-cell reach is a long arm, not a gun. Presentation tunable (the guide and the card label).
 */
export const GUIDE_RANGED_MIN_CELLS = 3;

/** A raider shoots from range; read off the scout, never the resolver. */
export function isRangedRaider(u: { readonly attackRange: number }): boolean {
  return u.attackRange >= GUIDE_RANGED_MIN_CELLS * TUNABLES.ATTACK_RANGE_MELEE_DEFAULT;
}

/** How many of a party's raiders shoot from range (the card's "N of M shoot from range"). */
export function rangedCount(p: ScoutPartyLike): { readonly ranged: number; readonly total: number } {
  return { ranged: p.units.filter(isRangedRaider).length, total: p.units.length };
}

/** Every raider in the party is ranged (an empty party is not). */
export function isRangedOnly(p: ScoutPartyLike): boolean {
  const r = rangedCount(p);
  return r.total > 0 && r.ranged === r.total;
}

/** At least half of the party's raiders are ranged (an empty party is not). */
export function isRangedHeavy(p: ScoutPartyLike): boolean {
  const r = rangedCount(p);
  return r.total > 0 && r.ranged * 2 >= r.total;
}

export interface GuidePick {
  readonly index: number;
  readonly raiders: number;
  readonly hp: number;
  readonly siege: number;
  /** Indexes of the ranged-only parties the pick passed over (empty when every party is ranged-only). */
  readonly passedOver: readonly number[];
}

/**
 * The guide's pick from a served menu: pass over ranged-only parties whenever another candidate
 * exists, then the smallest by the scout alone — least total HP, then fewest siege pieces, then
 * fewest raiders, then menu order. Null for an empty menu. Applied at every guided encounter.
 */
export function guidePick(menu: readonly ScoutPartyLike[]): GuidePick | null {
  const anyNotRanged = menu.some((c) => !isRangedOnly(c));
  const passedOver = anyNotRanged ? menu.map((c, i) => (isRangedOnly(c) ? i : -1)).filter((i) => i >= 0) : [];
  let best: GuidePick | null = null;
  menu.forEach((c, index) => {
    if (anyNotRanged && isRangedOnly(c)) return;
    const raiders = c.units.length;
    const siege = c.siege.length;
    const hp = c.units.reduce((n, u) => n + u.hp, 0);
    const b: GuidePick | null = best;
    if (!b || hp < b.hp || (hp === b.hp && (siege < b.siege || (siege === b.siege && raiders < b.raiders)))) best = { index, raiders, hp, siege, passedOver };
  });
  return best;
}

/** The stakes preview the advice reads (the server's GET …/trip/preview, structurally). */
export interface StakesLike {
  readonly units: readonly { readonly ref: string; readonly alive: boolean; readonly hp: number; readonly maxHp: number }[];
  readonly traps: { readonly remaining: readonly unknown[]; readonly spent: readonly unknown[] };
  readonly fences: { readonly intact: readonly unknown[]; readonly destroyed: readonly unknown[] };
}

/** The preview's units / traps / fences for a survivors manifest, as the server's preview builds them. */
export function guideStakesOf(survivors: Manifest): StakesLike {
  return {
    units: survivors.units.map((u) => ({ ref: u.ref, alive: u.hp > 0, hp: u.hp, maxHp: u.maxHp })),
    traps: { remaining: survivors.traps.filter((t) => !t.spent).map((t) => t.ref), spent: survivors.traps.filter((t) => t.spent).map((t) => t.ref) },
    fences: { intact: survivors.fences.filter((f) => f.hp > 0).map((f) => f.ref), destroyed: survivors.fences.filter((f) => f.hp === 0).map((f) => f.ref) },
  };
}

export type AdviceReason =
  | { readonly kind: "hurt"; readonly ref: string; readonly hp: number; readonly maxHp: number }
  | { readonly kind: "none_standing" }
  | { readonly kind: "no_trap" }
  | { readonly kind: "fence"; readonly destroyed: number; readonly intact: number }
  | { readonly kind: "ranged_menu"; readonly parties: number }
  /**
   * Round 4 D1: past encounter 2 (`encounterIndex >= 2`), the stakes themselves are the reason. `worn`:
   * the circle has taken any loss (`circleHurt`); `rangedParties`: the menu just faced was every party
   * ranged-heavy (its size), else 0. At least one of the two holds whenever this reason is given.
   */
  | { readonly kind: "stakes"; readonly encounter: number; readonly worn: boolean; readonly rangedParties: number };

export type Advice = { readonly kind: "bank"; readonly reasons: readonly AdviceReason[] } | { readonly kind: "push" };

/** The circle has taken any loss at all: damage carried, a death, a spent trap or a broken segment. */
export function circleHurt(p: StakesLike): boolean {
  return p.units.some((u) => !u.alive || u.hp < u.maxHp) || p.traps.spent.length > 0 || p.fences.destroyed.length > 0;
}

/**
 * The bank-or-push advice (chunk 24 QA D2; round 3 S1; round 4 D1), for the decision after surviving
 * encounter `encounterIndex` (1-based; the default 1 is the first decision).
 *
 * Every encounter: bank when the circle is badly hurt — a packed unit still standing is under half
 * its HP, none is standing, or every trap is spent while more fence is broken than stands.
 *
 * Encounter 1: also bank when the circle is hurt at all and every party in `menu` is ranged-heavy
 * (round 3 S1: ranged parties shoot a hurt circle's posts from outside the fence). Otherwise push.
 *
 * Encounter 2 and later (round 4 D1): push ONLY when the circle is unhurt (`!circleHurt`) and the
 * menu is not ranged-heavy (not every party in it is ranged-heavy; a null or empty menu is not).
 * Otherwise bank, with a `stakes` reason (last) saying which of the two failed; the client states
 * the unbanked Coin and the units at stake. The `ranged_menu` reason is encounter 1's only.
 *
 * `menu` is the best reading of what the next search serves that the player has: the client passes
 * the menu of the encounter just fought (the next search is centred one escalation step above it).
 * Advice only: the player chooses.
 */
export function pushAdvice(p: StakesLike, menu: readonly ScoutPartyLike[] | null = null, encounterIndex = 1): Advice {
  const reasons: AdviceReason[] = [];
  const alive = p.units.filter((u) => u.alive);
  for (const u of alive) if (u.hp * 2 < u.maxHp) reasons.push({ kind: "hurt", ref: u.ref, hp: u.hp, maxHp: u.maxHp });
  if (p.units.length > 0 && alive.length === 0) reasons.push({ kind: "none_standing" });
  const trapsGone = p.traps.remaining.length === 0 && p.traps.spent.length > 0;
  const fenceGone = p.fences.destroyed.length > p.fences.intact.length;
  if (trapsGone && fenceGone) reasons.push({ kind: "no_trap" }, { kind: "fence", destroyed: p.fences.destroyed.length, intact: p.fences.intact.length });
  const heavy = !!menu && menu.length > 0 && menu.every(isRangedHeavy);
  const worn = circleHurt(p);
  if (encounterIndex >= 2) {
    if (worn || heavy) reasons.push({ kind: "stakes", encounter: encounterIndex, worn, rangedParties: heavy ? menu!.length : 0 });
  } else if (heavy && worn) reasons.push({ kind: "ranged_menu", parties: menu!.length });
  return reasons.length > 0 ? { kind: "bank", reasons } : { kind: "push" };
}
