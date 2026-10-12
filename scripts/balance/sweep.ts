/**
 * The matchup sweep (PHASE-2 §37): every authored party against a corpus of representative
 * wagon circles, resolved OFFLINE by the real resolver through the server's own adapter path
 * (`resolverInputOf` = @caravan/circle `toBattlefield` + `toResolverParty` + `resolverTunables`,
 * exactly what an encounter job runs). Nothing here reaches a resolution's inputs that the
 * server would not build; the sweep only chooses WHICH circle to commit, the way a player does.
 *
 * Determinism: the resolver is a pure function, and everything this file adds is too — no
 * clock, no Math.random. Matchmaking draws use the server's own seeded `selectCandidates` and
 * `candidateSeed` over fixed ids. Floats appear only in the statistics (shares, means).
 *
 * What a "layout" is: a function (manifest, scouted party) → Formation that reads only what the
 * scout shows (the raiders' edges and stances, the siege), never the fight. Three families:
 *   - guided  — the onboarding arrangement (apps/web/src/onboarding/arrangeGuide.ts), ported to
 *               @caravan/circle calls only; the full script cross-checks it against the web's.
 *   - naive   — layouts that ignore the scout: a contiguous fence with the posts round the core;
 *               evenly spread gaps with posts on hold; evenly spread gaps with posts spread out.
 *   - search  — the SKILLED set: a small grid of shapes keyed off the scouted main edge (where the
 *               gaps go × where the posts stand × stance × where the traps lie). A skilled player
 *               is approximated by the BEST of these per matchup ("take the best"): an upper
 *               bound on what one reading of the scout gets, since a player cannot try them all.
 */
import { CONTENT, REGION_IDS, TUNABLES, getUnitType, unlockWebFor, type RegionId } from "../../packages/content/src/index.js";
import {
  ENTRY_EDGES,
  RING_SEGMENTS,
  applyEncounterOutcome,
  isFenceIntact,
  isUnitAlive,
  packManifest,
  ringSegment,
  validateFormation,
  type Cell,
  type DefensiveStance,
  type EntryEdge,
  type Formation,
  type Manifest,
  type Party,
} from "../../packages/circle/src/index.js";
import { resolve, type ResolveOutput } from "../../packages/resolver/src/index.js";
import { authoredPartyConfig, authoredPartySpecs, baseMergeLevel, maxLivingTier, type AuthoredPartySpec } from "../../apps/server/src/matchmaking/authored.js";
import { authoredPartyId } from "../../apps/server/src/matchmaking/authored.js";
import { bandOf, candidateSeed, escalatedCentre, selectCandidates, type PoolEntry } from "../../apps/server/src/matchmaking/band.js";
import { reputationDelta } from "../../apps/server/src/progression/reputation.js";
import { resolverInputOf } from "../../apps/server/src/trip/resolverAdapter.js";

// ── geometry (lattice cells; the grid is a placement lattice only) ──────────────────────

const C = { x: Math.floor(TUNABLES.GRID_WIDTH / 2) - 1, y: Math.floor(TUNABLES.GRID_HEIGHT / 2) - 1 };
const OUT: Readonly<Record<EntryEdge, Cell>> = { north: { x: 0, y: -1 }, south: { x: 0, y: 1 }, east: { x: 1, y: 0 }, west: { x: -1, y: 0 } };
const OPPOSITE: Readonly<Record<EntryEdge, EntryEdge>> = { north: "south", south: "north", east: "west", west: "east" };
const add = (a: Cell, b: Cell, k = 1): Cell => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const d2 = (a: Cell, b: Cell): number => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
const cheb = (a: Cell): number => Math.max(Math.abs(a.x - C.x), Math.abs(a.y - C.y));
const key = (c: Cell): string => `${c.x},${c.y}`;

export function sideSegments(edge: EntryEdge): number[] {
  return RING_SEGMENTS.filter((s) => s.edge === edge).map((s) => s.index);
}
export function midSegment(edge: EntryEdge): number {
  const s = sideSegments(edge);
  return s[Math.floor(s.length / 2)]!;
}

/** Cells a trap or a post may stand on (circle's rule: not the ring, an anchor, the core or an entry band; in bounds). */
const PLACEABLE: Cell[] = (() => {
  const out: Cell[] = [];
  const band = TUNABLES.ENTRY_BAND_DEPTH;
  for (let y = band; y < TUNABLES.GRID_HEIGHT - band; y++) {
    for (let x = band; x < TUNABLES.GRID_WIDTH - band; x++) {
      const r = cheb({ x, y });
      if (r === TUNABLES.PERIMETER_RING_RADIUS) continue; // the ring and its anchors
      if (r <= Math.floor(TUNABLES.CORE_SIZE / 2)) continue; // the core
      out.push({ x, y });
    }
  }
  return out;
})();

/** Placeable cells nearest `target` (squared distance, then row, then column), skipping `taken`, filtered by `where`. */
function nearestCells(target: Cell, taken: Set<string>, where: (c: Cell) => boolean = () => true): Cell[] {
  return PLACEABLE.filter((c) => !taken.has(key(c)) && where(c)).sort((a, b) => d2(a, target) - d2(b, target) || a.y - b.y || a.x - b.x);
}

// ── the scout, as a layout may read it ─────────────────────────────────────────────────

export interface Scout {
  /** Raiders per edge, most first; ties in ENTRY_EDGES order (arrangeGuide's raidersByEdge). */
  readonly byEdge: readonly { edge: EntryEdge; raiders: number }[];
  readonly main: EntryEdge;
  readonly edges: readonly EntryEdge[];
  readonly coreRunners: number;
  readonly siege: readonly string[];
}

export function scoutOf(party: Party): Scout {
  const byEdge = ENTRY_EDGES.map((edge) => ({ edge, raiders: party.units.filter((u) => u.edge === edge).length })).sort((a, b) => b.raiders - a.raiders || ENTRY_EDGES.indexOf(a.edge) - ENTRY_EDGES.indexOf(b.edge));
  const edges = ENTRY_EDGES.filter((e) => party.units.some((u) => u.edge === e));
  return { byEdge, main: byEdge[0]!.raiders > 0 ? byEdge[0]!.edge : "north", edges, coreRunners: party.units.filter((u) => u.stance === "core").length, siege: party.siege.map((s) => s.typeId) };
}

// ── layouts ────────────────────────────────────────────────────────────────────────────

export type LayoutFamily = "guided" | "naive" | "search";
export interface Layout {
  readonly name: string;
  readonly family: LayoutFamily;
  build(m: Manifest, scout: Scout): Formation | null;
}

const alive = (m: Manifest) => m.units.filter(isUnitAlive);
const intactFences = (m: Manifest) => m.fences.filter(isFenceIntact).sort((a, b) => b.hp - a.hp || (a.ref < b.ref ? -1 : 1));
const unspentTraps = (m: Manifest) => m.traps.filter((t) => !t.spent);

/** Fence the segments of `order` (first = most wanted) with the healthiest intact material, until it runs out. */
function fenceInOrder(m: Manifest, order: readonly number[]): Formation["fences"] {
  const mat = intactFences(m);
  const seen = new Set<number>();
  const out: { ref: string; segment: number }[] = [];
  for (const s of order) {
    if (out.length >= mat.length) break;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push({ ref: mat[out.length]!.ref, segment: s });
  }
  return out;
}

/** Ring order of every segment, by a list of sides; segments of later sides only once earlier sides are full. */
function sidesOrder(sides: readonly EntryEdge[], skip: ReadonlySet<number> = new Set()): number[] {
  const out: number[] = [];
  for (const e of sides) for (const s of sideSegments(e)) if (!skip.has(s)) out.push(s);
  return out;
}

function ranked(edges: Scout["byEdge"], first: EntryEdge): EntryEdge[] {
  return [first, ...edges.map((e) => e.edge).filter((e) => e !== first)];
}

/**
 * Where the gaps go. Returns [the fence order, the "focus" — the ring cell the raiders are
 * invited through, which posts and traps key off].
 */
type GapPlan = (scout: Scout) => { order: number[]; focus: EntryEdge; focusSeg: number };
const GAP_PLANS: Readonly<Record<string, GapPlan>> = {
  // The guide's shape: the main side fenced but its middle; then the other sides, most raiders first.
  pinhole: (s) => {
    const mid = midSegment(s.main);
    return { order: [...sidesOrder(ranked(s.byEdge, s.main), new Set([mid])), mid], focus: s.main, focusSeg: mid };
  },
  // Pinhole on the main side, and the side opposite the main edge left open (the long way round).
  pinholeBack: (s) => {
    const mid = midSegment(s.main);
    const opp = OPPOSITE[s.main];
    const sides = [s.main, ...ENTRY_EDGES.filter((e) => e !== s.main && e !== opp), opp];
    return { order: [...sidesOrder(sides, new Set([mid])), mid], focus: s.main, focusSeg: mid };
  },
  // Meet them head-on: the main side open, everything else fenced.
  openFront: (s) => {
    const sides = [OPPOSITE[s.main], ...ENTRY_EDGES.filter((e) => e !== s.main && e !== OPPOSITE[s.main]), s.main];
    return { order: sidesOrder(sides), focus: s.main, focusSeg: midSegment(s.main) };
  },
  // Make them walk round: the main side and its neighbours fenced, the far side open.
  openBack: (s) => {
    const opp = OPPOSITE[s.main];
    const sides = [s.main, ...ENTRY_EDGES.filter((e) => e !== s.main && e !== opp), opp];
    return { order: sidesOrder(sides), focus: opp, focusSeg: midSegment(opp) };
  },
};

/** Naive gap plans: no scout read. */
const SPREAD_GAPS = [0, 3, 7, 10, 14, 17, 21, 24]; // two per side, evenly
function spreadOrder(): number[] {
  const gaps = new Set(SPREAD_GAPS);
  return [...RING_SEGMENTS.map((s) => s.index).filter((i) => !gaps.has(i)), ...SPREAD_GAPS];
}

/** Post spots: the cells to post on, best first, given the focus side and its gap. */
type PostPlan = (focus: EntryEdge, focusSeg: number, n: number, taken: Set<string>) => Cell[];
const inside = (c: Cell) => cheb(c) < TUNABLES.PERIMETER_RING_RADIUS;
const POST_PLANS: Readonly<Record<string, PostPlan>> = {
  // Just inside the gap (two cells in), clustered.
  behind: (focus, seg, n, taken) => nearestCells(add(ringSegment(seg).cell, OUT[focus], -2), taken, inside).slice(0, n),
  // In front of the core on the focus side.
  coreFront: (focus, _seg, n, taken) => nearestCells(add(C, OUT[focus], 2), taken, (c) => inside(c) && cheb(c) === 2).slice(0, n),
  // Round the core, one side at a time starting with the focus side.
  coreRing: (focus, _seg, n, taken) => {
    const sides = [focus, OPPOSITE[focus], ...ENTRY_EDGES.filter((e) => e !== focus && e !== OPPOSITE[focus])];
    const out: Cell[] = [];
    const t = new Set(taken);
    for (let i = 0; i < n; i++) {
      const c = nearestCells(add(C, OUT[sides[i % 4]!], 2), t, (x) => inside(x) && cheb(x) === 2)[0];
      if (!c) break;
      out.push(c);
      t.add(key(c));
    }
    return out;
  },
};

type TrapPlan = (focus: EntryEdge, focusSeg: number, n: number, taken: Set<string>) => Cell[];
const TRAP_PLANS: Readonly<Record<string, TrapPlan>> = {
  // On the lane through the gap: one cell in, then just outside, then fanning out.
  lane: (focus, seg, n, taken) => {
    const g = ringSegment(seg).cell;
    const lane = [add(g, OUT[focus], -1), add(g, OUT[focus], 1), add(g, OUT[focus], 2), add(g, OUT[focus], -2)];
    const out: Cell[] = [];
    const t = new Set(taken);
    for (const c of lane) {
      if (out.length >= n) break;
      if (PLACEABLE.some((p) => p.x === c.x && p.y === c.y) && !t.has(key(c))) {
        out.push(c);
        t.add(key(c));
      }
    }
    for (const c of nearestCells(add(g, OUT[focus], -1), t)) {
      if (out.length >= n) break;
      out.push(c);
      t.add(key(c));
    }
    return out;
  },
  // The last line: next to the core on the focus side, then round it.
  core: (focus, _seg, n, taken) => nearestCells(add(C, OUT[focus], 2), taken, (c) => cheb(c) === 2).slice(0, n),
  // Every approach ends at the core: one trap in front of each face of it, focus side first, then the corners.
  coreRing: (focus, _seg, n, taken) => {
    const sides = [focus, OPPOSITE[focus], ...ENTRY_EDGES.filter((e) => e !== focus && e !== OPPOSITE[focus])];
    const out: Cell[] = [];
    const t = new Set(taken);
    for (let i = 0; i < n; i++) {
      const c = nearestCells(add(C, OUT[sides[i % 4]!], 2), t, (x) => cheb(x) === 2)[0];
      if (!c) break;
      out.push(c);
      t.add(key(c));
    }
    return out;
  },
};

/** Melee first (they stand in front), then by range; ties by ref. */
function postOrder(m: Manifest): string[] {
  return alive(m)
    .map((u) => ({ ref: u.ref, range: getUnitType(u.typeId)!.attackRange, hp: u.hp }))
    .sort((a, b) => a.range - b.range || b.hp - a.hp || (a.ref < b.ref ? -1 : 1))
    .map((u) => u.ref);
}

function stanceFor(mode: "guard" | "hold" | "mixed", ref: string, m: Manifest): DefensiveStance {
  if (mode !== "mixed") return mode;
  const u = m.units.find((x) => x.ref === ref)!;
  return getUnitType(u.typeId)!.attackRange > TUNABLES.ATTACK_RANGE_MELEE_DEFAULT ? "hold" : "guard";
}

function assemble(m: Manifest, fences: Formation["fences"], trapCells: Cell[], postCells: Cell[], mode: "guard" | "hold" | "mixed"): Formation | null {
  const traps = unspentTraps(m);
  const refs = postOrder(m);
  if (postCells.length < refs.length) return null;
  const f: Formation = {
    v: 2,
    fences,
    traps: traps.slice(0, trapCells.length).map((t, i) => ({ ref: t.ref, cell: trapCells[i]! })),
    posts: refs.map((ref, i) => ({ ref, cell: postCells[i]!, stance: stanceFor(mode, ref, m) })),
  };
  const v = validateFormation(m, f, () => true);
  return v.ok ? v.value : null;
}

export function searchLayout(gap: string, post: string, mode: "guard" | "hold" | "mixed", trap: string): Layout {
  return {
    name: `${gap}/${post}/${mode}/${trap}`,
    family: "search",
    build(m, scout) {
      const g = GAP_PLANS[gap]!(scout);
      const fences = fenceInOrder(m, g.order);
      const taken = new Set<string>();
      const trapCells = TRAP_PLANS[trap]!(g.focus, g.focusSeg, unspentTraps(m).length, taken);
      for (const c of trapCells) taken.add(key(c));
      const postCells = POST_PLANS[post]!(g.focus, g.focusSeg, alive(m).length, taken);
      return assemble(m, fences, trapCells, postCells, mode);
    },
  };
}

/**
 * The onboarding's guided arrangement (arrangeGuide.ts), step for step: fence the main side but
 * its middle; leave the middle open; lay the first trap one cell inside the gap; post every unit
 * as near two cells inside the gap as the rules allow (keeping the trap's cell free), on the
 * default stance (guard); then the rest of the fence, most raiders first. Only the FIRST trap is
 * laid (the guide lays one); a manifest with more keeps the rest back.
 */
export const GUIDED: Layout = {
  name: "guided",
  family: "guided",
  build(m, scout) {
    const mid = midSegment(scout.main);
    const fences = fenceInOrder(m, [...sidesOrder(ranked(scout.byEdge, scout.main), new Set([mid]))]);
    const gapCell = ringSegment(mid).cell;
    const trapCell = add(gapCell, OUT[scout.main], -1);
    const postTarget = add(gapCell, OUT[scout.main], -2);
    const traps = unspentTraps(m);
    const f0: { fences: Formation["fences"]; traps: { ref: string; cell: Cell }[]; posts: { ref: string; cell: Cell; stance: DefensiveStance }[] } = { fences: [], traps: [], posts: [] };
    // Fence the main side first (as the guide does), then posts, trap, rest — the cells do not
    // interact with the fence, so placing all fences at once is the same formation.
    f0.fences = fences;
    const taken = new Set<string>();
    // Posts (the guide posts before laying the trap, keeping the trap's cell free).
    for (const u of m.units.filter(isUnitAlive)) {
      const c = nearestCells(postTarget, new Set([...taken, key(trapCell)]), (x) => minPostOk(x, f0.posts))[0];
      if (!c) return null;
      f0.posts.push({ ref: u.ref, cell: c, stance: "guard" });
      taken.add(key(c));
    }
    const t = traps[0];
    if (t) {
      const c = nearestCells(trapCell, taken)[0];
      if (c) f0.traps.push({ ref: t.ref, cell: c });
    }
    const f: Formation = { v: 2, fences: f0.fences, traps: f0.traps, posts: f0.posts };
    const v = validateFormation(m, f, () => true);
    return v.ok ? v.value : null;
  },
};

const MIN_POST_D2 = Math.trunc(TUNABLES.MIN_POST_DISTANCE / 1024) ** 2;
function minPostOk(c: Cell, posts: readonly { cell: Cell }[]): boolean {
  return posts.every((p) => d2(p.cell, c) >= MIN_POST_D2);
}

export const NAIVE: readonly Layout[] = [
  {
    // A contiguous fence from the first ring position, every unit on guard round the core.
    name: "naive/contiguous/coreRing/guard",
    family: "naive",
    build(m) {
      const fences = fenceInOrder(m, RING_SEGMENTS.map((s) => s.index));
      const taken = new Set<string>();
      const traps = TRAP_PLANS["core"]!("north", 3, unspentTraps(m).length, taken);
      for (const c of traps) taken.add(key(c));
      return assemble(m, fences, traps, POST_PLANS["coreRing"]!("north", 3, alive(m).length, taken), "guard");
    },
  },
  {
    // Evenly spread gaps, every unit on hold round the core.
    name: "naive/spread/coreRing/hold",
    family: "naive",
    build(m) {
      const fences = fenceInOrder(m, spreadOrder());
      const taken = new Set<string>();
      const traps = TRAP_PLANS["core"]!("north", 3, unspentTraps(m).length, taken);
      for (const c of traps) taken.add(key(c));
      return assemble(m, fences, traps, POST_PLANS["coreRing"]!("north", 3, alive(m).length, taken), "hold");
    },
  },
  {
    // Evenly spread gaps, units on guard spread one per side just inside the ring, traps on the north lane.
    name: "naive/spread/sides/guard",
    family: "naive",
    build(m) {
      const fences = fenceInOrder(m, spreadOrder());
      const taken = new Set<string>();
      const traps = TRAP_PLANS["lane"]!("north", 3, unspentTraps(m).length, taken);
      for (const c of traps) taken.add(key(c));
      const posts: Cell[] = [];
      for (let i = 0; i < alive(m).length; i++) {
        const e = ENTRY_EDGES[i % 4]!;
        const c = nearestCells(add(C, OUT[e], 3), taken, inside)[0];
        if (!c) break;
        posts.push(c);
        taken.add(key(c));
      }
      return assemble(m, fences, traps, posts, "guard");
    },
  },
];

export const SEARCH: readonly Layout[] = (() => {
  const out: Layout[] = [];
  for (const gap of Object.keys(GAP_PLANS)) for (const post of Object.keys(POST_PLANS)) for (const mode of ["guard", "mixed"] as const) for (const trap of Object.keys(TRAP_PLANS)) out.push(searchLayout(gap, post, mode, trap));
  return out;
})();

/** Every layout the skilled search may pick from (search ∪ guided ∪ naive: a skilled player could also play those). */
export const SKILLED: readonly Layout[] = [...SEARCH, GUIDED, ...NAIVE];

// ── parties ────────────────────────────────────────────────────────────────────────────

export interface ServedParty {
  readonly spec: AuthoredPartySpec;
  readonly party: Party;
  readonly scout: Scout;
  readonly pool: PoolEntry;
}

/** The authored party exactly as seeded (authoredPartyConfig over one instance per spec unit). */
export function servedParty(spec: AuthoredPartySpec): ServedParty {
  const ids = spec.units.map((_, i) => `${spec.username}#${i}`);
  const cfg = authoredPartyConfig(spec, ids);
  const party: Party = { v: 1, units: cfg.units.map((u, i) => ({ ...u, typeId: spec.units[i]!.typeId, mergeLevel: spec.units[i]!.mergeLevel })), siege: cfg.siege.map((typeId) => ({ typeId })) };
  return { spec, party, scout: scoutOf(party), pool: { partyId: authoredPartyId(spec.username), ownerAccountId: spec.username, rating: spec.rating, authored: true } };
}

let cachedParties: ServedParty[] | undefined;
export function authoredParties(): ServedParty[] {
  return (cachedParties ??= authoredPartySpecs().map(servedParty));
}

// ── rosters (the defending corpus) ─────────────────────────────────────────────────────

export interface RosterSpec {
  readonly label: string;
  readonly regionId: RegionId;
  readonly units: readonly { readonly typeId: string; readonly mergeLevel: number }[];
  readonly traps: readonly string[];
  readonly fence: { readonly tierId: string; readonly count: number } | null;
}

export function manifestOf(r: RosterSpec): Manifest {
  const res = packManifest({ units: r.units.map((u, i) => ({ instanceId: `u${i}`, typeId: u.typeId, mergeLevel: u.mergeLevel })), traps: r.traps, fence: r.fence }, () => true);
  if (!res.ok) throw new Error(`roster ${r.label}: ${res.issues.map((i) => i.message).join("; ")}`);
  return res.value;
}

/** A unit's worth posted: HP × the rating it fights with (defense). */
function defensiveValue(typeId: string): number {
  const t = getUnitType(typeId)!;
  return t.defense * t.defense * t.hp;
}

/** The region's living types reachable at web tier ≤ `tier`. */
export function typesUpTo(regionId: RegionId, tier: number): string[] {
  return unlockWebFor("living", regionId).nodes.filter((n) => n.tier <= tier).map((n) => n.id);
}

/** The starting types of a region (tier 0 nodes): what STARTING_ROSTER grants one each of. */
export function starterTypes(regionId: RegionId): string[] {
  return typesUpTo(regionId, 0);
}

const TRAP_WEB = () => unlockWebFor("trap");
function trapsUpTo(tier: number): string[] {
  return TRAP_WEB().nodes.filter((n) => n.tier <= tier && n.id.startsWith("trap.")).map((n) => n.id);
}
function bestFenceUpTo(tier: number): string {
  const f = TRAP_WEB().nodes.filter((n) => n.tier <= tier && n.id.startsWith("fence.")).map((n) => CONTENT.fences.find((x) => x.id === n.id)!);
  return f.sort((a, b) => b.segmentHp - a.segmentHp)[0]!.id;
}

export type Composition = "defensive" | "mixed";

/**
 * A roster at one strength: `size` units at `level` (the last half one level lower when
 * `level` > 1 and `ragged`), types from the region's web up to `tier` — "defensive" takes the
 * sturdiest guards first, "mixed" cycles every reachable type — `traps` traps of the types up to
 * `trapTier` (heaviest first, then variety), and a full fence budget of the best tier reachable.
 */
export function rosterAt(regionId: RegionId, o: { size: number; level: number; tier: number; traps: number; trapTier: number; fenceTier: number; composition: Composition; label?: string }): RosterSpec {
  const types = typesUpTo(regionId, o.tier);
  const ordered = o.composition === "defensive" ? [...types].sort((a, b) => defensiveValue(b) - defensiveValue(a) || (a < b ? -1 : 1)) : types;
  const units = Array.from({ length: o.size }, (_, i) => ({ typeId: ordered[i % ordered.length]!, mergeLevel: o.level }));
  const trapTypes = trapsUpTo(o.trapTier).sort((a, b) => CONTENT.traps.find((t) => t.id === b)!.damage - CONTENT.traps.find((t) => t.id === a)!.damage);
  const traps = Array.from({ length: o.traps }, (_, i) => trapTypes[i % trapTypes.length]!);
  return { label: o.label ?? `${regionId} ${o.size}×L${o.level} t${o.tier} ${o.composition}`, regionId, units, traps, fence: { tierId: bestFenceUpTo(o.fenceTier), count: TUNABLES.FENCE_MATERIAL_BUDGET } };
}

/**
 * STARTING_ROSTER (chunk 24 QA D1). The mechanism is the chunk 24 fixer's; until it lands the
 * sweep models it here: `copiesPerStarterType` level-1 copies of each of the region's starter
 * types — read from TUNABLES.STARTING_ROSTER once that block is on main, else the value this pass
 * recommends (BALANCE_STARTING_COPIES). `refugee` adds the first free refugee claim the guide
 * walks the player through.
 */
export const BALANCE_STARTING_COPIES = 3;
export const STARTING_ROSTER_MODEL: { readonly copiesPerStarterType: number } = (TUNABLES as unknown as { STARTING_ROSTER?: { copiesPerStarterType: number } }).STARTING_ROSTER ?? { copiesPerStarterType: BALANCE_STARTING_COPIES };
export function freshRoster(regionId: RegionId, refugee: string | null, traps: number): RosterSpec {
  const units: { typeId: string; mergeLevel: number }[] = [];
  for (const t of starterTypes(regionId)) for (let i = 0; i < STARTING_ROSTER_MODEL.copiesPerStarterType; i++) units.push({ typeId: t, mergeLevel: 1 });
  if (refugee) units.push({ typeId: refugee, mergeLevel: 1 });
  return { label: `fresh ${regionId}${refugee ? ` +${refugee.split(".")[1]}` : ""} ${traps} trap`, regionId, units, traps: Array(traps).fill(trapsUpTo(0)[0]!), fence: { tierId: bestFenceUpTo(0), count: TUNABLES.FENCE_MATERIAL_BUDGET } };
}

// ── fights ─────────────────────────────────────────────────────────────────────────────

export type Kind = "caravan_held" | "caravan_overrun" | "stalemate";
export interface FightResult {
  readonly layout: string;
  readonly family: LayoutFamily;
  readonly kind: Kind;
  readonly depth: number;
  readonly endTick: number;
  /** Defender HP left / HP brought in (0..1). */
  readonly hpLeft: number;
  readonly deaths: number;
  readonly survivors: Manifest;
  readonly breakerFires: number;
  readonly healed: number;
  readonly postDamageTaken: number;
}

/** One fight, through the server's own input builder. */
/** Exploration only (never set by the sweep itself): rewrite the plain resolver input before it runs, to try a number without editing content. */
export const EXPLORE: { transform: ((input: ReturnType<typeof resolverInputOf>) => ReturnType<typeof resolverInputOf>) | null } = { transform: null };

/**
 * Exploration only: `--explore aggro=2048,trapRadius=1280,def=0.9,speed=0.8,hp=0.8` rewrites the
 * resolver input (posts' aggro + leash in fixed cells, the trap trigger radius, posts' defense
 * scale, raiders' speed / HP scale) so a lever can be tried before it is written into content.
 */
export function exploreFromArgv(argv: readonly string[]): void {
  const i = argv.indexOf("--explore");
  if (i < 0) return;
  const kv = Object.fromEntries(argv[i + 1]!.split(",").map((p) => p.split("=") as [string, string]).map(([k, v]) => [k, Number(v)]));
  EXPLORE.transform = (inp) => {
    const x = JSON.parse(JSON.stringify(inp)) as ReturnType<typeof resolverInputOf>;
    const w = x as unknown as { battlefield: { posts: { aggroRadius: number; leashDistance: number; defense: number }[] }; party: { units: { moveSpeed: number; hp: number; maxHp: number }[] }; tunables: { trapTriggerRadius: number } };
    for (const p of w.battlefield.posts) {
      if (kv["aggro"]) {
        p.aggroRadius += kv["aggro"];
        p.leashDistance += kv["aggro"];
      }
      if (kv["def"]) p.defense = Math.max(1, Math.round(p.defense * kv["def"]));
    }
    for (const u of w.party.units) {
      if (kv["speed"]) u.moveSpeed = Math.floor(u.moveSpeed * kv["speed"]);
      if (kv["hp"]) u.hp = u.maxHp = Math.floor(u.maxHp * kv["hp"]);
    }
    if (kv["trapRadius"]) w.tunables.trapTriggerRadius = kv["trapRadius"];
    return x;
  };
}
exploreFromArgv(process.argv);

export function fight(m: Manifest, f: Formation, sp: ServedParty, layout: Layout): FightResult {
  const input = resolverInputOf({ tripId: "sweep", encounterIndex: 1, formation: f, survivors: m, party: sp.party, contentHash: null });
  const out: ResolveOutput = resolve(EXPLORE.transform ? EXPLORE.transform(input) : input);
  const defenders = out.units.filter((u) => u.side === "defender");
  // (An EXPLORE transform may raise an input HP; carry-forward never rises above the manifest.)
  const capU = (ref: string, hp: number) => Math.min(hp, m.units.find((u) => u.ref === ref)!.hp);
  const capF = (ref: string, hp: number) => Math.min(hp, m.fences.find((x) => x.ref === ref)!.hp);
  const survivors = applyEncounterOutcome(m, { units: defenders.map((u) => ({ ref: u.ref, hp: capU(u.ref, u.hp) })), spentTraps: out.traps.filter((t) => t.spent).map((t) => t.ref), fences: out.fences.map((x) => ({ ref: x.ref, hp: capF(x.ref, x.hp) })) });
  const start = defenders.reduce((s, u) => s + u.startHp, 0);
  let breakerFires = 0;
  let healed = 0;
  let postDamageTaken = 0;
  const sideOf = new Map(out.units.map((u) => [u.id, u.side] as const));
  for (const e of out.log) {
    if (e.k === "ability") {
      if (e.a === "structure_breaker") breakerFires++;
      for (const t of e.tg) {
        if (e.a === "heal_radius") healed += t.amount;
        else if (t.kind === "unit" && sideOf.get(t.id) === "defender") postDamageTaken += t.amount;
      }
    } else if (e.k === "hit" && sideOf.get(e.v) === "defender") postDamageTaken += e.damage;
  }
  return {
    layout: layout.name,
    family: layout.family,
    kind: out.outcome.kind,
    depth: out.outcome.depth,
    endTick: out.outcome.endTick,
    hpLeft: start > 0 ? defenders.reduce((s, u) => s + u.hp, 0) / start : 0,
    deaths: defenders.filter((u) => u.startHp > 0 && u.hp === 0).length,
    survivors,
    breakerFires,
    healed,
    postDamageTaken,
  };
}

const RANK: Readonly<Record<Kind, number>> = { caravan_held: 2, stalemate: 1, caravan_overrun: 0 };
/** Better for the caravan: held > stalemate > overrun; then more HP left; then shallower; then a longer fight (an overrun held off longer). */
export function better(a: FightResult, b: FightResult): boolean {
  if (RANK[a.kind] !== RANK[b.kind]) return RANK[a.kind] > RANK[b.kind];
  if (a.kind !== "caravan_overrun" && a.hpLeft !== b.hpLeft) return a.hpLeft > b.hpLeft;
  if (a.depth !== b.depth) return a.depth < b.depth;
  return a.endTick > b.endTick;
}

/** The best of `layouts` for this matchup (null if none builds). */
export function bestFight(m: Manifest, sp: ServedParty, layouts: readonly Layout[]): FightResult | null {
  let best: FightResult | null = null;
  for (const l of layouts) {
    const f = l.build(m, sp.scout);
    if (!f) continue;
    const r = fight(m, f, sp, l);
    if (!best || better(r, best)) best = r;
  }
  return best;
}

export function oneFight(m: Manifest, sp: ServedParty, layout: Layout): FightResult | null {
  const f = layout.build(m, sp.scout);
  return f ? fight(m, f, sp, layout) : null;
}

// ── matchmaking, as a fresh / cold-start pool serves it ────────────────────────────────

/** The menu `selectCandidates` serves from the authored pool alone (a cold start), for one search. */
export function servedMenu(caravanId: string, tripId: string, rating: number, encounterIndex: number, searchSeq = 1): { centre: number; menu: ServedParty[] } {
  const parties = authoredParties();
  const centre = escalatedCentre(rating, encounterIndex);
  const r = selectCandidates({ centre, seed: candidateSeed(caravanId, tripId, encounterIndex, searchSeq), pool: parties.map((p) => p.pool) });
  const byId = new Map(parties.map((p) => [p.pool.partyId, p] as const));
  return { centre, menu: r.picks.map((p) => byId.get(p.partyId)!) };
}

/** Final play-test review r2 S2: a raider is ranged when its attack range exceeds the melee default — the client guide's rule (TrailGuide isRangedRaider). */
export const RANGED_ATTACK_RANGE_ABOVE: number = TUNABLES.ATTACK_RANGE_MELEE_DEFAULT;
/** r2 S2: every raider of the party is ranged (it can stand outside the fence and shoot the posts). */
export function isRangedOnly(party: Party): boolean {
  return party.units.length > 0 && party.units.every((u) => getUnitType(u.typeId)!.attackRange > RANGED_ATTACK_RANGE_ABOVE);
}

/**
 * The guide's scouting pick, as the client's TrailGuide makes it: least total HP, then fewest siege,
 * then fewest raiders, then menu order — and (final play-test review r2 S2) never a ranged-only
 * party while the menu holds another one.
 */
export function guidePick(menu: readonly ServedParty[]): ServedParty {
  const hp = (p: ServedParty) => p.party.units.reduce((s, u) => s + Math.floor((getUnitType(u.typeId)!.hp * TUNABLES.MERGE_STAT_MULT_BY_LEVEL[u.mergeLevel]!) / 1024), 0);
  const notRanged = menu.filter((p) => !isRangedOnly(p.party));
  const from = notRanged.length > 0 ? notRanged : menu;
  return from
    .map((p, i) => ({ p, i }))
    .sort((a, b) => hp(a.p) - hp(b.p) || a.p.party.siege.length - b.p.party.siege.length || a.p.party.units.length - b.p.party.units.length || a.i - b.i)[0]!.p;
}

/**
 * Final play-test review r2 S2: a tester's standing party as the guide's "Raise my party from my
 * roster" (and the server's `suggested` party) makes it: every unit at L1 on the north edge at
 * `nearest`, spread along the band (party/service.ts suggestParty's cells), plus the free siege
 * piece. Served at REPUTATION_START (an owner who has not struck yet). `template` lends the spec
 * fields a fight reads (rating, a name for the report).
 */
export function raisedStarterParty(typeIds: readonly string[], label: string, template: ServedParty): ServedParty {
  const party: Party = {
    v: 1,
    units: typeIds.map((typeId, n) => ({ ref: `raised#${n}`, stance: "nearest" as const, edge: "north" as const, cell: { x: 2 + ((n * 3) % (TUNABLES.GRID_WIDTH - 4)), y: 0 }, typeId, mergeLevel: 1 })),
    siege: [{ typeId: "siege.battering_wagon" }],
  };
  const spec = { ...template.spec, username: `raised:${label}`, rating: TUNABLES.REPUTATION_START, outfit: { ...template.spec.outfit, name: label } };
  return { spec, party, scout: scoutOf(party), pool: { partyId: `raised:${label}`, ownerAccountId: `raised:${label}`, rating: TUNABLES.REPUTATION_START, authored: false } };
}

// ── trips ──────────────────────────────────────────────────────────────────────────────

export interface TripStep {
  readonly encounter: number;
  readonly band: number;
  readonly party: string;
  readonly result: FightResult;
  readonly ratingBefore: number;
}

export type PickPolicy = "best" | "guide" | "first";

/**
 * One trip from `rating`: at each encounter the server's menu, the player's pick (`best` = the
 * candidate the layouts do best against, `guide` = the guide's pick, `first` = menu slot 0), the
 * best of `layouts` against it, attrition carried forward, until an overrun or `maxEncounters`
 * survived. The caravan's living rating moves by the server's reputationDelta after each fight.
 */
export function runTrip(roster: RosterSpec, startRating: number, seedId: string, layouts: readonly Layout[], pick: PickPolicy, maxEncounters: number, perEncounterLayouts?: (j: number) => readonly Layout[]): { steps: TripStep[]; finalRating: number } {
  let m = manifestOf(roster);
  let rating = startRating;
  const steps: TripStep[] = [];
  for (let j = 1; j <= maxEncounters; j++) {
    if (alive(m).length === 0) break;
    const { centre, menu } = servedMenu(`caravan-${seedId}`, `trip-${seedId}`, rating, j);
    const ls = perEncounterLayouts ? perEncounterLayouts(j) : layouts;
    let chosen: { sp: ServedParty; r: FightResult } | null = null;
    const candidates = pick === "best" ? menu : [pick === "guide" ? guidePick(menu) : menu[0]!];
    for (const sp of candidates) {
      const r = bestFight(m, sp, ls);
      if (r && (!chosen || better(r, chosen.r))) chosen = { sp, r };
    }
    if (!chosen) break;
    steps.push({ encounter: j, band: bandOf(centre).index, party: chosen.sp.spec.username, result: chosen.r, ratingBefore: rating });
    rating += reputationDelta("caravan", chosen.r.kind, rating, chosen.sp.spec.rating).delta;
    if (chosen.r.kind === "caravan_overrun") break;
    m = chosen.r.survivors;
  }
  return { steps, finalRating: rating };
}

// ── statistics ─────────────────────────────────────────────────────────────────────────

export const share = (n: number, d: number): number => (d === 0 ? 0 : n / d);
export const pct = (x: number): string => `${(100 * x).toFixed(0)}%`;
export function median(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

export { REGION_IDS, baseMergeLevel, maxLivingTier };

// ── the band-typical roster ────────────────────────────────────────────────────────────

/** Fence tier a caravan has reached by band ordinal `o` (trap-web tiers 0, 2, 3, 4 hold brush, split rail, barbed wire, stacked stone). */
export function fenceTierAt(o: number): number {
  return o <= 1 ? 0 : o <= 3 ? 2 : o <= 5 ? 3 : 4;
}

/**
 * What a caravan typically packs in band ordinal `o` (a stated assumption of the sweep, not
 * measured play: merge level 1, 1, 2, 2, 3, 3, 4, 5 and living tier 0, 0, 1, 1, 2, 2, 3, 4 — the
 * curve the authored set used before this pass): eight units (at the floor: the starting roster and one refugee) at the band's base merge
 * level, living types up to the band's tier, six traps (they cost nothing to pack) of the types
 * reachable by then, and a full fence of the best tier reachable.
 */
/** A caravan's own progress by band ordinal (merge level 1 → 5 and living tier 0 → 4 spread evenly over the eight bands). The authored outfits climb a little faster (authored.ts). */
export function playerLevelAt(o: number): number {
  return Math.min(TUNABLES.MERGE_LEVEL_MAX, TUNABLES.MERGE_LEVEL_MIN + Math.floor((o * (TUNABLES.MERGE_LEVEL_MAX - TUNABLES.MERGE_LEVEL_MIN)) / 7));
}
export function playerTierAt(o: number): number {
  return Math.min(TUNABLES.UNLOCK_WEB_TIERS, Math.floor((o * TUNABLES.UNLOCK_WEB_TIERS) / 7));
}

export function bandTypicalRoster(regionId: RegionId, o: number, composition: Composition = "defensive"): RosterSpec {
  const fresh = starterTypes(regionId).length * STARTING_ROSTER_MODEL.copiesPerStarterType + 1;
  const size = Math.min(TUNABLES.DEPLOYMENT_SLOT_CAP, o === 0 ? fresh : TUNABLES.DEPLOYMENT_SLOT_CAP);
  return rosterAt(regionId, { size, level: playerLevelAt(o), tier: playerTierAt(o), traps: TUNABLES.TRAP_SLOT_CAP, trapTier: Math.min(3, Math.floor((o + 1) / 2)), fenceTier: fenceTierAt(o), composition, label: `b${o}-typical ${regionId} ${composition}` });
}

/** A layout by name (SKILLED ∪ NAIVE ∪ GUIDED). */
export function layoutNamed(name: string): Layout {
  const l = SKILLED.find((x) => x.name === name);
  if (!l) throw new Error(`no layout '${name}'`);
  return l;
}
