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
 *   - where each living unit is posted. Its post is a lattice cell: the fixed origin its
 *     aggro radius and leash are measured from during the fight.
 *
 * There is no stance field on a post. The only stances the design defines are the three
 * targeting stances of the ATTACKING party (chunk 09); a posted unit's behaviour is
 * aggro/leash around its post (chunk 11).
 */
import { FIXED_POINT_SCALE, TUNABLES } from "@caravan/content";
import { issue, type Issue, type Validation } from "./issues.js";
import {
  cellDistSq,
  cellKey,
  isAnyEntryCell,
  isCell,
  isCoreCell,
  isRingCell,
  isRingSegmentIndex,
  sameCell,
  type Cell,
} from "./lattice.js";
import { isFenceIntact, isUnitAlive, type AccessCheck, type Manifest } from "./manifest.js";

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
}

export interface Formation {
  readonly v: 1;
  readonly fences: readonly FencePlacement[];
  readonly traps: readonly TrapPlacement[];
  readonly posts: readonly PostPlacement[];
}

export const FORMATION_VERSION = 1 as const;

export const EMPTY_FORMATION: Formation = Object.freeze({
  v: FORMATION_VERSION,
  fences: Object.freeze([]),
  traps: Object.freeze([]),
  posts: Object.freeze([]),
});

/** Minimum squared post separation, in cells² (MIN_POST_DISTANCE is Fixed cells). */
const MIN_POST_DIST_SQ_CELLS: number = (() => {
  // Posts are whole cells, so the threshold is compared in whole cells (truncated).
  const d = Math.trunc(TUNABLES.MIN_POST_DISTANCE / FIXED_POINT_SCALE);
  return d * d;
})();

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
    return { ok: false, issues: [issue("bad_count", `unsupported formation version ${String(formation.v)}`)] };
  }
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
    if (isRingCell(cell) || isCoreCell(cell) || isAnyEntryCell(cell)) {
      issues.push(issue("cell_reserved", `'${ref}' may not be placed on the fence ring, the core or an entry band`, ref));
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

  if (issues.length > 0) return { ok: false, issues };
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
    posts: Object.freeze([...f.posts].sort(byRef).map((p) => Object.freeze({ ref: p.ref, cell: Object.freeze({ x: p.cell.x, y: p.cell.y }) }))),
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
