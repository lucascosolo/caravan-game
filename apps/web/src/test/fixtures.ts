/**
 * Test fixtures shaped exactly like the server's responses (chunk 05 view.ts / spend.ts,
 * chunk 04 progression view). A fake fetch routes by method + path.
 */
import type { MeResponse, ProgressionResponse, UnlockNodeView, UnlocksResponse, UnlockWebView } from "../api/types.ts";

export const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
export const CARAVAN_ID = "22222222-2222-4222-8222-222222222222";

// Per-pool cost curves (chunk 05 QA D1): the client reads cost from each node; these are
// only used to BUILD the fixture nodes the way the server would.
const COST: Record<"living" | "trap" | "siege", readonly number[]> = {
  living: [0, 1, 4, 8, 14],
  trap: [0, 1, 3, 7, 10],
  siege: [0, 1, 8, 15, 21],
};

interface Spec {
  id: string;
  tier: number;
  requires?: string[];
}

function nodes(pool: "living" | "trap" | "siege", specs: Spec[], purchased: string[], available: number): UnlockNodeView[] {
  const reached = new Set([...specs.filter((s) => s.tier === 0).map((s) => s.id), ...purchased]);
  return specs.map((s) => {
    const requires = s.requires ?? [];
    const missing = requires.filter((r) => !reached.has(r));
    const cost = COST[pool][s.tier]!;
    const isReached = reached.has(s.id);
    return {
      id: s.id,
      tier: s.tier,
      cost,
      requires,
      starting: s.tier === 0,
      reached: isReached,
      prerequisitesMet: missing.length === 0,
      affordable: !isReached && missing.length === 0 && cost <= available,
      missing,
    };
  });
}

export const TRAP_SPECS: Spec[] = [
  { id: "trap.spike_pit", tier: 0 },
  { id: "fence.brush_pile", tier: 0 },
  { id: "trap.tripwire_snare", tier: 1 },
  { id: "trap.jaw_trap", tier: 1, requires: ["trap.spike_pit"] },
  { id: "trap.caltrop_scatter", tier: 2, requires: ["trap.tripwire_snare"] },
  { id: "fence.split_rail", tier: 2, requires: ["fence.brush_pile"] },
  { id: "trap.powder_keg", tier: 3, requires: ["trap.jaw_trap"] },
  { id: "trap.tar_pot", tier: 3, requires: ["trap.caltrop_scatter"] },
  { id: "fence.barbed_wire", tier: 3, requires: ["fence.split_rail"] },
  { id: "fence.stacked_stone", tier: 4, requires: ["fence.barbed_wire"] },
];
export const SIEGE_SPECS: Spec[] = [
  { id: "siege.battering_wagon", tier: 0 },
  { id: "siege.bridging_planks", tier: 1 },
  { id: "siege.fence_cutters", tier: 2, requires: ["siege.battering_wagon"] },
  { id: "siege.dousing_wagon", tier: 2, requires: ["siege.bridging_planks"] },
  { id: "siege.blasting_crate", tier: 4, requires: ["siege.fence_cutters"] },
];
export const LIVING_SPECS: Spec[] = [
  { id: "desert.dust_rider", tier: 0 },
  { id: "desert.well_digger", tier: 0 },
  { id: "desert.sand_sharpshooter", tier: 1 },
  { id: "desert.coyote_pack", tier: 2, requires: ["desert.dust_rider"] },
  { id: "desert.powder_monkey", tier: 2, requires: ["desert.well_digger"] },
  { id: "desert.canteen_carrier", tier: 3, requires: ["desert.sand_sharpshooter"] },
  { id: "desert.longhorn_bull", tier: 3, requires: ["desert.coyote_pack", "desert.powder_monkey"] },
  { id: "desert.vaquero", tier: 4, requires: ["desert.canteen_carrier"] },
];

export interface FixtureState {
  trapPurchased?: string[];
  trapGranted?: number;
  siegePurchased?: string[];
  siegeGranted?: number;
  livingPurchased?: string[];
  livingGranted?: number;
}

export function unlocksResponse(state: FixtureState = {}): UnlocksResponse {
  const mk = (pool: "living" | "trap" | "siege", specs: Spec[], purchased: string[], granted: number): UnlockWebView => {
    const spent = purchased.reduce((sum, id) => sum + COST[pool][specs.find((s) => s.id === id)!.tier]!, 0);
    const available = granted - spent;
    const living = pool === "living";
    return {
      id: living ? "living.desert" : pool,
      pool,
      scope: living ? "caravan" : "account",
      regionId: living ? "desert" : null,
      accountId: ACCOUNT_ID,
      caravanId: living ? CARAVAN_ID : null,
      points: { granted, spent, available },
      nodes: nodes(pool, specs, purchased, available),
    };
  };
  return {
    webs: [
      mk("trap", TRAP_SPECS, state.trapPurchased ?? [], state.trapGranted ?? 3),
      mk("siege", SIEGE_SPECS, state.siegePurchased ?? [], state.siegeGranted ?? 0),
      mk("living", LIVING_SPECS, state.livingPurchased ?? [], state.livingGranted ?? 1),
    ],
  };
}

export function progressionResponse(): ProgressionResponse {
  const ladder = (level: number, points: number) => ({
    level,
    points,
    cap: 10,
    capped: false,
    nextRungAt: 100,
    pointsToNextRung: 100 - points,
    nextRungUnlockPoints: 3,
  });
  return {
    pools: [
      { pool: "trap", scope: "account", accountId: ACCOUNT_ID, caravanId: null, reputation: 0, ladder: ladder(1, 40), unlockPoints: { granted: 3, spent: 0, available: 3 } },
      { pool: "siege", scope: "account", accountId: ACCOUNT_ID, caravanId: null, reputation: 0, ladder: ladder(0, 0), unlockPoints: { granted: 0, spent: 0, available: 0 } },
      { pool: "living", scope: "caravan", accountId: null, caravanId: CARAVAN_ID, reputation: 0, ladder: ladder(1, 10), unlockPoints: { granted: 1, spent: 0, available: 1 } },
    ],
  };
}

export function meResponse(): MeResponse {
  return { account: { id: ACCOUNT_ID, username: "tester" }, caravans: [{ id: CARAVAN_ID, name: "Dev Caravan", region_id: "desert" }] };
}

export interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export type Handler = (call: Call) => { status: number; body?: unknown };

/** A fake `fetch` that routes "METHOD /path" to a handler and records every call. */
export function fakeFetch(routes: Record<string, Handler>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const path = url.replace(/^\/api/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const call: Call = { method, path, body, headers };
    calls.push(call);
    const handler = routes[`${method} ${path}`];
    if (!handler) return new Response(JSON.stringify({ error: "not_found", message: `no route ${method} ${path}` }), { status: 404 });
    const out = handler(call);
    if (out.status === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status, headers: { "Content-Type": "application/json" } });
  };
  return { fetch: impl as typeof fetch, calls };
}
