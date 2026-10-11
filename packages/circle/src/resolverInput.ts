/**
 * The battlefield as the RESOLVER sees it (chunks 10–13 consume; chunk 07 builds).
 *
 * The TYPE (`Battlefield` and its parts), the version (2: chunk 07 QA D1/D2 — stances,
 * anchors, `pathConnectivity`) and the runtime shape guard `assertBattlefield` (closed keys
 * at every level including the nested ability / trap-effect shapes, enum checks, positions
 * on the field, hp within 0..maxHp — chunk 07 QA S1) are OWNED by `@caravan/resolver`
 * (battlefield.ts) since chunk 10 and re-exported here under their chunk 07 names. The
 * resolver mirrors the content enums as literals; the test in battlefield.test.ts pins
 * the mirrored lists equal to @caravan/content's, so the one guard covers both. What stays in this file is the one thing the resolver cannot do:
 * `toBattlefield(manifest, formation)` joins a committed formation with the manifest it
 * references and with CONTENT data, producing one self-contained, plain-integer structure
 * — every placed object with its continuous tick-zero position (cellCenter, defined once
 * in the resolver), its current HP, the stats the fight needs, and the four permanent
 * ring anchors. `resolverTunables()` does the same for the registry values the resolver
 * needs, so nothing in the resolver ever reads @caravan/content.
 *
 * THE PLAYFIELD IS FLAT. The interfaces are closed: no elevation, terrain, cover, height
 * or scenery field, no index signature that could hold one, and `assertBattlefield`
 * rejects any extra key at runtime. Decorative geometry that could influence a fight would
 * hand some players an advantage they never earned through the unlock web (the same
 * failure class as pay-to-win, arriving through the art pipeline). A test pins both the
 * type and the runtime check.
 *
 * Nothing here is account-level: no account id, no Coin, no purchase or entitlement state
 * can reach the resolver through this structure (GUARDRAILS §2).
 */
import { TUNABLES, getFenceTier, getTrapType, getUnitType, mergeStatMult, scaleInt } from "@caravan/content";
import {
  BATTLEFIELD_VERSION,
  CORE_CELLS,
  CORE_CENTER,
  ENTRY_EDGES,
  GRID_HEIGHT,
  GRID_WIDTH,
  PATH_CONNECTIVITY,
  RING_ANCHORS,
  cellCenter,
  entryBand,
  ringSegment,
  type Battlefield,
  type BattlefieldFence,
  type BattlefieldPost,
  type BattlefieldTrap,
  type ResolverTunables,
} from "@caravan/resolver";
import type { Formation } from "./formation.js";
import type { Manifest } from "./manifest.js";

export {
  BATTLEFIELD_KEYS,
  BATTLEFIELD_VERSION,
  BattlefieldShapeError,
  POST_STANCES,
  assertBattlefield,
  isPostStance,
  type Battlefield,
  type BattlefieldEntry,
  type BattlefieldFence,
  type BattlefieldPost,
  type BattlefieldTrap,
  type PostStance,
  type ResolverTunables,
} from "@caravan/resolver";

/**
 * Build the resolver's view. The formation must already have passed validateFormation
 * against this manifest; this function throws on a dangling ref rather than validating
 * again. Arrays come out in canonical order (fences by segment, others by ref).
 */
export function toBattlefield(manifest: Manifest, formation: Formation): Battlefield {
  const fences = [...formation.fences]
    .sort((a, b) => a.segment - b.segment)
    .map((p): BattlefieldFence => {
      const f = manifest.fences.find((x) => x.ref === p.ref);
      if (!f) throw new Error(`fence '${p.ref}' is not in the manifest`);
      const tier = getFenceTier(f.tierId);
      if (!tier) throw new Error(`unknown fence tier '${f.tierId}'`);
      const seg = ringSegment(p.segment);
      return { ref: f.ref, segment: seg.index, cell: seg.cell, pos: cellCenter(seg.cell), tierId: f.tierId, category: tier.category, hp: f.hp, maxHp: f.maxHp };
    });
  const byRef = <T extends { readonly ref: string }>(a: T, b: T) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  const traps = [...formation.traps].sort(byRef).map((p): BattlefieldTrap => {
    const t = manifest.traps.find((x) => x.ref === p.ref);
    if (!t) throw new Error(`trap '${p.ref}' is not in the manifest`);
    const type = getTrapType(t.typeId);
    if (!type) throw new Error(`unknown trap type '${t.typeId}'`);
    return { ref: t.ref, cell: p.cell, pos: cellCenter(p.cell), typeId: t.typeId, category: type.category, affinity: type.affinity, damage: type.damage, effect: type.effect };
  });
  const posts = [...formation.posts].sort(byRef).map((p): BattlefieldPost => {
    const u = manifest.units.find((x) => x.ref === p.ref);
    if (!u) throw new Error(`unit '${p.ref}' is not in the manifest`);
    const type = getUnitType(u.typeId);
    if (!type) throw new Error(`unknown unit type '${u.typeId}'`);
    const mult = mergeStatMult(u.mergeLevel);
    return {
      ref: u.ref,
      typeId: u.typeId,
      mergeLevel: u.mergeLevel,
      stance: p.stance,
      cell: p.cell,
      pos: cellCenter(p.cell),
      hp: u.hp,
      maxHp: u.maxHp,
      affinity: type.affinity,
      defense: scaleInt(type.defense, mult),
      moveSpeed: type.moveSpeed,
      attackRange: type.attackRange,
      attackCooldown: type.attackCooldown,
      aggroRadius: type.aggroRadius,
      leashDistance: type.leashDistance,
      ability: type.ability,
    };
  });
  return {
    v: BATTLEFIELD_VERSION,
    grid: { width: GRID_WIDTH, height: GRID_HEIGHT },
    pathConnectivity: PATH_CONNECTIVITY,
    core: { cells: CORE_CELLS, center: CORE_CENTER },
    anchors: RING_ANCHORS,
    entries: ENTRY_EDGES.map((edge) => ({ edge, cells: entryBand(edge) })),
    fences,
    traps,
    posts,
  };
}

/** The chunk 10 tunables, read from the registry and handed to the resolver as plain input. */
export function resolverTunables(): ResolverTunables {
  return {
    tickRate: TUNABLES.TICK_RATE,
    battleLengthCapSeconds: TUNABLES.BATTLE_LENGTH_CAP_SECONDS,
    pathRecomputeIntervalMs: TUNABLES.PATH_RECOMPUTE_INTERVAL,
    unitRadius: TUNABLES.UNIT_RADIUS,
    keyframeIntervalMs: TUNABLES.LOG_KEYFRAME_INTERVAL,
    pathConnectivity: TUNABLES.PATH_CONNECTIVITY,
  };
}
