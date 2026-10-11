/**
 * The scouting view of an attacking party, client side (chunk 08, wired to chunk 14).
 *
 * Shape: `PartyScoutView` from @caravan/circle — `scoutParty(party)` — which is EXACTLY
 * what the server stores on each matchmaking candidate (`candidate.scout`) and what the
 * party's owner previews. The client reads the type and never rebuilds the view itself.
 * EVERYTHING in it is shown (GUARDRAILS §4): any field present in `ScoutUnit` or
 * `ScoutSiege` and absent from the scouting panel is a legibility bug.
 */
import type { PartyScoutView, ScoutSiege, ScoutUnit } from "@caravan/circle";
import type { CandidateView } from "../../api/types.ts";

export type ScoutedParty = PartyScoutView;
export type ScoutedUnit = ScoutUnit;
export type ScoutedSiege = ScoutSiege;

/** The party this encounter is arranged against: the CHOSEN matchmaking candidate. */
export interface ScoutedEncounter {
  readonly encounterIndex: number;
  readonly candidateId: string;
  readonly owner: CandidateView["owner"];
  readonly reputation: CandidateView["reputation"];
  readonly scout: ScoutedParty;
  /** `matchmaking` in the app; `fixture` only in component tests (scoutFixture.ts). */
  readonly source: "fixture" | "matchmaking";
}

export function encounterFromCandidate(encounterIndex: number, c: CandidateView): ScoutedEncounter {
  return { encounterIndex, candidateId: c.candidateId, owner: c.owner, reputation: c.reputation, scout: c.scout, source: "matchmaking" };
}
