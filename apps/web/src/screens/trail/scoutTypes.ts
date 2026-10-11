/**
 * The scouting view of an attacking party, client side (chunk 08).
 *
 * Shape: the resolver's `Party` (packages/resolver/src/input.ts) — the standing-party
 * snapshot chunk 09 stores and chunk 14 serves as an encounter. The client imports the
 * TYPE from @caravan/resolver (it never runs the simulation; AGENTS.md "the client never
 * runs the simulation"). EVERYTHING in the party is shown (GUARDRAILS §4): any field
 * present in `PartyUnit` and absent from the scouting panel is a legibility bug.
 */
import type { Party, PartySiege, PartyUnit } from "@caravan/resolver";

export type ScoutedParty = Party;
export type ScoutedUnit = PartyUnit;
export type ScoutedSiege = PartySiege;

export interface ScoutedEncounter {
  readonly encounterIndex: number;
  readonly party: ScoutedParty;
  /**
   * Where this party came from. `fixture` until chunk 14 (matchmaking) lands — the screen
   * says so in a hint, so nobody mistakes a fixture for a matched opponent.
   */
  readonly source: "fixture" | "matchmaking";
  /** A label for the party's owner, when matchmaking provides one. */
  readonly ownerLabel: string | null;
}
