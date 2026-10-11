/**
 * The Trail tab (chunk 08): loads the caravan's open manifest (chunk 07 route), the draft
 * or committed formation for the NEXT encounter (`encountersResolved + 1`) and the scouted
 * party for it (scoutFeed.ts, a fixture until chunk 14), then hands everything to the
 * formation screen. "In town — nothing packed" is a state, not an error: packing happens
 * in town (chunk 17).
 *
 * Every payload is shape-checked at this boundary (guards.ts); a bad shape is an ErrorBox
 * with Retry, never a thrown TypeError.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { useSession } from "../../auth/session.tsx";
import { STRINGS } from "../../strings.ts";
import { ErrorBox, FormationScreen } from "./FormationScreen.tsx";
import { guardFormation, guardManifest, type FormationState, type TripState } from "./guards.ts";
import { createScoutFeed, type ScoutFeed } from "./scoutFeed.ts";
import type { ScoutedEncounter } from "./scoutTypes.ts";

const T = STRINGS.trail;

type Loaded =
  | { kind: "loading" }
  | { kind: "in_town" }
  | { kind: "ended" }
  | { kind: "error"; error: ApiError }
  | { kind: "ready"; caravanId: string; trip: TripState; encounterIndex: number; initial: FormationState | null; scout: ScoutedEncounter };

export function TrailScreen({ feed }: { feed?: ScoutFeed } = {}): JSX.Element {
  const { api } = useSession();
  const scoutFeed = useMemo(() => feed ?? createScoutFeed(api), [feed, api]);
  const [state, setState] = useState<Loaded>({ kind: "loading" });

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    try {
      const me = await api.me();
      const caravan = Array.isArray(me?.caravans) ? me.caravans[0] : undefined;
      if (!caravan || typeof caravan.id !== "string") throw new ApiError(0, "bad_payload", STRINGS.app.badPayload);
      let trip: TripState;
      try {
        trip = guardManifest(await api.manifest(caravan.id));
      } catch (err) {
        if (err instanceof ApiError && err.status === 404 && err.code === "no_open_manifest") {
          setState({ kind: "in_town" });
          return;
        }
        throw err;
      }
      if (trip.view.closedAt) {
        setState({ kind: "ended" });
        return;
      }
      const encounterIndex = trip.view.encountersResolved + 1;
      let initial: FormationState | null = null;
      try {
        initial = guardFormation(await api.formation(caravan.id, encounterIndex));
      } catch (err) {
        if (!(err instanceof ApiError && err.status === 404 && err.code === "no_formation")) throw err;
      }
      const scout = await scoutFeed.loadScoutedEncounter(caravan.id, encounterIndex);
      setState({ kind: "ready", caravanId: caravan.id, trip, encounterIndex, initial, scout });
    } catch (err) {
      setState({ kind: "error", error: err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError) });
    }
  }, [api, scoutFeed]);

  useEffect(() => {
    void load();
  }, [load]);

  switch (state.kind) {
    case "loading":
      return (
        <section>
          <h1>{T.title}</h1>
          <p className="hint" role="status">
            {STRINGS.app.loading}
          </p>
        </section>
      );
    case "in_town":
      return (
        <section data-testid="trail-in-town">
          <h1>{T.title}</h1>
          <p>{T.inTown}</p>
          <p className="hint">{T.inTownBody}</p>
        </section>
      );
    case "ended":
      return (
        <section>
          <h1>{T.title}</h1>
          <p>{T.tripEnded}</p>
        </section>
      );
    case "error":
      return (
        <section>
          <h1>{T.title}</h1>
          <p className="hint">{T.loadFailed}</p>
          <ErrorBox error={state.error} />
          <button type="button" className="btn" onClick={() => void load()}>
            {STRINGS.app.retry}
          </button>
        </section>
      );
    case "ready":
      return (
        <FormationScreen
          key={`${state.caravanId}:${state.encounterIndex}`}
          api={api}
          caravanId={state.caravanId}
          trip={state.trip}
          encounterIndex={state.encounterIndex}
          initial={state.initial}
          scout={state.scout}
        />
      );
  }
}
