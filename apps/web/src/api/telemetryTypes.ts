/**
 * Chunk 32 response types: the telemetry setting, the ingest answer, and the admin dashboard
 * (apps/server/src/analytics/dashboard.ts). The dashboard is read by the admin page only.
 */
import type { TelemetryErrorName, TelemetryScreen } from "../telemetry/screens.ts";

export interface AnalyticsSettings {
  readonly optedOut: boolean;
}

export type TelemetryEvent =
  | { readonly kind: "screen" | "heartbeat"; readonly screen: TelemetryScreen; readonly agoMs: number }
  | { readonly kind: "crash"; readonly screen: TelemetryScreen; readonly errorName: TelemetryErrorName; readonly stackHash: string; readonly agoMs: number };

/** QA D2: a batch carries this page load's random session id and its sequence number in it. */
export interface TelemetryBatch {
  readonly session: number;
  readonly seq: number;
  readonly events: readonly TelemetryEvent[];
}

export interface TelemetryIngestResult {
  readonly accepted: number;
  readonly dropped: number;
  readonly optedOut: boolean;
}

export interface UnitRowView {
  readonly typeId: string;
  readonly appearances: number;
  readonly wins: number;
  readonly pickRateBp: number | null;
  readonly winRateBp: number | null;
  readonly live?: number | undefined;
}

export interface TypedPanel {
  readonly settled: number;
  readonly rows: readonly UnitRowView[];
}

export interface TuningEntryView {
  readonly n: number;
  readonly number: string;
  readonly tunables: readonly string[];
  readonly panels: readonly string[];
  readonly metric: string;
}

export interface PoolBandView {
  readonly band: number;
  readonly low: number;
  readonly high: number;
  readonly liveParties: number;
  readonly authoredParties: number;
  readonly caravans: number;
  readonly served: number;
  readonly servedAuthored: number;
  readonly liveShareBp: number | null;
  readonly servedAuthoredShareBp: number | null;
  readonly matchmakerWindow: { readonly served: number; readonly authored: number; readonly shareBp: number | null };
  readonly alarm: "ok" | "empty" | "thin" | "no_live" | "authored_over_share";
}

export interface DashboardView {
  readonly generatedAt: string;
  readonly window: { readonly from: string; readonly to: string; readonly days: number };
  readonly tuning: readonly TuningEntryView[];
  readonly tunableValues: Readonly<Record<string, unknown>>;
  readonly panels: {
    readonly tripLength: readonly { readonly endReason: string; readonly encounters: number; readonly trips: number }[];
    readonly bankVsPush: readonly {
      readonly encounterIndex: number;
      readonly settled: number;
      readonly held: number;
      readonly overrun: number;
      readonly stalemate: number;
      readonly pushed: number;
      readonly banked: number;
      readonly undecided: number;
      readonly pushRateBp: number | null;
      readonly overrunRateBp: number | null;
    }[];
    readonly overrunByBand: readonly { readonly band: number; readonly encounters: number; readonly held: number; readonly overrun: number; readonly stalemate: number; readonly overrunRateBp: number | null }[];
    readonly defenderUnits: TypedPanel;
    readonly attackerUnits: TypedPanel;
    readonly matchups: readonly { readonly defender: string; readonly attacker: string; readonly encounters: number; readonly held: number; readonly overrun: number; readonly heldRateBp: number | null }[];
    readonly mergeLevels: readonly { readonly side: string; readonly level: number; readonly encounters: number; readonly held: number; readonly heldRateBp: number | null }[];
    readonly fences: readonly { readonly tierId: string; readonly placed: number; readonly broken: number; readonly damaged: number; readonly hpLost: number; readonly brokenRateBp: number | null }[];
    readonly traps: TypedPanel;
    readonly siege: TypedPanel;
    readonly stances: readonly { readonly stance: string; readonly posts: number; readonly held: number; readonly heldRateBp: number | null }[];
    readonly slots: readonly { readonly side: string; readonly count: number; readonly encounters: number; readonly held: number; readonly heldRateBp: number | null }[];
    readonly tickCap: {
      readonly capTicks: number;
      readonly nearCapTicks: number;
      readonly rows: readonly { readonly outcomeKind: string; readonly fights: number; readonly nearCap: number; readonly atCap: number; readonly maxEndTick: number; readonly medianEndTick: number }[];
    };
    readonly ladder: {
      readonly levels: readonly { readonly pool: string; readonly level: number; readonly owners: number }[];
      readonly gained: readonly { readonly pool: string; readonly events: number; readonly points: number; readonly rungs: number }[];
    };
    readonly unlockPurchases: readonly { readonly pool: string; readonly nodeId: string; readonly purchases: number; readonly points: number }[];
    readonly mergeSpend: {
      readonly byDay: readonly { readonly day: string; readonly merges: number; readonly coin: number }[];
      readonly byLevel: readonly { readonly toLevel: number; readonly merges: number; readonly coin: number }[];
    };
    readonly spendByReason: readonly { readonly reason: string; readonly events: number; readonly coin: number }[];
    readonly refugees: readonly { readonly day: string; readonly freeMenus: number; readonly rerolls: number; readonly claims: number; readonly caravans: number }[];
    readonly earnBySource: readonly { readonly type: string; readonly reason: string; readonly events: number; readonly coin: number; readonly discarded: number }[];
    readonly storageCap: { readonly accounts: number; readonly nearCap: number; readonly atCap: number; readonly nearCapPercent: number; readonly cap: number; readonly discarded: number };
    readonly tripCap: { readonly starts: number; readonly accounts: number; readonly tookLastUse: number; readonly tookLastUseBp: number | null; readonly capPerHour: number };
    readonly grindWall: {
      readonly weekIndex: number;
      readonly weekFrom: string;
      readonly weekTo: string;
      readonly weeklyPayCeiling: number;
      readonly freeWeeklyEarnEstimate: number;
      readonly note: string;
      readonly deciles: readonly {
        readonly decile: number;
        readonly players: number;
        readonly minFree: number;
        readonly maxFree: number;
        readonly avgFree: number;
        readonly avgPaid: number;
        readonly payers: number;
        readonly ceilingToFreeBp: number | null;
      }[];
    };
    readonly packFunnel: {
      readonly viewers: number;
      readonly storeViewers: number;
      readonly buyers: number;
      readonly allBuyers: number;
      readonly tiers: readonly { readonly tier: number; readonly reserved: number; readonly settled: number; readonly buyers: number; readonly cents: number }[];
      /** Final review D1: with the store off (the play test) the funnel is not counted: counted false, every number 0. */
      readonly storeMode: "sandbox" | "off";
      readonly counted: boolean;
    };
    readonly sessionLength: {
      readonly sessions: number;
      readonly players: number;
      readonly medianMs: number;
      readonly maxMs: number;
      readonly screens: number;
      readonly gapMs: number;
      readonly buckets: readonly { readonly label: string; readonly sessions: number }[];
    };
    readonly retention: { readonly cohortFrom: string; readonly cohortTo: string; readonly days: readonly { readonly day: number; readonly eligible: number; readonly returned: number; readonly rateBp: number | null }[] };
    readonly screens: readonly { readonly screen: string; readonly views: number; readonly viewers: number }[];
    readonly crashes: readonly { readonly errorName: string; readonly stackHash: string; readonly screen: string; readonly reports: number; readonly reporters: number }[];
    readonly poolHealth: { readonly candidatesPerSearch: number; readonly maxAuthoredShareBp: number; readonly bands: readonly PoolBandView[]; readonly alarms: number };
    /** Final guardrail review r4 D1: strikes per live party, by party size. Absent from older servers. */
    readonly partyStrikes?:
      | {
          readonly suggestedPartyMax: number;
          readonly lowBandMax: number;
          readonly rows: readonly { readonly size: number; readonly liveParties: number; readonly strikes: number; readonly lowBandStrikes: number; readonly overran: number; readonly perPartyPerDayMilli: number | null }[];
        }
      | undefined;
  };
}
