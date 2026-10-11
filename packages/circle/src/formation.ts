/**
 * The FORMATION — how the caravan is arranged for ONE encounter (chunk 07, "The two
 * lifetimes").
 *
 * Lifetime: one encounter. Chosen fresh every time, against a specific scouted attacking
 * party, from whatever the manifest still has. It REFERENCES manifest entries by ref; it
 * owns nothing. A new formation may be arranged freely before each encounter; once
 * committed it is snapshotted (serialize.ts) and the resolver consumes that snapshot.
 *
 * What a formation decides:
 *   - which fence segments go on which ring positions (and therefore where the gaps are —
 *     a gap is legal and, under the budget, unavoidable);
 *   - where each unspent trap is laid, if it is laid at all (holding one back is legal);
 *   - where each living unit is posted, and with what DEFENSIVE STANCE. Its post is a
 *     lattice cell: the fixed origin its aggro radius and leash are measured from during
 *     the fight.
 *
 * Defensive stances (QA D1; PROJECT.md §9 "where units are posted and with what stance").
 * One per post, chosen fresh per encounter like everything else here. Chunk 11 implements
 * the behaviour; the semantics are fixed here so the model and the resolver agree:
 *   - `guard`   — the default. Aggro/leash pursuit as chunk 11's brief describes: notices
 *                 an attacker inside its aggro radius, chases up to its leash, returns.
 *   - `hold`    — fights only attackers within attack range of its post and never leaves
 *                 it (leash 0).
 *   - `reserve` — ignores everything until an attacker is INSIDE THE RING (any lattice cell
 *                 with Chebyshev distance < PERIMETER_RING_RADIUS from the core centre),
 *                 then behaves as `guard`. This is the "kept safely in the back" choice of
 *                 §13.4, which is why every living unit must still be posted.
 * These are the DEFENDING side's stances. They are distinct from the attacking party's
 * three targeting stances (chunk 09), which live on the party, not here.
 */
import { FIXED_POINT_SCALE, TUNABLES } from "@caravan/content";
import { capIssues, issue, type Issue, type Validation } from "./issues.js";
import {
  cellDistSq,
  cellKey,
  isAnyEntryCell,
  isCell,
  isCoreCell,
  isRingOrAnchorCell,
  isRingSegmentIndex,
  sameCell,
  type Cell,
} from "./lattice.js";
import { isFenceIntact, isUnitAlive, type AccessCheck, type Manifest } from "./manifest.js";

export const DEFENSIVE_STANCES = ["guard", "hold", "reserve"] as const;
export type DefensiveStance = (typeof DEFENSIVE_STANCES)[number];
export const DEFAULT_DEFENSIVE_STANCE: DefensiveStance = "guard";

export function isDefensiveStance(value: unknown): value is DefensiveStance {
  return typeof value === "string" && (DEFENSIVE_STANCES as readonly string[]).includes(value);
}

export interface FencePlacement {
  /** A manifest fence ref. */
  readonly ref: string;
  /** Ring segment index, 0..PERIMETER_SEGMENTS-1. */
  readonly segment: number;
}

export interface TrapPlacement {
  /** A manifest trap ref. */
  readonly ref: string;
  readonly cell: Cell;
}

export interface PostPlacement {
  /** A manifest unit ref. */
  readonly ref: string;
  /** The post: the fixed origin the unit's leash is measured from. */
  readonly cell: Cell;
  /** QA D1: how the unit behaves at that post. See the header. */
  readonly stance: DefensiveStance;
}

export interface Formation {
  /** 2 since QA D1 (posts carry a stance). Version 1 snapshots were never stored outside tests. */
  readonly v: 2;
  readonly fences: readonly FencePlacement[];
  readonly traps: readonly TrapPlacement[];
  readonly posts: readonly PostPlacement[];
}

export const FORMATION_VERSION = 2 as const;

export const EMPTY_FORMATION: Formation = Object.freeze({
  v: FORMATION_VERSION,
  fences: Object.freeze([]),
  traps: Object.freeze([]),
  posts: Object.freeze([]),
});

/**
 * Minimum squared post separation, in cells² (MIN_POST_DISTANCE is Fixed cells).
 * QA N6: posts are whole lattice cells, so the threshold is TRUNCATED to whole cells. A
 * fractional MIN_POST_DISTANCE is therefore a no-op: anything in [1, 2) cells means
 * "distinct cells", which the cell-occupancy check already enforces; only 2 or more
 * cells changes behaviour. Tune it in whole cells.
 */
const MIN_POST_DIST_SQ_CELLS: number = (() => {
  const d = Math.trunc(TUNABLES.MIN_POST_DISTANCE / FIXED_POINT_SCALE);
  return d * d;
})();

/**
 * QA S8: the most placements a formation can legitimately carry. A formation can only
 * reference what was packed, so anything larger is refused outright — before any per-entry
 * work — rather than validated entry by entry.
 */
export const FORMATION_SIZE_CAPS = Object.freeze({
  fences: TUNABLES.PERIMETER_SEGMENTS,
  traps: TUNABLES.TRAP_SLOT_CAP,
  posts: TUNABLES.DEPLOYMENT_SLOT_CAP,
});

/** The oversized issue, or null when every list is within its cap. */
export function oversizedIssue(lists: { readonly fences: readonly unknown[]; readonly traps: readonly unknown[]; readonly posts: readonly unknown[] }): Issue | null {
  for (const kind of ["fences", "traps", "posts"] as const) {
    const cap = FORMATION_SIZE_CAPS[kind];
    if (lists[kind].length > cap) return issue("oversized", `${lists[kind].length} ${kind} placed; a formation carries at most ${cap}`, kind);
  }
  return null;
}

/**
 * Validate a formation against its manifest. Every rule the server enforces lives here:
 *   - every ref exists in the manifest and is usable (alive / unspent / intact);
 *   - no ref placed twice; every living unit posted;
 *   - fence segments on distinct ring positions; gaps are fine;
 *   - traps and posts on in-bounds cells that are not the ring, the core or an entry band;
 *   - no two placed objects on one cell; posts at least MIN_POST_DISTANCE apart;
 *   - every placed type passes the access gate (defence in depth: the manifest was already
 *     gated at pack time, but access is checked again at the placement boundary).
 * Slot caps and the material budget were enforced at pack time; a formation cannot exceed
 * them because it can only reference what was packed.
 */
export function validateFormation(manifest: Manifest, formation: Formation, isUnlocked: AccessCheck): Validation<Formation> {
  const issues: Issue[] = [];
  if (formation.v !== FORMATION_VERSION) {
    return { ok: false, issues: [issue("bad_version", `unsupported formation version ${String(formation.v)}`)] };
  }
  const oversized = oversizedIssue(formation);
  if (oversized) return { ok: false, issues: [oversized] };
  const usedRefs = new Set<string>();
  const takeRef = (ref: string): boolean => {
    if (usedRefs.has(ref)) {
      issues.push(issue("duplicate_ref", `'${ref}' is placed more than once`, ref));
      return false;
    }
    usedRefs.add(ref);
    return true;
  };
  const occupied = new Map<number, string>();
  const takeCell = (cell: Cell, ref: string): boolean => {
    if (!isCell(cell)) {
      issues.push(issue("bad_cell", `'${ref}' is placed off the lattice`, ref));
      return false;
    }
    if (isRingOrAnchorCell(cell) || isCoreCell(cell) || isAnyEntryCell(cell)) {
      issues.push(issue("cell_reserved", `'${ref}' may not be placed on the fence ring, a wagon anchor, the core or an entry band`, ref));
      return false;
    }
    const k = cellKey(cell);
    const prior = occupied.get(k);
    if (prior !== undefined) {
      issues.push(issue("cell_occupied", `'${ref}' overlaps '${prior}' at (${cell.x}, ${cell.y})`, ref));
      return false;
    }
    occupied.set(k, ref);
    return true;
  };

  // Fences.
  const usedSegments = new Map<number, string>();
  for (const p of formation.fences) {
    if (!takeRef(p.ref)) continue;
    const f = manifest.fences.find((x) => x.ref === p.ref);
    if (!f) {
      issues.push(issue("unknown_ref", `fence '${p.ref}' is not in the manifest`, p.ref));
      continue;
    }
    if (!isUnlocked(f.tierId)) issues.push(issue("type_locked", `fence tier '${f.tierId}' is not unlocked`, f.tierId));
    if (!isFenceIntact(f)) issues.push(issue("fence_destroyed", `fence '${p.ref}' was destroyed earlier this trip`, p.ref));
    if (!isRingSegmentIndex(p.segment)) {
      issues.push(issue("bad_segment", `segment ${String(p.segment)} is not a ring position`, p.ref));
      continue;
    }
    const prior = usedSegments.get(p.segment);
    if (prior !== undefined) {
      issues.push(issue("duplicate_segment", `segment ${p.segment} holds both '${prior}' and '${p.ref}'`, p.ref));
      continue;
    }
    usedSegments.set(p.segment, p.ref);
  }

  // Traps.
  for (const p of formation.traps) {
    if (!takeRef(p.ref)) continue;
    const t = manifest.traps.find((x) => x.ref === p.ref);
    if (!t) {
      issues.push(issue("unknown_ref", `trap '${p.ref}' is not in the manifest`, p.ref));
      continue;
    }
    if (!isUnlocked(t.typeId)) issues.push(issue("type_locked", `trap type '${t.typeId}' is not unlocked`, t.typeId));
    if (t.spent) issues.push(issue("trap_spent", `trap '${p.ref}' was spent earlier this trip and does not re-arm`, p.ref));
    takeCell(p.cell, p.ref);
  }

  // Posts.
  const placedPosts: PostPlacement[] = [];
  for (const p of formation.posts) {
    if (!takeRef(p.ref)) continue;
    const u = manifest.units.find((x) => x.ref === p.ref);
    if (!u) {
      issues.push(issue("unknown_ref", `unit '${p.ref}' is not in the manifest`, p.ref));
      continue;
    }
    if (!isUnlocked(u.typeId)) issues.push(issue("type_locked", `living-unit type '${u.typeId}' is not unlocked`, u.typeId));
    if (!isUnitAlive(u)) issues.push(issue("unit_dead", `unit '${p.ref}' died earlier this trip`, p.ref));
    if (!isDefensiveStance(p.stance)) issues.push(issue("bad_stance", `'${p.ref}' has stance ${String(p.stance)}; expected one of ${DEFENSIVE_STANCES.join(", ")}`, p.ref));
    if (!takeCell(p.cell, p.ref)) continue;
    for (const q of placedPosts) {
      if (cellDistSq(p.cell, q.cell) < MIN_POST_DIST_SQ_CELLS) {
        issues.push(issue("post_too_close", `posts '${q.ref}' and '${p.ref}' are closer than MIN_POST_DISTANCE`, p.ref));
      }
    }
    placedPosts.push(p);
  }
  // Every living unit on the trip is at the camp; each must have a post.
  for (const u of manifest.units) {
    if (isUnitAlive(u) && !usedRefs.has(u.ref)) issues.push(issue("unit_not_posted", `living unit '${u.ref}' has no post`, u.ref));
  }

  if (issues.length > 0) return { ok: false, issues: capIssues(issues) };
  return { ok: true, value: normalizeFormation(formation) };
}

/**
 * Canonical ordering: fences by segment, traps and posts by ref (code-unit order). Two
 * formations that place the same things in a different list order normalize to the same
 * value, so their snapshots byte-compare.
 */
export function normalizeFormation(f: Formation): Formation {
  const byRef = <T extends { readonly ref: string }>(a: T, b: T) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
  return Object.freeze({
    v: FORMATION_VERSION,
    fences: Object.freeze([...f.fences].sort((a, b) => a.segment - b.segment).map((p) => Object.freeze({ ref: p.ref, segment: p.segment }))),
    traps: Object.freeze([...f.traps].sort(byRef).map((p) => Object.freeze({ ref: p.ref, cell: Object.freeze({ x: p.cell.x, y: p.cell.y }) }))),
    posts: Object.freeze([...f.posts].sort(byRef).map((p) => Object.freeze({ ref: p.ref, cell: Object.freeze({ x: p.cell.x, y: p.cell.y }), stance: p.stance }))),
  });
}

/** The ring positions a formation leaves open. Informational (chunk 08 shows them); never an error. */
export function formationGaps(f: Formation): readonly number[] {
  const filled = new Set(f.fences.map((p) => p.segment));
  const gaps: number[] = [];
  for (let i = 0; i < TUNABLES.PERIMETER_SEGMENTS; i++) if (!filled.has(i)) gaps.push(i);
  return gaps;
}

export function formationPlacesCell(f: Formation, cell: Cell): boolean {
  return f.traps.some((t) => sameCell(t.cell, cell)) || f.posts.some((p) => sameCell(p.cell, cell));
}
