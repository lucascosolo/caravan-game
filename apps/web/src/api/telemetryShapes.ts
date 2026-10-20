/**
 * Chunk 32 payload guards: the telemetry setting, the ingest answer, and the admin dashboard.
 * Bounded wherever a value sizes a render (a dashboard row list builds table rows).
 */
import { ShapeError, array, boolean, integer, literal, nullable, object, optional, string, type Guard } from "./shape.ts";
import type { AnalyticsSettings, DashboardView, TelemetryIngestResult, TypedPanel } from "./telemetryTypes.ts";

const n = integer({ min: 0 });
const rate = nullable(integer({ min: 0 }));
const ROWS = { maxLength: 500 };

export const analyticsSettingsShape: Guard<AnalyticsSettings> = object({ optedOut: boolean() });

export const telemetryIngestShape: Guard<TelemetryIngestResult> = object({ accepted: n, dropped: n, optedOut: boolean() });

const typedPanel: Guard<TypedPanel> = object({
  settled: n,
  rows: array(object({ typeId: string({ maxLength: 64 }), appearances: n, wins: n, pickRateBp: rate, winRateBp: rate, live: optional(n) }), ROWS),
});

const tunableValues: Guard<Readonly<Record<string, unknown>>> = (v, path) => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ShapeError(path, "object", v);
  return v as Record<string, unknown>;
};

export const dashboardShape: Guard<DashboardView> = object({
  generatedAt: string(),
  window: object({ from: string(), to: string(), days: integer({ min: 1, max: 366 }) }),
  tuning: array(object({ n: integer({ min: 1, max: 14 }), number: string(), tunables: array(string(), ROWS), panels: array(string(), ROWS), metric: string() }), { maxLength: 14 }),
  tunableValues,
  panels: object({
    tripLength: array(object({ endReason: string(), encounters: n, trips: n }), ROWS),
    bankVsPush: array(object({ encounterIndex: integer({ min: 1 }), settled: n, held: n, overrun: n, stalemate: n, pushed: n, banked: n, undecided: integer(), pushRateBp: rate, overrunRateBp: rate }), ROWS),
    overrunByBand: array(object({ band: n, encounters: n, held: n, overrun: n, stalemate: n, overrunRateBp: rate }), ROWS),
    defenderUnits: typedPanel,
    attackerUnits: typedPanel,
    matchups: array(object({ defender: string({ maxLength: 32 }), attacker: string({ maxLength: 32 }), encounters: n, held: n, overrun: n, heldRateBp: rate }), ROWS),
    mergeLevels: array(object({ side: string({ maxLength: 16 }), level: n, encounters: n, held: n, heldRateBp: rate }), ROWS),
    fences: array(object({ tierId: string({ maxLength: 64 }), placed: n, broken: n, damaged: n, hpLost: n, brokenRateBp: rate }), ROWS),
    traps: typedPanel,
    siege: typedPanel,
    stances: array(object({ stance: string({ maxLength: 32 }), posts: n, held: n, heldRateBp: rate }), ROWS),
    slots: array(object({ side: string({ maxLength: 16 }), count: n, encounters: n, held: n, heldRateBp: rate }), ROWS),
    tickCap: object({ capTicks: n, nearCapTicks: n, rows: array(object({ outcomeKind: string(), fights: n, nearCap: n, atCap: n, maxEndTick: n, medianEndTick: n }), ROWS) }),
    ladder: object({ levels: array(object({ pool: string(), level: n, owners: n }), ROWS), gained: array(object({ pool: string(), events: n, points: n, rungs: n }), ROWS) }),
    unlockPurchases: array(object({ pool: string(), nodeId: string({ maxLength: 96 }), purchases: n, points: n }), ROWS),
    mergeSpend: object({ byDay: array(object({ day: string({ maxLength: 10 }), merges: n, coin: n }), ROWS), byLevel: array(object({ toLevel: n, merges: n, coin: n }), ROWS) }),
    spendByReason: array(object({ reason: string({ maxLength: 64 }), events: n, coin: n }), ROWS),
    refugees: array(object({ day: string({ maxLength: 10 }), freeMenus: n, rerolls: n, claims: n, caravans: n }), ROWS),
    earnBySource: array(object({ type: string(), reason: string({ maxLength: 64 }), events: n, coin: n, discarded: n }), ROWS),
    storageCap: object({ accounts: n, nearCap: n, atCap: n, nearCapPercent: n, cap: n, discarded: n }),
    tripCap: object({ starts: n, accounts: n, tookLastUse: n, tookLastUseBp: rate, capPerHour: n }),
    grindWall: object({
      weekIndex: integer(),
      weekFrom: string(),
      weekTo: string(),
      weeklyPayCeiling: n,
      freeWeeklyEarnEstimate: n,
      note: string({ maxLength: 500 }),
      deciles: array(object({ decile: integer({ min: 1, max: 10 }), players: n, minFree: n, maxFree: n, avgFree: n, avgPaid: n, payers: n, ceilingToFreeBp: rate }), { maxLength: 10 }),
    }),
    packFunnel: object({ viewers: n, storeViewers: n, buyers: n, allBuyers: n, tiers: array(object({ tier: integer({ min: 1, max: 3 }), reserved: n, settled: n, buyers: n, cents: n }), { maxLength: 3 }), storeMode: literal("sandbox", "off"), counted: boolean() }),
    sessionLength: object({ sessions: n, players: n, medianMs: n, maxMs: n, screens: n, gapMs: n, buckets: array(object({ label: string({ maxLength: 16 }), sessions: n }), { maxLength: 12 }) }),
    retention: object({ cohortFrom: string(), cohortTo: string(), days: array(object({ day: n, eligible: n, returned: n, rateBp: rate }), { maxLength: 3 }) }),
    screens: array(object({ screen: string({ maxLength: 24 }), views: n, viewers: n }), ROWS),
    crashes: array(object({ errorName: string({ maxLength: 24 }), stackHash: string({ maxLength: 8 }), screen: string({ maxLength: 24 }), reports: n, reporters: n }), { maxLength: 20 }),
    poolHealth: object({
      candidatesPerSearch: n,
      maxAuthoredShareBp: n,
      alarms: n,
      bands: array(
        object({
          band: n,
          low: integer(),
          high: integer(),
          liveParties: n,
          authoredParties: n,
          caravans: n,
          served: n,
          servedAuthored: n,
          liveShareBp: rate,
          servedAuthoredShareBp: rate,
          matchmakerWindow: object({ served: n, authored: n, shareBp: rate }),
          alarm: literal("ok", "empty", "thin", "no_live", "authored_over_share"),
        }),
        ROWS,
      ),
    }),
    // Final guardrail review r4 D1 (optional: older servers do not send it).
    partyStrikes: optional(
      object({
        suggestedPartyMax: n,
        lowBandMax: integer({ min: -1 }),
        rows: array(object({ size: n, liveParties: n, strikes: n, lowBandStrikes: n, overran: n, perPartyPerDayMilli: rate }), ROWS),
      }),
    ),
  }),
});
