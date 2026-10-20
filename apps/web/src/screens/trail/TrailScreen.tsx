/**
 * The Trail tab (chunk 08's encounter screens, driven end to end by chunk 23 over chunk 15's
 * trip loop). Everything follows `GET /me/caravans/:id/trip` (status + phase):
 *
 *   no open trip, a packed manifest  → "packed, waiting to ride out" (ride out from the town)
 *   no open trip, a last trip        → the trip summary of that trip
 *   no open trip, nothing            → "in town, nothing packed"
 *   phase arranging (encounter n)    → candidates 404 `no_search` → "Search for parties";
 *                                      menu unchosen → CandidatesScreen; chosen →
 *                                      FormationScreen, whose commit goes through the trip
 *                                      route (frozen + queued) …
 *   phase resolving                  → ResolvingScreen (polls with backoff)
 *   phase resolution_unavailable     → the fight cannot be resolved yet (said plainly)
 *   phase decide                     → the encounter's results (EncounterResult) → the
 *                                      bank-or-push decision (BankOrPushScreen)
 *   phase ended                      → the trip summary (bank or overrun) → back to town
 *
 * Push leads to the next encounter's search; bank to the summary. Every payload is
 * shape-checked by the API client; a bad shape is an ErrorBox with Retry. The server decides
 * who is offered, which phase the trip is in and what is at stake; this screen relays.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/client.ts";
import type { BankResult, TripEncounterView, TripView } from "../../api/tripTypes.ts";
import type { CandidateMenuView, CandidateView, FormationView, ManifestView } from "../../api/types.ts";
import { useApi } from "../../auth/session.tsx";
import type { Api } from "../../api/client.ts";
import { STRINGS } from "../../strings.ts";
import { navigate } from "../../shell/router.tsx";
import { BankOrPushScreen, type Decided } from "./BankOrPushScreen.tsx";
import { CandidatesScreen } from "./CandidatesScreen.tsx";
import { EncounterResult } from "./EncounterResult.tsx";
import { RecentFights } from "../replay/RecentFights.tsx";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { FormationScreen } from "./FormationScreen.tsx";
import { ResolvingScreen } from "./ResolvingScreen.tsx";
import { TripSummary } from "./TripSummary.tsx";
import { encounterFromCandidate, type ScoutedEncounter } from "./scoutTypes.ts";
import { useOnboarding } from "../../onboarding/OnboardingProvider.tsx";
import type { FormationGuideContext } from "./FormationScreen.tsx";
import { ArrangeGuide, FreeGuide, ResultGuide, ScoutGuide, SearchGuide, showsAt, stepForMoment, type TrailMoment } from "../../onboarding/TrailGuide.tsx";

const T = STRINGS.trail;
const P = STRINGS.trip;

type Loaded =
  | { kind: "loading" }
  | { kind: "in_town" }
  | { kind: "packed" }
  | { kind: "error"; error: ApiError }
  | { kind: "unsearched"; caravanId: string; encounterIndex: number }
  | { kind: "menu"; caravanId: string; encounterIndex: number; menu: CandidateMenuView }
  | { kind: "ready"; caravanId: string; trip: ManifestView; encounterIndex: number; initial: FormationView | null; scout: ScoutedEncounter }
  | { kind: "resolving"; caravanId: string; encounterIndex: number }
  | { kind: "unavailable"; encounterIndex: number }
  | { kind: "decide"; caravanId: string; tripId: string; encounter: TripEncounterView; autoplay: boolean }
  | { kind: "ended"; trip: TripView; past: boolean; balance: number | null; autoplay: boolean };

function is404(err: unknown, code: string): boolean {
  return err instanceof ApiError && err.status === 404 && err.code === code;
}

async function openManifest(api: Api, caravanId: string): Promise<ManifestView | null> {
  try {
    const m = (await api.manifest(caravanId)).manifest;
    return !m || m.closedAt ? null : m;
  } catch (err) {
    if (is404(err, "no_open_manifest")) return null;
    throw err;
  }
}

/** Chunk 24: what the guide needs to know of where the Trail stands. */
function momentOf(state: Loaded): TrailMoment {
  switch (state.kind) {
    case "unsearched":
      return { kind: "arranging", encounterIndex: state.encounterIndex, searched: false, chosen: false };
    case "menu":
      return { kind: "arranging", encounterIndex: state.encounterIndex, searched: true, chosen: false };
    case "ready":
      return { kind: "arranging", encounterIndex: state.encounterIndex, searched: true, chosen: true };
    case "resolving":
      return { kind: "resolving", encounterIndex: state.encounterIndex };
    case "decide":
      return { kind: "decide", encounterIndex: state.encounter.index };
    case "ended":
      return { kind: "ended" };
    default:
      return { kind: "other" };
  }
}

export interface TrailScreenProps {
  /** Injected for tests; defaults to the session's client. */
  readonly api?: Api;
  /** Resolving poll delays (tests pass short ones). */
  readonly pollBackoffMs?: readonly number[];
}

export function TrailScreen(props: TrailScreenProps = {}): JSX.Element {
  const api = useApi(props.api);
  const [state, setState] = useState<Loaded>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<ApiError | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [lastBank, setLastBank] = useState<BankResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** The open trip this screen has seen: its end is "this trip", any other ended trip is "your last trip". */
  const openSeen = useRef<string | null>(null);
  /** Final play-test review S4: a commit just went through; the next result read opens its replay playing. */
  const committedJustNow = useRef(false);

  const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

  const load = useCallback(async (): Promise<void> => {
    setState({ kind: "loading" });
    setActionError(null);
    setDeciding(false);
    try {
      const me = await api.me();
      const caravan = Array.isArray(me?.caravans) ? me.caravans[0] : undefined;
      if (!caravan || typeof caravan.id !== "string") throw new ApiError(0, "bad_payload", STRINGS.app.badPayload);
      const status = await api.tripStatus(caravan.id);
      const trip = status.trip;
      if (!trip || trip.phase === "ended") {
        const packed = await openManifest(api, caravan.id);
        if (packed) setState({ kind: "packed" });
        else if (trip) {
          // Chunk 23 QA N3: the town balance comes from the economy, so a returning player (no
          // bank answer in this session) sees the same summary. A failed read only drops the line.
          const balance = await Promise.resolve()
            .then(() => api.economy())
            .then((e) => e.balance, () => null);
          const autoplay = committedJustNow.current && trip.endReason !== "banked";
          committedJustNow.current = false;
          setState({ kind: "ended", trip, past: openSeen.current !== trip.id, balance, autoplay });
        }
        else setState({ kind: "in_town" });
        return;
      }
      openSeen.current = trip.id;
      if (trip.phase === "resolving") {
        setState({ kind: "resolving", caravanId: caravan.id, encounterIndex: trip.currentEncounter ?? trip.encountersResolved + 1 });
        return;
      }
      if (trip.phase === "resolution_unavailable") {
        setState({ kind: "unavailable", encounterIndex: trip.currentEncounter ?? trip.encountersResolved + 1 });
        return;
      }
      if (trip.phase === "decide") {
        const encounter = trip.encounters.find((e) => e.index === trip.decisionFor);
        if (!encounter) throw new ApiError(0, "bad_payload", STRINGS.app.badPayload, `GET trip: no encounter ${String(trip.decisionFor)} to decide`);
        const autoplay = committedJustNow.current;
        committedJustNow.current = false;
        setState({ kind: "decide", caravanId: caravan.id, tripId: trip.id, encounter, autoplay });
        return;
      }
      // arranging
      const encounterIndex = trip.currentEncounter ?? trip.encountersResolved + 1;
      let menu: CandidateMenuView | null;
      try {
        menu = (await api.candidates(caravan.id, encounterIndex)).menu;
      } catch (err) {
        if (is404(err, "no_search")) {
          setState({ kind: "unsearched", caravanId: caravan.id, encounterIndex });
          return;
        }
        throw err;
      }
      // N10: nothing searched yet is a 200 with no menu (older servers answered 404 no_search, above).
      if (!menu) {
        setState({ kind: "unsearched", caravanId: caravan.id, encounterIndex });
        return;
      }
      const chosen = menu.chosen ? menu.candidates.find((c) => c.candidateId === menu.chosen!.candidateId) : undefined;
      if (!chosen) {
        setState({ kind: "menu", caravanId: caravan.id, encounterIndex, menu });
        return;
      }
      const manifest = await openManifest(api, caravan.id);
      if (!manifest) throw new ApiError(0, "bad_payload", STRINGS.app.badPayload, "GET manifest: the open trip has no open manifest");
      // r2 N10: no draft yet is the normal state on a cold load: asked for as an empty state, not a 404.
      const initial: FormationView | null = await api.formationIfAny(caravan.id, encounterIndex);
      setState({ kind: "ready", caravanId: caravan.id, trip: manifest, encounterIndex, initial, scout: encounterFromCandidate(encounterIndex, chosen) });
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
      const menu = (await api.searchCandidates(caravanId, encounterIndex)).menu;
      setState({ kind: "menu", caravanId, encounterIndex, menu });
    } catch (err) {
      setActionError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  /** Final guardrail review r4 N4: a menu drawn before a game update — back to a free search, with no wait. */
  const staleMenu = (caravanId: string, encounterIndex: number): void => {
    setActionError(null);
    setNotice(T.menuStale);
    setState({ kind: "unsearched", caravanId, encounterIndex });
  };

  /** Final guardrail review r4 S1: no menu can be filled; the server voids the trip through the void path. */
  const returnToTown = async (caravanId: string, encounterIndex: number): Promise<void> => {
    setBusy(true);
    try {
      const st = await api.tripStatus(caravanId);
      if (!st.trip) throw new ApiError(0, "bad_payload", STRINGS.app.badPayload, "GET trip: no open trip to return from");
      await api.returnToTown(caravanId, st.trip.id, encounterIndex);
      setActionError(null);
      await load();
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
      await api.chooseCandidate(caravanId, encounterIndex, candidate.candidateId);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.code === "menu_stale") {
        staleMenu(caravanId, encounterIndex);
        return;
      }
      setActionError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  /** A circle committed through chunk 07's own route but never queued: send it to the fight (idempotent). */
  const sendToFight = async (caravanId: string, encounterIndex: number): Promise<void> => {
    setBusy(true);
    setActionError(null);
    try {
      await api.commitEncounter(caravanId, encounterIndex);
      await load();
    } catch (err) {
      setActionError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const decided = (d: Decided): void => {
    if (d.kind === "banked") {
      setLastBank(d.result);
      setNotice(d.result.replayed ? P.bankReplayed : null);
    } else {
      setLastBank(null);
      setNotice(d.result.replayed ? P.pushReplayed : null);
    }
    void load();
  };

  /** Chunk 23 QA S3: the decision was made elsewhere — say so, and show where the trip stands now. */
  const stale = useCallback((): void => {
    setLastBank(null);
    setNotice(P.decideStale);
    void load();
  }, [load]);

  // ── chunk 24: the first-session guide (only inside the app's provider; tests without one see none) ──
  const onboarding = useOnboarding();
  const guideStep = onboarding?.active ? onboarding.step : null;
  const moment: TrailMoment = momentOf(state);
  const momentKey = JSON.stringify(moment);
  const reach = onboarding?.reach;
  useEffect(() => {
    if (!guideStep || !reach) return;
    const step = stepForMoment(JSON.parse(momentKey) as TrailMoment);
    if (step) void reach(step);
  }, [guideStep, reach, momentKey]);
  const guiding = showsAt(guideStep, moment);
  const isFirst = "encounterIndex" in moment && moment.encounterIndex <= 1;

  const title = <h1>{T.title}</h1>;
  const noticeLine = notice && (
    <p className="notice" role="status" data-testid="trail-notice">
      {notice}
    </p>
  );
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
          <RecentFights api={api} />
        </section>
      );
    case "packed":
      return (
        <section data-testid="trail-no-trip">
          {title}
          <p>{T.noTrip}</p>
          <p className="hint">{T.noTripBody}</p>
          <button type="button" className="btn btn--primary btn--block" onClick={() => navigate("town")}>
            {P.toTown}
          </button>
          <RecentFights api={api} />
        </section>
      );
    case "ended":
      return (
        <>
          {noticeLine}
          <TripSummary trip={state.trip} bank={lastBank} balance={state.balance} past={state.past} autoplayLast={state.autoplay} />
          {/* Chunk 22 QA D2: any fight within retention, not only this trip's. */}
          <RecentFights api={api} />
        </>
      );
    case "error":
      return (
        <section>
          {title}
          <ErrorBox error={state.error} heading={T.loadFailed} onRetry={() => void load()} />
        </section>
      );
    case "unsearched":
      return (
        <section data-testid="trail-unsearched" data-encounter={state.encounterIndex}>
          <h1>{T.encounter(state.encounterIndex)}</h1>
          {noticeLine}
          {guiding && (isFirst ? <SearchGuide /> : <FreeGuide />)}
          <h2>{T.candidatesHeading}</h2>
          <p className="hint">{T.candidatesIntro}</p>
          {actionError && actionError.code !== "pool_empty" && <ErrorBox error={actionError} />}
          <button type="button" className="btn btn--primary btn--block" disabled={busy} onClick={() => void search(state.caravanId, state.encounterIndex)} data-testid="search">
            {busy ? T.searching : T.searchButton}
          </button>
          {actionError?.code === "pool_empty" && (
            <div className="notice" role="alert" data-testid="pool-empty">
              <p>{T.returnToTownBody}</p>
              <button type="button" className="btn btn--block" disabled={busy} onClick={() => void returnToTown(state.caravanId, state.encounterIndex)} data-testid="return-to-town">
                {busy ? T.returningToTown : T.returnToTown}
              </button>
            </div>
          )}
        </section>
      );
    case "menu":
      return (
        <>
          {noticeLine}
          {/* Round 3 S1: the scout reading (pick + ranged pass-over) at EVERY encounter while the guide is active. */}
          {(guiding || guideStep !== null) && <ScoutGuide candidates={state.menu.candidates} encounterIndex={state.encounterIndex} />}
          <CandidatesScreen
          encounterIndex={state.encounterIndex}
          menu={state.menu}
          busy={busy}
          error={actionError}
          onSearchAgain={() => void search(state.caravanId, state.encounterIndex)}
          onChoose={(c) => void choose(state.caravanId, state.encounterIndex, c)}
          />
        </>
      );
    case "ready":
      return (
        <>
          {/* Round 3: the guided steps also come at every later guided encounter (below the circle); this card says so. */}
          {guiding && !isFirst && <FreeGuide />}
          {state.initial?.committedAt && (
            <div className="notice" data-testid="committed-unsent">
              <p>{P.committedUnsent}</p>
              {actionError && <ErrorBox error={actionError} />}
              <button type="button" className="btn btn--primary btn--block" disabled={busy} onClick={() => void sendToFight(state.caravanId, state.encounterIndex)} data-testid="send-to-fight">
                {busy ? P.sending : P.sendToFight}
              </button>
            </div>
          )}
          <FormationScreen
            key={`${state.caravanId}:${state.encounterIndex}:${state.scout.candidateId}`}
            api={api}
            caravanId={state.caravanId}
            trip={state.trip}
            encounterIndex={state.encounterIndex}
            initial={state.initial}
            scout={state.scout}
            onCommitted={() => {
              committedJustNow.current = true;
              void load();
            }}
            onStaleMenu={() => staleMenu(state.caravanId, state.encounterIndex)}
            {...((guiding || guideStep !== null)
              ? { guide: (g: FormationGuideContext) => <ArrangeGuide {...g} scout={state.scout.scout} /> }
              : {})}
          />
        </>
      );
    case "resolving":
      return (
        <ResolvingScreen
          api={api}
          caravanId={state.caravanId}
          encounterIndex={state.encounterIndex}
          onSettled={() => void load()}
          {...(props.pollBackoffMs ? { backoffMs: props.pollBackoffMs } : {})}
        />
      );
    case "unavailable":
      return (
        <section data-testid="resolution-unavailable">
          <h1>{P.unavailableTitle(state.encounterIndex)}</h1>
          <p>{P.unavailableBody}</p>
          <button type="button" className="btn btn--block" onClick={() => void load()}>
            {STRINGS.app.retry}
          </button>
        </section>
      );
    case "decide":
      return deciding ? (
        <>
        {guiding && <ResultGuide encounter={state.encounter} deciding api={api} caravanId={state.caravanId} />}
        <BankOrPushScreen api={api} caravanId={state.caravanId} tripId={state.tripId} encounterIndex={state.encounter.index} onDecided={decided} onStale={stale} />
        </>
      ) : (
        <section data-testid="encounter-results">
          <h1>{T.encounter(state.encounter.index)}</h1>
          {noticeLine}
          {guiding && <ResultGuide encounter={state.encounter} deciding={false} />}
          <EncounterResult encounter={state.encounter} autoplay={state.autoplay} />
          <div className="actions">
            <button type="button" className="btn btn--primary btn--block" onClick={() => setDeciding(true)} data-testid="to-decision">
              {P.toDecision}
            </button>
          </div>
        </section>
      );
  }
}
