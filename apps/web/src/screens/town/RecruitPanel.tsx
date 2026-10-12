/**
 * Mercenary recruit (chunk 17 UI for chunk 18's routes): every type the caravan has
 * UNLOCKED, one level-1 copy at its fixed cost, always available — no cooldown, no daily
 * limit (the payload guard refuses a body that claims either). Locked types are listed so
 * the player knows what the Webs would open; they are never sold here (GUARDRAILS §3: the
 * server re-checks access on the POST, this list is not the gate).
 *
 * The cost and the balance are on the button and again in the confirm (a real modal)
 * before anything is spent. A full merge board never blocks a recruit: the new unit lands
 * in the overflow (chunk 17 open question 2).
 *
 * QA-17 N5: pressing Recruit re-reads the list first, so the confirm quotes the CURRENT cost
 * and balance. QA-17 S2: a lost answer (status 0) keeps the confirm open with the same
 * `requestId` and offers "Try again", which replays that request (the server answers a
 * replay with the stored outcome, never a second charge); its copy says "could not
 * confirm", not "refused". Closing it then re-reads the town so the roster is the server's.
 */
import { useRef, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { RecruitOfferView, RecruitView } from "../../api/types.ts";
import { navigate } from "../../shell/router.tsx";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { Modal } from "../../shell/Modal.tsx";
import { STRINGS } from "../../strings.ts";
import { SpendError, unconfirmed } from "./SpendError.tsx";

const T = STRINGS.town;

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

/** A fresh idempotency key per confirm: a retried POST of the same confirm replays, a new confirm buys again. */
function newRequestId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const hex = (n: number): string => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
}

export interface RecruitPanelProps {
  readonly api: Api;
  readonly caravanId: string;
  readonly view: RecruitView;
  /** After a recruit: re-read the list and the roster. */
  readonly onRecruited: () => void;
}

interface Confirm {
  readonly offer: RecruitOfferView;
  /** The balance from the re-read made when the confirm opened (QA-17 N5). */
  readonly balance: number;
  /** One idempotency key per confirm; "Try again" resends it unchanged (QA-17 S2). */
  readonly requestId: string;
  /** The last attempt's answer was lost (status 0): it may have landed. */
  readonly lost: ApiError | null;
}

export function RecruitPanel({ api, caravanId, view, onRecruited }: RecruitPanelProps): JSX.Element {
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [quoting, setQuoting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [errorHeading, setErrorHeading] = useState<string>(T.recruitRefused);
  const [status, setStatus] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const open = async (o: RecruitOfferView): Promise<void> => {
    setQuoting(o.unitTypeId);
    setError(null);
    setStatus(null);
    try {
      const fresh = await api.recruitList(caravanId);
      const offer = fresh.recruitable.find((r) => r.unitTypeId === o.unitTypeId);
      if (!offer) {
        setErrorHeading(T.quoteGone);
        setError(new ApiError(409, "not_recruitable", T.quoteGone));
        onRecruited();
        return;
      }
      setConfirm({ offer, balance: fresh.balance, requestId: newRequestId(), lost: null });
    } catch (err) {
      setErrorHeading(T.quoteFailed);
      setError(asApiError(err));
    } finally {
      setQuoting(null);
    }
  };

  const recruit = async (): Promise<void> => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const r = await api.recruit(caravanId, confirm.offer.unitTypeId, confirm.requestId);
      setStatus(r.replayed ? T.recruitReplayed : T.recruited(confirm.offer.displayName, r.balanceAfter));
      setConfirm(null);
      onRecruited();
    } catch (err) {
      const e = asApiError(err);
      if (unconfirmed(e)) {
        // It may have landed: keep this confirm (and its requestId) so a retry replays it.
        setConfirm({ ...confirm, lost: e });
      } else {
        setErrorHeading(T.recruitRefused);
        setError(e);
        setConfirm(null);
        onRecruited();
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = (): void => {
    if (confirm?.lost) {
      // Walked away from an unconfirmed spend: re-read, so what is shown is the server's.
      setStatus(T.spendUnconfirmedClosed);
      onRecruited();
    }
    setConfirm(null);
  };

  return (
    <section aria-labelledby="recruit-heading" data-testid="recruit-panel">
      <h2 id="recruit-heading" ref={headingRef} tabIndex={-1}>
        {T.recruitHeading}
      </h2>
      <p className="hint">{T.recruitIntro(view.costBase)}</p>
      <p className="hint" data-testid="recruit-inventory">
        {T.inventoryLine(view.inventory.count, view.inventory.cap)}
      </p>
      <ul className="cards" data-testid="recruit-list">
        {view.recruitable.map((o) => (
          <li key={o.unitTypeId} className="card" data-type={o.unitTypeId}>
            <div className="card__head">
              <span className="card__name">{o.displayName}</span>
              <span>{T.coin(o.cost)}</span>
            </div>
            <div className="card__line hint">{T.abilityLine(o.ability.displayName)}</div>
            <button
              type="button"
              className="btn btn--block"
              disabled={busy || quoting !== null || !o.affordable || view.inventory.full}
              onClick={() => void open(o)}
            >
              {quoting === o.unitTypeId ? T.quoteLoading : T.recruitButton(o.displayName, o.cost)}
            </button>
            {!o.affordable && <div className="hint">{T.recruitUnaffordable}</div>}
          </li>
        ))}
      </ul>
      {view.locked.length > 0 && (
        // Final play-test review r2 N13: the locked list is reference, not a choice: collapsed by default.
        <details className="disclosure" data-testid="recruit-locked-details">
          <summary>{T.recruitLockedSummary(view.locked.length)}</summary>
          <ul className="plain" data-testid="recruit-locked">
            {view.locked.map((l) => (
              <li key={l.unitTypeId} data-type={l.unitTypeId}>
                <span className="card__name">{l.displayName}</span> — <span className="hint">{T.recruitLocked}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn--block" onClick={() => navigate("webs")}>
            {T.recruitToWebs}
          </button>
        </details>
      )}
      {view.inventory.full && <p className="error">{T.inventoryFull}</p>}
      {error && <ErrorBox error={error} heading={errorHeading} />}
      {status && (
        <p className="notice" role="status">
          {status}
        </p>
      )}
      {confirm && (
        <Modal
          title={T.recruitConfirmTitle}
          busy={busy}
          onCancel={cancel}
          testId="recruit-dialog"
          restoreFocusTo={() => headingRef.current}
          actions={
            <>
              <button type="button" className="btn" disabled={busy} onClick={cancel}>
                {T.previewCancel}
              </button>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void recruit()} data-testid="recruit-confirm">
                {busy ? T.recruiting : confirm.lost ? T.spendTryAgain : T.recruitYes}
              </button>
            </>
          }
        >
          <p>{T.recruitConfirmBody(confirm.offer.displayName, confirm.offer.cost, confirm.balance)}</p>
          {confirm.lost && <SpendError error={confirm.lost} heading={T.recruitRefused} />}
        </Modal>
      )}
    </section>
  );
}
