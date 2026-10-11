/**
 * THE SCOUTING FEED SEAM (chunk 08 → chunk 14).
 *
 * The formation screen arranges against ONE scouted party per encounter. Chunk 14
 * (matchmaking & scouting) will serve it: three fully-scoutable candidates with a free,
 * time-gated reroll, then the one the player faces. Until then this module returns a
 * FIXTURE party (scoutFixture.ts) so the screen is complete and testable.
 *
 * Wiring chunk 14 is a change to THIS FILE ONLY: replace the body of `loadScoutedEncounter`
 * with the matchmaking call and map its response onto `ScoutedEncounter` (the party shape
 * is already the resolver's `Party`, which is what chunk 14 stores). `source` becomes
 * `"matchmaking"` and the screen's fixture hint disappears by itself.
 */
import type { Api } from "../../api/client.ts";
import { fixturePartyFor } from "./scoutFixture.ts";
import type { ScoutedEncounter } from "./scoutTypes.ts";

export interface ScoutFeed {
  loadScoutedEncounter(caravanId: string, encounterIndex: number): Promise<ScoutedEncounter>;
}

/** The feed the screen uses. `api` is unused until chunk 14; it is in the signature so the swap is local. */
export function createScoutFeed(_api: Api): ScoutFeed {
  return {
    async loadScoutedEncounter(_caravanId, encounterIndex) {
      // TODO(chunk-14): `const res = await api.scoutEncounter(caravanId, encounterIndex)` and map it.
      return { encounterIndex, party: fixturePartyFor(encounterIndex), source: "fixture", ownerLabel: null };
    },
  };
}
