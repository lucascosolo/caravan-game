/**
 * Chunk 13 QA round 1 — DEPTH_METRIC from the ring line (D1) and "depth 1024 ⇔ an overrun" (S2).
 *   - D1: depth is the share of the ring-to-core distance (RING_SPAN, Chebyshev to the core
 *     block) the deepest raider closed; a raider that never crossed the ring line contributes 0.
 *   - S2: a raider is sampled only at the end of a tick it ends alive, or on its arrival tick —
 *     a dash its own traps kill on a core cell never counts as reaching the core.
 * Every whole fight named here is also a golden (test/fixtures.ts → packages/resolver/golden).
 */
import { describe, expect, it } from "vitest";
import { CORE_ORIGIN, CORE_SIZE, DEPTH_SCALE, FIXED_POINT_SCALE, PERIMETER_RING_RADIUS, RING_SEGMENTS, RING_SPAN, coreDistCheb, resolve, unitDepth, type UnitState } from "../src/index.js";
import { clone, scenarios } from "./fixtures.js";

const S = FIXED_POINT_SCALE;
const depthAt = (closest: number) => unitDepth({ coreClosest: closest } as UnitState);
const byName = (name: string) => resolve(clone(scenarios().find((s) => s.name === name)!.input));

describe("D1: DEPTH_METRIC is measured from the ring line", () => {
  it("RING_SPAN is the Chebyshev distance from the core block to the ring's outer edge, the same on all four sides", () => {
    expect(RING_SPAN).toBe((PERIMETER_RING_RADIUS - Math.trunc(CORE_SIZE / 2)) * S);
    expect(RING_SPAN).toBe(3 * S);
    // The outer edge of every ring cell, on its outward side, is exactly RING_SPAN from the core block.
    for (const seg of RING_SEGMENTS) {
      const out = seg.edge === "north" ? { x: seg.cell.x * S + S / 2, y: seg.cell.y * S } : seg.edge === "south" ? { x: seg.cell.x * S + S / 2, y: (seg.cell.y + 1) * S - 1 } : seg.edge === "west" ? { x: seg.cell.x * S, y: seg.cell.y * S + S / 2 } : { x: (seg.cell.x + 1) * S - 1, y: seg.cell.y * S + S / 2 };
      expect(coreDistCheb(out.x, out.y), `segment ${seg.index}`).toBe(RING_SPAN);
    }
    expect(coreDistCheb(CORE_ORIGIN.x * S, CORE_ORIGIN.y * S)).toBe(0);
  });

  it("outside or on the ring line → 0; half way to the core → 512; on the core → 1024; monotone", () => {
    expect(depthAt(20 * S)).toBe(0);
    expect(depthAt(RING_SPAN + 1)).toBe(0);
    expect(depthAt(RING_SPAN)).toBe(0);
    expect(depthAt(RING_SPAN - 1)).toBe(0); // floor(1024 × 1 / 3072)
    expect(depthAt(RING_SPAN / 2)).toBe(512);
    expect(depthAt(S / 2)).toBe(Math.floor((DEPTH_SCALE * (RING_SPAN - S / 2)) / RING_SPAN)); // standing in a ring gap's inner neighbour
    expect(depthAt(0)).toBe(DEPTH_SCALE);
    let prev = -1;
    for (let d = RING_SPAN + 10; d >= 0; d -= 7) {
      const v = depthAt(d);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("a party held at a sealed ring (never inside the ring line) has depth 0", () => {
    const out = byName("c13-stalemate-deep-but-not-in");
    expect(out.outcome).toMatchObject({ kind: "stalemate", depth: 0, deepestUnit: -1 });
  });

  it("the corpus: every overrun is 1024, nothing else is; a held fight's depth tells inside from outside the ring", () => {
    const held: number[] = [];
    for (const { name, input } of scenarios()) {
      const o = resolve(clone(input));
      if (o.outcome.kind === "caravan_overrun") expect(o.outcome.depth, name).toBe(DEPTH_SCALE);
      else expect(o.outcome.depth, name).toBeLessThan(DEPTH_SCALE);
      if (o.outcome.kind === "caravan_held") held.push(o.outcome.depth);
    }
    expect(held.length).toBeGreaterThan(5);
    expect(held.some((d) => d === 0)).toBe(true); // some parties were wiped before the ring line
  });
});

describe("S2: a raider that died before arriving never reports the core", () => {
  it("qa12-dash-over-trap-onto-core: the dash ends on a core cell, its traps kill it — held, depth below 1024, no core_reached", () => {
    const out = byName("qa12-dash-over-trap-onto-core");
    expect(out.outcome.kind).toBe("caravan_held");
    expect(out.outcome.depth).toBeLessThan(DEPTH_SCALE);
    expect(out.log.some((e) => e.k === "core_reached")).toBe(false);
    const dasher = out.units.find((u) => u.side === "attacker")!;
    expect(dasher.alive).toBe(false);
    // Its depth is taken where its traps stopped it, not at the dash end on the core.
    const lethal = out.log.filter((e) => e.k === "trap_fired" && e.u === dasher.id && e.hp === 0);
    expect(lethal).toHaveLength(1);
    const trap = out.traps[(lethal[0] as { i: number }).i]!;
    expect(out.outcome.depth).toBe(depthAt(coreDistCheb(trap.x, trap.y)));
    expect(out.outcome.depth).toBeGreaterThan(0);
    expect(coreDistCheb(dasher.x, dasher.y)).toBe(0); // it lies on the core — and still did not arrive
  });

  it("qa12-dash-over-trap-tick-cap: the same on the cap tick — held, below 1024", () => {
    const out = byName("qa12-dash-over-trap-tick-cap");
    expect(out.outcome.kind).toBe("caravan_held");
    expect(out.outcome.depth).toBeLessThan(DEPTH_SCALE);
  });

  it("an arrival and a death on the same tick is still an overrun at 1024 (c13-overrun-and-wipe-same-tick)", () => {
    expect(byName("c13-overrun-and-wipe-same-tick").outcome).toMatchObject({ kind: "caravan_overrun", depth: DEPTH_SCALE });
  });
});
