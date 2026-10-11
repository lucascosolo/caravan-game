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
 */
import { useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { RecruitOfferView, RecruitView } from "../../api/types.ts";
import { navigate } from "../../shell/router.tsx";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { Modal } from "../../shell/Modal.tsx";
import { STRINGS } from "../../strings.ts";

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

export function RecruitPanel({ api, caravanId, view, onRecruited }: RecruitPanelProps): JSX.Element {
  const [confirm, setConfirm] = useState<{ offer: RecruitOfferView; requestId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const recruit = async (): Promise<void> => {
    if (!confirm) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const r = await api.recruit(caravanId, confirm.offer.unitTypeId, confirm.requestId);
      setStatus(T.recruited(confirm.offer.displayName, r.balanceAfter));
      setConfirm(null);
      onRecruited();
    } catch (err) {
      setError(asApiError(err));
      setConfirm(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="recruit-heading" data-testid="recruit-panel">
      <h2 id="recruit-heading">{T.recruitHeading}</h2>
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
              disabled={busy || !o.affordable || view.inventory.full}
              onClick={() => setConfirm({ offer: o, requestId: newRequestId() })}
            >
              {T.recruitButton(o.displayName, o.cost)}
            </button>
            {!o.affordable && <div className="hint">{T.recruitUnaffordable}</div>}
          </li>
        ))}
      </ul>
      {view.locked.length > 0 && (
        <>
          <div className="h3">{T.recruitLockedHeading}</div>
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
        </>
      )}
      {view.inventory.full && <p className="error">{T.inventoryFull}</p>}
      {error && <ErrorBox error={error} heading={T.recruitRefused} />}
      {status && (
        <p className="notice" role="status">
          {status}
        </p>
      )}
      {confirm && (
        <Modal
          title={T.recruitConfirmTitle}
          busy={busy}
          onCancel={() => setConfirm(null)}
          testId="recruit-dialog"
          actions={
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirm(null)}>
                {T.previewCancel}
              </button>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void recruit()}>
                {busy ? T.recruiting : T.recruitYes}
              </button>
            </>
          }
        >
          <p>{T.recruitConfirmBody(confirm.offer.displayName, confirm.offer.cost, view.balance)}</p>
        </Modal>
      )}
    </section>
  );
}
