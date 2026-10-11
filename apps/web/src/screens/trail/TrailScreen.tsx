/**
 * The Trail tab (chunk 08, wired to chunks 07 and 14). The flow for the NEXT encounter
 * (`encountersResolved + 1`) of the caravan's open manifest:
 *
 *   manifest 404 `no_open_manifest`  → "in town, nothing packed" (packing is chunk 17's)
 *   candidates 404 `no_trip`         → packed but the trip is not open (chunk 15 opens it)
 *   candidates 404 `no_search`       → the "Search for parties" button (POST search)
 *   menu with `chosen: null`         → CandidatesScreen: three scoutable parties, free
 *                                      time-gated reroll, choose one
 *   menu with `chosen`               → FormationScreen against that candidate's scouting view
 *
 * Every payload is shape-checked at this boundary (guards.ts); a bad shape is an ErrorBox
 * with Retry, never a thrown TypeError. The server decides who is offered, whether a
 * search is open and whether a choice stands; this screen relays.
 */
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../api/client.ts";
import type { CandidateMenuView, CandidateView } from "../../api/types.ts";
import { useSession } from "../../auth/session.tsx";
import { STRINGS } from "../../strings.ts";
import { CandidatesScreen } from "./CandidatesScreen.tsx";
import { ErrorBox, FormationScreen } from "./FormationScreen.tsx";
import { guardChoice, guardFormation, guardManifest, guardMenu, type FormationState, type TripState } from "./guards.ts";
import { encounterFromCandidate, type ScoutedEncounter } from "./scoutTypes.ts";

const T = STRINGS.trail;

type Loaded =
  | { kind: "loading" }
  | { kind: "in_town" }
  | { kind: "no_trip" }
  | { kind: "ended" }
  | { kind: "error"; error: ApiError }
  | { kind: "unsearched"; caravanId: string; encounterIndex: number }
  | { kind: "menu"; caravanId: string; encounterIndex: number; menu: CandidateMenuView }
  | { kind: "ready"; caravanId: string; trip: TripState; encounterIndex: number; initial: FormationState | null; scout: ScoutedEncounter };

function is404(err: unknown, code: string): boolean {
  return err instanceof ApiError && err.status === 404 && err.code === code;
}

export function TrailScreen(): JSX.Element {
  const { api } = useSession();
  const [state, setState] = useState<Loaded>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);

  const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    setActionError(null);
    try {
      const me = await api.me();
      const caravan = Array.isArray(me?.caravans) ? me.caravans[0] : undefined;
      if (!caravan || typeof caravan.id !== "string") throw new ApiError(0, "bad_payload", STRINGS.app.badPayload);
      let trip: TripState;
      try {
        trip = guardManifest(await api.manifest(caravan.id));
      } catch (err) {
        if (is404(err, "no_open_manifest")) {
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
      let menu: CandidateMenuView;
      try {
        menu = guardMenu(await api.candidates(caravan.id, encounterIndex));
      } catch (err) {
        if (is404(err, "no_trip")) {
          setState({ kind: "no_trip" });
          return;
        }
        if (is404(err, "no_search")) {
          setState({ kind: "unsearched", caravanId: caravan.id, encounterIndex });
          return;
        }
        throw err;
      }
      const chosen = menu.chosen ? menu.candidates.find((c) => c.candidateId === menu.chosen!.candidateId) : undefined;
      if (!chosen) {
        setState({ kind: "menu", caravanId: caravan.id, encounterIndex, menu });
        return;
      }
      let initial: FormationState | null = null;
      try {
        initial = guardFormation(await api.formation(caravan.id, encounterIndex));
      } catch (err) {
        if (!is404(err, "no_formation")) throw err;
      }
      setState({ kind: "ready", caravanId: caravan.id, trip, encounterIndex, initial, scout: encounterFromCandidate(encounterIndex, chosen) });
    } catch (err) {
      setState({ kind: "error", error: asApiError(err) });
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const search = async (caravanId: string, encounterIndex: number): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      const menu = guardMenu(await api.searchCandidates(caravanId, encounterIndex));
      setState({ kind: "menu", caravanId, encounterIndex, menu });
    } catch (err) {
      setActionError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const choose = async (caravanId: string, encounterIndex: number, candidate: CandidateView): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      guardChoice(await api.chooseCandidate(caravanId, encounterIndex, candidate.candidateId));
      await load();
    } catch (err) {
      setActionError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const title = <h1>{T.title}</h1>;
  switch (state.kind) {
    case "loading":
      return (
        <section>
          {title}
          <p className="hint" role="status">
            {STRINGS.app.loading}
          </p>
        </section>
      );
    case "in_town":
      return (
        <section data-testid="trail-in-town">
          {title}
          <p>{T.inTown}</p>
          <p className="hint">{T.inTownBody}</p>
        </section>
      );
    case "no_trip":
      return (
        <section data-testid="trail-no-trip">
          {title}
          <p>{T.noTrip}</p>
          <p className="hint">{T.noTripBody}</p>
        </section>
      );
    case "ended":
      return (
        <section>
          {title}
          <p>{T.tripEnded}</p>
        </section>
      );
    case "error":
      return (
        <section>
          {title}
          <p className="hint">{T.loadFailed}</p>
          <ErrorBox error={state.error} />
          <button type="button" className="btn" onClick={() => void load()}>
            {STRINGS.app.retry}
          </button>
        </section>
      );
    case "unsearched":
      return (
        <section data-testid="trail-unsearched">
          <h1>{T.encounter(state.encounterIndex)}</h1>
          <h2>{T.candidatesHeading}</h2>
          <p className="hint">{T.candidatesIntro}</p>
          {actionError && <ErrorBox error={actionError} />}
          <button type="button" className="btn btn--primary btn--block" disabled={busy} onClick={() => void search(state.caravanId, state.encounterIndex)} data-testid="search">
            {busy ? T.searching : T.searchButton}
          </button>
        </section>
      );
    case "menu":
      return (
        <CandidatesScreen
          encounterIndex={state.encounterIndex}
          menu={state.menu}
          busy={busy}
          error={actionError}
          onSearchAgain={() => void search(state.caravanId, state.encounterIndex)}
          onChoose={(c) => void choose(state.caravanId, state.encounterIndex, c)}
        />
      );
    case "ready":
      return (
        <FormationScreen
          key={`${state.caravanId}:${state.encounterIndex}:${state.scout.candidateId}`}
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
