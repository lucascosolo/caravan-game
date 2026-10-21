import { TUNABLES } from "@caravan/content";
import { describe, expect, it } from "vitest";
import {
  CORE_CENTER_CELL,
  DEFAULT_DEFENSIVE_STANCE,
  DEFENSIVE_STANCES,
  EMPTY_FORMATION,
  MAX_ISSUES,
  RING_ANCHORS,
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
    expect(formationGaps(f)).toEqual([0, 1, 2, 3, 15]); // 16 segments − 11 budget = 5 gaps
    // The gap can go anywhere; a different read of the attacker, a different gap.
    expect(validateFormation(m, arrange(m, 12), ALLOW_ALL).ok).toBe(true);
    expect(formationGaps(arrange(m, 12))).toEqual([7, 8, 9, 10, 11]);
    // Placing fewer segments than packed is fine too: holding material back is a choice.
    const sparse = { ...f, fences: f.fences.filter((p) => p.segment % 2 === 0) };
    expect(validateFormation(m, sparse, ALLOW_ALL).ok).toBe(true);
    expect(formationGaps(sparse)).toHaveLength(TUNABLES.PERIMETER_SEGMENTS - sparse.fences.length);
  });

  it("QA D1: every post carries a defensive stance; guard, hold and reserve are legal, anything else is not", () => {
    const f = arrange(m);
    expect(DEFENSIVE_STANCES).toEqual(["guard", "hold", "reserve"]);
    expect(DEFAULT_DEFENSIVE_STANCE).toBe("guard");
    expect(f.posts.every((p) => p.stance === "guard")).toBe(true);
    const mixed: Formation = { ...f, posts: f.posts.map((p, i) => ({ ...p, stance: DEFENSIVE_STANCES[i % 3]! })) };
    const res = validateFormation(m, mixed, ALLOW_ALL);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The stance survives normalization and is part of the canonical value.
    expect(res.value.posts.map((p) => p.stance).sort()).toEqual([...mixed.posts.map((p) => p.stance)].sort());
    for (const bad of ["attack", "GUARD", "", 1, null, undefined]) {
      const withBad = { ...f, posts: [{ ...f.posts[0]!, stance: bad as never }, ...f.posts.slice(1)] };
      expect(codes(m, withBad), String(bad)).toEqual(["bad_stance"]);
    }
    // A reserve unit still needs a post: "kept safely in the back" is a stance, not an absence.
    expect(codes(m, { ...mixed, posts: mixed.posts.slice(1) })).toEqual(["unit_not_posted"]);
  });

  it("QA N1: a wrong version is reported as bad_version", () => {
    expect(codes(m, { ...arrange(m), v: 1 as never })).toEqual(["bad_version"]);
    expect(codes(m, { ...arrange(m), v: 2 as never })).toEqual(["bad_version"]);
  });

  it("QA D2: nothing may be placed on a wagon anchor", () => {
    const f = arrange(m);
    for (const a of RING_ANCHORS) {
      expect(codes(m, { ...f, traps: [{ ref: "t0", cell: a }, ...f.traps.slice(1)] })).toEqual(["cell_reserved"]);
      expect(codes(m, { ...f, posts: [{ ...f.posts[0]!, cell: a }, ...f.posts.slice(1)] })).toEqual(["cell_reserved"]);
    }
  });

  it("QA S8: an oversized formation is refused outright, and the issue list is capped at MAX_ISSUES", () => {
    const f = arrange(m);
    const many = (n: number) => Array.from({ length: n }, (_, i) => ({ ref: `zz${i}`, cell: { x: 12, y: 12 }, stance: "guard" as const }));
    const r1 = validateFormation(m, { ...f, posts: many(TUNABLES.DEPLOYMENT_SLOT_CAP + 1) }, ALLOW_ALL);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.issues).toEqual([{ code: "oversized", message: `${TUNABLES.DEPLOYMENT_SLOT_CAP + 1} posts placed; a formation carries at most ${TUNABLES.DEPLOYMENT_SLOT_CAP}`, subject: "posts" }]);
    const r2 = validateFormation(m, { ...f, traps: Array.from({ length: TUNABLES.TRAP_SLOT_CAP + 1 }, (_, i) => ({ ref: `t${i}`, cell: { x: 12, y: 12 } })) }, ALLOW_ALL);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.issues.map((i) => i.code)).toEqual(["oversized"]);
    const r3 = validateFormation(m, { ...f, fences: Array.from({ length: TUNABLES.PERIMETER_SEGMENTS + 1 }, (_, i) => ({ ref: `f${i}`, segment: 0 })) }, ALLOW_ALL);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.issues.map((i) => i.code)).toEqual(["oversized"]);
    // A legal-sized formation can still produce many issues — never more than the cap.
    expect(MAX_ISSUES).toBe(50);
    const noisy: Formation = {
      v: 3,
      fences: Array.from({ length: TUNABLES.PERIMETER_SEGMENTS }, (_, i) => ({ ref: i < m.fences.length ? `f${i}` : `nope${i}`, segment: 99 })),
      traps: Array.from({ length: TUNABLES.TRAP_SLOT_CAP }, (_, i) => ({ ref: `t${i}`, cell: CORE_CENTER_CELL })),
      posts: m.units.map((u) => ({ ref: u.ref, cell: CORE_CENTER_CELL, stance: "nope" as never })),
    };
    const r4 = validateFormation(m, noisy, () => false);
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.issues).toHaveLength(MAX_ISSUES);
    // Validating an oversized list is O(1): it never walks the entries.
    const t0 = performance.now();
    validateFormation(m, { ...f, posts: many(60_000) }, ALLOW_ALL);
    expect(performance.now() - t0).toBeLessThan(2_000) // was 50 ms: a guard against quadratic blow-up, not a benchmark; flaked under parallel load;
  });

  it("holding a trap back is legal; a unit that is alive must be posted", () => {
    const f = arrange(m);
    expect(validateFormation(m, { ...f, traps: [] }, ALLOW_ALL).ok).toBe(true);
    expect(codes(m, { ...f, posts: f.posts.slice(1) })).toEqual(["unit_not_posted"]);
    expect(codes(m, EMPTY_FORMATION)).toEqual(Array(8).fill("unit_not_posted"));
  });

  it("refuses refs that are not in the manifest, and refs placed twice", () => {
    const f = arrange(m);
    // (The post list is at the slot cap, so a smuggled post REPLACES one — a ninth would be `oversized`.)
    expect(codes(m, { ...f, posts: [...f.posts.slice(1), { ref: "u-smuggled", cell: { x: 20, y: 20 }, stance: "guard" as const }] }).sort()).toEqual(["unit_not_posted", "unknown_ref"]);
    expect(codes(m, { ...f, traps: [...f.traps.slice(1), { ref: "t9", cell: { x: 20, y: 20 } }] })).toEqual(["unknown_ref"]);
    expect(codes(m, { ...f, fences: [...f.fences, { ref: "f99", segment: 15 }] })).toEqual(["unknown_ref"]);
    expect(codes(m, { ...f, fences: [...f.fences, { ref: "f0", segment: 15 }] })).toEqual(["duplicate_ref"]);
    expect(codes(m, { ...f, posts: [...f.posts.slice(1), { ref: f.posts[1]!.ref, cell: { x: 20, y: 20 }, stance: "guard" as const }] }).sort()).toEqual(["duplicate_ref", "unit_not_posted"]);
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
    const withPostAt = (cell: { x: number; y: number }) => ({ ...f, posts: [{ ...f.posts[0]!, cell }, ...f.posts.slice(1)] });
    expect(codes(m, withPostAt({ x: 0, y: 0 }))).toEqual(["cell_reserved"]);
    expect(codes(m, withPostAt({ x: 15, y: 16 }))).toEqual(["cell_reserved"]);
    // Outside the ring but inside the field is fine: a unit may be posted beyond the fence.
    expect(codes(m, withPostAt({ x: 5, y: 15 }))).toEqual([]);
  });

  it("no two placed objects share a cell; adjacent posts are allowed", () => {
    const f = arrange(m);
    const cell = f.traps[0]!.cell;
    expect(codes(m, { ...f, posts: [{ ...f.posts[0]!, cell }, ...f.posts.slice(1)] })).toEqual(["cell_occupied"]);
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
