import { TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import {
  CORE_CENTER_CELL,
  EMPTY_FORMATION,
  RING_SEGMENTS,
  formationGaps,
  validateFormation,
  type Formation,
  type Manifest,
} from "../src/index.js";
import { ALLOW_ALL, arrange, fullPack, innerCells } from "./fixtures.js";

function codes(m: Manifest, f: Formation, access = ALLOW_ALL): string[] {
  const res = validateFormation(m, f, access);
  return res.ok ? [] : res.issues.map((i) => i.code);
}

describe("formation validation", () => {
  const m = fullPack();

  it("a gapped ring is legal — and with the budget it is the only kind there is", () => {
    const f = arrange(m, 4);
    const res = validateFormation(m, f, ALLOW_ALL);
    expect(res.ok).toBe(true);
    expect(f.fences).toHaveLength(TUNABLES.FENCE_MATERIAL_BUDGET);
    expect(formationGaps(f)).toEqual([0, 1, 2, 3, 24, 25, 26, 27]); // 28 segments − 20 budget = 8 gaps
    // The gap can go anywhere; a different read of the attacker, a different gap.
    expect(validateFormation(m, arrange(m, 20), ALLOW_ALL).ok).toBe(true);
    expect(formationGaps(arrange(m, 20))).toEqual([12, 13, 14, 15, 16, 17, 18, 19]);
    // Placing fewer segments than packed is fine too: holding material back is a choice.
    const sparse = { ...f, fences: f.fences.filter((p) => p.segment % 2 === 0) };
    expect(validateFormation(m, sparse, ALLOW_ALL).ok).toBe(true);
    expect(formationGaps(sparse)).toHaveLength(TUNABLES.PERIMETER_SEGMENTS - sparse.fences.length);
  });

  it("holding a trap back is legal; a unit that is alive must be posted", () => {
    const f = arrange(m);
    expect(validateFormation(m, { ...f, traps: [] }, ALLOW_ALL).ok).toBe(true);
    expect(codes(m, { ...f, posts: f.posts.slice(1) })).toEqual(["unit_not_posted"]);
    expect(codes(m, EMPTY_FORMATION)).toEqual(Array(8).fill("unit_not_posted"));
  });

  it("refuses refs that are not in the manifest, and refs placed twice", () => {
    const f = arrange(m);
    expect(codes(m, { ...f, posts: [...f.posts, { ref: "u-smuggled", cell: { x: 20, y: 20 } }] })).toEqual(["unknown_ref"]);
    expect(codes(m, { ...f, traps: [...f.traps, { ref: "t9", cell: { x: 20, y: 20 } }] })).toEqual(["unknown_ref"]);
    expect(codes(m, { ...f, fences: [...f.fences, { ref: "f99", segment: 31 }] })).toEqual(["unknown_ref"]);
    expect(codes(m, { ...f, fences: [...f.fences, { ref: "f0", segment: 31 }] })).toEqual(["duplicate_ref"]);
    expect(codes(m, { ...f, posts: [...f.posts, { ref: "u-rider", cell: { x: 20, y: 20 } }] })).toEqual(["duplicate_ref"]);
  });

  it("fence segments must be ring positions and must not share one", () => {
    const f = arrange(m);
    const fences = f.fences.map((p, i) => (i === 0 ? { ...p, segment: 32 } : p));
    expect(codes(m, { ...f, fences })).toEqual(["bad_segment"]);
    expect(codes(m, { ...f, fences: f.fences.map((p, i) => (i === 0 ? { ...p, segment: -1 } : p)) })).toEqual(["bad_segment"]);
    expect(codes(m, { ...f, fences: f.fences.map((p, i) => (i === 1 ? { ...p, segment: f.fences[0]!.segment } : p)) })).toEqual(["duplicate_segment"]);
  });

  it("traps and posts must be on the lattice, off the ring, the core and the entry bands", () => {
    const f = arrange(m);
    const withTrapAt = (cell: { x: number; y: number }) => ({ ...f, traps: [{ ref: "t0", cell }, ...f.traps.slice(1)] });
    expect(codes(m, withTrapAt({ x: 32, y: 5 }))).toEqual(["bad_cell"]);
    expect(codes(m, withTrapAt({ x: 5, y: -1 }))).toEqual(["bad_cell"]);
    expect(codes(m, withTrapAt({ x: 5, y: 5.5 }))).toEqual(["bad_cell"]);
    expect(codes(m, withTrapAt(RING_SEGMENTS[3]!.cell))).toEqual(["cell_reserved"]);
    expect(codes(m, withTrapAt(CORE_CENTER_CELL))).toEqual(["cell_reserved"]);
    expect(codes(m, withTrapAt({ x: 15, y: 1 }))).toEqual(["cell_reserved"]);
    expect(codes(m, withTrapAt({ x: 30, y: 15 }))).toEqual(["cell_reserved"]);
    const withPostAt = (cell: { x: number; y: number }) => ({ ...f, posts: [{ ref: f.posts[0]!.ref, cell }, ...f.posts.slice(1)] });
    expect(codes(m, withPostAt({ x: 0, y: 0 }))).toEqual(["cell_reserved"]);
    expect(codes(m, withPostAt({ x: 15, y: 16 }))).toEqual(["cell_reserved"]);
    // Outside the ring but inside the field is fine: a unit may be posted beyond the fence.
    expect(codes(m, withPostAt({ x: 5, y: 15 }))).toEqual([]);
  });

  it("no two placed objects share a cell; adjacent posts are allowed", () => {
    const f = arrange(m);
    const cell = f.traps[0]!.cell;
    expect(codes(m, { ...f, posts: [{ ref: f.posts[0]!.ref, cell }, ...f.posts.slice(1)] })).toEqual(["cell_occupied"]);
    expect(codes(m, { ...f, traps: [{ ref: "t1", cell }, ...f.traps.filter((t) => t.ref !== "t1" && t.ref !== "t0"), f.traps[0]!] })).toEqual(["cell_occupied"]);
    const cells = innerCells();
    const adjacent = { ...f, posts: f.posts.map((p, i) => ({ ...p, cell: cells[i]! })), traps: f.traps.map((t, i) => ({ ...t, cell: cells[8 + i]! })) };
    expect(codes(m, adjacent)).toEqual([]);
  });

  it("every placed type passes the access seam again at the placement boundary", () => {
    const f = arrange(m);
    const noVaquero = (id: string) => id !== "desert.vaquero";
    const res = validateFormation(m, f, noVaquero);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.issues).toEqual([{ code: "type_locked", message: "living-unit type 'desert.vaquero' is not unlocked", subject: "desert.vaquero" }]);
    expect(codes(m, f, (id) => id !== "trap.tar_pot")).toEqual(["type_locked"]);
    expect(codes(m, f, (id) => id !== "fence.brush_pile")).toEqual(Array(TUNABLES.FENCE_MATERIAL_BUDGET).fill("type_locked"));
  });

  it("a validated formation comes back in canonical order", () => {
    const f = arrange(m);
    const shuffled = { ...f, fences: [...f.fences].reverse(), traps: [...f.traps].reverse(), posts: [...f.posts].reverse() };
    const res = validateFormation(m, shuffled, ALLOW_ALL);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fences.map((p) => p.segment)).toEqual([...res.value.fences.map((p) => p.segment)].sort((a, b) => a - b));
    expect(res.value.posts.map((p) => p.ref)).toEqual([...res.value.posts.map((p) => p.ref)].sort());
    expect(Object.isFrozen(res.value)).toBe(true);
  });
});
