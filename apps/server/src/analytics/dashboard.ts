/**
 * Chunk 32: the admin dashboard — every panel, and the PROJECT.md §20 table that says which
 * panel each placeholder number is tuned against (the chunk's definition of done: "every §20
 * number has a dashboard panel that shows the metric it should be tuned against").
 *
 * Read-only, admin-only (/admin/dashboard). Nothing in play reads it.
 */
import { TUNABLES, weekBounds, weekIndexAt } from "@caravan/content";
import type { Queryable } from "../db/pool.js";
import * as q from "./queries.js";
import { ANALYTICS_RETENTION_COHORT_DAYS } from "./tunables.js";

export const PANEL_IDS = [
  "tripLength",
  "bankVsPush",
  "overrunByBand",
  "defenderUnits",
  "attackerUnits",
  "stances",
  "slots",
  "traps",
  "siege",
  "tickCap",
  "ladder",
  "unlockPurchases",
  "mergeSpend",
  "spendByReason",
  "refugees",
  "earnBySource",
  "storageCap",
  "tripCap",
  "grindWall",
  "packFunnel",
  "sessionLength",
  "retention",
  "screens",
  "crashes",
  "poolHealth",
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export interface TuningEntry {
  /** 1..14, in PROJECT.md §20's order. */
  n: number;
  number: string;
  /** The registry keys that hold it today. */
  tunables: string[];
  /** The panels that show the metric it should be tuned against (first = primary). */
  panels: PanelId[];
  /** What to read on those panels. */
  metric: string;
}

/** PROJECT.md §20's fourteen placeholder numbers → the panel(s) to tune each against. */
export const TUNING_MAP: readonly TuningEntry[] = [
  {
    n: 1,
    number: "Damage formula coefficients and the full type/affinity matrix",
    tunables: ["DAMAGE_FORMULA", "AFFINITY_ADVANTAGE_MULT", "AFFINITY_DISADVANTAGE_MULT", "MERGE_MULT_PER_LEVEL"],
    panels: ["defenderUnits", "attackerUnits", "overrunByBand"],
    metric: "Win rate by unit type on each side: no type should predict the outcome far from the field's average; overrun rate should sit level across bands.",
  },
  {
    n: 2,
    number: "Garrison aggro radius and leash distance",
    tunables: ["AGGRO_RADIUS_DEFAULT", "LEASH_DISTANCE_DEFAULT", "LEASH_HYSTERESIS_MULT"],
    panels: ["stances", "defenderUnits"],
    metric: "Held rate per defensive stance (guard / hold / reserve): a stance that always or never holds says the leash or aggro is off.",
  },
  {
    n: 3,
    number: "Deployment slot count",
    tunables: ["DEPLOYMENT_SLOT_CAP", "PARTY_SLOT_CAP", "SIEGE_SLOT_CAP"],
    panels: ["slots"],
    metric: "Posted units and raiders per encounter, with held rate: if nearly every circle fills every slot, the cap binds; if held rate climbs steeply with count, it decides fights.",
  },
  {
    n: 4,
    number: "Fence segment HP and unlock-web cost",
    tunables: ["FENCE_SEGMENT_HP_DEFAULT", "FENCE_HIT_SEGMENT_CAP", "FENCE_MATERIAL_BUDGET"],
    panels: ["slots", "unlockPurchases"],
    metric: "Fence segments placed per encounter against held rate (the 'fences' rows), and which fence nodes players buy and how soon.",
  },
  {
    n: 5,
    number: "Trap damage/effect values and unlock-web costs",
    tunables: ["TRAP_DAMAGE_MIN", "TRAP_DAMAGE_MAX", "TRAP_SLOW_MAGNITUDE_DEFAULT", "TRAP_ROOT_DURATION_DEFAULT", "TRAP_SLOT_CAP"],
    panels: ["traps", "unlockPurchases"],
    metric: "Pick and held rate per trap type, and trap-pool node purchases.",
  },
  {
    n: 6,
    number: "Siege equipment effect values and unlock-web costs",
    tunables: ["SIEGE_FENCE_DAMAGE_MULT", "SIEGE_TRAP_NULLIFY", "STRUCTURE_BREAKER_MULT_DEFAULT"],
    panels: ["siege", "unlockPurchases"],
    metric: "Pick and overrun rate per siege type in the served parties, and siege-pool node purchases.",
  },
  {
    n: 7,
    number: "Ladder point curves per pool",
    tunables: ["LADDER_*"],
    panels: ["ladder"],
    metric: "How many owners sit at each rung per pool now, and rungs crossed in the window: a pile-up at one rung is a wall in the curve.",
  },
  {
    n: 8,
    number: "Unlock web node counts and structure",
    tunables: ["LIVING_UNITS_PER_REGION", "TRAP_TYPES", "SIEGE_TYPES", "FENCE_TIERS"],
    panels: ["unlockPurchases", "ladder"],
    metric: "Which nodes are bought (and which never are) per pool, against the points the ladder has granted.",
  },
  {
    n: 9,
    number: "Weekly pack Coin amounts per tier, and the combined weekly cap",
    tunables: ["PACK_COIN_BY_TIER", "PACK_TIER_PRICES_CENTS", "WEEKLY_PAY_CEILING"],
    panels: ["grindWall", "packFunnel"],
    metric: "WEEKLY_PAY_CEILING against free weekly earn per active-player decile (the grind-wall probe): the paid path must stay optional at every decile; and the store funnel per tier.",
  },
  {
    n: 10,
    number: "Coin storage cap value",
    tunables: ["COIN_STORAGE_CAP"],
    panels: ["storageCap", "earnBySource"],
    metric: "Share of players at or near the cap now, and Coin the cap discarded per source in the window.",
  },
  {
    n: 11,
    number: "Coin earn rates (per encounter, per completed trip, passive trickle)",
    tunables: ["COIN_PER_ENCOUNTER_BASE", "COIN_ENCOUNTER_ESCALATION_MULT", "COIN_ENCOUNTER_BAND_SCALE_BP", "COIN_DELIVERY_PER_ENCOUNTER", "COIN_PER_PARTY_WIN", "COIN_TRICKLE_RATE_PER_HOUR"],
    panels: ["earnBySource", "grindWall", "bankVsPush", "tripLength"],
    metric: "Coin by source, free weekly earn by decile, and whether players push past encounter 1 (push rate by encounter, trip length): a bank-at-1 habit means the escalation does not pay.",
  },
  {
    n: 12,
    number: "Trips-per-hour cap value",
    tunables: ["TRIPS_PER_HOUR_CAP", "TRIP_CAP_REGEN_MS"],
    panels: ["tripCap", "sessionLength"],
    metric: "Share of trip starts that took the last available use, against session length: frequent last-use starts in short sessions mean the cap ends sessions.",
  },
  {
    n: 13,
    number: "Refugee drip refresh interval and mercenary recruit Coin cost",
    tunables: ["REFUGEE_REFRESH_INTERVAL_MINUTES", "REFUGEE_REROLL_COST_SCHEDULE", "MERCENARY_COST_BASE"],
    panels: ["refugees", "spendByReason"],
    metric: "Free menus, rerolls and claims per day, and Coin spent on refugee_reroll and mercenary_recruit.",
  },
  {
    n: 14,
    number: "Tick cap / stalemate threshold",
    tunables: ["BATTLE_LENGTH_CAP_SECONDS", "TICK_RATE", "STALEMATE_LOOT_SHARE"],
    panels: ["tickCap", "bankVsPush"],
    metric: "Fights ending at or near the tick cap, by outcome, and the stalemate share per encounter index.",
  },
];

export interface Dashboard {
  generatedAt: string;
  window: { from: string; to: string; days: number };
  tuning: readonly TuningEntry[];
  /** Today's value of every tunable the table names (registry keys; a trailing * names every key with that prefix). */
  tunableValues: Record<string, unknown>;
  panels: {
    tripLength: q.TripLengthRow[];
    bankVsPush: q.BankPushRow[];
    overrunByBand: q.OverrunBandRow[];
    defenderUnits: { settled: number; rows: q.UnitRow[] };
    attackerUnits: { settled: number; rows: q.UnitRow[] };
    stances: q.StanceRow[];
    slots: q.SlotRow[];
    traps: { settled: number; rows: q.UnitRow[] };
    siege: { settled: number; rows: q.UnitRow[] };
    tickCap: { capTicks: number; nearCapTicks: number; rows: q.TickRow[] };
    ladder: Awaited<ReturnType<typeof q.ladder>>;
    unlockPurchases: Awaited<ReturnType<typeof q.unlockPurchases>>;
    mergeSpend: { byDay: Awaited<ReturnType<typeof q.mergeByDay>>; byLevel: Awaited<ReturnType<typeof q.mergeByLevel>> };
    spendByReason: q.SpendRow[];
    refugees: Awaited<ReturnType<typeof q.refugeesByDay>>;
    earnBySource: q.EarnRow[];
    storageCap: Awaited<ReturnType<typeof q.nearCap>> & { cap: number; discarded: number };
    tripCap: Awaited<ReturnType<typeof q.tripCapUse>> & { capPerHour: number };
    grindWall: { weekIndex: number; weekFrom: string; weekTo: string; weeklyPayCeiling: number; freeWeeklyEarnEstimate: number; deciles: q.GrindDecileRow[] };
    packFunnel: q.PackFunnel;
    sessionLength: q.SessionStats;
    retention: { cohortFrom: string; cohortTo: string; days: Awaited<ReturnType<typeof q.retention>> };
    screens: Awaited<ReturnType<typeof q.screens>>;
    crashes: Awaited<ReturnType<typeof q.crashes>>;
    poolHealth: { candidatesPerSearch: number; maxAuthoredShareBp: number; bands: q.PoolBandRow[]; alarms: number };
  };
}

export function tunableValues(): Record<string, unknown> {
  const reg = TUNABLES as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const entry of TUNING_MAP) {
    for (const key of entry.tunables) {
      if (key.endsWith("*")) {
        const prefix = key.slice(0, -1);
        for (const k of Object.keys(reg).sort()) if (k.startsWith(prefix)) out[k] = reg[k];
      } else if (key in reg) out[key] = reg[key];
    }
  }
  return out;
}

export interface DashboardOptions {
  nowMs: number;
  days: number;
  /** Grind-wall week (pack rotation week index); defaults to the last complete week. */
  week?: number;
}

export async function buildDashboard(db: Queryable, opts: DashboardOptions): Promise<Dashboard> {
  const to = new Date(opts.nowMs);
  const from = new Date(opts.nowMs - opts.days * 86_400_000);
  const win: q.Window = { from, to };
  const weekIndex = opts.week ?? weekIndexAt(opts.nowMs) - 1;
  const wb = weekBounds(weekIndex);
  const week: q.Window = { from: new Date(wb.startsAtMs), to: new Date(wb.endsAtMs) };
  const cohort: q.Window = { from: new Date(opts.nowMs - ANALYTICS_RETENTION_COHORT_DAYS * 86_400_000), to };

  const bankVsPush = await q.bankVsPush(db, win);
  const settled = bankVsPush.reduce((s, r) => s + r.settled, 0);
  const earnBySource = await q.earnBySource(db, win);
  const pool = await q.poolHealth(db, win);
  return {
    generatedAt: to.toISOString(),
    window: { from: from.toISOString(), to: to.toISOString(), days: opts.days },
    tuning: TUNING_MAP,
    tunableValues: tunableValues(),
    panels: {
      tripLength: await q.tripLength(db, win),
      bankVsPush,
      overrunByBand: await q.overrunByBand(db, win),
      defenderUnits: { settled, rows: await q.defenderUnits(db, win, settled) },
      attackerUnits: { settled, rows: await q.attackerUnits(db, win, settled) },
      stances: await q.stances(db, win),
      slots: await q.slots(db, win),
      traps: { settled, rows: await q.trapUsage(db, win, settled) },
      siege: { settled, rows: await q.siegeUsage(db, win, settled) },
      tickCap: { capTicks: q.TICK_CAP, nearCapTicks: q.NEAR_TICK_CAP, rows: await q.tickCap(db, win) },
      ladder: await q.ladder(db, win),
      unlockPurchases: await q.unlockPurchases(db, win),
      mergeSpend: { byDay: await q.mergeByDay(db, win), byLevel: await q.mergeByLevel(db, win) },
      spendByReason: await q.spendByReason(db, win),
      refugees: await q.refugeesByDay(db, win),
      earnBySource,
      storageCap: { ...(await q.nearCap(db)), cap: TUNABLES.COIN_STORAGE_CAP, discarded: earnBySource.reduce((s, r) => s + r.discarded, 0) },
      tripCap: { ...(await q.tripCapUse(db, win)), capPerHour: TUNABLES.TRIPS_PER_HOUR_CAP },
      grindWall: {
        weekIndex,
        weekFrom: week.from.toISOString(),
        weekTo: week.to.toISOString(),
        weeklyPayCeiling: TUNABLES.WEEKLY_PAY_CEILING,
        freeWeeklyEarnEstimate: TUNABLES.FREE_WEEKLY_EARN_ESTIMATE,
        deciles: await q.grindWall(db, week),
      },
      packFunnel: await q.packFunnel(db, win),
      sessionLength: await q.sessionLength(db, win),
      retention: { cohortFrom: cohort.from.toISOString(), cohortTo: cohort.to.toISOString(), days: await q.retention(db, cohort) },
      screens: await q.screens(db, win),
      crashes: await q.crashes(db, win),
      poolHealth: {
        candidatesPerSearch: TUNABLES.CANDIDATES_PER_SEARCH,
        maxAuthoredShareBp: TUNABLES.AUTHORED_PARTY_MAX_SHARE_BP,
        bands: pool,
        alarms: pool.filter((b) => b.alarm !== "ok").length,
      },
    },
  };
}
