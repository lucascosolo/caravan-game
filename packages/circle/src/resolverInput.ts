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
import { getFenceTier, getTrapType, getUnitType, mergeStatMult, scaleInt, type Ability, type AffinityCategory, type Fixed, type FenceCategory, type Millis, type TrapCategory, type TrapEffect } from "@caravan/content";
import type { Formation } from "./formation.js";
import {
  CORE_CELLS,
  CORE_CENTER,
  ENTRY_EDGES,
  GRID_HEIGHT,
  GRID_WIDTH,
  cellCenter,
  entryBand,
  isCell,
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
}

export interface BattlefieldEntry {
  readonly edge: EntryEdge;
  /** The band of cells an attacking party may start in on this edge. */
  readonly cells: readonly Cell[];
}

export interface Battlefield {
  readonly v: 1;
  readonly grid: { readonly width: number; readonly height: number };
  readonly core: { readonly cells: readonly Cell[]; readonly center: FixedPoint };
  /** All four edges, always. A party may be split across any of them. */
  readonly entries: readonly BattlefieldEntry[];
  readonly fences: readonly BattlefieldFence[];
  readonly traps: readonly BattlefieldTrap[];
  readonly posts: readonly BattlefieldPost[];
}

export const BATTLEFIELD_VERSION = 1 as const;

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
    };
  });
  return {
    v: BATTLEFIELD_VERSION,
    grid: { width: GRID_WIDTH, height: GRID_HEIGHT },
    core: { cells: CORE_CELLS, center: CORE_CENTER },
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
  battlefield: ["v", "grid", "core", "entries", "fences", "traps", "posts"],
  grid: ["width", "height"],
  core: ["cells", "center"],
  point: ["x", "y"],
  entry: ["edge", "cells"],
  fence: ["ref", "segment", "cell", "pos", "tierId", "category", "hp", "maxHp"],
  trap: ["ref", "cell", "pos", "typeId", "category", "affinity", "damage", "effect"],
  post: ["ref", "typeId", "mergeLevel", "cell", "pos", "hp", "maxHp", "affinity", "defense", "moveSpeed", "attackRange", "attackCooldown", "aggroRadius", "leashDistance", "ability"],
} as const;

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
function point(v: unknown, where: string): void {
  const o = onlyKeys(v, where, KEYS.point);
  for (const k of KEYS.point) if (!Number.isSafeInteger(o[k])) throw new BattlefieldShapeError(`${where}.${k} must be an integer`);
}
function cell(v: unknown, where: string): void {
  onlyKeys(v, where, KEYS.point);
  if (!isCell(v)) throw new BattlefieldShapeError(`${where} is not a lattice cell`);
}

/** Throws unless `v` is exactly a Battlefield: closed keys at every level, integers only. */
export function assertBattlefield(v: unknown): asserts v is Battlefield {
  const b = onlyKeys(v, "battlefield", KEYS.battlefield);
  if (b["v"] !== BATTLEFIELD_VERSION) throw new BattlefieldShapeError(`version ${String(b["v"])}`);
  onlyKeys(b["grid"], "grid", KEYS.grid);
  const core = onlyKeys(b["core"], "core", KEYS.core);
  eachOf(core["cells"], "core.cells").forEach((c, i) => cell(c, `core.cells[${i}]`));
  point(core["center"], "core.center");
  eachOf(b["entries"], "entries").forEach((e, i) => {
    const o = onlyKeys(e, `entries[${i}]`, KEYS.entry);
    eachOf(o["cells"], `entries[${i}].cells`).forEach((c, j) => cell(c, `entries[${i}].cells[${j}]`));
  });
  eachOf(b["fences"], "fences").forEach((f, i) => {
    const o = onlyKeys(f, `fences[${i}]`, KEYS.fence);
    cell(o["cell"], `fences[${i}].cell`);
    point(o["pos"], `fences[${i}].pos`);
  });
  eachOf(b["traps"], "traps").forEach((t, i) => {
    const o = onlyKeys(t, `traps[${i}]`, KEYS.trap);
    cell(o["cell"], `traps[${i}].cell`);
    point(o["pos"], `traps[${i}].pos`);
  });
  eachOf(b["posts"], "posts").forEach((p, i) => {
    const o = onlyKeys(p, `posts[${i}]`, KEYS.post);
    cell(o["cell"], `posts[${i}].cell`);
    point(o["pos"], `posts[${i}].pos`);
  });
  assertIntegersOnly(v, "battlefield");
}

function assertIntegersOnly(v: unknown, where: string): void {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new BattlefieldShapeError(`${where} is not an integer (${String(v)})`);
  } else if (Array.isArray(v)) v.forEach((x, i) => assertIntegersOnly(x, `${where}[${i}]`));
  else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) assertIntegersOnly(x, `${where}.${k}`);
}
