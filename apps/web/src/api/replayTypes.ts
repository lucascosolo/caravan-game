/**
 * Response type of the replay route (chunk 13 server, chunk 22 client), hand-written: only
 * the fields the replay player renders. The guard in replayShapes.ts is typed against it.
 *
 *   GET /me/encounters/:jobId/replay   ReplayView
 *     404 no_replay       not a participant, malformed or unknown id (no existence oracle)
 *     409 not_resolved    the fight has not been resolved yet
 *     410 replay_expired  the stored log was pruned (LOG_RETENTION)
 *
 * `log` is the stored replay exactly as the resolver encoded it (LOG_FORMAT, packages/
 * resolver/src/replay.ts). The guard does not look inside it: `readReplay` validates the
 * whole thing — envelope, checksum, every row, every keyframe — and refuses anything wrong.
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
}

export interface ReplayFenceLabelView {
  readonly f: number;
  readonly ref: string;
  readonly segment: number;
  readonly tierId: string;
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
}

export interface ReplayLabelsView {
  readonly units: readonly ReplayUnitLabelView[];
  readonly fences: readonly ReplayFenceLabelView[];
  readonly traps: readonly ReplayTrapLabelView[];
}

export interface ReplayView {
  readonly jobId: string;
  readonly viewer: ReplayViewer;
  readonly tripId: string;
  readonly encounterIndex: number;
  /** Null when the fight was resolved without a log (the dev/test double). */
  readonly resolverVersion: number | null;
  readonly currentResolverVersion: number;
  readonly logFormat: number | null;
  /** False: the server could not read this log (or there is none); `reason` says why. Never rendered. */
  readonly renderable: boolean;
  readonly reason: string | null;
  readonly outcome: ReplayOutcomeView | null;
  /** DEPTH_METRIC in one sentence, as the server words it. */
  readonly depthExplained: string;
  readonly labels: ReplayLabelsView;
  /** The stored LOG_FORMAT object, untouched; null when none was recorded. */
  readonly log: unknown;
}
