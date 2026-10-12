/**
 * The placement model (chunk 08): PURE functions over chunk 07's `Manifest` (what
 * survives) and `Formation` (this encounter's arrangement). Every edit the screen makes
 * goes through here; the screen holds the resulting Formation and nothing else.
 *
 * What this file decides is only what the UI may OFFER. Where a drop may land is answered
 * by @caravan/circle's own `validateFormation` run over the hypothetical arrangement
 * (`dropRefusal`, chunk 08 QA S9): the refusal is the server's rule and the server's code,
 * never a re-implementation. The server re-validates every save and commit, and its issue
 * list is what the player sees when the two disagree.
 *
 * Gaps are never an issue here or anywhere (chunk 07 `formationGaps` is informational):
 * the material budget is below the ring by design, so the question is WHERE the gaps go.
 */
import {
  DEFAULT_DEFENSIVE_STANCE,
  EMPTY_FORMATION,
  FORMATION_VERSION,
  GRID_HEIGHT,
  GRID_WIDTH,
  RING_SEGMENTS,
  ENTRY_EDGES,
  cellKey,
  formationGaps,
  isAnyEntryCell,
  isCell,
  isCoreCell,
  isFenceIntact,
  isRingOrAnchorCell,
  isUnitAlive,
  resolverTunables,
  ringIndexAt,
  ringSegment,
  sameCell,
  toBattlefield,
  validateFormation,
  type Cell,
  type DefensiveStance,
  type EntryEdge,
  type Formation,
  type Manifest,
  type ManifestFence,
} from "@caravan/circle";
import { FIXED_POINT_SCALE, TUNABLES } from "@caravan/content";
import { STRINGS } from "../../strings.ts";
import type { ScoutedParty } from "./scoutTypes.ts";

const T = STRINGS.trail;

// ── what can go where ────────────────────────────────────────────────────────────────

/** A cell a trap or post may occupy: on the lattice, off the ring/anchors, the core and the entry bands. */
export function isPlaceableCell(cell: Cell): boolean {
  return isCell(cell) && !isRingOrAnchorCell(cell) && !isCoreCell(cell) && !isAnyEntryCell(cell);
}

export function occupantAt(f: Formation, cell: Cell): string | null {
  return f.traps.find((t) => sameCell(t.cell, cell))?.ref ?? f.posts.find((p) => sameCell(p.cell, cell))?.ref ?? null;
}

/** Whether `ref` (which may already be placed elsewhere) can be put on `cell` as far as the cell itself goes. */
export function canDropOnCell(f: Formation, cell: Cell, ref: string): boolean {
  if (!isPlaceableCell(cell)) return false;
  const who = occupantAt(f, cell);
  return who === null || who === ref;
}

export function fenceAtSegment(f: Formation, segment: number): string | null {
  return f.fences.find((p) => p.segment === segment)?.ref ?? null;
}

/** Whether a fence (`ref`, possibly already placed elsewhere) can be dropped on ring position `segment`. */
export function canDropOnSegment(f: Formation, segment: number, ref: string): boolean {
  const who = fenceAtSegment(f, segment);
  return who === null || who === ref;
}

// ── the material budget and the tray ─────────────────────────────────────────────────

export interface FenceBudget {
  /** Segments packed for the trip. */
  readonly packed: number;
  /** Destroyed earlier this trip; gone. */
  readonly destroyed: number;
  /** Placed on the ring now. */
  readonly placed: number;
  /** Intact and still in the wagon. */
  readonly remaining: number;
  /** Ring positions, for the meter's ceiling. */
  readonly ring: number;
}

export function fenceBudget(m: Manifest, f: Formation): FenceBudget {
  const intact = m.fences.filter(isFenceIntact);
  const placedRefs = new Set(f.fences.map((p) => p.ref));
  return {
    packed: m.fences.length,
    destroyed: m.fences.length - intact.length,
    placed: f.fences.length,
    remaining: intact.filter((x) => !placedRefs.has(x.ref)).length,
    ring: RING_SEGMENTS.length,
  };
}

/** Intact, unplaced fence segments, healthiest first, then by ref — the order "place next" uses. */
export function unplacedFences(m: Manifest, f: Formation): readonly ManifestFence[] {
  const placed = new Set(f.fences.map((p) => p.ref));
  return m.fences
    .filter((x) => isFenceIntact(x) && !placed.has(x.ref))
    .sort((a, b) => b.hp - a.hp || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
}

export function nextFenceRef(m: Manifest, f: Formation): string | null {
  return unplacedFences(m, f)[0]?.ref ?? null;
}

export function unplacedTraps(m: Manifest, f: Formation): readonly Manifest["traps"][number][] {
  const placed = new Set(f.traps.map((p) => p.ref));
  return m.traps.filter((t) => !t.spent && !placed.has(t.ref));
}

export function unpostedUnits(m: Manifest, f: Formation): readonly Manifest["units"][number][] {
  const placed = new Set(f.posts.map((p) => p.ref));
  return m.units.filter((u) => isUnitAlive(u) && !placed.has(u.ref));
}

/** A segment's player-facing number: its place in the packed list, 1-based (never the raw ref, QA S15). */
export function segmentNumber(m: Manifest, ref: string): number {
  return m.fences.findIndex((f) => f.ref === ref) + 1;
}

// ── edits (each returns a new Formation; the input is never mutated) ─────────────────

export function placeFence(f: Formation, ref: string, segment: number): Formation {
  if (!canDropOnSegment(f, segment, ref)) return f;
  return { v: FORMATION_VERSION, fences: [...f.fences.filter((p) => p.ref !== ref), { ref, segment }], traps: f.traps, posts: f.posts };
}

export function placeTrap(f: Formation, ref: string, cell: Cell): Formation {
  if (!canDropOnCell(f, cell, ref)) return f;
  return { v: FORMATION_VERSION, fences: f.fences, traps: [...f.traps.filter((p) => p.ref !== ref), { ref, cell: { x: cell.x, y: cell.y } }], posts: f.posts };
}

export function placePost(f: Formation, ref: string, cell: Cell, stance?: DefensiveStance): Formation {
  if (!canDropOnCell(f, cell, ref)) return f;
  const prior = f.posts.find((p) => p.ref === ref);
  const s = stance ?? prior?.stance ?? DEFAULT_DEFENSIVE_STANCE;
  return { v: FORMATION_VERSION, fences: f.fences, traps: f.traps, posts: [...f.posts.filter((p) => p.ref !== ref), { ref, cell: { x: cell.x, y: cell.y }, stance: s }] };
}

export function setStance(f: Formation, ref: string, stance: DefensiveStance): Formation {
  if (!f.posts.some((p) => p.ref === ref)) return f;
  return { v: FORMATION_VERSION, fences: f.fences, traps: f.traps, posts: f.posts.map((p) => (p.ref === ref ? { ...p, stance } : p)) };
}

/** Take a placed thing of any kind back into the wagon. */
export function remove(f: Formation, ref: string): Formation {
  return { v: FORMATION_VERSION, fences: f.fences.filter((p) => p.ref !== ref), traps: f.traps.filter((p) => p.ref !== ref), posts: f.posts.filter((p) => p.ref !== ref) };
}

export function clearAll(): Formation {
  return EMPTY_FORMATION;
}

export function isEmptyFormation(f: Formation): boolean {
  return f.fences.length === 0 && f.traps.length === 0 && f.posts.length === 0;
}

export type PlacedKind = "fence" | "trap" | "post";

export function kindOfRef(m: Manifest, ref: string): PlacedKind | null {
  if (m.units.some((u) => u.ref === ref)) return "post";
  if (m.traps.some((t) => t.ref === ref)) return "trap";
  if (m.fences.some((x) => x.ref === ref)) return "fence";
  return null;
}

export function isPlaced(f: Formation, ref: string): boolean {
  return f.fences.some((p) => p.ref === ref) || f.traps.some((p) => p.ref === ref) || f.posts.some((p) => p.ref === ref);
}

// ── refusals: circle's own per-entry rules, with circle's own codes (QA S9) ───────────

/** A refused drop: the code is @caravan/circle's (the server's), the message is the player's wording of it. */
export interface Refusal {
  readonly code: string;
  readonly message: string;
}

/** Codes that are about the whole arrangement, not the thing being dropped: never a reason to refuse one drop. */
const NOT_ABOUT_THIS_DROP = new Set(["unit_not_posted", "type_locked"]);

function refusal(code: string): Refusal {
  return { code, message: T.refusal(code) };
}

/** The arrangement as it would be with `ref` dropped on `cell`, placed unconditionally (null: not a place for it at all). */
function hypothetical(m: Manifest, f: Formation, ref: string, cell: Cell): Formation | Refusal {
  const kind = kindOfRef(m, ref);
  if (!kind) return refusal("unknown_ref");
  const rest = remove(f, ref);
  if (kind === "fence") {
    const seg = ringIndexAt(cell);
    if (seg === null) return refusal("bad_segment");
    return { ...rest, fences: [...rest.fences, { ref, segment: seg }] };
  }
  if (!isCell(cell)) return refusal("bad_cell");
  if (kind === "trap") return { ...rest, traps: [...rest.traps, { ref, cell: { x: cell.x, y: cell.y } }] };
  const stance = f.posts.find((p) => p.ref === ref)?.stance ?? DEFAULT_DEFENSIVE_STANCE;
  return { ...rest, posts: [...rest.posts, { ref, cell: { x: cell.x, y: cell.y }, stance }] };
}

/**
 * Why `ref` may not be dropped on `cell`, or null when it may. Runs circle's
 * `validateFormation` over the arrangement with the drop applied and keeps the issues
 * whose subject is the dropped thing (the dropped entry is appended last, so a pairwise
 * rule like MIN_POST_DISTANCE names it). Access is not this function's question: what is
 * in the manifest was gated at pack time and the server checks again.
 */
export function dropRefusal(m: Manifest, f: Formation, ref: string, cell: Cell): Refusal | null {
  const h = hypothetical(m, f, ref, cell);
  if (!("v" in h)) return h;
  const res = validateFormation(m, h, () => true);
  if (res.ok) return null;
  const mine = res.issues.find((i) => i.subject === ref && !NOT_ABOUT_THIS_DROP.has(i.code));
  return mine ? refusal(mine.code) : null;
}

/** Whether a drop of `ref` on `cell` would be accepted (drives the ghost's colour). */
export function canDropAt(m: Manifest, f: Formation, ref: string, cell: Cell): boolean {
  return dropRefusal(m, f, ref, cell) === null;
}

/** Drop `ref` wherever the pointer is: a fence wants a ring position, the rest a free cell. Refused drops change nothing. */
export function dropAt(m: Manifest, f: Formation, ref: string, cell: Cell): Formation {
  if (!canDropAt(m, f, ref, cell)) return f;
  switch (kindOfRef(m, ref)) {
    case "fence": {
      const seg = ringIndexAt(cell);
      return seg === null ? f : placeFence(f, ref, seg);
    }
    case "trap":
      return placeTrap(f, ref, cell);
    case "post":
      return placePost(f, ref, cell);
    default:
      return f;
  }
}

// ── reach: the numbers the resolver measures (QA B2 / N11) ───────────────────────────

/** A posted unit's circles in CELLS, exactly as the resolver measures them. */
export interface PostReach {
  /** aggroRadius + UNIT_RADIUS: an attacker whose centre is this close is noticed (guard; reserve once released). */
  readonly aggroReach: number;
  /** leashDistance: how far the unit's centre may get from its post before it turns back. */
  readonly leash: number;
  /** attackRange + UNIT_RADIUS: what it can hit from where it stands. */
  readonly attackReach: number;
}

/**
 * The reach of `ref` posted with `stance`, read from `toBattlefield` — the very structure
 * the server hands the resolver — and `resolverTunables().unitRadius`, never from a second
 * copy of the content numbers (QA N11). Null for a ref that is not a living unit.
 */
export function postReach(m: Manifest, ref: string, stance: DefensiveStance = DEFAULT_DEFENSIVE_STANCE): PostReach | null {
  const u = m.units.find((x) => x.ref === ref);
  if (!u) return null;
  try {
    const bf = toBattlefield(m, { v: FORMATION_VERSION, fences: [], traps: [], posts: [{ ref, cell: { x: 0, y: 0 }, stance }] });
    const p = bf.posts[0];
    if (!p) return null;
    const r = resolverTunables().unitRadius;
    return { aggroReach: (p.aggroRadius + r) / FIXED_POINT_SCALE, leash: p.leashDistance / FIXED_POINT_SCALE, attackReach: (p.attackRange + r) / FIXED_POINT_SCALE };
  } catch {
    return null;
  }
}

// ── reading the arrangement back ─────────────────────────────────────────────────────

// There is deliberately NO local "is this formation committable" verdict: legality is the
// server's to decide (chunk 06 QA convention). The screen shows the server's issue list
// from the last save or commit, exactly as returned.

export interface EdgeReport {
  readonly edge: EntryEdge;
  /** Attackers starting on this edge. */
  readonly attackers: number;
  readonly ringPositions: number;
  readonly gaps: number;
  /** Posts whose reach touches a ring position on this side (see `edgeReports`). */
  readonly postsWatching: number;
}

/**
 * The threat overlay's numbers (SHOW_THREAT_OVERLAY): per edge, how many attackers start
 * there, how many ring positions on that side are open, and how many posts can reach that
 * side. Informational — the design choice is the player's — never a verdict.
 *
 * "In reach" is measured centre to centre against the resolver's REACH: a guard notices
 * out to aggroRadius + UNIT_RADIUS and chases; a hold post never leaves its post and hits
 * out to attackRange + UNIT_RADIUS; a reserve post holds its post and strikes what enters
 * its attack reach until the ring is breached (chunk 11 QA D1), so before release it is
 * counted by its attack reach, like hold (QA N11).
 */
export function edgeReports(m: Manifest, f: Formation, party: ScoutedParty | null): readonly EdgeReport[] {
  const open = new Set(formationGaps(f));
  const reach = f.posts.map((p) => {
    const r = postReach(m, p.ref, p.stance);
    return { cell: p.cell, reach: r ? (p.stance === "guard" ? r.aggroReach : r.attackReach) : 0 };
  });
  return ENTRY_EDGES.map((edge) => {
    const side = RING_SEGMENTS.filter((s) => s.edge === edge);
    const gaps = side.filter((s) => open.has(s.index)).length;
    let postsWatching = 0;
    for (const p of reach) {
      const reachSq = p.reach * p.reach;
      if (side.some((s) => (s.cell.x - p.cell.x) ** 2 + (s.cell.y - p.cell.y) ** 2 <= reachSq)) postsWatching++;
    }
    return { edge, attackers: party ? party.units.filter((u) => u.edge === edge).length : 0, ringPositions: side.length, gaps, postsWatching };
  });
}

/** Open ring positions as cells (for the scene's gap markers). */
export function gapCells(f: Formation): readonly Cell[] {
  return formationGaps(f).map((i) => ringSegment(i).cell);
}

/** A stable key for a cell, for sets. */
export const keyOf = cellKey;

// ── what gets committed ──────────────────────────────────────────────────────────────

export interface CommitItem {
  readonly kind: PlacedKind;
  readonly ref: string;
  readonly typeId: string;
  readonly where: string;
  readonly detail: string;
}

/** Every placed thing, in canonical order, for the commit confirmation. Player wording only (QA S15). */
export function itemize(m: Manifest, f: Formation): readonly CommitItem[] {
  const items: CommitItem[] = [];
  for (const p of [...f.fences].sort((a, b) => a.segment - b.segment)) {
    const x = m.fences.find((q) => q.ref === p.ref);
    if (x) items.push({ kind: "fence", ref: p.ref, typeId: x.tierId, where: T.ringPosition(p.segment, T.edgeName(ringSegment(p.segment).edge)), detail: T.hpOf(x.hp, x.maxHp) });
  }
  for (const p of [...f.traps].sort((a, b) => (a.ref < b.ref ? -1 : 1))) {
    const t = m.traps.find((q) => q.ref === p.ref);
    if (t) items.push({ kind: "trap", ref: p.ref, typeId: t.typeId, where: T.cellAt(p.cell.x, p.cell.y), detail: "" });
  }
  for (const p of [...f.posts].sort((a, b) => (a.ref < b.ref ? -1 : 1))) {
    const u = m.units.find((q) => q.ref === p.ref);
    if (u) items.push({ kind: "post", ref: p.ref, typeId: u.typeId, where: T.cellAt(p.cell.x, p.cell.y), detail: `${T.stanceName(p.stance)} · ${T.hpOf(u.hp, u.maxHp)}` });
  }
  return items;
}

/** Ring positions grouped into runs for the commit summary: "north 0–5, east 7–13". */
export function fenceRuns(f: Formation): readonly { readonly from: number; readonly to: number }[] {
  const segs = [...f.fences.map((p) => p.segment)].sort((a, b) => a - b);
  const runs: { from: number; to: number }[] = [];
  for (const s of segs) {
    const last = runs[runs.length - 1];
    if (last && last.to === s - 1) last.to = s;
    else runs.push({ from: s, to: s });
  }
  return runs;
}

// ── the DOM placement picker (QA D3) ─────────────────────────────────────────────────

export interface PickerOption {
  readonly cell: Cell;
  /** Ring position index for a fence; null for a cell. */
  readonly segment: number | null;
  readonly refusal: Refusal | null;
}

/**
 * Every target for `ref`, grouped by the side of the circle it faces, each with circle's
 * refusal (or none). A fence gets the 28 ring positions; a trap or post every placeable
 * cell (legal ones only — the reserved cells are listed once as a rule, not 400 times).
 * A cell's side is the edge it is nearest: |dx| > |dy| from the core centre → east/west.
 */
export function pickerOptions(m: Manifest, f: Formation, ref: string): ReadonlyMap<EntryEdge, readonly PickerOption[]> {
  const kind = kindOfRef(m, ref);
  const out = new Map<EntryEdge, PickerOption[]>(ENTRY_EDGES.map((e) => [e, []]));
  if (!kind) return out;
  if (kind === "fence") {
    for (const s of RING_SEGMENTS) out.get(s.edge)!.push({ cell: s.cell, segment: s.index, refusal: dropRefusal(m, f, ref, s.cell) });
    return out;
  }
  const side = (c: Cell): EntryEdge => {
    const dx = c.x + 0.5 - GRID_WIDTH / 2;
    const dy = c.y + 0.5 - GRID_HEIGHT / 2;
    return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "east" : "west") : dy > 0 ? "south" : "north";
  };
  for (let y = 0; y < GRID_HEIGHT; y++) {
    for (let x = 0; x < GRID_WIDTH; x++) {
      const cell = { x, y };
      if (!isPlaceableCell(cell)) continue;
      out.get(side(cell))!.push({ cell, segment: null, refusal: dropRefusal(m, f, ref, cell) });
    }
  }
  return out;
}

// ── fast arranging (final play-test review S3) ───────────────────────────────────────

/** Ring positions on one side, in ring order. */
export function sidePositions(edge: EntryEdge): readonly number[] {
  return RING_SEGMENTS.filter((s) => s.edge === edge).map((s) => s.index);
}

/** How many of a side's positions are still open (no fence on them). */
export function openOnSide(f: Formation, edge: EntryEdge): number {
  return sidePositions(edge).filter((s) => fenceAtSegment(f, s) === null).length;
}

/**
 * "Fence this side": every open position on `edge` gets the next intact segment (healthiest
 * first, the same order as "next segment"), until the side is closed or the wagon is empty.
 * Every drop goes through `dropRefusal`, so it places exactly what a hand drop would.
 */
export function fenceSide(m: Manifest, f: Formation, edge: EntryEdge): Formation {
  let out = f;
  for (const s of sidePositions(edge)) {
    if (fenceAtSegment(out, s) !== null) continue;
    const ref = nextFenceRef(m, out);
    if (!ref) break;
    if (dropRefusal(m, out, ref, ringSegment(s).cell) === null) out = placeFence(out, ref, s);
  }
  return out;
}

/**
 * The next thing of the same kind still in the wagon, after `ref` was just placed (the
 * picker's and the tap-to-place loop's auto-advance): the next intact segment, the next
 * unposted living unit (in manifest order after `ref`, wrapping), or the next unlaid trap.
 * Null when nothing of that kind is left.
 */
export function nextUnplacedOfKind(m: Manifest, f: Formation, ref: string): string | null {
  const kind = kindOfRef(m, ref);
  if (kind === "fence") return nextFenceRef(m, f);
  const pick = <T extends { readonly ref: string }>(all: readonly T[], open: readonly T[]): string | null => {
    if (open.length === 0) return null;
    const at = all.findIndex((x) => x.ref === ref);
    for (let i = 1; i <= all.length; i++) {
      const cand = all[(at + i) % all.length]!;
      if (open.some((o) => o.ref === cand.ref)) return cand.ref;
    }
    return open[0]!.ref;
  };
  if (kind === "post") return pick(m.units, unpostedUnits(m, f));
  if (kind === "trap") return pick(m.traps, unplacedTraps(m, f));
  return null;
}

/**
 * A tap meant for the ring (a fence is selected): the ring cell under it, or the nearest ring
 * cell within `reach` cells (Chebyshev) — the ring cells are small on a phone, and only a ring
 * position can take a fence. Null when the tap is not near the ring.
 */
export function snapToRing(cell: Cell, reach = 1): Cell | null {
  if (ringIndexAt(cell) !== null) return cell;
  let best: Cell | null = null;
  let bestD = Infinity;
  for (const s of RING_SEGMENTS) {
    const dx = Math.abs(s.cell.x - cell.x);
    const dy = Math.abs(s.cell.y - cell.y);
    if (Math.max(dx, dy) > reach) continue;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      best = s.cell;
      bestD = d;
    }
  }
  return best;
}

/**
 * "Start from my last arrangement": the previous encounter's committed formation, kept to
 * what survives now — a destroyed segment, a spent trap and a dead unit drop out — and
 * re-applied through `dropRefusal` one item at a time (fences, then traps, then posts), so
 * the result is exactly what hand drops could have made. Stances carry over.
 */
export function carryForward(m: Manifest, previous: Formation): Formation {
  let out: Formation = clearAll();
  for (const p of previous.fences) {
    const x = m.fences.find((q) => q.ref === p.ref);
    if (!x || !isFenceIntact(x)) continue;
    if (dropRefusal(m, out, p.ref, ringSegment(p.segment).cell) === null) out = placeFence(out, p.ref, p.segment);
  }
  for (const p of previous.traps) {
    const t = m.traps.find((q) => q.ref === p.ref);
    if (!t || t.spent) continue;
    if (dropRefusal(m, out, p.ref, p.cell) === null) out = placeTrap(out, p.ref, p.cell);
  }
  for (const p of previous.posts) {
    const u = m.units.find((q) => q.ref === p.ref);
    if (!u || !isUnitAlive(u)) continue;
    if (dropRefusal(m, out, p.ref, p.cell) === null) out = placePost(out, p.ref, p.cell, p.stance);
  }
  return out;
}

/** The commit summary's fence line by side (N14): "north 7, east 7, west 6". */
export function fencesBySide(f: Formation): readonly { readonly edge: EntryEdge; readonly placed: number; readonly open: number }[] {
  return ENTRY_EDGES.map((edge) => {
    const side = sidePositions(edge);
    const placed = side.filter((s) => fenceAtSegment(f, s) !== null).length;
    return { edge, placed, open: side.length - placed };
  });
}
