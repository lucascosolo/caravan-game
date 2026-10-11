/**
 * The refugee menu (chunk 17 UI for chunk 18's routes). Three slots drawn from the types
 * the caravan has ALREADY unlocked (GUARDRAILS §3); duplicates collapsed ("offered 2×").
 * Take one; the next free menu arrives on the server's timer. When it is due the server
 * says so (`freeRefreshDue`) and the player can take it (free). A Coin reroll buys a
 * SOONER menu from the same pool — its cost is on the button and confirmed in a real modal
 * before anything is spent (GUARDRAILS §4).
 *
 * Every write names the menu it is about (`sequence` / `fromSequence`, chunk 18 QA S1),
 * taken from the last GET. The countdown counts down locally from the server's
 * `msUntilFreeRefresh` between reads and, on reaching zero, re-reads (GET never writes).
 */
import { useEffect, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { RefugeeView } from "../../api/types.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { Modal } from "../../shell/Modal.tsx";
import { STRINGS } from "../../strings.ts";
import { collapseOffers, refugeeTimer } from "./refugeeModel.ts";

const T = STRINGS.town;

export interface RefugeePanelProps {
  readonly api: Api;
  readonly caravanId: string;
  readonly view: RefugeeView;
  /** `Date.now()` when `view` was read; the countdown is measured from it. */
  readonly readAt: number;
  /** A new view from a write (claim / refresh / reroll), with its read time. */
  readonly onView: (view: RefugeeView, readAt: number) => void;
  /** Re-read the menu (the countdown ran out). */
  readonly onReload: () => void;
  /** A unit joined the roster: the town re-reads it. */
  readonly onRosterChanged: () => void;
  /** Injected for tests. */
  readonly now?: () => number;
}

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

export function RefugeePanel({ api, caravanId, view, readAt, onView, onReload, onRosterChanged, now = Date.now }: RefugeePanelProps): JSX.Element {
  const [tick, setTick] = useState(() => now());
  const [busy, setBusy] = useState<null | "claim" | "refresh" | "reroll">(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmReroll, setConfirmReroll] = useState(false);

  const timer = refugeeTimer(view, tick - readAt);
  // A one-second display clock for the countdown only (it counts nothing the server owns).
  useEffect(() => {
    if (timer.kind !== "counting") return;
    const id = window.setInterval(() => setTick(now()), 1000);
    return () => window.clearInterval(id);
  }, [timer.kind, now]);
  useEffect(() => {
    if (timer.kind === "stale") onReload();
  }, [timer.kind, onReload]);

  const offers = collapseOffers(view.menu.offers);
  const claimed = view.menu.claimed;
  const claimedName = claimed ? (view.menu.offers.find((o) => o.unitTypeId === claimed.unitTypeId)?.displayName ?? claimed.unitTypeId) : null;

  const run = async (kind: "claim" | "refresh" | "reroll", fn: () => Promise<{ status: string; view: RefugeeView; roster: boolean }>): Promise<void> => {
    setBusy(kind);
    setError(null);
    setStatus(null);
    try {
      const r = await fn();
      onView(r.view, now());
      setTick(now());
      setStatus(r.status);
      if (r.roster) onRosterChanged();
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setBusy(null);
      setConfirmReroll(false);
    }
  };

  const claim = (unitTypeId: string, name: string): Promise<void> =>
    run("claim", async () => {
      const r = await api.claimRefugee(caravanId, unitTypeId, view.menu.sequence);
      return { status: r.replayed ? T.refugeeReplayed : T.refugeeClaimed(name), view: r.refugees, roster: true };
    });
  const refresh = (): Promise<void> =>
    run("refresh", async () => {
      const r = await api.refreshRefugees(caravanId, view.menu.sequence);
      return { status: T.refugeeRefreshed, view: r.refugees, roster: false };
    });
  const reroll = (): Promise<void> =>
    run("reroll", async () => {
      const r = await api.rerollRefugees(caravanId, view.menu.sequence);
      return { status: T.refugeeRerolled(r.coinCost, r.balanceAfter), view: r.refugees, roster: false };
    });

  const rr = view.reroll;
  return (
    <section aria-labelledby="refugees-heading" data-testid="refugee-panel" data-timer={timer.kind}>
      <h2 id="refugees-heading">{T.refugeesHeading}</h2>
      <p className="hint">{T.refugeesIntro}</p>
      <p className="hint">{T.refugeeSlots(view.menu.offers.length, offers.length)}</p>
      <ul className="cards" data-testid="refugee-offers">
        {offers.map((o) => (
          <li key={o.unitTypeId} className="card" data-type={o.unitTypeId}>
            <div className="card__head">
              <span className="card__name">{o.displayName}</span>
              {o.times > 1 && <span className="hint">{T.refugeeDuplicate(o.times)}</span>}
            </div>
            <div className="card__line hint">{T.abilityLine(o.abilityName)}</div>
            {!claimed && (
              <button type="button" className="btn btn--block btn--primary" disabled={busy !== null || view.inventory.full} onClick={() => void claim(o.unitTypeId, o.displayName)}>
                {busy === "claim" ? T.claiming : T.refugeeClaim(o.displayName)}
              </button>
            )}
          </li>
        ))}
      </ul>
      {claimed && claimedName && <p data-testid="refugee-claimed">{T.refugeeAlreadyClaimed(claimedName)}</p>}
      {view.inventory.full && <p className="error">{T.inventoryFull}</p>}

      <div data-testid="refugee-timer">
        {timer.kind === "counting" && <p>{T.refugeeTimer(timer.mmss)}</p>}
        {timer.kind === "stale" && <p className="hint">{STRINGS.app.loading}</p>}
        {timer.kind === "due" && (
          <>
            <p>{timer.claimed ? T.refugeeDueAfterClaim : T.refugeeDue}</p>
            <button type="button" className="btn btn--block" disabled={busy !== null} onClick={() => void refresh()} data-testid="refugee-refresh">
              {busy === "refresh" ? T.refugeeRefreshing : T.refugeeRefresh}
            </button>
          </>
        )}
      </div>

      <div className="h3">{T.refugeeRerollHeading}</div>
      <p className="hint">{T.refugeeRerollSchedule(rr.schedule.join(", "))}</p>
      {rr.blockedByFreeRefresh ? (
        <p className="hint" data-testid="refugee-reroll-blocked">
          {T.refugeeRerollBlocked}
        </p>
      ) : (
        <>
          {rr.forfeitsUnclaimedOffer && <p className="hint">{T.refugeeRerollForfeits}</p>}
          <button type="button" className="btn btn--block" disabled={busy !== null || !rr.affordable} onClick={() => setConfirmReroll(true)} data-testid="refugee-reroll">
            {T.refugeeReroll(rr.nextCost, rr.nextIndex)}
          </button>
          {!rr.affordable && <p className="hint">{T.refugeeUnaffordable}</p>}
        </>
      )}

      {error && <ErrorBox error={error} heading={T.refugeeRefused} />}
      {status && (
        <p className="notice" role="status">
          {status}
        </p>
      )}

      {confirmReroll && (
        <Modal
          title={T.refugeeRerollConfirmTitle}
          busy={busy !== null}
          onCancel={() => setConfirmReroll(false)}
          testId="reroll-dialog"
          actions={
            <>
              <button type="button" className="btn" disabled={busy !== null} onClick={() => setConfirmReroll(false)}>
                {T.previewCancel}
              </button>
              <button type="button" className="btn btn--primary" disabled={busy !== null} onClick={() => void reroll()}>
                {busy === "reroll" ? T.refugeeRerolling : T.refugeeRerollYes}
              </button>
            </>
          }
        >
          <p>{T.refugeeRerollConfirmBody(rr.nextCost, view.balance, rr.forfeitsUnclaimedOffer)}</p>
        </Modal>
      )}
    </section>
  );
}
