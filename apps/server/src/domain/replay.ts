import type { EncounterOutcome, TickEvent } from "@caravan/resolver";
import type { PartySnapshot } from "./standingParty.js";

/**
 * The symmetrical replay artifact (chunk 09 criterion 6 / chunk 13). There is
 * exactly one `Replay` row per encounter; the party owner and the caravan
 * player who met it are both handed the *same* object by id — there is no
 * per-viewer rendering path that could let them diverge. This is also the
 * standing party owner's only feedback channel, since they were never present
 * for the fight (chunk 13's "founding hook" QA check).
 */
export interface Replay {
  readonly id: string;
  readonly tripId: string;
  readonly partySnapshot: PartySnapshot;
  readonly resolverVersion: string;
  readonly outcome: EncounterOutcome;
  readonly depthFractionMilli: number;
  readonly tickLog: readonly TickEvent[];
  readonly createdAt: string;
}

/**
 * One row in the standing party's results feed (chunk 09 criterion 5): every
 * trip the party was served into, whether it broke the caravan, and a link to
 * that fight's replay.
 */
export interface ResolutionRecord {
  readonly id: string;
  readonly partyId: string;
  readonly partyVersionAtServe: number;
  readonly tripId: string;
  readonly outcome: EncounterOutcome;
  readonly brokeCaravan: boolean;
  readonly replayId: string;
  readonly servedAt: string;
}
