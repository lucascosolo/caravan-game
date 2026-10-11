/**
 * The placement model (chunk 08): PURE functions over chunk 07's `Manifest` (what
 * survives) and `Formation` (this encounter's arrangement). Every edit the screen makes
 * goes through here; the screen holds the resulting Formation and nothing else.
 *
 * What this file decides is only what the UI may OFFER. The server re-validates every
 * save and commit with the same @caravan/circle rules, and its issue list is what the
 * player sees when the two disagree. Nothing here reads anything but the manifest, the
 * formation and the content package.
 *
 * Gaps are never an issue here or anywhere (chunk 07 `formationGaps` is informational):
 * the material budget is below the ring by design, so the question is WHERE the gaps go.
 */
import {
  DEFAULT_DEFENSIVE_STANCE,
  EMPTY_FORMATION,
  FORMATION_VERSION,
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
  ringIndexAt,
  ringSegment,
  sameCell,
  type Cell,
  type DefensiveStance,
  type EntryEdge,
  type Formation,
  type Manifest,
  type ManifestFence,
} from "@caravan/circle";
import { FIXED_POINT_SCALE, TUNABLES, getUnitType } from "@caravan/content";
import type { ScoutedParty } from "./scoutTypes.ts";

// ── what can go where ────────────────────────────────────────────────────────────────

/** A cell a trap or post may occupy: on the lattice, off the ring/anchors, the core and the entry bands. */
export function isPlaceableCell(cell: Cell): boolean {
  return isCell(cell) && !isRingOrAnchorCell(cell) && !isCoreCell(cell) && !isAnyEntryCell(cell);
}

export function occupantAt(f: Formation, cell: Cell): string | null {
  return f.traps.find((t) => sameCell(t.cell, cell))?.ref ?? f.posts.find((p) => sameCell(p.cell, cell))?.ref ?? null;
}

/** Whether `ref` (which may already be placed elsewhere) can be dropped on `cell`. */
export function canDropOnCell(f: Formation, cell: Cell, ref: string): boolean {
  if (!isPlaceableCell(cell)) return false;
  const who = occupantAt(f, cell);
  if (who !== null && who !== ref) return false;
  // MIN_POST_DISTANCE between posts, in whole cells (chunk 07 QA N6).
  const minD = Math.trunc(TUNABLES.MIN_POST_DISTANCE / FIXED_POINT_SCALE);
  for (const p of f.posts) {
    if (p.ref === ref) continue;
    const dx = p.cell.x - cell.x;
    const dy = p.cell.y - cell.y;
    if (dx * dx + dy * dy < minD * minD) return false;
  }
  return true;
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

export type PlacedKind = "fence" | "trap" | "post";

export function kindOfRef(m: Manifest, ref: string): PlacedKind | null {
  if (m.units.some((u) => u.ref === ref)) return "post";
  if (m.traps.some((t) => t.ref === ref)) return "trap";
  if (m.fences.some((x) => x.ref === ref)) return "fence";
  return null;
}

/** Drop `ref` wherever the pointer is: a fence wants a ring position, the rest a free cell. */
export function dropAt(m: Manifest, f: Formation, ref: string, cell: Cell): Formation {
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

/** Whether a drop of `ref` on `cell` would be accepted (drives the ghost's colour). */
export function canDropAt(m: Manifest, f: Formation, ref: string, cell: Cell): boolean {
  switch (kindOfRef(m, ref)) {
    case "fence": {
      const seg = ringIndexAt(cell);
      return seg !== null && canDropOnSegment(f, seg, ref);
    }
    case "trap":
    case "post":
      return canDropOnCell(f, cell, ref);
    default:
      return false;
  }
}

// ── reading the arrangement back ─────────────────────────────────────────────────────

// There is deliberately NO local validateFormation call: legality is the server's to decide
// (chunk 06 QA convention — no client-side derivation of server-decided facts). The screen
// shows the server's issue list from the last save or commit, exactly as returned. What
// this file gates is only placement feasibility (where a drop can land), a UI affordance.

export interface EdgeReport {
  readonly edge: EntryEdge;
  /** Attackers starting on this edge. */
  readonly attackers: number;
  /** Siege pieces are not per-edge; shown once. */
  readonly ringPositions: number;
  readonly gaps: number;
  /** Posts whose aggro circle (guard/reserve) or attack range (hold) reaches a ring cell on this side. */
  readonly postsWatching: number;
}

/**
 * The threat overlay's numbers (SHOW_THREAT_OVERLAY): per edge, how many attackers start
 * there, how many ring positions on that side are open, and how many posts can reach that
 * side. Informational — the design choice is the player's — never a verdict.
 */
export function edgeReports(m: Manifest, f: Formation, party: ScoutedParty | null): readonly EdgeReport[] {
  const open = new Set(formationGaps(f));
  return ENTRY_EDGES.map((edge) => {
    const side = RING_SEGMENTS.filter((s) => s.edge === edge);
    const gaps = side.filter((s) => open.has(s.index)).length;
    let postsWatching = 0;
    for (const p of f.posts) {
      const u = m.units.find((x) => x.ref === p.ref);
      const t = u ? getUnitType(u.typeId) : undefined;
      if (!t) continue;
      const reach = (p.stance === "hold" ? t.attackRange : t.aggroRadius) / FIXED_POINT_SCALE;
      const reachSq = reach * reach;
      const watches = side.some((s) => {
        const dx = s.cell.x - p.cell.x;
        const dy = s.cell.y - p.cell.y;
        return dx * dx + dy * dy <= reachSq;
      });
      if (watches) postsWatching++;
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

/** Every placed thing, in canonical order, for the commit confirmation. */
export function itemize(m: Manifest, f: Formation): readonly CommitItem[] {
  const items: CommitItem[] = [];
  for (const p of [...f.fences].sort((a, b) => a.segment - b.segment)) {
    const x = m.fences.find((q) => q.ref === p.ref);
    if (x) items.push({ kind: "fence", ref: p.ref, typeId: x.tierId, where: `#${p.segment} ${ringSegment(p.segment).edge}`, detail: `${x.hp}/${x.maxHp}` });
  }
  for (const p of [...f.traps].sort((a, b) => (a.ref < b.ref ? -1 : 1))) {
    const t = m.traps.find((q) => q.ref === p.ref);
    if (t) items.push({ kind: "trap", ref: p.ref, typeId: t.typeId, where: `(${p.cell.x}, ${p.cell.y})`, detail: "" });
  }
  for (const p of [...f.posts].sort((a, b) => (a.ref < b.ref ? -1 : 1))) {
    const u = m.units.find((q) => q.ref === p.ref);
    if (u) items.push({ kind: "post", ref: p.ref, typeId: u.typeId, where: `(${p.cell.x}, ${p.cell.y})`, detail: `${p.stance} · ${u.hp}/${u.maxHp}` });
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
