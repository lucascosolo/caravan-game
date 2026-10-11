/**
 * The three unlock webs (chunk 05) — THE only access gate in the game (GUARDRAILS §3).
 *
 * A node's id IS the type id it grants access to (`desert.vaquero`, `trap.powder_keg`,
 * `fence.split_rail`, `siege.fence_cutters`): one node per type, nothing else in the web.
 * Reaching a node grants ACCESS to recruit / deploy that type. It never grants an instance
 * (that is chunk 18's job) — nothing in this file knows what an instance is.
 *
 * Fixed, authored, visible data: nothing here is generated, discovered or randomized per
 * player. The whole web, including unaffordable nodes, is what the client reads.
 *
 * Scope (GUARDRAILS §5): the living web is CARAVAN-level and region-specific — a caravan's
 * web holds only its region's living units. The trap web (traps AND fence tiers) and the
 * siege web are ACCOUNT-level. The server's access check reads them on exactly those rows.
 *
 * Shape: each web is a DAG with WEB_ROOTS_MIN..MAX roots. `requires` lists prerequisite
 * node ids, ALL of which must be reached first. Tier 0 nodes are the STARTING nodes —
 * reached free at creation, never purchased. Cost is a pure function of tier
 * (UNLOCK_NODE_COST_BY_TIER); nothing per node, nothing per player.
 */
import { deepFreeze } from "./freeze.js";
import { FENCE_TIERS } from "./fences.js";
import { REGION_IDS, isRegionId, type RegionId } from "./regions.js";
import { SIEGE_TYPES } from "./siege.js";
import { TRAP_TYPES } from "./traps.js";
import { TUNABLES } from "./tunables.js";
import { LIVING_UNIT_TYPES } from "./units.js";

/** The three pools, exactly as pool_progress and the ledger name them. */
export const UNLOCK_POOLS = deepFreeze(["living", "trap", "siege"] as const);
export type UnlockPool = (typeof UNLOCK_POOLS)[number];

export function isUnlockPool(value: unknown): value is UnlockPool {
  return typeof value === "string" && (UNLOCK_POOLS as readonly string[]).includes(value);
}

export interface UnlockNode {
  /** The type id this node grants access to. Unique within its web and across all webs. */
  readonly id: string;
  /** 0 = starting node (free, reached at creation); 1..UNLOCK_WEB_TIERS are paid. */
  readonly tier: number;
  /** Node ids that must ALL be reached before this one can be. Empty = a root. */
  readonly requires: readonly string[];
}

export interface UnlockWeb {
  /** `living.<region>`, `trap`, or `siege`. */
  readonly id: string;
  readonly pool: UnlockPool;
  /** Set for living webs only. */
  readonly regionId: RegionId | null;
  readonly nodes: readonly UnlockNode[];
}

const node = (id: string, tier: number, requires: readonly string[] = []): UnlockNode => ({ id, tier, requires });

// ── Living webs: one per region, 8 nodes, 3 roots (2 free + 1 paid), two tier-2 branches
// that rejoin at a tier-3 node, and a tier-4 capstone behind the region's tier-3 specialist.
function livingWeb(regionId: RegionId, nodes: readonly UnlockNode[]): UnlockWeb {
  return { id: `living.${regionId}`, pool: "living", regionId, nodes };
}

export const LIVING_UNLOCK_WEBS: Readonly<Record<RegionId, UnlockWeb>> = deepFreeze({
  desert: livingWeb("desert", [
    node("desert.dust_rider", 0),
    node("desert.well_digger", 0),
    node("desert.sand_sharpshooter", 1),
    node("desert.coyote_pack", 2, ["desert.dust_rider"]),
    node("desert.powder_monkey", 2, ["desert.well_digger"]),
    node("desert.canteen_carrier", 3, ["desert.sand_sharpshooter"]),
    node("desert.longhorn_bull", 3, ["desert.coyote_pack", "desert.powder_monkey"]),
    node("desert.vaquero", 4, ["desert.canteen_carrier"]),
  ]),
  high_plains: livingWeb("high_plains", [
    node("high_plains.homesteader", 0),
    node("high_plains.prairie_wolf", 0),
    node("high_plains.drover", 1),
    node("high_plains.buffalo_bull", 2, ["high_plains.prairie_wolf"]),
    node("high_plains.railroad_gang", 2, ["high_plains.homesteader"]),
    node("high_plains.prairie_doctor", 3, ["high_plains.drover"]),
    node("high_plains.buffalo_hunter", 3, ["high_plains.buffalo_bull", "high_plains.railroad_gang"]),
    node("high_plains.shotgun_messenger", 4, ["high_plains.prairie_doctor"]),
  ]),
  mountain: livingWeb("mountain", [
    node("mountain.grizzly", 0),
    node("mountain.trapper", 0),
    node("mountain.hardrock_miner", 1),
    node("mountain.mountain_lion", 2, ["mountain.grizzly"]),
    node("mountain.lumberjack", 2, ["mountain.trapper"]),
    node("mountain.apothecary", 3, ["mountain.hardrock_miner"]),
    node("mountain.blasting_crew", 3, ["mountain.mountain_lion", "mountain.lumberjack"]),
    node("mountain.pack_mule_train", 4, ["mountain.apothecary"]),
  ]),
  badlands: livingWeb("badlands", [
    node("badlands.gunslinger", 0),
    node("badlands.bounty_hunter", 0),
    node("badlands.claim_jumper", 1),
    node("badlands.rattlesnake_den", 2, ["badlands.gunslinger"]),
    node("badlands.vulture_flock", 2, ["badlands.bounty_hunter"]),
    node("badlands.snake_oil_peddler", 3, ["badlands.claim_jumper"]),
    node("badlands.powder_thief", 3, ["badlands.rattlesnake_den", "badlands.vulture_flock"]),
    node("badlands.rail_bull", 4, ["badlands.snake_oil_peddler"]),
  ]),
});

// ── Trap web (account-level): 6 traps + 4 fence tiers. Three roots: the starting trap, the
// starting fence tier, and a paid groundwork trap. Fence tiers form a chain (each tier
// behind the previous); the powder traps sit behind the groundwork ones.
export const TRAP_UNLOCK_WEB: UnlockWeb = deepFreeze({
  id: "trap",
  pool: "trap",
  regionId: null,
  nodes: [
    node("trap.spike_pit", 0),
    node("fence.brush_pile", 0),
    node("trap.tripwire_snare", 1),
    node("trap.jaw_trap", 1, ["trap.spike_pit"]),
    node("trap.caltrop_scatter", 2, ["trap.tripwire_snare"]),
    node("fence.split_rail", 2, ["fence.brush_pile"]),
    node("trap.powder_keg", 3, ["trap.jaw_trap"]),
    node("trap.tar_pot", 3, ["trap.caltrop_scatter"]),
    node("fence.barbed_wire", 3, ["fence.split_rail"]),
    node("fence.stacked_stone", 4, ["fence.barbed_wire"]),
  ],
});

// ── Siege web (account-level): 5 pieces, two roots (the starting timber ram and a paid
// groundwork bypass), each opening a tier-2 branch (wire cutters behind the ram, the powder
// douser behind the planks), and the stone breaker as the capstone behind the cutters.
export const SIEGE_UNLOCK_WEB: UnlockWeb = deepFreeze({
  id: "siege",
  pool: "siege",
  regionId: null,
  nodes: [
    node("siege.battering_wagon", 0),
    node("siege.bridging_planks", 1),
    node("siege.fence_cutters", 2, ["siege.battering_wagon"]),
    node("siege.dousing_wagon", 2, ["siege.bridging_planks"]),
    node("siege.blasting_crate", 4, ["siege.fence_cutters"]),
  ],
});

/** Every web, in one diffable list: the four living webs, then trap, then siege. */
export const UNLOCK_WEBS: readonly UnlockWeb[] = deepFreeze([
  ...REGION_IDS.map((r) => LIVING_UNLOCK_WEBS[r]),
  TRAP_UNLOCK_WEB,
  SIEGE_UNLOCK_WEB,
]);

// ---------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------

/** The web for a pool; the living pool needs the caravan's region. */
export function unlockWebFor(pool: UnlockPool, regionId?: RegionId | null): UnlockWeb {
  if (pool === "trap") return TRAP_UNLOCK_WEB;
  if (pool === "siege") return SIEGE_UNLOCK_WEB;
  if (!isRegionId(regionId)) throw new RangeError(`the living web is region-scoped; got region '${String(regionId)}'`);
  return LIVING_UNLOCK_WEBS[regionId];
}

export function findUnlockNode(web: UnlockWeb, nodeId: string): UnlockNode | undefined {
  return web.nodes.find((n) => n.id === nodeId);
}

/** Unlock points to reach a node: a function of its tier only. Starting nodes cost 0. */
export function nodeCost(node: UnlockNode): number {
  const cost = TUNABLES.UNLOCK_NODE_COST_BY_TIER[node.tier];
  if (cost === undefined) throw new RangeError(`node '${node.id}' has tier ${node.tier} outside the cost table`);
  return cost;
}

/** Starting nodes are tier 0: reached at creation, never purchased. */
export function isStartingNode(node: UnlockNode): boolean {
  return node.tier === 0;
}

export function startingNodeIds(web: UnlockWeb): readonly string[] {
  return web.nodes.filter(isStartingNode).map((n) => n.id);
}

/**
 * Which web (and node) a TYPE id belongs to. A living type resolves to its own region's
 * web only — a desert caravan's access check can never find `mountain.grizzly` because the
 * desert web does not contain it.
 */
export function webForTypeId(typeId: string): { web: UnlockWeb; node: UnlockNode } | undefined {
  for (const web of UNLOCK_WEBS) {
    const node = findUnlockNode(web, typeId);
    if (node) return { web, node };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// Pure evaluation: what a player sees, and whether a spend is legal. The server calls
// these with the reached set it read from the ledger; the client renders the result.
// ---------------------------------------------------------------------------------------

export interface UnlockNodeView {
  readonly id: string;
  readonly tier: number;
  readonly cost: number;
  readonly requires: readonly string[];
  readonly starting: boolean;
  /** Reached: a starting node, or purchased. Access exists. */
  readonly reached: boolean;
  /** Every prerequisite is reached. */
  readonly prerequisitesMet: boolean;
  /** Not reached, prerequisites met, and the cost fits the available points. */
  readonly affordable: boolean;
  /** Prerequisites not yet reached (empty when met). */
  readonly missing: readonly string[];
}

/** The full reached set: starting nodes plus whatever was purchased. */
export function reachedSet(web: UnlockWeb, purchased: Iterable<string>): ReadonlySet<string> {
  const set = new Set<string>(startingNodeIds(web));
  for (const id of purchased) if (findUnlockNode(web, id)) set.add(id);
  return set;
}

/** Every node, with its cost and state — unaffordable and unreachable nodes included. */
export function evaluateWeb(web: UnlockWeb, purchased: Iterable<string>, availablePoints: number): UnlockNodeView[] {
  const reached = reachedSet(web, purchased);
  return web.nodes.map((n) => {
    const missing = n.requires.filter((r) => !reached.has(r));
    const isReached = reached.has(n.id);
    const cost = nodeCost(n);
    return {
      id: n.id,
      tier: n.tier,
      cost,
      requires: n.requires,
      starting: isStartingNode(n),
      reached: isReached,
      prerequisitesMet: missing.length === 0,
      affordable: !isReached && missing.length === 0 && cost <= availablePoints,
      missing,
    };
  });
}

export type SpendCheck =
  | { readonly ok: true; readonly node: UnlockNode; readonly cost: number }
  | { readonly ok: false; readonly reason: "unknown_node" | "already_reached" | "prerequisites_unmet" | "insufficient_points"; readonly missing?: readonly string[]; readonly cost?: number };

/**
 * Can `nodeId` be purchased in `web` given what is purchased and the points available?
 * Pure; the server re-runs it inside the spend transaction and the client can run it for
 * a preview. "already_reached" covers starting nodes too — they are never purchased.
 */
export function checkSpend(web: UnlockWeb, purchased: Iterable<string>, availablePoints: number, nodeId: string): SpendCheck {
  const node = findUnlockNode(web, nodeId);
  if (!node) return { ok: false, reason: "unknown_node" };
  const reached = reachedSet(web, purchased);
  if (reached.has(node.id)) return { ok: false, reason: "already_reached" };
  const missing = node.requires.filter((r) => !reached.has(r));
  if (missing.length > 0) return { ok: false, reason: "prerequisites_unmet", missing };
  const cost = nodeCost(node);
  if (cost > availablePoints) return { ok: false, reason: "insufficient_points", cost };
  return { ok: true, node, cost };
}

/**
 * Every MAXIMAL set of purchases reachable with `budget` points (no further node is
 * affordable from it). Exhaustive and deterministic (node order is the authored order).
 * More than one result at a mid-game budget is what makes a web a web — a test asserts it.
 * Sized for the webs here (≤ 10 nodes); not for use on hot paths.
 */
export function maximalReachableSets(web: UnlockWeb, budget: number): string[][] {
  const results = new Map<string, string[]>();
  const walk = (purchased: readonly string[], spent: number): void => {
    const options = web.nodes.filter((n) => checkSpend(web, purchased, budget - spent, n.id).ok);
    if (options.length === 0) {
      const key = [...purchased].sort().join("|");
      if (!results.has(key)) results.set(key, [...purchased].sort());
      return;
    }
    for (const n of options) walk([...purchased, n.id], spent + nodeCost(n));
  };
  walk([], 0);
  return [...results.values()].sort((a, b) => a.join("|").localeCompare(b.join("|")));
}

// ---------------------------------------------------------------------------------------
// Validation (runs at import via index.ts): the webs are data, so a dangling prerequisite,
// a node for a type that does not exist, a type with no node, a cycle, or a web that is a
// line instead of a web all fail at load time.
// ---------------------------------------------------------------------------------------

export function validateUnlockWebs(webs: readonly UnlockWeb[] = UNLOCK_WEBS): string[] {
  const problems: string[] = [];
  const costs = TUNABLES.UNLOCK_NODE_COST_BY_TIER;
  if (costs.length !== TUNABLES.UNLOCK_WEB_TIERS + 1) problems.push(`UNLOCK_NODE_COST_BY_TIER has ${costs.length} entries, expected UNLOCK_WEB_TIERS + 1 = ${TUNABLES.UNLOCK_WEB_TIERS + 1}`);
  if (costs[0] !== 0) problems.push("UNLOCK_NODE_COST_BY_TIER[0] must be 0: starting nodes are free");
  for (let t = 1; t < costs.length; t++) {
    const c = costs[t]!;
    if (!Number.isInteger(c) || c <= (costs[t - 1] ?? 0)) problems.push(`UNLOCK_NODE_COST_BY_TIER must be strictly increasing integers; tier ${t} = ${c}`);
  }

  const unitIds = new Set(LIVING_UNIT_TYPES.map((u) => u.id as string));
  const trapIds = new Set(TRAP_TYPES.map((t) => t.id as string));
  const fenceIds = new Set(FENCE_TIERS.map((f) => f.id as string));
  const siegeIds = new Set(SIEGE_TYPES.map((s) => s.id as string));
  const globalIds = new Set<string>();
  const webIds = new Set<string>();

  for (const web of webs) {
    const where = `web '${web.id}'`;
    if (webIds.has(web.id)) problems.push(`duplicate web id '${web.id}'`);
    webIds.add(web.id);
    if (!isUnlockPool(web.pool)) problems.push(`${where}: unknown pool '${String(web.pool)}'`);
    if (web.pool === "living" ? !isRegionId(web.regionId) : web.regionId !== null) problems.push(`${where}: living webs carry a region, account webs carry none`);

    // Which types this web may contain, and the expected node count.
    const allowed = web.pool === "living" ? new Set(LIVING_UNIT_TYPES.filter((u) => u.regionId === web.regionId).map((u) => u.id as string)) : web.pool === "trap" ? new Set([...trapIds, ...fenceIds]) : siegeIds;
    const expected = web.pool === "living" ? TUNABLES.LIVING_WEB_NODES : web.pool === "trap" ? TUNABLES.TRAP_WEB_NODES : TUNABLES.SIEGE_WEB_NODES;
    if (web.nodes.length !== expected) problems.push(`${where}: has ${web.nodes.length} nodes, expected ${expected}`);
    if (allowed.size !== expected) problems.push(`${where}: content has ${allowed.size} types for this web but the registry expects ${expected} nodes`);

    const byId = new Map<string, UnlockNode>();
    for (const n of web.nodes) {
      const nw = `${where} node '${n.id}'`;
      if (byId.has(n.id)) problems.push(`${nw}: duplicate node`);
      byId.set(n.id, n);
      if (globalIds.has(n.id)) problems.push(`${nw}: appears in more than one web`);
      globalIds.add(n.id);
      if (!allowed.has(n.id)) problems.push(`${nw}: not a type this web may contain (${web.id})`);
      if (!Number.isInteger(n.tier) || n.tier < 0 || n.tier > TUNABLES.UNLOCK_WEB_TIERS) problems.push(`${nw}: tier ${String(n.tier)} outside 0..${TUNABLES.UNLOCK_WEB_TIERS}`);
      if (n.tier === 0 && n.requires.length > 0) problems.push(`${nw}: a starting node cannot have prerequisites`);
      if (new Set(n.requires).size !== n.requires.length) problems.push(`${nw}: duplicate prerequisite`);
      if (n.requires.includes(n.id)) problems.push(`${nw}: requires itself`);
    }
    for (const t of allowed) if (!byId.has(t)) problems.push(`${where}: type '${t}' has no node — it would be unreachable by anyone, forever`);

    for (const n of web.nodes) {
      for (const r of n.requires) {
        const dep = byId.get(r);
        if (!dep) problems.push(`${where} node '${n.id}': prerequisite '${r}' is not in this web`);
        else if (dep.tier >= n.tier) problems.push(`${where} node '${n.id}' (tier ${n.tier}): prerequisite '${r}' is tier ${dep.tier}; prerequisites must be lower-tier`);
      }
    }

    // Acyclic: tier ordering already forbids cycles when prerequisites are lower-tier, but
    // check directly so the guarantee does not depend on the tier rule staying.
    const state = new Map<string, 1 | 2>();
    const visit = (id: string, trail: string[]): void => {
      const s = state.get(id);
      if (s === 2) return;
      if (s === 1) {
        problems.push(`${where}: cycle through ${[...trail, id].join(" -> ")}`);
        return;
      }
      state.set(id, 1);
      for (const r of byId.get(id)?.requires ?? []) if (byId.has(r)) visit(r, [...trail, id]);
      state.set(id, 2);
    };
    for (const n of web.nodes) visit(n.id, []);

    // Shape: a web, not a line.
    const roots = web.nodes.filter((n) => n.requires.length === 0).length;
    if (roots < TUNABLES.WEB_ROOTS_MIN || roots > TUNABLES.WEB_ROOTS_MAX) problems.push(`${where}: ${roots} roots, expected ${TUNABLES.WEB_ROOTS_MIN}..${TUNABLES.WEB_ROOTS_MAX}`);

    // Starting nodes: exactly the registry's counts, by kind.
    const starting = web.nodes.filter(isStartingNode).map((n) => n.id);
    const want = TUNABLES.STARTING_NODES;
    if (web.pool === "living" && starting.length !== want.living) problems.push(`${where}: ${starting.length} starting nodes, expected ${want.living}`);
    if (web.pool === "siege" && starting.length !== want.siege) problems.push(`${where}: ${starting.length} starting nodes, expected ${want.siege}`);
    if (web.pool === "trap") {
      const st = starting.filter((id) => trapIds.has(id)).length;
      const sf = starting.filter((id) => fenceIds.has(id)).length;
      if (st !== want.trap) problems.push(`${where}: ${st} starting trap nodes, expected ${want.trap}`);
      if (sf !== want.fence) problems.push(`${where}: ${sf} starting fence tiers, expected ${want.fence}`);
      // Fence tiers unlock in tier order: a higher fence tier is never reachable before a lower one.
      const fenceNodes = web.nodes.filter((n) => fenceIds.has(n.id)).map((n) => ({ n, tier: FENCE_TIERS.find((f) => f.id === n.id)!.tier }));
      for (const a of fenceNodes) for (const b of fenceNodes) if (a.tier < b.tier && a.n.tier >= b.n.tier) problems.push(`${where}: fence tier ${b.tier} ('${b.n.id}') is not deeper in the web than fence tier ${a.tier}`);
    }
  }
  if (!REGION_IDS.every((r) => webIds.has(`living.${r}`))) problems.push("every region needs a living web");
  if (!unitIds.size) problems.push("no living units");
  return problems;
}

export class UnlockWebValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Unlock webs failed validation (${problems.length} problem(s)):\n  - ${problems.join("\n  - ")}`);
    this.name = "UnlockWebValidationError";
  }
}

export function assertUnlockWebsValid(webs: readonly UnlockWeb[] = UNLOCK_WEBS): void {
  const problems = validateUnlockWebs(webs);
  if (problems.length > 0) throw new UnlockWebValidationError(problems);
}
