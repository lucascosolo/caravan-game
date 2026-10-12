/**
 * THE PACKS SCREEN (chunk 20 web): this week's three tiers, previewed completely before any
 * purchase (GUARDRAILS §4) — fixed price, exact Coin, exact cosmetics (name, kind, what it is
 * drawn on), the overflow forecast per tier AND for every unpurchased tier combined, each
 * tier's purchase state, next week's rotation, and the combined weekly ceiling stated
 * plainly (the P2W number is all three tiers together, never one tier; §2). A loud banner
 * says it is the sandbox stub: no real money moves.
 *
 * Everything shown is the server's (`GET /me/store`); the client computes no forecast, no
 * affordability and no ownership. Opening a confirm RE-READS the store (README §4: the quote
 * is current), so the dialog quotes exactly what the purchase will be checked against.
 *
 * The purchase (`POST /me/store/purchase`) sends `{tier, weekIndex, contentsHash}` — the week
 * and the fingerprint of the contents the player was SHOWN; the server re-derives the offer
 * and never takes contents from the client:
 *   - 201: the grant (Coin credited / discarded at the cap, cosmetics granted / already owned);
 *   - 200 `{replayed: true}`: this tier was already bought this week — shown as "already
 *     yours"; nothing was charged again and nothing moved (QA-20 D1);
 *   - 409 `offer_changed` / `offer_not_current`: what would be granted is no longer what was
 *     shown. Nothing was bought. The store is re-read and the dialog shows the NEW contents
 *     with the server's reason before the player can buy again (QA-20 S2);
 *   - status 0 (the answer was lost): the purchase may have landed. The dialog stays open
 *     with the SAME body and offers "Try again" (src/screens/town/SpendError.tsx): the
 *     server's (account, week, tier) idempotency answers a landed purchase with the 200
 *     replay, never a second grant. Closing it instead re-reads the store.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { CosmeticsView, PackOfferView, PackTierView, PurchaseResult, StoreView } from "../../api/types.ts";
import { useApi } from "../../auth/session.tsx";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { formatWhen } from "../../shell/issues.ts";
import { Modal } from "../../shell/Modal.tsx";
import { navigate } from "../../shell/router.tsx";
import { STRINGS } from "../../strings.ts";
import { SpendError, unconfirmed } from "../town/SpendError.tsx";
import { OverflowLine, PackContents } from "./PackParts.tsx";

const T = STRINGS.store;

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

/** Basis points as "1.5" (integer arithmetic only; two places at most, trailing zeros dropped). */
export function ratioFromBp(bp: number): string {
  const whole = Math.floor(bp / 10_000);
  const hundredths = Math.floor((bp % 10_000) / 100);
  if (hundredths === 0) return String(whole);
  const f = hundredths < 10 ? `0${hundredths}` : String(hundredths);
  return `${whole}.${f.replace(/0$/, "")}`;
}

/** The 409s that mean "what you were shown is not what would be granted now". */
const OFFER_MOVED = new Set(["offer_changed", "offer_not_current"]);

interface Confirm {
  /** The offer as of the re-read made when the confirm opened (or after an `offer_changed`). */
  readonly offer: PackOfferView;
  /** Cosmetic ids already owned (marked "not granted twice"); null when that read failed. */
  readonly owned: ReadonlySet<string> | null;
  /** The last attempt's answer was lost (status 0): it may have landed. Try again resends the SAME body. */
  readonly lost: ApiError | null;
  /** The server refused the last attempt because the offer moved; the contents shown are the new ones. */
  readonly changed: ApiError | null;
}

interface Status {
  readonly text: string;
  readonly extra: readonly string[];
  readonly toCosmetics: boolean;
}

export interface PacksScreenProps {
  /** Injected for tests; defaults to the session's client. */
  readonly api?: Api;
}

async function ownedSet(api: Api): Promise<ReadonlySet<string> | null> {
  try {
    const c: CosmeticsView = await api.cosmetics();
    return new Set(c.owned.map((o) => o.id));
  } catch {
    return null;
  }
}

export function PacksScreen(props: PacksScreenProps = {}): JSX.Element {
  const api = useApi(props.api);
  const [store, setStore] = useState<StoreView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [quoting, setQuoting] = useState<PackTierView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ readonly error: ApiError; readonly heading: string } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async (): Promise<StoreView | null> => {
    try {
      const s = await api.store();
      setStore(s);
      setLoadError(null);
      return s;
    } catch (err) {
      setLoadError(asApiError(err));
      return null;
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const open = async (tier: PackTierView): Promise<void> => {
    setQuoting(tier);
    setError(null);
    setStatus(null);
    try {
      const [fresh, owned] = await Promise.all([api.store(), ownedSet(api)]);
      setStore(fresh);
      setLoadError(null);
      const offer = fresh.offers.find((o) => o.tier === tier);
      if (!offer) {
        setError({ error: new ApiError(409, "offer_not_current", T.goneHeading), heading: T.goneHeading });
        return;
      }
      if (offer.purchased) {
        setStatus({ text: T.alreadyYours(tier, offer.purchasedAt ? formatWhen(offer.purchasedAt) : ""), extra: [], toCosmetics: true });
        return;
      }
      setConfirm({ offer, owned, lost: null, changed: null });
    } catch (err) {
      setError({ error: asApiError(err), heading: T.quoteFailed });
    } finally {
      setQuoting(null);
    }
  };

  const nameOf = (offer: PackOfferView, id: string): string => offer.cosmetics.find((c) => c.id === id)?.displayName ?? id;

  const done = (offer: PackOfferView, r: PurchaseResult): void => {
    if (r.replayed) {
      setStatus({ text: T.alreadyYours(r.purchase.tier, formatWhen(r.purchase.purchasedAt)), extra: [], toCosmetics: true });
    } else {
      const extra: string[] = [];
      if (r.cosmeticsGranted.length > 0) extra.push(T.boughtCosmetics(r.cosmeticsGranted.map((id) => nameOf(offer, id)).join(", ")));
      if (r.cosmeticsAlreadyOwned.length > 0) extra.push(T.boughtOwned(r.cosmeticsAlreadyOwned.map((id) => nameOf(offer, id)).join(", ")));
      setStatus({ text: T.bought(r.purchase.tier, r.coin.credited, r.coin.discarded, r.coin.balanceAfter), extra, toCosmetics: r.cosmeticsGranted.length > 0 });
    }
  };

  const buy = async (): Promise<void> => {
    if (!confirm) return;
    const { offer } = confirm;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      // The SAME body on every attempt of this confirm: tier, the week previewed, the fingerprint shown.
      const r = await api.purchasePack({ tier: offer.tier, weekIndex: offer.weekIndex, contentsHash: offer.contentsHash });
      setConfirm(null);
      done(offer, r);
      void load();
    } catch (err) {
      const e = asApiError(err);
      if (unconfirmed(e)) {
        setConfirm({ ...confirm, lost: e });
      } else if (e.status === 409 && OFFER_MOVED.has(e.code)) {
        // Nothing was bought. Show what the pack holds NOW before any retry.
        const fresh = await load();
        const next = fresh?.offers.find((o) => o.tier === offer.tier);
        if (next && !next.purchased) {
          setConfirm({ offer: next, owned: confirm.owned, lost: null, changed: e });
        } else {
          setConfirm(null);
          setError({ error: e, heading: T.goneHeading });
        }
      } else {
        setConfirm(null);
        setError({ error: e, heading: T.refused });
        void load();
      }
    } finally {
      setBusy(false);
    }
  };

  const cancel = (): void => {
    if (confirm?.lost) {
      setStatus({ text: T.unconfirmedClosed, extra: [], toCosmetics: false });
      void load();
    }
    setConfirm(null);
  };

  const top = (
    <>
      <div className="row row--spread">
        <button type="button" className="btn" onClick={() => navigate("town")}>
          {T.back}
        </button>
        <button type="button" className="btn" onClick={() => navigate("cosmetics")}>
          {T.toCosmetics}
        </button>
      </div>
      <h1 ref={headingRef} tabIndex={-1}>
        {T.title}
      </h1>
      {store?.mode === "off" ? (
        <div className="sandbox-banner" role="note" data-testid="store-off-banner">
          <strong>{T.offHeading}</strong>
          <div>{T.offBody}</div>
        </div>
      ) : (
        <div className="sandbox-banner" role="note" data-testid="sandbox-banner">
          <strong>{T.sandboxHeading}</strong>
          <div>{T.sandboxBody}</div>
          {store && <div className="hint">{store.backend.message}</div>}
        </div>
      )}
    </>
  );

  if (!store) {
    return (
      <section data-testid="packs-screen">
        {top}
        {loadError ? (
          <ErrorBox error={loadError} heading={T.loadFailed} onRetry={() => void load()} />
        ) : (
          <p className="hint" role="status">
            {STRINGS.app.loading}
          </p>
        )}
      </section>
    );
  }

  const { ceiling, combined } = store;
  const tierCount = store.offers.length;

  return (
    <section data-testid="packs-screen" data-week={store.week.index}>
      {top}
      <p>{T.intro}</p>
      <p className="hint">{T.powerNote}</p>
      {loadError && <ErrorBox error={loadError} heading={T.reloadFailed} onRetry={() => void load()} />}

      <section aria-labelledby="ceiling-heading" className="card" data-testid="store-ceiling">
        <h2 id="ceiling-heading" className="h3">
          {T.ceilingHeading}
        </h2>
        <p>{T.ceilingLine(ceiling.weeklyPayCeiling, tierCount)}</p>
        <p className="hint">{T.limitLine(ceiling.purchaseLimitPerTierPerWeek)}</p>
        <p className="hint">{T.ceilingCap(ceiling.storageCap, ceiling.weeklyPayCeiling)}</p>
        <p className="hint">{T.ceilingRatio(ratioFromBp(ceiling.paidToFreeRatioBp), ceiling.freeWeeklyEarnEstimate)}</p>
        <p className="hint">{ceiling.note}</p>
      </section>

      <p data-testid="store-balance">
        {T.balanceLine(store.balance.balance, store.balance.cap, store.balance.room)}
        {store.balance.pendingTrickle > 0 && <span className="hint"> {T.pendingLine(store.balance.pendingTrickle)}</span>}
      </p>

      {status && (
        <div className="notice" role="status" data-testid="store-status">
          <div>{status.text}</div>
          {status.extra.map((x) => (
            <div key={x}>{x}</div>
          ))}
          {status.toCosmetics && (
            <button type="button" className="btn btn--block" style={{ marginTop: 8 }} onClick={() => navigate("cosmetics")}>
              {T.toCosmeticsAfter}
            </button>
          )}
        </div>
      )}
      {error && <ErrorBox error={error.error} heading={error.heading} />}

      <h2>{T.thisWeekHeading}</h2>
      <p className="hint">{T.weekLine(store.week.index, formatWhen(store.week.endsAtMs))}</p>
      <ul className="cards" data-testid="store-offers">
        {store.offers.map((o) => (
          <li key={o.id} className={o.purchased ? "card card--bought" : "card"} data-testid={`offer-${o.tier}`} data-purchased={o.purchased ? "yes" : "no"}>
            <div className="card__head">
              <span className="card__name">{T.tierHead(o.tier, o.priceDisplay)}</span>
              {o.purchased && (
                <span className="badge" data-testid={`offer-${o.tier}-bought`}>
                  <span aria-hidden="true">✓ </span>
                  {T.purchasedBadge}
                </span>
              )}
            </div>
            <div className="h3">{T.contentsHeading}</div>
            <PackContents contents={o.contents} cosmetics={o.cosmetics} testId={`offer-${o.tier}-contents`} />
            {o.purchased ? (
              <p className="hint">{T.purchasedAt(o.purchasedAt ? formatWhen(o.purchasedAt) : "")}</p>
            ) : (
              <>
                <div className="h3">{T.overflowHeading}</div>
                <OverflowLine overflow={o.overflow} testId={`offer-${o.tier}-overflow`} />
                {store.mode === "off" ? (
                  <p className="hint" role="note" data-testid={`buy-${o.tier}-unavailable`}>
                    {T.notAvailable}
                  </p>
                ) : (
                <button
                  type="button"
                  className="btn btn--primary btn--block"
                  disabled={busy || quoting !== null}
                  onClick={() => void open(o.tier)}
                  data-testid={`buy-${o.tier}`}
                >
                  {quoting === o.tier ? T.quoting : T.buyButton(o.tier, o.priceDisplay)}
                </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>

      <section aria-labelledby="combined-heading" className="card" data-testid="store-combined">
        <h2 id="combined-heading" className="h3">
          {T.combinedHeading}
        </h2>
        {combined.tiers.length === 0 ? (
          <p>{T.combinedNone}</p>
        ) : (
          <>
            <p>{T.combinedLine(T.tierList(combined.tiers), combined.coin)}</p>
            <OverflowLine overflow={combined.overflow} testId="combined-overflow" />
          </>
        )}
      </section>

      {store.upcoming.map((w) => (
        <section key={w.weekIndex} aria-labelledby={`upcoming-${w.weekIndex}`} data-testid="store-upcoming">
          <h2 id={`upcoming-${w.weekIndex}`}>{T.nextWeekHeading}</h2>
          <p className="hint">{T.nextWeekLine(w.weekIndex, formatWhen(w.startsAtMs))}</p>
          <p className="hint">{T.nextWeekNote}</p>
          <ul className="cards">
            {w.offers.map((o) => (
              <li key={o.id} className="card card--preview" data-testid={`upcoming-${o.tier}`}>
                <div className="card__head">
                  <span className="card__name">{T.tierHead(o.tier, o.priceDisplay)}</span>
                </div>
                <PackContents contents={o.contents} cosmetics={o.cosmetics} />
              </li>
            ))}
          </ul>
        </section>
      ))}

      {confirm && (
        <Modal
          title={T.confirmTitle(confirm.offer.tier, confirm.offer.priceDisplay)}
          busy={busy}
          onCancel={cancel}
          testId="purchase-dialog"
          restoreFocusTo={() => headingRef.current}
          actions={
            <>
              <button type="button" className="btn" disabled={busy} onClick={cancel}>
                {T.confirmCancel}
              </button>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void buy()} data-testid="purchase-confirm">
                {busy ? T.buying : confirm.lost ? STRINGS.town.spendTryAgain : T.confirmYes}
              </button>
            </>
          }
        >
          <p className="sandbox-banner sandbox-banner--inline">
            <strong>{T.confirmSandbox}</strong>
          </p>
          {confirm.changed && (
            <div className="error" role="alert" data-testid="offer-changed">
              <div>{T.changedHeading}</div>
              <div data-testid="api-error-message">{confirm.changed.message}</div>
              <div className="error__code">
                {confirm.changed.status} {confirm.changed.code}
              </div>
              <div>{T.changedBody}</div>
            </div>
          )}
          <div className="h3">{T.confirmGrant}</div>
          <PackContents contents={confirm.offer.contents} cosmetics={confirm.offer.cosmetics} {...(confirm.owned ? { owned: confirm.owned } : {})} testId="confirm-contents" />
          <div className="h3">{T.confirmOverflowHeading}</div>
          <OverflowLine overflow={confirm.offer.overflow} testId="confirm-overflow" />
          {confirm.lost && <SpendError error={confirm.lost} heading={T.refused} />}
        </Modal>
      )}
    </section>
  );
}
