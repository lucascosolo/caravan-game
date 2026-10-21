/**
 * Saved layouts (chunk 51): the caravan's last wagon-circle arrangement, kept relative to the
 * main attack edge and turned to face the next scouted party. Pure: no I/O, no clock, no
 * randomness; same inputs, same output, byte for byte.
 *
 *   saveLayout   committed formation + the survivors it was committed against + the scout
 *                → the layout, normalised so the scout's main edge is north
 *   loadLayout   layout + the current survivors + the new scout → { formation, leftOut }:
 *                every stored piece is turned by the quarter turn that takes north to the new
 *                main edge and re-placed in a fixed order (fences, traps, posts, each in
 *                stored order); whatever cannot be placed is listed in `leftOut` with why
 *   layoutHints  the gentle, information-only notes about a loaded layout against a scout
 *
 * Main edge: `mainEdge` (guideLayout.ts) — most raiders; ties go to ENTRY_EDGES order (north,
 * east, south, west); a party with no units uses its first scouted edge, else north.
 * Rotation: clockwise quarter turns about CORE_CENTER_CELL, (dx, dy) → (−dy, dx) per turn, with
 * y growing southward; north → east → south → west. Ring and interior cells are symmetric under
 * it; the six wagons are not, so a turned fence can land on a wagon cell ("wagon": already walled
 * there) and a stored gap can land on one (simply closed). No piece is ever moved elsewhere.
 * Matching to the current manifest: fences by tier (intact, unassigned, highest HP first, then
 * manifest order), traps by type (unspent, unassigned, manifest order), posts by instance id.
 */
import { BATTLEFIELD_VERSION } from "@caravan/resolver";
import { DEFAULT_DEFENSIVE_STANCE, EMPTY_FORMATION, FORMATION_VERSION, isDefensiveStance, normalizeFormation, type DefensiveStance, type Formation } from "./formation.js";
import { guideDropOk, mainEdge, type GuideScoutLike } from "./guideLayout.js";
import { ParseError } from "./serialize.js";
import { CORE_CENTER_CELL, ENTRY_EDGES, RING_SEGMENTS, isAnchorCell, isEntryEdge, ringIndexAt, ringSegment, type Cell, type EntryEdge } from "./lattice.js";
import { isFenceIntact, isUnitAlive, type Manifest } from "./manifest.js";

export const LAYOUT_VERSION = 1 as const;

export interface SavedFence {
  readonly cell: Cell;
  readonly tierId: string;
}
export interface SavedTrap {
  readonly cell: Cell;
  readonly typeId: string;
}
export interface SavedPost {
  readonly cell: Cell;
  readonly instanceId: string;
  readonly typeId: string;
  readonly stance: DefensiveStance;
}

/** Cells are in the normalised frame (main edge north). `raiders` is the scout's count per edge, in the ORIGINAL frame. */
export interface SavedLayout {
  readonly v: typeof LAYOUT_VERSION;
  readonly battlefieldVersion: number;
  readonly mainEdge: EntryEdge;
  readonly raiders: Readonly<Record<EntryEdge, number>>;
  readonly fences: readonly SavedFence[];
  readonly traps: readonly SavedTrap[];
  readonly posts: readonly SavedPost[];
}

export type LeftOutReason = "wagon" | "broken" | "spent" | "dead" | "not_packed" | "blocked";

/** One stored piece the load could not place. `edge` is the side it would have stood on after turning. */
export interface LeftOut {
  readonly kind: "fence" | "trap" | "post";
  /** Fence tier id, trap type id or living-unit type id. */
  readonly typeId: string;
  /** Posts only: the unit instance. */
  readonly instanceId: string | null;
  readonly edge: EntryEdge;
  readonly reason: LeftOutReason;
}

export interface LoadedLayout {
  readonly formation: Formation;
  readonly leftOut: readonly LeftOut[];
  /** "battlefield_version": saved on another wagon circle; nothing was loaded. */
  readonly unavailable: "battlefield_version" | null;
}

export type LayoutHint =
  | { readonly code: "gap_faces_main"; readonly edge: EntryEdge; readonly raiders: number; readonly total: number }
  | { readonly code: "trap_unused_side"; readonly ref: string; readonly edge: EntryEdge }
  | { readonly code: "direction_changed"; readonly was: readonly EntryEdge[]; readonly now: readonly EntryEdge[] };

/** Quarter turns clockwise from north to `edge`. */
export function turnsTo(edge: EntryEdge): number {
  return ENTRY_EDGES.indexOf(edge);
}

export function rotateEdge(edge: EntryEdge, quarterTurns: number): EntryEdge {
  return ENTRY_EDGES[(((turnsTo(edge) + quarterTurns) % 4) + 4) % 4]!;
}

/** `cell` turned clockwise `quarterTurns` times (any integer, taken mod 4) about CORE_CENTER_CELL. */
export function rotateCell(cell: Cell, quarterTurns: number): Cell {
  let dx = cell.x - CORE_CENTER_CELL.x;
  let dy = cell.y - CORE_CENTER_CELL.y;
  for (let i = ((quarterTurns % 4) + 4) % 4; i > 0; i--) [dx, dy] = [-dy, dx];
  return { x: CORE_CENTER_CELL.x + dx, y: CORE_CENTER_CELL.y + dy };
}

/** The side a cell is on: dominant axis from the core centre; an exact diagonal goes to the next edge clockwise (as RingSegment.edge). */
export function sideOfCell(cell: Cell): EntryEdge {
  const dx = cell.x - CORE_CENTER_CELL.x;
  const dy = cell.y - CORE_CENTER_CELL.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ay > ax) return dy < 0 ? "north" : "south";
  if (ax > ay) return dx > 0 ? "east" : "west";
  if (dx > 0) return dy < 0 ? "east" : "south";
  return dy > 0 ? "west" : "north";
}

function raiderCounts(scout: GuideScoutLike): Record<EntryEdge, number> {
  const out = { north: 0, east: 0, south: 0, west: 0 };
  for (const u of scout.units) out[u.edge]++;
  return out;
}

/** Edges with at least one raider, in ENTRY_EDGES order. */
function sidesOf(raiders: Readonly<Record<EntryEdge, number>>): EntryEdge[] {
  return ENTRY_EDGES.filter((e) => raiders[e] > 0);
}

/** Normalise a committed formation (valid against `manifest`) so the scout's main edge is north. */
export function saveLayout(formation: Formation, manifest: Manifest, scout: GuideScoutLike): SavedLayout {
  const main = mainEdge(scout);
  const back = -turnsTo(main);
  const f = normalizeFormation(formation);
  const fences: SavedFence[] = [];
  for (const p of f.fences) {
    const x = manifest.fences.find((q) => q.ref === p.ref);
    if (x) fences.push({ cell: rotateCell(ringSegment(p.segment).cell, back), tierId: x.tierId });
  }
  const traps: SavedTrap[] = [];
  for (const p of f.traps) {
    const t = manifest.traps.find((q) => q.ref === p.ref);
    if (t) traps.push({ cell: rotateCell(p.cell, back), typeId: t.typeId });
  }
  const posts: SavedPost[] = [];
  for (const p of f.posts) {
    const u = manifest.units.find((q) => q.ref === p.ref);
    if (u) posts.push({ cell: rotateCell(p.cell, back), instanceId: u.ref, typeId: u.typeId, stance: p.stance });
  }
  return { v: LAYOUT_VERSION, battlefieldVersion: BATTLEFIELD_VERSION, mainEdge: main, raiders: raiderCounts(scout), fences, traps, posts };
}

/** Turn `saved` to face `scout`'s main edge and re-place it from `survivors`. See the header. */
export function loadLayout(saved: SavedLayout, survivors: Manifest, scout: GuideScoutLike): LoadedLayout {
  if (saved.battlefieldVersion !== BATTLEFIELD_VERSION) return { formation: EMPTY_FORMATION, leftOut: [], unavailable: "battlefield_version" };
  const turn = turnsTo(mainEdge(scout));
  const used = new Set<string>();
  const leftOut: LeftOut[] = [];
  let out: Formation = EMPTY_FORMATION;
  const drop = (kind: LeftOut["kind"], typeId: string, instanceId: string | null, cell: Cell, reason: LeftOutReason): void => {
    leftOut.push({ kind, typeId, instanceId, edge: sideOfCell(cell), reason });
  };

  for (const s of saved.fences) {
    const cell = rotateCell(s.cell, turn);
    const ofTier = survivors.fences.filter((x) => x.tierId === s.tierId && !used.has(x.ref));
    const best = ofTier.filter(isFenceIntact).sort((a, b) => b.hp - a.hp)[0];
    if (isAnchorCell(cell)) drop("fence", s.tierId, null, cell, "wagon");
    else if (!best) drop("fence", s.tierId, null, cell, ofTier.length > 0 ? "broken" : "not_packed");
    else {
      const segment = ringIndexAt(cell);
      if (segment === null || !guideDropOk(survivors, out, best.ref, cell)) drop("fence", s.tierId, null, cell, "blocked");
      else {
        used.add(best.ref);
        out = { ...out, fences: [...out.fences, { ref: best.ref, segment }] };
      }
    }
  }
  for (const s of saved.traps) {
    const cell = rotateCell(s.cell, turn);
    const ofType = survivors.traps.filter((t) => t.typeId === s.typeId && !used.has(t.ref));
    const next = ofType.find((t) => !t.spent);
    if (!next) drop("trap", s.typeId, null, cell, ofType.length > 0 ? "spent" : "not_packed");
    else if (!guideDropOk(survivors, out, next.ref, cell)) drop("trap", s.typeId, null, cell, "blocked");
    else {
      used.add(next.ref);
      out = { ...out, traps: [...out.traps, { ref: next.ref, cell }] };
    }
  }
  for (const s of saved.posts) {
    const cell = rotateCell(s.cell, turn);
    const u = survivors.units.find((x) => x.ref === s.instanceId);
    if (!u) drop("post", s.typeId, s.instanceId, cell, "not_packed");
    else if (!isUnitAlive(u)) drop("post", s.typeId, s.instanceId, cell, "dead");
    else if (used.has(u.ref) || !guideDropOk(survivors, { ...out, posts: [...out.posts, { ref: u.ref, cell, stance: s.stance }] }, u.ref, cell)) drop("post", s.typeId, s.instanceId, cell, "blocked");
    else {
      used.add(u.ref);
      out = { ...out, posts: [...out.posts, { ref: u.ref, cell, stance: s.stance }] };
    }
  }
  return { formation: normalizeFormation({ ...out, v: FORMATION_VERSION }), leftOut, unavailable: null };
}

/** The sides the layout was saved against, turned the way `loadLayout` turns it for `scout` (ENTRY_EDGES order). */
export function savedSidesFacing(saved: SavedLayout, scout: GuideScoutLike): readonly EntryEdge[] {
  const turn = turnsTo(mainEdge(scout)) - turnsTo(saved.mainEdge);
  const sides = new Set(sidesOf(saved.raiders).map((e) => rotateEdge(e, turn)));
  return ENTRY_EDGES.filter((e) => sides.has(e));
}

/**
 * Information about `formation` against `scout`, in order: an open fence position on the main
 * edge's side, each trap on a side no raider comes from, and a change of sides since the layout
 * was saved (`savedSides`, already turned: savedSidesFacing). Never a verdict; a gap is legal.
 */
export function layoutHints(formation: Formation, scout: GuideScoutLike, savedSides: readonly EntryEdge[]): readonly LayoutHint[] {
  const raiders = raiderCounts(scout);
  const total = scout.units.length;
  if (total === 0) return [];
  const hints: LayoutHint[] = [];
  const main = mainEdge(scout);
  const fenced = new Set(formation.fences.map((p) => p.segment));
  const sideOpen = RING_SEGMENTS.some((s) => s.edge === main && !fenced.has(s.index));
  if (sideOpen) hints.push({ code: "gap_faces_main", edge: main, raiders: raiders[main], total });
  for (const t of normalizeFormation(formation).traps) {
    const edge = sideOfCell(t.cell);
    if (raiders[edge] === 0) hints.push({ code: "trap_unused_side", ref: t.ref, edge });
  }
  const now = sidesOf(raiders);
  if (savedSides.length > 0 && savedSides.join() !== now.join()) hints.push({ code: "direction_changed", was: [...savedSides], now });
  return hints;
}

// ── storage ──────────────────────────────────────────────────────────────────────────

const cellOrThrow = (v: unknown, at: string): Cell => {
  const c = v as { x?: unknown; y?: unknown } | null;
  if (!c || typeof c !== "object" || !Number.isInteger(c.x) || !Number.isInteger(c.y)) throw new ParseError(`${at}: expected an integer cell`);
  return { x: c.x as number, y: c.y as number };
};
const stringOrThrow = (v: unknown, at: string): string => {
  if (typeof v !== "string" || v.length === 0) throw new ParseError(`${at}: expected a string`);
  return v;
};
const listOrThrow = (v: unknown, at: string): readonly Record<string, unknown>[] => {
  if (!Array.isArray(v)) throw new ParseError(`${at}: expected a list`);
  return v as Record<string, unknown>[];
};

/** Parse a stored layout. Throws ParseError on anything malformed. */
export function layoutFromJson(value: unknown): SavedLayout {
  const o = value as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw new ParseError("layout: expected an object");
  if (o["v"] !== LAYOUT_VERSION) throw new ParseError(`layout: unsupported version ${String(o["v"])}`);
  if (!Number.isInteger(o["battlefieldVersion"])) throw new ParseError("layout.battlefieldVersion: expected an integer");
  if (!isEntryEdge(o["mainEdge"])) throw new ParseError("layout.mainEdge: expected an entry edge");
  const r = o["raiders"] as Record<string, unknown> | null;
  if (!r || typeof r !== "object") throw new ParseError("layout.raiders: expected an object");
  const raiders = { north: 0, east: 0, south: 0, west: 0 };
  for (const e of ENTRY_EDGES) {
    const n = r[e];
    if (!Number.isInteger(n) || (n as number) < 0) throw new ParseError(`layout.raiders.${e}: expected a non-negative integer`);
    raiders[e] = n as number;
  }
  return {
    v: LAYOUT_VERSION,
    battlefieldVersion: o["battlefieldVersion"] as number,
    mainEdge: o["mainEdge"],
    raiders,
    fences: listOrThrow(o["fences"], "layout.fences").map((p, i) => ({ cell: cellOrThrow(p["cell"], `layout.fences[${i}].cell`), tierId: stringOrThrow(p["tierId"], `layout.fences[${i}].tierId`) })),
    traps: listOrThrow(o["traps"], "layout.traps").map((p, i) => ({ cell: cellOrThrow(p["cell"], `layout.traps[${i}].cell`), typeId: stringOrThrow(p["typeId"], `layout.traps[${i}].typeId`) })),
    posts: listOrThrow(o["posts"], "layout.posts").map((p, i) => {
      const stance = p["stance"];
      return {
        cell: cellOrThrow(p["cell"], `layout.posts[${i}].cell`),
        instanceId: stringOrThrow(p["instanceId"], `layout.posts[${i}].instanceId`),
        typeId: stringOrThrow(p["typeId"], `layout.posts[${i}].typeId`),
        stance: isDefensiveStance(stance) ? stance : DEFAULT_DEFENSIVE_STANCE,
      };
    }),
  };
}

/** Canonical JSON: fixed key order, lists in stored order. */
export function serializeLayout(l: SavedLayout): string {
  const cell = (c: Cell) => ({ x: c.x, y: c.y });
  return JSON.stringify({
    v: l.v,
    battlefieldVersion: l.battlefieldVersion,
    mainEdge: l.mainEdge,
    raiders: { north: l.raiders.north, east: l.raiders.east, south: l.raiders.south, west: l.raiders.west },
    fences: l.fences.map((p) => ({ cell: cell(p.cell), tierId: p.tierId })),
    traps: l.traps.map((p) => ({ cell: cell(p.cell), typeId: p.typeId })),
    posts: l.posts.map((p) => ({ cell: cell(p.cell), instanceId: p.instanceId, typeId: p.typeId, stance: p.stance })),
  });
}
