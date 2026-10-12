/**
 * Riding out (chunk 23 over chunk 15's `POST …/trip/start`): the trip cap — uses available
 * and when the next one returns, counted from SERVER time (`nextRegenAtMs − nowMs` of the
 * status read, on the monotonic clock from receipt: shell/countdown.ts) — and the "Ride out"
 * action behind a real modal. The cap is time-gated only: nothing here offers to buy or speed it.
 *
 * Refusals are shown as the server gave them: `trip_cap_exhausted` (its `retryAfterSeconds`
 * restarts the countdown), `trip_open` (already out: go to the trail), `not_packed`. A lost
 * answer (status 0) keeps the dialog open with "Try again"; if the retry finds the trip
 * already open (409 `trip_open`), the first attempt went through and that is said plainly —
 * a start is never counted twice.
 */
import { useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import { expectShape } from "../../api/shape.ts";
import { tripCapRefusalShape } from "../../api/tripShapes.ts";
import type { TripCapRefusal, TripStatusView } from "../../api/tripTypes.ts";
import { formatSeconds, monotonic, useAnchoredCountdown } from "../../shell/countdown.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { Modal } from "../../shell/Modal.tsx";
import { navigate } from "../../shell/router.tsx";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.trip;

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

function capRefusal(error: ApiError | null): TripCapRefusal | null {
  if (!error || error.code !== "trip_cap_exhausted") return null;
  try {
    return expectShape(tripCapRefusalShape, error.body);
  } catch {
    return { cap: { available: 0, cap: 0, regenMs: 1, nextRegenAtMs: null, fullAtMs: null, gate: "time" }, retryAfterSeconds: 0 };
  }
}

/** The cap line on its own (the town shows it in every caravan state). */
export function TripCapLine({ status, now = monotonic }: { readonly status: TripStatusView; readonly now?: () => number }): JSX.Element {
  const cap = status.cap;
  const waitMs = cap.nextRegenAtMs === null ? 0 : Math.max(0, cap.nextRegenAtMs - status.nowMs);
  const left = useAnchoredCountdown(status, waitMs, now);
  return (
    <p data-testid="trip-cap" data-available={cap.available} data-seconds-left={left}>
      {T.capLine(cap.available, cap.cap)} {cap.nextRegenAtMs === null ? T.capFull : left > 0 ? T.capNext(formatSeconds(left)) : T.capNextNow}
    </p>
  );
}

export interface RideOutPanelProps {
  readonly api: Api;
  readonly caravanId: string;
  /** The latest trip status read: the cap and the server's clock at that read. */
  readonly status: TripStatusView;
  /** A refusal from a start already tried (the outfit screen's pack-and-ride-out). */
  readonly initialError?: ApiError | null;
  /** The trip is open; `replayed` when a retried start found it already open. */
  readonly onStarted: (status: TripStatusView | null, replayed: boolean) => void;
  /** N9: when given, an "Unpack" button closes the unused manifest (the units go back to the roster) and this is called. */
  readonly onUnpacked?: () => void;
  readonly now?: () => number;
}

export function RideOutPanel({ api, caravanId, status, initialError = null, onStarted, onUnpacked, now = monotonic }: RideOutPanelProps): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(initialError);
  const [lost, setLost] = useState<ApiError | null>(null);
  const cap = status.cap;
  const waitMs = cap.nextRegenAtMs === null ? 0 : Math.max(0, cap.nextRegenAtMs - status.nowMs);
  const left = useAnchoredCountdown(status, waitMs, now);
  const refusal = capRefusal(error);
  const refusedLeft = useAnchoredCountdown(refusal, (refusal?.retryAfterSeconds ?? 0) * 1000, now);
  const canRide = !busy && refusedLeft === 0 && (cap.available > 0 || left === 0 || refusal !== null);

  const unpack = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await api.unpackManifest(caravanId);
      onUnpacked?.();
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(false);
    }
  };

  const start = async (): Promise<void> => {
    setBusy(true);
    try {
      const res = await api.startTrip(caravanId);
      setConfirming(false);
      setLost(null);
      onStarted(res.status, false);
    } catch (err) {
      const e = asApiError(err);
      if (e.status === 0) {
        // The start may have committed and only the answer been lost: keep the dialog, offer Try again.
        setLost(e);
        return;
      }
      if (lost && e.code === "trip_open") {
        setConfirming(false);
        setLost(null);
        onStarted(null, true);
        return;
      }
      setConfirming(false);
      setLost(null);
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="ride-out-heading" data-testid="ride-out">
      <h2 id="ride-out-heading">{T.packedTitle}</h2>
      <p className="hint">{T.packedBody}</p>
      <TripCapLine status={status} now={now} />
      <p className="hint">{T.capRule(Math.round(cap.regenMs / 60_000))}</p>
      {refusal && (
        <p className="error" role="alert" data-testid="ride-out-refused">
          {refusedLeft > 0 ? T.rideOutCapRefused(formatSeconds(refusedLeft)) : T.rideOutCapBack}
        </p>
      )}
      {error?.code === "trip_open" && (
        <div className="error" role="alert" data-testid="ride-out-open">
          <div>{T.rideOutAlready}</div>
          <button type="button" className="btn btn--block" onClick={() => navigate("trail")}>
            {T.toTrail}
          </button>
        </div>
      )}
      {error?.code === "not_packed" && (
        <p className="error" role="alert" data-testid="ride-out-not-packed">
          {T.rideOutNotPacked}
        </p>
      )}
      {error && !refusal && error.code !== "trip_open" && error.code !== "not_packed" && <ErrorBox error={error} />}
      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={!canRide}
        onClick={() => {
          setError(null);
          setConfirming(true);
        }}
        data-testid="ride-out-open-confirm"
      >
        {T.rideOut}
      </button>
      {onUnpacked && (
        <button type="button" className="btn btn--block" disabled={busy} onClick={() => void unpack()} data-testid="ride-out-unpack">
          {T.unpack}
        </button>
      )}
      {confirming && (
        <Modal
          title={T.rideOutTitle}
          busy={busy}
          onCancel={() => {
            setConfirming(false);
            setLost(null);
          }}
          testId="ride-out-dialog"
          restoreFocusTo={() => document.getElementById("ride-out-heading")}
          actions={
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>
                {T.rideOutNo}
              </button>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void start()} data-testid="ride-out-confirm">
                {busy ? T.ridingOut : lost ? T.rideOutTryAgain : T.rideOutYes}
              </button>
            </>
          }
        >
          <p>{T.rideOutBody(cap.available, cap.cap)}</p>
          {lost && (
            <div className="error" role="alert" data-testid="ride-out-unconfirmed">
              <div>{T.rideOutUnconfirmed}</div>
              <div>{T.rideOutUnconfirmedBody}</div>
              <div className="error__code">{lost.code}</div>
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}
