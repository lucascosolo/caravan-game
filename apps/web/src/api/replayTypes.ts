/**
 * Response type of the replay route (chunk 13 server, chunk 22 client), hand-written: only
 * the fields the replay player renders. The guard in replayShapes.ts is typed against it.
 *
 *   GET /me/encounters/:jobId/replay   ReplayView
 *     404 no_replay               not a participant, malformed or unknown id (no existence oracle)
 *     409 not_resolved            the fight has not been resolved yet (poll again)
 *     409 resolution_unavailable  the fight could not be resolved and never will be
 *     410 replay_expired          the stored log is gone and no summary was kept (pruned before PHASE-2 §36)
 *   200 with `renderable: false`, `log: null` and `compacted` set: the log was compacted to its
 *     results summary (LOG_RETENTION / LOG_SIZE_BUDGET, PHASE-2 §36) — outcome and tally stay.
 *   GET /me/encounters                 RecentFightsView (chunk 22 QA D2: the caravan's fights within retention)
 *
 * `log` is the stored replay exactly as the resolver encoded it (LOG_FORMAT, packages/
 * resolver/src/replay.ts). The guard does not look inside it: `readReplay` validates the
 * whole thing — envelope, seal, every row, every keyframe — and refuses anything wrong.
 */
import type { EncounterOutcomeKind } from "./tripTypes.ts";

/** Which side of the fight the signed-in account was on. */
export type ReplayViewer = "caravan" | "party_owner";

/** The outcome the server recorded for this encounter (the job's result). */
export interface ReplayOutcomeView {
  readonly kind: EncounterOutcomeKind;
  /** DEPTH_METRIC, fixed-point 0..1024. */
  readonly depth: number;
  readonly endTick: number;
  /** The party OWNER's loot for this fight, as reported (crediting is the settle path's). */
  readonly loot: number;
}

/** A raider's targeting stance (party snapshot) or a post's defensive stance (formation snapshot). */
export type ReplayStance = "nearest" | "traps" | "core" | "guard" | "hold" | "reserve";

export interface ReplayUnitLabelView {
  readonly u: number;
  readonly side: "attacker" | "defender";
  readonly ref: string;
  readonly typeId: string;
  readonly level: number;
  readonly maxHp: number;
  readonly hp: number;
  readonly displayName: string;
  /** The type's one ability, by display name (null for a type the content no longer has). */
  readonly ability: string | null;
  /** Chunk 22 QA D1: from the job's snapshots, matched by ref (null when the snapshot does not name it). */
  readonly stance: ReplayStance | null;
}

export interface ReplayFenceLabelView {
  readonly f: number;
  readonly ref: string;
  readonly segment: number;
  readonly tierId: string;
  readonly category: string;
  readonly maxHp: number;
  readonly hp: number;
  readonly displayName: string;
}

export interface ReplayTrapLabelView {
  readonly i: number;
  readonly ref: string;
  readonly typeId: string;
  readonly x: number;
  readonly y: number;
  readonly displayName: string;
  /** What class of trap it is (a siege piece counters a class). Null for a type the content no longer has. */
  readonly category: string | null;
}

/** Chunk 22 QA D1: a siege piece the party brought (the job's party snapshot), and what it counters. */
export interface ReplaySiegeLabelView {
  readonly typeId: string;
  readonly displayName: string;
  readonly counters: { readonly kind: "fence" | "trap"; readonly category: string } | null;
}

export interface ReplayLabelsView {
  readonly units: readonly ReplayUnitLabelView[];
  readonly fences: readonly ReplayFenceLabelView[];
  readonly traps: readonly ReplayTrapLabelView[];
  readonly siege: readonly ReplaySiegeLabelView[];
}

/** Chunk 22 QA S8 / D3: what this encounter settled for the viewer, itemized from the ledger events its job caused. */
export interface ReplaySettledView {
  readonly source: "ledger";
  /** False while the trip loop has not folded the outcome in yet: nothing below is written yet. */
  readonly applied: boolean;
  readonly coin: readonly { readonly reason: string; readonly amount: number; readonly discarded: number }[];
  readonly coinLost: { readonly amount: number; readonly transferred: number; readonly destroyed: number } | null;
  readonly reputation: readonly { readonly pool: string; readonly delta: number }[];
  readonly ladder: readonly { readonly pool: string; readonly pointsDelta: number; readonly levelBefore: number; readonly levelAfter: number }[];
  readonly unlockPoints: readonly { readonly pool: string; readonly points: number }[];
  readonly deMerged: readonly { readonly typeId: string; readonly displayName: string; readonly fromLevel: number; readonly toLevel: number }[];
  readonly destroyed: readonly { readonly typeId: string; readonly displayName: string; readonly mergeLevel: number }[];
  /** The caravan's trip (null for the party's owner): `ended` false = the bank credit and de-merges are not written yet. */
  readonly trip: { readonly ended: boolean; readonly endReason: string | null; readonly unbankedCoin: number | null } | null;
}

/** The end-card tally the server kept when it compacted the log (PHASE-2 §36). */
export interface ReplayCompactedTallyView {
  readonly raiders: number;
  readonly raidersFallen: number;
  readonly defenders: number;
  readonly defendersFallen: number;
  readonly fences: number;
  readonly fencesBroken: number;
  readonly traps: number;
  readonly trapsSprung: number;
  /** Absent in tallies kept before the web player counted nullified traps apart. */
  readonly trapsNullified?: number | undefined;
  readonly coreReached: boolean;
  readonly deepest: { readonly side: "attacker" | "defender"; readonly typeId: string; readonly displayName: string } | null;
}

/** Present only when the tick log was compacted away (PHASE-2 §36). */
export interface ReplayCompactedView {
  readonly reason: "retention" | "size_budget";
  readonly compactedAt: string;
  readonly logCreatedAt: string;
  /** Null for a fight resolved before the server kept tallies. */
  readonly tally: ReplayCompactedTallyView | null;
}

export interface ReplayView {
  readonly jobId: string;
  readonly viewer: ReplayViewer;
  /** The caravan's trip; null in the party owner's body (QA N10). */
  readonly tripId: string | null;
  readonly encounterIndex: number;
  /** Null when the fight was resolved without a log (the dev/test double). */
  readonly resolverVersion: number | null;
  readonly currentResolverVersion: number;
  readonly logFormat: number | null;
  /** False: the server could not read this log (or there is none); `reason` says why. Never rendered. */
  readonly renderable: boolean;
  readonly reason: string | null;
  readonly outcome: ReplayOutcomeView | null;
  readonly labels: ReplayLabelsView;
  readonly settled: ReplaySettledView;
  /** The stored LOG_FORMAT object, untouched; null when none was recorded (or it was compacted). */
  readonly log: unknown;
  /** PHASE-2 §36: set when the log was compacted to its results summary; absent otherwise. */
  readonly compacted?: ReplayCompactedView | null | undefined;
}

/** One of the caravan's fights within retention (GET /me/encounters). */
export interface RecentFightView {
  readonly jobId: string;
  readonly tripId: string;
  readonly encounterIndex: number;
  readonly outcome: EncounterOutcomeKind;
  readonly depth: number;
  readonly settledAt: string;
  /** "log": playable; "no_log": resolved without a stored log; "compacted": only its results summary is kept (PHASE-2 §36); "pruned": past retention, nothing kept. */
  readonly replay: "log" | "no_log" | "compacted" | "pruned";
}

export interface RecentFightsView {
  readonly encounters: readonly RecentFightView[];
  readonly retention: { readonly days: number; readonly minPerCaravan: number };
}
