/**
 * "Resolving" (chunk 23): the circle is committed and the fight runs on the server with no
 * live input (GUARDRAILS §1). This screen polls `GET /me/caravans/:id/trip` with backoff —
 * reading it also settles a finished resolution (chunk 15's lazy settle) — until the phase
 * leaves `resolving`, then hands the new status up. A failed check is shown with Retry and
 * stops the polling (no silent hammering). "Check now" re-reads immediately.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { TripStatusView } from "../../api/tripTypes.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.trip;

/** Poll delays (ms): 1 s, 2 s, 4 s, 8 s, then every 15 s. Not balance; a client courtesy. */
export const RESOLVE_POLL_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];

export interface ResolvingScreenProps {
  readonly api: Api;
  readonly caravanId: string;
  readonly encounterIndex: number;
  /** The phase moved on (decide, ended, or unavailable): the Trail re-renders from this status. */
  readonly onSettled: (status: TripStatusView) => void;
  readonly backoffMs?: readonly number[];
}

export function ResolvingScreen({ api, caravanId, encounterIndex, onSettled, backoffMs = RESOLVE_POLL_BACKOFF_MS }: ResolvingScreenProps): JSX.Element {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [waitS, setWaitS] = useState(Math.ceil((backoffMs[0] ?? 1000) / 1000));
  const timer = useRef<number | null>(null);
  const alive = useRef(true);
  const settledRef = useRef(onSettled);
  settledRef.current = onSettled;

  const check = useCallback(async (): Promise<void> => {
    try {
      const status = await api.tripStatus(caravanId);
      if (!alive.current) return;
      if (status.trip?.phase !== "resolving" || status.trip.currentEncounter !== encounterIndex) {
        settledRef.current(status);
        return;
      }
      setAttempt((a) => a + 1);
    } catch (err) {
      if (!alive.current) return;
      setError(err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));
    }
  }, [api, caravanId, encounterIndex]);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (error) return;
    const delay = backoffMs[Math.min(attempt, backoffMs.length - 1)] ?? 1000;
    setWaitS(Math.ceil(delay / 1000));
    timer.current = window.setTimeout(() => void check(), delay);
    return () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, [attempt, error, check, backoffMs]);

  return (
    <section data-testid="resolving-screen" data-encounter={encounterIndex}>
      <h1>{T.resolvingTitle(encounterIndex)}</h1>
      <p role="status">{T.resolvingBody}</p>
      {error ? (
        <ErrorBox
          error={error}
          heading={T.resolvingFailed}
          onRetry={() => {
            setError(null);
            setAttempt(0);
          }}
        />
      ) : (
        <>
          <p className="hint" data-testid="resolving-next">
            {T.resolvingCheck(waitS)}
          </p>
          <button
            type="button"
            className="btn btn--block"
            onClick={() => {
              if (timer.current !== null) window.clearTimeout(timer.current);
              void check();
            }}
            data-testid="resolving-check"
          >
            {T.resolvingCheckNow}
          </button>
        </>
      )}
    </section>
  );
}
