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
 *
 * QA-17 S2: a write whose answer is lost (status 0) may have landed. The panel says "could
 * not confirm" and offers "Try again", which resends the SAME write (same `sequence` /
 * `fromSequence`): the server replays a landed claim, refresh or reroll, never twice. The
 * reroll confirm stays open for that. QA-17 N5: opening the reroll confirm re-reads the menu
 * first, so the cost and balance it quotes are current. QA-17 S5: a claimed menu whose free
 * refresh is due says the next menu is ready and that nothing is forfeited.
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ApiError, type Api } from "../../api/client.ts";
import type { RefugeeView } from "../../api/types.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { STRINGS } from "../../strings.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Note } from "../../ui/Note.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { collapseOffers, refugeeTimer } from "./refugeeModel.ts";
import { SpendError, unconfirmed } from "./SpendError.tsx";
import { ErrorPlate, StatusNote } from "./townBits.tsx";

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
  /** Where the waiting-menu timer hangs as a nailed note on the town scene; in place when absent. */
  readonly noteHost?: HTMLElement | null;
  /** Injected for tests. */
  readonly now?: () => number;
}

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

export function RefugeePanel({ api, caravanId, view, readAt, onView, onReload, onRosterChanged, noteHost = null, now = Date.now }: RefugeePanelProps): JSX.Element {
  const [tick, setTick] = useState(() => now());
  const [busy, setBusy] = useState<null | "claim" | "refresh" | "reroll">(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [confirmReroll, setConfirmReroll] = useState<{ readonly cost: number; readonly balance: number; readonly forfeits: boolean } | null>(null);
  const [quoting, setQuoting] = useState(false);
  /** The last write's answer was lost: what to resend, unchanged, on "Try again". */
  const [lost, setLost] = useState<{ readonly kind: "claim" | "refresh" | "reroll"; readonly error: ApiError; readonly retry: () => Promise<void> } | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

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
    setLost(null);
    let keepConfirm = false;
    try {
      const r = await fn();
      onView(r.view, now());
      setTick(now());
      setStatus(r.status);
      if (r.roster) onRosterChanged();
    } catch (err) {
      const e = asApiError(err);
      if (unconfirmed(e)) {
        // It may have landed: offer the very same write again (the server replays it).
        setLost({ kind, error: e, retry: () => run(kind, fn) });
        keepConfirm = kind === "reroll";
      } else setError(e);
    } finally {
      setBusy(null);
      if (!keepConfirm) setConfirmReroll(null);
    }
  };

  /** Walked away from an unconfirmed write: re-read so what is shown is the server's. */
  const dismissLost = (): void => {
    setLost(null);
    setConfirmReroll(null);
    setStatus(T.spendUnconfirmedClosed);
    onReload();
    onRosterChanged();
  };

  const openReroll = async (): Promise<void> => {
    setQuoting(true);
    setError(null);
    setStatus(null);
    setLost(null);
    try {
      const fresh = await api.refugees(caravanId);
      onView(fresh, now());
      setTick(now());
      if (!fresh.reroll.blockedByFreeRefresh && fresh.reroll.affordable) {
        setConfirmReroll({ cost: fresh.reroll.nextCost, balance: fresh.balance, forfeits: fresh.reroll.forfeitsUnclaimedOffer });
      }
    } catch (err) {
      setError(asApiError(err));
    } finally {
      setQuoting(false);
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
      return { status: r.replayed ? T.refugeeRerollReplayed : T.refugeeRerolled(r.coinCost, r.balanceAfter), view: r.refugees, roster: false };
    });

  const rr = view.reroll;
  const counting = timer.kind === "counting";
  const countingNote = (
    <Note variant="paper" className="town-note">
      <div className="town-row">
        <Icon name="hourglass" />
        <span>{counting ? T.refugeeTimer(timer.mmss) : null}</span>
      </div>
    </Note>
  );
  return (
    <section className="town-panel" aria-labelledby="refugees-heading" data-testid="refugee-panel" data-timer={timer.kind}>
      <h2 id="refugees-heading" ref={headingRef} tabIndex={-1}>
        {T.refugeesHeading}
      </h2>
      <p className="cv-small">{T.refugeesIntro}</p>
      <p className="cv-small">{T.refugeeSlots(view.menu.offers.length, offers.length)}</p>
      <ul className="town-list" data-testid="refugee-offers">
        {offers.map((o) => (
          <li key={o.unitTypeId} className="cv-card town-panel" data-type={o.unitTypeId}>
            <div className="town-row">
              <span className="town-name town-grow">{o.displayName}</span>
              {o.times > 1 && <span className="cv-pill cv-pill--parch cv-pill--sm">{T.refugeeDuplicate(o.times)}</span>}
            </div>
            <div className="cv-small">{T.abilityLine(o.abilityName)}</div>
            {!claimed && (
              <Button variant="primary" block disabled={busy !== null || view.inventory.full} onClick={() => void claim(o.unitTypeId, o.displayName)}>
                {busy === "claim" ? T.claiming : T.refugeeClaim(o.displayName)}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {claimed && claimedName && (
        <p data-testid="refugee-claimed">{timer.kind === "due" ? T.refugeeClaimedPick(claimedName) : T.refugeeAlreadyClaimed(claimedName)}</p>
      )}
      {view.inventory.full && <ErrorPlate>{T.inventoryFull}</ErrorPlate>}

      <div data-testid="refugee-timer">
        {counting && (noteHost ? createPortal(countingNote, noteHost) : countingNote)}
        {timer.kind === "stale" && <p className="cv-small">{STRINGS.app.loading}</p>}
        {timer.kind === "due" && (
          <>
            <p>{timer.claimed ? T.refugeeDueAfterClaim : T.refugeeDue}</p>
            <Button block icon="hourglass" disabled={busy !== null} onClick={() => void refresh()} testId="refugee-refresh">
              {busy === "refresh" ? T.refugeeRefreshing : T.refugeeRefresh}
            </Button>
          </>
        )}
      </div>

      <div className="town-name">{T.refugeeRerollHeading}</div>
      <p className="cv-small">{T.refugeeRerollSchedule(rr.schedule.join(", "))}</p>
      {rr.blockedByFreeRefresh ? (
        <p className="cv-small" data-testid="refugee-reroll-blocked">
          {T.refugeeRerollBlocked}
        </p>
      ) : (
        <>
          {rr.forfeitsUnclaimedOffer && <p className="cv-small">{T.refugeeRerollForfeits}</p>}
          <Button block icon="coin" disabled={busy !== null || quoting || !rr.affordable} disabledReason={rr.affordable ? undefined : T.refugeeUnaffordable} onClick={() => void openReroll()} testId="refugee-reroll">
            {quoting ? T.quoteLoading : T.refugeeReroll(rr.nextCost, rr.nextIndex)}
          </Button>
        </>
      )}

      {error && <ErrorBox error={error} heading={T.refugeeRefused} />}
      {lost && lost.kind !== "reroll" && (
        <div className="town-panel" data-testid="refugee-lost">
          <SpendError error={lost.error} heading={T.refugeeRefused} />
          <div className="town-actions">
            <Button disabled={busy !== null} onClick={dismissLost}>
              {T.previewCancel}
            </Button>
            <Button variant="primary" disabled={busy !== null} onClick={() => void lost.retry()} testId="refugee-try-again">
              {T.spendTryAgain}
            </Button>
          </div>
        </div>
      )}
      {status && <StatusNote>{status}</StatusNote>}

      {confirmReroll && (
        <Sheet
          title={T.refugeeRerollConfirmTitle}
          question
          busy={busy !== null}
          onClose={() => (lost ? dismissLost() : setConfirmReroll(null))}
          testId="reroll-dialog"
          restoreFocusTo={() => headingRef.current}
          footer={
            <div className="town-actions">
              <Button disabled={busy !== null} onClick={() => (lost ? dismissLost() : setConfirmReroll(null))}>
                {T.previewCancel}
              </Button>
              <Button variant="primary" icon="coin" disabled={busy !== null} onClick={() => void (lost?.kind === "reroll" ? lost.retry() : reroll())} testId="reroll-confirm">
                {busy === "reroll" ? T.refugeeRerolling : lost?.kind === "reroll" ? T.spendTryAgain : T.refugeeRerollYes}
              </Button>
            </div>
          }
        >
          <p>{T.refugeeRerollConfirmBody(confirmReroll.cost, confirmReroll.balance, confirmReroll.forfeits)}</p>
          {lost?.kind === "reroll" && <SpendError error={lost.error} heading={T.refugeeRefused} />}
        </Sheet>
      )}
    </section>
  );
}
