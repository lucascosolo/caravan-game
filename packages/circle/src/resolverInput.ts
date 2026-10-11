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
import { AFFINITY_MATRIX, CONTENT, TUNABLES, getFenceTier, getSiegeType, getTrapType, getUnitType, mergeStatMult, scaleInt } from "@caravan/content";
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
  type Party as ResolverParty,
  type PartyUnit as ResolverPartyUnit,
  type ResolverTunables,
} from "@caravan/resolver";
import type { Formation } from "./formation.js";
import type { Party } from "./party.js";
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
    // Chunk 03 QA B1 / chunk 09 QA X1: the merge multiplier applies to HP (already in the
    // manifest's hp/maxHp) and to post-formula damage output (the resolver applies it from
    // mergeLevel) — NEVER to the ratings that enter the damage formula. `defense` is the
    // unscaled type rating at every merge level.
    return {
      ref: u.ref,
      typeId: u.typeId,
      mergeLevel: u.mergeLevel,
      stance: p.stance,
      cell: p.cell,
      pos: cellCenter(p.cell),
      // maxHp already carries the merge multiplier (manifest.ts). The DEFENSE RATING does
      // not: chunk 03 QA B1 — the multiplier applies to HP and to each hit's output inside
      // the resolver (mergeStatMultByLevel[mergeLevel]), never to a rating.
      hp: u.hp,
      maxHp: u.maxHp,
      affinity: type.affinity,
      defense: type.defense,
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

/**
 * Chunk 13: the served standing party as the RESOLVER sees it — the owner's choices (stance,
 * approach edge, start cell, siege) joined with CONTENT stats, the same way `toBattlefield`
 * joins a formation. Every unit enters at full HP (a standing party is a template: it is never
 * worn down, GUARDRAILS §0): maxHp = type HP × MERGE_STAT_MULT_BY_LEVEL[level], floored, exactly
 * as a manifest computes a posted unit's; the OFFENSE rating is the unscaled type value (chunk
 * 03 QA B1 — the multiplier applies to HP and to each hit's output inside the resolver). A siege
 * piece's ref is its type id (a party carries each type at most once). Arrays come out in ref
 * order. Throws on an unknown type id.
 */
export function toResolverParty(party: Party): ResolverParty {
  const units = [...party.units]
    .sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0))
    .map((u): ResolverPartyUnit => {
      const type = getUnitType(u.typeId);
      if (!type) throw new Error(`unknown unit type '${u.typeId}'`);
      const maxHp = scaleInt(type.hp, mergeStatMult(u.mergeLevel));
      return {
        ref: u.ref,
        typeId: u.typeId,
        mergeLevel: u.mergeLevel,
        stance: u.stance,
        entry: { edge: u.edge, cell: { x: u.cell.x, y: u.cell.y } },
        hp: maxHp,
        maxHp,
        affinity: type.affinity,
        offense: type.offense,
        moveSpeed: type.moveSpeed,
        attackRange: type.attackRange,
        attackCooldown: type.attackCooldown,
        ability: type.ability,
      };
    });
  const siege = [...party.siege]
    .sort((a, b) => (a.typeId < b.typeId ? -1 : a.typeId > b.typeId ? 1 : 0))
    .map((s) => {
      const type = getSiegeType(s.typeId);
      if (!type) throw new Error(`unknown siege type '${s.typeId}'`);
      return { ref: s.typeId, typeId: s.typeId, counters: type.counters };
    });
  return { v: 1, units, siege };
}

/**
 * The chunk 10, 11 and 12 tunables, read from the registry and handed to the resolver as plain
 * input: the clock and cadences, the affinity multipliers and the matrix (content's
 * affinity.ts, copied as data), the merge multiplier table, the trap trigger radius, the
 * siege fence multiplier, the leash hysteresis, and (chunk 12) the ability first-use delay
 * multiplier and the structure-breaker segment cap. Per-type ability values travel on each
 * unit's `ability` (content data, unchanged).
 */
export function resolverTunables(): ResolverTunables {
  return {
    tickRate: TUNABLES.TICK_RATE,
    battleLengthCapSeconds: TUNABLES.BATTLE_LENGTH_CAP_SECONDS,
    pathRecomputeIntervalMs: TUNABLES.PATH_RECOMPUTE_INTERVAL,
    unitRadius: TUNABLES.UNIT_RADIUS,
    keyframeIntervalMs: TUNABLES.LOG_KEYFRAME_INTERVAL,
    pathConnectivity: TUNABLES.PATH_CONNECTIVITY,
    affinityAdvantageMult: TUNABLES.AFFINITY_ADVANTAGE_MULT,
    affinityDisadvantageMult: TUNABLES.AFFINITY_DISADVANTAGE_MULT,
    affinityNeutralMult: TUNABLES.AFFINITY_NEUTRAL_MULT,
    affinityMatrix: {
      grit: { ...AFFINITY_MATRIX.grit },
      powder: { ...AFFINITY_MATRIX.powder },
      beast: { ...AFFINITY_MATRIX.beast },
    },
    mergeStatMultByLevel: [...TUNABLES.MERGE_STAT_MULT_BY_LEVEL],
    trapTriggerRadius: TUNABLES.TRAP_TRIGGER_RADIUS,
    siegeFenceDamageMult: TUNABLES.SIEGE_FENCE_DAMAGE_MULT,
    leashHysteresisMult: TUNABLES.LEASH_HYSTERESIS_MULT,
    abilityFirstUseDelayMult: TUNABLES.ABILITY_FIRST_USE_DELAY_MULT,
    structureBreakerFirstUseMult: TUNABLES.STRUCTURE_BREAKER_FIRST_USE_MULT,
    fenceHitSegmentCap: TUNABLES.FENCE_HIT_SEGMENT_CAP,
  };
}

/**
 * Chunk 13 (QA-15 S3, QA-13 D3): everything a resolution READS from content, as one plain
 * object: the stat PROJECTION of the unit, trap, siege and fence tables that `toBattlefield` /
 * `toResolverParty` look up, plus the resolver tunables. The server hashes it
 * (RESOLUTION_CONTENT_HASH), stamps the hash on every encounter job at enqueue and refuses to
 * resolve a job whose stamp differs.
 *
 * COPY IS NOT HASHED (D3): display names, flavor text and ability descriptions are left out, so
 * a copy-only deploy never makes an in-flight encounter throw ContentHashMismatchError (and park,
 * voiding the trip). The projection is a WHITELIST of the stat keys (`RESOLUTION_STAT_KEYS`); the
 * circle test pins that every key of every content type is either in it or in
 * `RESOLUTION_COPY_KEYS`, so a new stat can never slip past the hash unnoticed.
 */
export const RESOLUTION_STAT_KEYS = {
  units: ["id", "affinity", "offense", "defense", "hp", "moveSpeed", "attackRange", "attackCooldown", "aggroRadius", "leashDistance", "ability"],
  traps: ["id", "category", "affinity", "damage", "effect"],
  siege: ["id", "counters"],
  fences: ["id", "tier", "category", "segmentHp"],
} as const;
/** Player-facing copy: never read by the simulation, never hashed. `regionId` is the unit's region (its id carries it), not a stat. */
export const RESOLUTION_COPY_KEYS: readonly string[] = ["displayName", "flavor", "description", "regionId"];

type ContentTables = Pick<typeof CONTENT, "units" | "traps" | "siege" | "fences">;

function project(row: object, keys: readonly string[]): Record<string, unknown> {
  const r = row as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (!(k in r)) continue;
    const v = r[k];
    if (k === "ability" && v !== null && typeof v === "object") {
      const ability: Record<string, unknown> = {};
      for (const [ak, av] of Object.entries(v as Record<string, unknown>)) if (!RESOLUTION_COPY_KEYS.includes(ak)) ability[ak] = av;
      out[k] = ability;
    } else out[k] = v;
  }
  return out;
}

export function resolutionContent(content: ContentTables = CONTENT): { readonly units: unknown; readonly traps: unknown; readonly siege: unknown; readonly fences: unknown; readonly tunables: ResolverTunables } {
  return {
    units: content.units.map((u) => project(u, RESOLUTION_STAT_KEYS.units)),
    traps: content.traps.map((t) => project(t, RESOLUTION_STAT_KEYS.traps)),
    siege: content.siege.map((s) => project(s, RESOLUTION_STAT_KEYS.siege)),
    fences: content.fences.map((f) => project(f, RESOLUTION_STAT_KEYS.fences)),
    tunables: resolverTunables(),
  };
}
