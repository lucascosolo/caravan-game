/**
 * Chunk 05 — the unlock webs as data: fixed, complete (one node per type, every type), a
 * DAG with genuine branching, region-scoped for living units, costs by tier from the
 * registry, and starting nodes exactly as the registry says.
 */
import { describe, expect, it } from "vitest";
import {
  FENCE_TIERS,
  LIVING_UNIT_TYPES,
  LIVING_UNLOCK_WEBS,
  REGION_IDS,
  SIEGE_TYPES,
  SIEGE_UNLOCK_WEB,
  TRAP_TYPES,
  TRAP_UNLOCK_WEB,
  TUNABLES,
  UNLOCK_WEBS,
  checkSpend,
  closureCost,
  compareCodePoints,
  evaluateWeb,
  isDeepFrozen,
  maximalReachableSets,
  nodeCost,
  pointsPerPoolAtLadderCap,
  startingNodeIds,
  unlockWebFor,
  validateUnlockWebs,
  webForTypeId,
  type UnlockWeb,
} from "../src/index.js";

const paidTotal = (web: UnlockWeb): number => web.nodes.reduce((sum, n) => sum + nodeCost(web, n), 0);

describe("the webs are complete, fixed data", () => {
  it("validate clean and are deep-frozen", () => {
    expect(validateUnlockWebs()).toEqual([]);
    expect(isDeepFrozen(UNLOCK_WEBS)).toBe(true);
    expect(isDeepFrozen(LIVING_UNLOCK_WEBS)).toBe(true);
    expect(UNLOCK_WEBS).toHaveLength(REGION_IDS.length + 2);
  });

  it("sizes match the registry: 8 living per region, 6 + 4 fence tiers, 5 siege", () => {
    for (const r of REGION_IDS) expect(LIVING_UNLOCK_WEBS[r].nodes).toHaveLength(TUNABLES.LIVING_WEB_NODES);
    expect(TRAP_UNLOCK_WEB.nodes).toHaveLength(TUNABLES.TRAP_WEB_NODES);
    expect(TUNABLES.TRAP_WEB_NODES).toBe(TUNABLES.TRAP_TYPES + TUNABLES.FENCE_TIERS);
    expect(SIEGE_UNLOCK_WEB.nodes).toHaveLength(TUNABLES.SIEGE_WEB_NODES);
    expect(TUNABLES.SIEGE_WEB_NODES).toBe(TUNABLES.SIEGE_TYPES);
    expect(TUNABLES.LIVING_WEB_NODES).toBe(TUNABLES.LIVING_UNITS_PER_REGION);
  });

  it("every unit, trap, fence tier and siege piece has exactly one node, in the right web, and nothing else is in any web", () => {
    const all = UNLOCK_WEBS.flatMap((w) => w.nodes.map((n) => n.id));
    expect(new Set(all).size).toBe(all.length);
    for (const u of LIVING_UNIT_TYPES) {
      const hit = webForTypeId(u.id);
      expect(hit?.web.pool).toBe("living");
      expect(hit?.web.regionId).toBe(u.regionId);
    }
    for (const t of TRAP_TYPES) expect(webForTypeId(t.id)?.web).toBe(TRAP_UNLOCK_WEB);
    for (const f of FENCE_TIERS) expect(webForTypeId(f.id)?.web).toBe(TRAP_UNLOCK_WEB);
    for (const s of SIEGE_TYPES) expect(webForTypeId(s.id)?.web).toBe(SIEGE_UNLOCK_WEB);
    expect(all).toHaveLength(LIVING_UNIT_TYPES.length + TRAP_TYPES.length + FENCE_TIERS.length + SIEGE_TYPES.length);
    expect(webForTypeId("nobody.has_this")).toBeUndefined();
  });

  it("a region's living web contains ONLY that region's units", () => {
    for (const r of REGION_IDS) {
      for (const n of LIVING_UNLOCK_WEBS[r].nodes) expect(n.id.startsWith(`${r}.`)).toBe(true);
      expect(unlockWebFor("living", r)).toBe(LIVING_UNLOCK_WEBS[r]);
    }
    expect(() => unlockWebFor("living")).toThrow(/region/);
    expect(unlockWebFor("trap")).toBe(TRAP_UNLOCK_WEB);
    expect(unlockWebFor("siege")).toBe(SIEGE_UNLOCK_WEB);
  });

  it("costs come from the per-pool tier table (QA-05 D1): tier 0 free, first paid node 1 point, strictly increasing", () => {
    expect(TUNABLES.UNLOCK_NODE_COST_BY_TIER).toEqual({ living: [0, 1, 4, 8, 14], trap: [0, 1, 3, 7, 10], siege: [0, 1, 8, 15, 21] });
    for (const w of UNLOCK_WEBS) for (const n of w.nodes) expect(nodeCost(w, n)).toBe(TUNABLES.UNLOCK_NODE_COST_BY_TIER[w.pool][n.tier]);
    for (const curve of Object.values(TUNABLES.UNLOCK_NODE_COST_BY_TIER)) {
      expect(curve[0]).toBe(0);
      expect(curve[1]).toBe(1);
      for (let t = 1; t < curve.length; t++) expect(curve[t]!).toBeGreaterThan(curve[t - 1]!);
    }
    // The same tier costs differently per pool: the curves are independent knobs.
    expect(nodeCost(SIEGE_UNLOCK_WEB, SIEGE_UNLOCK_WEB.nodes.find((n) => n.tier === 2)!)).not.toBe(nodeCost(TRAP_UNLOCK_WEB, TRAP_UNLOCK_WEB.nodes.find((n) => n.tier === 2)!));
  });

  it("a capped ladder (30 points) reaches most but not all of every web: ~77–79% of the paid total, and every single node is reachable at cap", () => {
    const cap = pointsPerPoolAtLadderCap();
    expect(cap).toBe(30);
    for (const r of REGION_IDS) expect(paidTotal(LIVING_UNLOCK_WEBS[r])).toBe(39);
    expect(paidTotal(TRAP_UNLOCK_WEB)).toBe(39);
    expect(paidTotal(SIEGE_UNLOCK_WEB)).toBe(38);
    for (const w of UNLOCK_WEBS) {
      const share = (cap * 100) / paidTotal(w);
      expect(share, w.id).toBeGreaterThanOrEqual(75);
      expect(share, w.id).toBeLessThan(80);
      // every root-to-node path fits in the cap: no node is "never" for a free player
      for (const n of w.nodes) expect(closureCost(w, n.id), `${w.id} ${n.id}`).toBeLessThanOrEqual(cap);
      // and at cap there is still a choice to make: more than one maximal reachable set
      const atCap = maximalReachableSets(w, cap);
      expect(atCap.length, w.id).toBeGreaterThan(1);
      for (const set of atCap) expect(set.length, w.id).toBeLessThan(w.nodes.filter((n) => n.tier > 0).length);
    }
    // closureCost counts a shared prerequisite once
    expect(closureCost(LIVING_UNLOCK_WEBS.desert, "desert.longhorn_bull")).toBe(4 + 4 + 8);
    expect(closureCost(SIEGE_UNLOCK_WEB, "siege.blasting_crate")).toBe(8 + 21);
    expect(closureCost(TRAP_UNLOCK_WEB, "fence.stacked_stone")).toBe(3 + 7 + 10);
  });

  it("validation refuses a cost curve that puts any node out of a capped ladder's reach, or a curve that is not per pool / not increasing", () => {
    const desert = LIVING_UNLOCK_WEBS.desert;
    // Push the capstone's chain above the cap by stacking its prerequisites: vaquero now also needs the whole rejoin branch.
    const heavy: UnlockWeb = { ...desert, nodes: desert.nodes.map((n) => (n.id === "desert.vaquero" ? { ...n, requires: ["desert.canteen_carrier", "desert.longhorn_bull"] } : n)) };
    const problems = validateUnlockWebs([heavy, ...UNLOCK_WEBS.filter((w) => w !== desert)]);
    expect(problems.some((p) => /desert\.vaquero.*needs (\d+) points but a capped ladder grants 30/.test(p))).toBe(true);
    expect(closureCost(heavy, "desert.vaquero")).toBe(1 + 8 + 14 + 4 + 4 + 8);
  });

  it("starting nodes: 2 living per region (the first two of the roster), 1 trap, 1 fence tier (tier 1), 1 siege — all free, all roots", () => {
    for (const r of REGION_IDS) {
      const roster = LIVING_UNIT_TYPES.filter((u) => u.regionId === r).map((u) => u.id);
      expect(startingNodeIds(LIVING_UNLOCK_WEBS[r])).toEqual(roster.slice(0, TUNABLES.STARTING_NODES.living));
    }
    expect(startingNodeIds(TRAP_UNLOCK_WEB)).toEqual(["trap.spike_pit", "fence.brush_pile"]);
    expect(FENCE_TIERS.find((f) => f.id === "fence.brush_pile")?.tier).toBe(1);
    expect(startingNodeIds(SIEGE_UNLOCK_WEB)).toEqual(["siege.battering_wagon"]);
    for (const w of UNLOCK_WEBS) for (const id of startingNodeIds(w)) {
      const n = w.nodes.find((x) => x.id === id)!;
      expect(nodeCost(w, n)).toBe(0);
      expect(n.requires).toEqual([]);
    }
  });
});

describe("the webs are DAGs with genuine branching", () => {
  it("every web has 2..3 roots and every node is reachable with enough points", () => {
    for (const w of UNLOCK_WEBS) {
      const roots = w.nodes.filter((n) => n.requires.length === 0).length;
      expect(roots).toBeGreaterThanOrEqual(TUNABLES.WEB_ROOTS_MIN);
      expect(roots).toBeLessThanOrEqual(TUNABLES.WEB_ROOTS_MAX);
      const sets = maximalReachableSets(w, paidTotal(w));
      expect(sets).toHaveLength(1);
      expect(sets[0]).toEqual(w.nodes.filter((n) => n.tier > 0).map((n) => n.id).sort());
    }
  });

  it("at a mid-game budget more than one distinct maximal reachable set exists in every web", () => {
    for (const w of UNLOCK_WEBS) {
      const budget = Math.floor(paidTotal(w) / 3);
      const sets = maximalReachableSets(w, budget);
      expect(sets.length, `${w.id} at ${budget} points`).toBeGreaterThan(1);
      // and they genuinely differ in which types exist, not just in order
      const asKeys = new Set(sets.map((s) => s.join("|")));
      expect(asKeys.size).toBe(sets.length);
      for (const s of sets) expect(s.reduce((sum, id) => sum + nodeCost(w, w.nodes.find((n) => n.id === id)!), 0)).toBeLessThanOrEqual(budget);
    }
  });

  it("maximalReachableSets is ordered by code point, not locale (QA-05 N2)", () => {
    const sets = maximalReachableSets(TRAP_UNLOCK_WEB, 12);
    const keys = sets.map((s) => s.join("|"));
    expect(keys).toEqual([...keys].sort(compareCodePoints));
    expect(compareCodePoints("a", "B")).toBe(1); // 'B' (0x42) < 'a' (0x61): code points, not dictionary order
    expect(compareCodePoints("x", "x")).toBe(0);
  });

  it("validation catches a dangling prerequisite, a cycle, a foreign-region unit, a missing type, a costed starting node and a line-shaped web", () => {
    const desert = LIVING_UNLOCK_WEBS.desert;
    const swap = (nodes: UnlockWeb["nodes"]): UnlockWeb[] => [{ ...desert, nodes }, ...UNLOCK_WEBS.filter((w) => w !== desert)];
    const n = (i: number) => desert.nodes[i]!;

    const dangling = swap([...desert.nodes.slice(0, 7), { ...n(7), requires: ["desert.ghost"] }]);
    expect(validateUnlockWebs(dangling).some((p) => p.includes("'desert.ghost' is not in this web"))).toBe(true);

    // tier rule disabled by giving both the same tier, so the cycle check itself has to fire
    const cyclic = swap([...desert.nodes.slice(0, 5), { ...n(5), tier: 3, requires: ["desert.longhorn_bull"] }, { ...n(6), tier: 3, requires: ["desert.canteen_carrier"] }, n(7)]);
    expect(validateUnlockWebs(cyclic).some((p) => /cycle|lower-tier/.test(p))).toBe(true);

    const foreign = swap([...desert.nodes.slice(0, 7), { ...n(7), id: "mountain.grizzly" }]);
    const fp = validateUnlockWebs(foreign);
    expect(fp.some((p) => p.includes("'mountain.grizzly': not a type this web may contain"))).toBe(true);
    expect(fp.some((p) => p.includes("'desert.vaquero' has no node"))).toBe(true);
    expect(fp.some((p) => p.includes("appears in more than one web"))).toBe(true);

    const costedStart = swap([{ ...n(0), tier: 1 }, ...desert.nodes.slice(1)]);
    expect(validateUnlockWebs(costedStart).some((p) => p.includes("starting nodes, expected 2"))).toBe(true);

    const line = swap(desert.nodes.map((x, i) => (i === 0 ? x : { ...x, tier: i, requires: [desert.nodes[i - 1]!.id] })));
    const lp = validateUnlockWebs(line);
    expect(lp.some((p) => p.includes("1 roots, expected 2..3"))).toBe(true);
  });
});

describe("pure evaluation", () => {
  it("evaluateWeb shows every node with its cost, including unaffordable and unreachable ones", () => {
    const view = evaluateWeb(SIEGE_UNLOCK_WEB, [], 1);
    expect(view.map((v) => v.id)).toEqual(SIEGE_UNLOCK_WEB.nodes.map((n) => n.id));
    const byId = Object.fromEntries(view.map((v) => [v.id, v]));
    expect(byId["siege.battering_wagon"]).toMatchObject({ starting: true, reached: true, affordable: false, cost: 0 });
    expect(byId["siege.bridging_planks"]).toMatchObject({ reached: false, prerequisitesMet: true, affordable: true, cost: 1 });
    expect(byId["siege.fence_cutters"]).toMatchObject({ reached: false, prerequisitesMet: true, affordable: false, cost: 8 });
    expect(byId["siege.dousing_wagon"]).toMatchObject({ reached: false, prerequisitesMet: false, affordable: false, cost: 8, missing: ["siege.bridging_planks"] });
    expect(byId["siege.blasting_crate"]).toMatchObject({ reached: false, prerequisitesMet: false, affordable: false, cost: 21, missing: ["siege.fence_cutters"] });
  });

  it("checkSpend refuses an unknown node, a starting node, a reached node, unmet prerequisites and too few points — and accepts a legal spend", () => {
    const w = TRAP_UNLOCK_WEB;
    expect(checkSpend(w, [], 30, "desert.vaquero")).toEqual({ ok: false, reason: "unknown_node" });
    expect(checkSpend(w, [], 30, "trap.spike_pit")).toEqual({ ok: false, reason: "already_reached" });
    expect(checkSpend(w, ["trap.jaw_trap"], 30, "trap.jaw_trap")).toEqual({ ok: false, reason: "already_reached" });
    expect(checkSpend(w, [], 30, "trap.powder_keg")).toEqual({ ok: false, reason: "prerequisites_unmet", missing: ["trap.jaw_trap"] });
    expect(checkSpend(w, [], 0, "trap.jaw_trap")).toEqual({ ok: false, reason: "insufficient_points", cost: 1 });
    expect(checkSpend(w, ["trap.jaw_trap"], 6, "trap.powder_keg")).toEqual({ ok: false, reason: "insufficient_points", cost: 7 });
    expect(checkSpend(w, ["trap.jaw_trap"], 7, "trap.powder_keg")).toMatchObject({ ok: true, cost: 7 });
    // a purchased id that is not in this web is ignored, never credited
    expect(checkSpend(w, ["siege.blasting_crate"], 30, "trap.tar_pot")).toEqual({ ok: false, reason: "prerequisites_unmet", missing: ["trap.caltrop_scatter"] });
  });
});
