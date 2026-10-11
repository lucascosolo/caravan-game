/**
 * The battlefield as the RESOLVER sees it (chunks 10–13 consume; chunk 07 defines).
 *
 * `toBattlefield(manifest, formation)` joins a committed formation with the manifest it
 * references and with content data, producing one self-contained, plain-integer structure:
 * every placed object with its continuous tick-zero position (cellCenter, defined once in
 * lattice.ts), its current HP, and the stats the fight needs. The resolver has zero
 * dependencies and never reads content or the database, so everything it needs is here.
 *
 * THE PLAYFIELD IS FLAT. These interfaces are closed: there is no elevation, terrain,
 * cover, height or scenery field, no index signature that could hold one, and
 * `assertBattlefield` rejects any extra key at runtime. Decorative geometry that could
 * influence a fight would hand some players an advantage they never earned through the
 * unlock web (the same failure class as pay-to-win, arriving through the art pipeline).
 * A test pins both the type and the runtime check.
 *
 * Nothing here is account-level: no account id, no Coin, no purchase or entitlement state
 * can reach the resolver through this structure (GUARDRAILS §2).
 */
import {
  FIXED_POINT_SCALE,
  getFenceTier,
  getTrapType,
  getUnitType,
  isAbilityArchetype,
  isAffinityCategory,
  isFenceCategory,
  isTrapCategory,
  mergeStatMult,
  scaleInt,
  type Ability,
  type AffinityCategory,
  type Fixed,
  type FenceCategory,
  type Millis,
  type TrapCategory,
  type TrapEffect,
} from "@caravan/content";
import { isDefensiveStance, type DefensiveStance, type Formation } from "./formation.js";
import {
  CORE_CELLS,
  CORE_CENTER,
  ENTRY_EDGES,
  GRID_HEIGHT,
  GRID_WIDTH,
  PATH_CONNECTIVITY,
  RING_ANCHORS,
  cellCenter,
  entryBand,
  isCell,
  isEntryEdge,
  ringSegment,
  type Cell,
  type EntryEdge,
  type FixedPoint,
} from "./lattice.js";
import type { Manifest } from "./manifest.js";

export interface BattlefieldFence {
  readonly ref: string;
  readonly segment: number;
  readonly cell: Cell;
  readonly pos: FixedPoint;
  readonly tierId: string;
  readonly category: FenceCategory;
  readonly hp: number;
  readonly maxHp: number;
}

export interface BattlefieldTrap {
  readonly ref: string;
  readonly cell: Cell;
  readonly pos: FixedPoint;
  readonly typeId: string;
  readonly category: TrapCategory;
  readonly affinity: AffinityCategory;
  readonly damage: number;
  readonly effect: TrapEffect | null;
}

export interface BattlefieldPost {
  readonly ref: string;
  readonly typeId: string;
  readonly mergeLevel: number;
  /** The post: fixed origin of the leash. */
  readonly cell: Cell;
  /** Tick-zero position. The unit moves freely from here during the fight. */
  readonly pos: FixedPoint;
  readonly hp: number;
  readonly maxHp: number;
  readonly affinity: AffinityCategory;
  /** The DEFENSE rating, scaled by merge level — posted units never use offense. */
  readonly defense: number;
  readonly moveSpeed: Fixed;
  readonly attackRange: Fixed;
  readonly attackCooldown: Millis;
  readonly aggroRadius: Fixed;
  readonly leashDistance: Fixed;
  readonly ability: Ability;
  /** QA D1: the defensive stance chosen for this post (semantics in formation.ts). */
  readonly stance: DefensiveStance;
}

export interface BattlefieldEntry {
  readonly edge: EntryEdge;
  /** The band of cells an attacking party may start in on this edge. */
  readonly cells: readonly Cell[];
}

export interface Battlefield {
  /** 2 since QA D1/D2 (stances, anchors, pathing). No battlefield was ever stored or consumed at 1. */
  readonly v: 2;
  readonly grid: { readonly width: number; readonly height: number };
  /**
   * QA D2: lattice pathing is 4-connected (orthogonal steps, no corner cutting). Carried so
   * the resolver's pathfinder and the circle's reachability check cannot silently disagree.
   */
  readonly pathConnectivity: 4;
  readonly core: { readonly cells: readonly Cell[]; readonly center: FixedPoint };
  /**
   * QA D2: the four fixed wagon anchors at the ring's corners — permanently BLOCKED cells,
   * exactly like an intact fence segment but with no HP and no owner. Never a gap.
   */
  readonly anchors: readonly Cell[];
  /** All four edges, always. A party may be split across any of them. */
  readonly entries: readonly BattlefieldEntry[];
  readonly fences: readonly BattlefieldFence[];
  readonly traps: readonly BattlefieldTrap[];
  readonly posts: readonly BattlefieldPost[];
}

export const BATTLEFIELD_VERSION = 2 as const;

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
      stance: p.stance,
    };
  });
  return {
    v: BATTLEFIELD_VERSION,
    grid: { width: GRID_WIDTH, height: GRID_HEIGHT },
    pathConnectivity: PATH_CONNECTIVITY as 4,
    core: { cells: CORE_CELLS, center: CORE_CENTER },
    anchors: RING_ANCHORS,
    entries: ENTRY_EDGES.map((edge) => ({ edge, cells: entryBand(edge) })),
    fences,
    traps,
    posts,
  };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// Runtime shape guard. The type system keeps extra fields out of code; this keeps them
// out of data (a battlefield that came through JSON). Every object level has an explicit
// allowed-key set; anything else — `elevation`, `terrain`, `scenery`, `cover`, `height`,
// `accountId`, whatever — is refused by name.
// ─────────────────────────────────────────────────────────────────────────────────────

const KEYS = {
  battlefield: ["v", "grid", "pathConnectivity", "core", "anchors", "entries", "fences", "traps", "posts"],
  grid: ["width", "height"],
  core: ["cells", "center"],
  point: ["x", "y"],
  entry: ["edge", "cells"],
  fence: ["ref", "segment", "cell", "pos", "tierId", "category", "hp", "maxHp"],
  trap: ["ref", "cell", "pos", "typeId", "category", "affinity", "damage", "effect"],
  post: ["ref", "typeId", "mergeLevel", "cell", "pos", "hp", "maxHp", "affinity", "defense", "moveSpeed", "attackRange", "attackCooldown", "aggroRadius", "leashDistance", "ability", "stance"],
  /**
   * QA S1: the nested content shapes are closed too. These mirror @caravan/content's own
   * whitelists (validate.ts) per archetype / effect kind — extend both together.
   */
  abilityBase: ["archetype", "displayName", "description", "cooldown"],
  abilityByArchetype: {
    burst_radius: ["radius", "damageMult"],
    heavy_strike: ["damageMult"],
    heal_radius: ["radius", "healFraction", "charges"],
    self_buff: ["damageBonus", "duration"],
    dash: ["distance"],
    structure_breaker: ["fenceDamageMult"],
  },
  effectByKind: {
    slow: ["kind", "magnitude", "duration"],
    root: ["kind", "duration"],
  },
} as const;

/** The continuous field: [0, GRID × SCALE) on each axis. A position outside it is off the map. */
const FIELD_MAX_X = GRID_WIDTH * FIXED_POINT_SCALE;
const FIELD_MAX_Y = GRID_HEIGHT * FIXED_POINT_SCALE;

export class BattlefieldShapeError extends Error {
  constructor(message: string) {
    super(`battlefield shape refused: ${message}`);
    this.name = "BattlefieldShapeError";
  }
}

function onlyKeys(v: unknown, where: string, allowed: readonly string[]): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new BattlefieldShapeError(`${where} must be an object`);
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new BattlefieldShapeError(`${where} carries unknown key '${k}'`);
  for (const k of allowed) if (!(k in o)) throw new BattlefieldShapeError(`${where} is missing '${k}'`);
  return o;
}
function eachOf(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new BattlefieldShapeError(`${where} must be an array`);
  return v;
}
/** A continuous position: integer coordinates inside the field (QA S1). */
function point(v: unknown, where: string): void {
  const o = onlyKeys(v, where, KEYS.point);
  for (const k of KEYS.point) if (!Number.isSafeInteger(o[k])) throw new BattlefieldShapeError(`${where}.${k} must be an integer`);
  const x = o["x"] as number;
  const y = o["y"] as number;
  if (x < 0 || y < 0 || x >= FIELD_MAX_X || y >= FIELD_MAX_Y) throw new BattlefieldShapeError(`${where} (${x}, ${y}) is off the field`);
}
function cell(v: unknown, where: string): void {
  onlyKeys(v, where, KEYS.point);
  if (!isCell(v)) throw new BattlefieldShapeError(`${where} is not a lattice cell`);
}
function hpPair(o: Record<string, unknown>, where: string): void {
  const hp = o["hp"];
  const maxHp = o["maxHp"];
  if (!Number.isSafeInteger(hp) || !Number.isSafeInteger(maxHp) || (hp as number) < 0 || (maxHp as number) < 1 || (hp as number) > (maxHp as number)) {
    throw new BattlefieldShapeError(`${where} hp ${String(hp)}/${String(maxHp)} is not within 0..maxHp`);
  }
}
/** QA S1: an ability is exactly the base keys plus its archetype's keys; nothing else. */
function ability(v: unknown, where: string): void {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new BattlefieldShapeError(`${where} must be an object`);
  const archetype = (v as Record<string, unknown>)["archetype"];
  if (!isAbilityArchetype(archetype)) throw new BattlefieldShapeError(`${where}.archetype ${String(archetype)} is not an ability archetype`);
  onlyKeys(v, where, [...KEYS.abilityBase, ...KEYS.abilityByArchetype[archetype]]);
}
/** QA S1: a trap effect is null or exactly its kind's keys. */
function effect(v: unknown, where: string): void {
  if (v === null) return;
  if (typeof v !== "object" || Array.isArray(v)) throw new BattlefieldShapeError(`${where} must be an object or null`);
  const kind = (v as Record<string, unknown>)["kind"];
  if (kind !== "slow" && kind !== "root") throw new BattlefieldShapeError(`${where}.kind ${String(kind)} is not a trap effect`);
  onlyKeys(v, where, KEYS.effectByKind[kind]);
}

/**
 * Throws unless `v` is exactly a Battlefield: closed keys at every level (content shapes
 * included), integers only, positions on the field, every enum-valued field one of the
 * content enums (QA S1). Nothing that is not on a whitelist survives this.
 */
export function assertBattlefield(v: unknown): asserts v is Battlefield {
  const b = onlyKeys(v, "battlefield", KEYS.battlefield);
  if (b["v"] !== BATTLEFIELD_VERSION) throw new BattlefieldShapeError(`version ${String(b["v"])}`);
  const grid = onlyKeys(b["grid"], "grid", KEYS.grid);
  if (grid["width"] !== GRID_WIDTH || grid["height"] !== GRID_HEIGHT) throw new BattlefieldShapeError(`grid is not ${GRID_WIDTH} × ${GRID_HEIGHT}`);
  if (b["pathConnectivity"] !== PATH_CONNECTIVITY) throw new BattlefieldShapeError(`pathConnectivity must be ${PATH_CONNECTIVITY}`);
  const core = onlyKeys(b["core"], "core", KEYS.core);
  eachOf(core["cells"], "core.cells").forEach((c, i) => cell(c, `core.cells[${i}]`));
  point(core["center"], "core.center");
  const anchors = eachOf(b["anchors"], "anchors");
  if (anchors.length !== RING_ANCHORS.length) throw new BattlefieldShapeError(`anchors must list the ${RING_ANCHORS.length} fixed wagon anchors`);
  anchors.forEach((c, i) => cell(c, `anchors[${i}]`));
  const entries = eachOf(b["entries"], "entries");
  if (entries.length !== ENTRY_EDGES.length) throw new BattlefieldShapeError(`entries must list all ${ENTRY_EDGES.length} edges`);
  entries.forEach((e, i) => {
    const o = onlyKeys(e, `entries[${i}]`, KEYS.entry);
    if (!isEntryEdge(o["edge"])) throw new BattlefieldShapeError(`entries[${i}].edge ${String(o["edge"])} is not an entry edge`);
    eachOf(o["cells"], `entries[${i}].cells`).forEach((c, j) => cell(c, `entries[${i}].cells[${j}]`));
  });
  eachOf(b["fences"], "fences").forEach((f, i) => {
    const o = onlyKeys(f, `fences[${i}]`, KEYS.fence);
    cell(o["cell"], `fences[${i}].cell`);
    point(o["pos"], `fences[${i}].pos`);
    if (!isFenceCategory(o["category"])) throw new BattlefieldShapeError(`fences[${i}].category ${String(o["category"])} is not a fence category`);
    hpPair(o, `fences[${i}]`);
  });
  eachOf(b["traps"], "traps").forEach((t, i) => {
    const o = onlyKeys(t, `traps[${i}]`, KEYS.trap);
    cell(o["cell"], `traps[${i}].cell`);
    point(o["pos"], `traps[${i}].pos`);
    if (!isTrapCategory(o["category"])) throw new BattlefieldShapeError(`traps[${i}].category ${String(o["category"])} is not a trap category`);
    if (!isAffinityCategory(o["affinity"])) throw new BattlefieldShapeError(`traps[${i}].affinity ${String(o["affinity"])} is not an affinity`);
    effect(o["effect"], `traps[${i}].effect`);
  });
  eachOf(b["posts"], "posts").forEach((p, i) => {
    const o = onlyKeys(p, `posts[${i}]`, KEYS.post);
    cell(o["cell"], `posts[${i}].cell`);
    point(o["pos"], `posts[${i}].pos`);
    if (!isAffinityCategory(o["affinity"])) throw new BattlefieldShapeError(`posts[${i}].affinity ${String(o["affinity"])} is not an affinity`);
    if (!isDefensiveStance(o["stance"])) throw new BattlefieldShapeError(`posts[${i}].stance ${String(o["stance"])} is not a defensive stance`);
    hpPair(o, `posts[${i}]`);
    ability(o["ability"], `posts[${i}].ability`);
  });
  assertIntegersOnly(v, "battlefield");
}

function assertIntegersOnly(v: unknown, where: string): void {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new BattlefieldShapeError(`${where} is not an integer (${String(v)})`);
  } else if (Array.isArray(v)) v.forEach((x, i) => assertIntegersOnly(x, `${where}[${i}]`));
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) assertIntegersOnly(x, `${where}.${k}`);
}
