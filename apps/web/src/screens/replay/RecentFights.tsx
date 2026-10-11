/**
 * "Recent fights" (chunk 22 QA D2): every fight of the caravan's still kept by the replay
 * retention rule, newest first, each with "Watch" — so the caravan's player can open any
 * encounter they were part of, not only the current trip's. Read from GET /me/encounters
 * when the player opens the list (never before: the Trail does not pay for it on every visit).
 * The server decides what is listed and whether each replay still exists; nothing is computed here.
 */
import { useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { RecentFightsView } from "../../api/replayTypes.ts";
import { useApi } from "../../auth/session.tsx";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { STRINGS } from "../../strings.ts";
import { WatchFight } from "./WatchFight.tsx";

const T = STRINGS.replay;

type State = { readonly k: "closed" } | { readonly k: "loading" } | { readonly k: "error"; readonly error: ApiError } | { readonly k: "ready"; readonly view: RecentFightsView };

const when = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export function RecentFights({ api: apiProp }: { readonly api?: Api }): JSX.Element {
  const api = useApi(apiProp);
  const [state, setState] = useState<State>({ k: "closed" });
  const load = async (): Promise<void> => {
    setState({ k: "loading" });
    try {
      setState({ k: "ready", view: await api.recentFights() });
    } catch (err) {
      setState({ k: "error", error: err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError) });
    }
  };
  const open = state.k !== "closed";
  return (
    <section className="recent-fights" data-testid="recent-fights" aria-labelledby="recent-fights-heading">
      <h2 id="recent-fights-heading">{T.recentHeading}</h2>
      <button type="button" className="btn btn--block" aria-expanded={open} data-testid="recent-fights-toggle" onClick={() => (open ? setState({ k: "closed" }) : void load())}>
        {open ? T.recentHide : T.recentOpen}
      </button>
      {state.k === "loading" && (
        <p className="hint" role="status">
          {T.recentLoading}
        </p>
      )}
      {state.k === "error" && <ErrorBox error={state.error} heading={T.recentFailed} onRetry={() => void load()} />}
      {state.k === "ready" && (
        <>
          <p className="hint">{T.recentIntro(state.view.retention.days, state.view.retention.minPerCaravan)}</p>
          {state.view.encounters.length === 0 ? (
            <p className="hint">{T.recentEmpty}</p>
          ) : (
            <ul className="cards" data-testid="recent-fights-list">
              {state.view.encounters.map((e) => (
                <li key={e.jobId} className="card" data-testid={`recent-fight-${e.jobId}`} data-replay={e.replay}>
                  <div className="card__line">{T.recentLine(e.encounterIndex, T.recentOutcome(e.outcome), when(e.settledAt))}</div>
                  {e.replay === "pruned" ? (
                    <p className="hint">{T.recentPruned}</p>
                  ) : (
                    <>
                      {e.replay === "no_log" && <p className="hint">{T.recentNoLog}</p>}
                      <WatchFight jobId={e.jobId} encounterIndex={e.encounterIndex} label={T.recentWatch} api={api} testId={`recent-watch-${e.jobId}`} />
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
