/**
 * BANK OR PUSH (chunk 23) — the single most important legibility screen in the game
 * (PHASE-2 §23, GUARDRAILS §4). Shown only after surviving an encounter. Every stake the
 * design names is itemized, each straight from `GET /me/caravans/:id/trip/preview`; nothing
 * on this screen is computed by the client:
 *
 *   - unbanked Coin: the total and each encounter's share (trip state, never the balance);
 *   - banking now: encounter Coin + delivery bonus, the overflow forecast against the
 *     store's room right now (what would be credited, what discarded), and every unit that
 *     died on the trip with the level the bank drops it to (`bankNow.unitsDeMerged`);
 *   - every packed unit: alive or dead (since which encounter), HP and damage carried, and
 *     the merge level it would drop to on death;
 *   - if overrun at the next encounter: all unbanked Coin lost and where it goes, which units
 *     are lost outright (alive now; one that dies in that last fight is de-merged instead), which
 *     are de-merged instead (already dead), each with its level change;
 *   - traps still armed / spent, fence segments intact (with damage) / destroyed;
 *   - the next encounter: its reward, the bank total if survived, its difficulty (chunk 14's
 *     escalation) and that its party arrives fresh;
 *   - the last opponent's Reputation hooks (gap beyond the band, earn multiplier).
 *
 * Both choices go through a real modal that re-reads the preview first (README §4: a quote
 * is current) and restates what is at stake. The decision names its encounter
 * (`{ tripId, encounterIndex }`), so a lost answer can be retried with the very same body:
 * the server replays it, never decides twice. There is nothing to buy here (GUARDRAILS §2).
 */
import { FIXED_ONE } from "@caravan/content";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { BankResult, DeMergedUnitView, PushResult, StakesPreview } from "../../api/tripTypes.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { Modal } from "../../shell/Modal.tsx";
import { STRINGS } from "../../strings.ts";
import { Icon } from "../../ui/Icon.tsx";
import { CoinRibbon } from "../replay/Moments.tsx";
import { fenceLabel, trapTypeName, unitLabel, unitTypeName } from "./tripNames.ts";

const T = STRINGS.trip;
const R = STRINGS.results;

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

export type Decided = { readonly kind: "pushed"; readonly result: PushResult } | { readonly kind: "banked"; readonly result: BankResult };

export interface BankOrPushScreenProps {
  readonly api: Api;
  readonly caravanId: string;
  readonly tripId: string;
  /** The survived encounter this decision is about. */
  readonly encounterIndex: number;
  readonly onDecided: (d: Decided) => void;
  /**
   * The decision was closed elsewhere (another tab, or a lost answer that did go through):
   * the Trail re-reads the trip and shows its current phase (chunk 23 QA S3). Absent, the
   * closed banner carries no way on.
   */
  readonly onStale?: () => void;
}

/** One line per de-merged unit: "Dust Rider · L4 → L3". */
export function DeMergedList({ units, testId }: { readonly units: readonly DeMergedUnitView[]; readonly testId: string }): JSX.Element {
  return (
    <ul className="rs-ledger" data-testid={testId}>
      {units.map((u) => (
        <li key={u.ref} data-testid={`${testId}-${u.ref}`}>
          <Icon name="wounded" />
          {T.levelChange(unitTypeName(u.typeId), u.fromLevel, u.toLevel)}
        </li>
      ))}
    </ul>
  );
}

/** Grouped trap names: "Spike Pit ×2, Snare". */
function trapNames(traps: readonly { readonly typeId: string }[]): string {
  const counts = new Map<string, number>();
  for (const t of traps) counts.set(t.typeId, (counts.get(t.typeId) ?? 0) + 1);
  return [...counts].map(([id, n]) => (n > 1 ? `${trapTypeName(id)} ×${n}` : trapTypeName(id))).join(", ");
}

export function Stakes({ preview }: { readonly preview: StakesPreview }): JSX.Element {
  const p = preview;
  const bankNow = p.bankNow;
  const f = bankNow?.forecast;
  const damagedFences = p.fences.intact.filter((x) => x.hp < x.maxHp);
  const rep = p.lastOpponent?.reputation;
  return (
    <>
      <section className="cv-card cv-card--canvas" data-testid="stake-unbanked">
        <h2>{T.unbankedHeading}</h2>
        <div className="rs-stake-big">
          <span className="cv-chip cv-chip--risk rs-riskchip" aria-hidden="true">
            <Icon name="strongbox-cracked" />
            <span className="cv-num">{p.unbankedCoin.total}</span>
            <span className="cv-chip__word">{R.atRisk}</span>
          </span>
          <p>
            <strong>{T.unbankedTotal(p.unbankedCoin.total)}</strong>
          </p>
        </div>
        <ul className="rs-ledger">
          {p.unbankedCoin.byEncounter.map((e) => (
            <li key={e.index}>
              <Icon name="trail-sign" />
              {T.unbankedEncounter(e.index, e.coin)}
            </li>
          ))}
        </ul>
      </section>

      <section className="cv-card" data-testid="stake-bank">
        <h2>{T.bankHeading}</h2>
        {/* Chunk 15 QA N2: the server omits the bank quote before the first survived encounter. */}
        {!bankNow || !f ? (
          <p className="hint" data-testid="stake-bank-none">
            {T.bankNotYet}
          </p>
        ) : (
          <>
            <div className="rs-coinline">
              <CoinRibbon amount={bankNow.total} />
              <p>{T.bankLine(bankNow.encounterCoin, bankNow.deliveryBonus, bankNow.total)}</p>
            </div>
            <p data-testid="stake-bank-forecast" className={f.wouldDiscard > 0 ? "error" : undefined} role={f.wouldDiscard > 0 ? "alert" : undefined}>
              {f.wouldDiscard > 0 ? T.bankForecastOverflow(f.wouldCredit, f.wouldDiscard, f.balance, f.cap) : T.bankForecastFits(f.wouldCredit, f.balance, f.cap)}
            </p>
            {bankNow.unitsDeMerged.length === 0 ? (
              <p className="hint" data-testid="stake-bank-demerged-none">
                {T.bankDemergedNone}
              </p>
            ) : (
              <>
                <p>{T.bankDemergedHeading}</p>
                <DeMergedList units={bankNow.unitsDeMerged} testId="stake-bank-demerged" />
              </>
            )}
          </>
        )}
      </section>

      <section className="cv-card" data-testid="stake-units">
        <h2>{T.unitsHeading}</h2>
        <ul className="rs-ledger">
          {p.units.map((u) => (
            <li key={u.ref} className="rs-unit" data-testid={`stake-unit-${u.ref}`} data-alive={u.alive ? "true" : "false"}>
              <strong className="rs-unit__name">
                <Icon name={u.alive ? "heart" : "grave"} />
                {unitLabel(u)}
              </strong>
              <div>{u.alive ? T.unitAlive(u.hp, u.maxHp, u.damage) : u.diedAtEncounter !== null ? T.unitDead(u.diedAtEncounter) : T.unitDeadAtLevel}</div>
              <div className="hint">{u.alive ? T.unitOnDeath(u.mergeLevel, u.mergeLevelOnDeath) : T.unitDemerge(u.mergeLevel, u.mergeLevelOnDeath)}</div>
            </li>
          ))}
        </ul>
      </section>

      <section className="cv-note cv-note--shade rs-risk" data-testid="stake-overrun">
        <h2>{T.overrunHeading}</h2>
        <p className="hint" data-testid="stakes-line">
          {STRINGS.outfit.stakesLine}
        </p>
        <p>
          <strong>{T.overrunCoin(p.ifOverrun.coinLost)}</strong>
        </p>
        {p.ifOverrun.coinLost > 0 && (
          <p className="hint" data-testid="stake-overrun-coin-goes">
            {T.overrunCoinGoesTo(p.ifOverrun.coinGoesTo)}
          </p>
        )}
        <p>{T.overrunLost}</p>
        <ul className="rs-ledger" data-testid="stake-overrun-lost">
          {p.ifOverrun.unitsLostOutright.length === 0 ? <li className="hint">{T.none}</li> : p.ifOverrun.unitsLostOutright.map((u) => (
                <li key={u.ref}>
                  <Icon name="grave" />
                  {unitLabel(u)}
                </li>
              ))}
        </ul>
        {p.ifOverrun.unitsLostOutright.length > 0 && T.overrunFinalFight(p.ifOverrun.unitDyingInTheFinalFight) !== "" && (
          <p className="hint" data-testid="stake-overrun-final-fight">
            {T.overrunFinalFight(p.ifOverrun.unitDyingInTheFinalFight)}
          </p>
        )}
        <p>{T.overrunDemerged}</p>
        {p.ifOverrun.unitsDeMergedNotDestroyed.length === 0 ? (
          <ul className="rs-ledger" data-testid="stake-overrun-demerged">
            <li className="hint">{T.none}</li>
          </ul>
        ) : (
          <DeMergedList units={p.ifOverrun.unitsDeMergedNotDestroyed} testId="stake-overrun-demerged" />
        )}
      </section>

      <section className="cv-card" data-testid="stake-traps">
        <h2>{T.trapsHeading}</h2>
        <p>
          {T.trapsRemaining(p.traps.remaining.length)}
          {p.traps.remaining.length > 0 ? `: ${trapNames(p.traps.remaining)}` : ""}
        </p>
        <p>
          {T.trapsSpent(p.traps.spent.length)}
          {p.traps.spent.length > 0 ? `: ${trapNames(p.traps.spent)}` : ""}
        </p>
      </section>

      <section className="cv-card" data-testid="stake-fences">
        <h2>{T.fencesHeading}</h2>
        <p>{T.fencesIntact(p.fences.intact.length)}</p>
        {damagedFences.length > 0 && (
          <ul className="rs-ledger">
            {damagedFences.map((x) => (
              <li key={x.ref}>
                {fenceLabel(x)} · {T.fenceHp(x.hp, x.maxHp)}
              </li>
            ))}
          </ul>
        )}
        <p>{T.fencesDestroyed(p.fences.destroyed.length)}</p>
        {p.fences.destroyed.length > 0 && (
          <ul className="rs-ledger">
            {p.fences.destroyed.map((x) => (
              <li key={x.ref}>{fenceLabel(x)}</li>
            ))}
          </ul>
        )}
      </section>

      <section className="cv-card" data-testid="stake-next">
        <h2>{T.nextHeading(p.nextEncounter.index)}</h2>
        <p>{T.nextReward(p.nextEncounter.reward)}</p>
        <p>{T.nextBankTotal(p.nextEncounter.bankTotalIfSurvived)}</p>
        <p data-testid="stake-next-difficulty">
          {p.nextEncounter.difficulty.harderThanThisEncounter
            ? T.nextDifficulty(p.nextEncounter.difficulty.escalationApplied, p.nextEncounter.difficulty.risePerEncounter)
            : T.nextDifficultySame(p.nextEncounter.difficulty.escalationApplied)}
        </p>
        {p.nextEncounter.partyArrivesFresh && <p>{T.nextFresh}</p>}
      </section>

      {rep && (rep.gapBeyondBand !== undefined || rep.sandbagEarnMultiplier !== undefined) && (
        <section className="cv-card" data-testid="stake-opponent">
          <h2>{T.lastOpponentHeading}</h2>
          <p className="hint">
            {[
              rep.gapBeyondBand !== undefined ? T.lastOpponentGap(rep.gapBeyondBand) : null,
              rep.sandbagEarnMultiplier !== undefined ? T.lastOpponentEarn(Math.round((rep.sandbagEarnMultiplier * 100) / FIXED_ONE)) : null,
            ]
              .filter((s): s is string => s !== null)
              .join(" · ")}
          </p>
        </section>
      )}
    </>
  );
}

type Confirm = {
  readonly kind: "bank" | "push";
  readonly preview: StakesPreview | null;
  /** The confirm's own re-read failed (chunk 23 QA N2): shown inside the modal, with Retry. */
  readonly readError: ApiError | null;
  readonly lost: ApiError | null;
};

export function BankOrPushScreen({ api, caravanId, tripId, encounterIndex, onDecided, onStale: onStaleProp }: BankOrPushScreenProps): JSX.Element {
  // Held in a ref so a parent's fresh closure each render never re-runs the initial read.
  const staleRef = useRef(onStaleProp);
  staleRef.current = onStaleProp;
  const hasStale = onStaleProp !== undefined;
  const onStale = useCallback((): void => staleRef.current?.(), []);
  const [preview, setPreview] = useState<StakesPreview | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  /** Is this preview still about the decision this screen was opened for? */
  const isOpen = useCallback((p: StakesPreview): boolean => p.decisionOpen && p.decisionFor === encounterIndex && p.tripId === tripId, [encounterIndex, tripId]);

  const read = useCallback(async (): Promise<{ preview: StakesPreview } | { error: ApiError }> => {
    try {
      return { preview: await api.tripPreview(caravanId) };
    } catch (err) {
      return { error: asApiError(err) };
    }
  }, [api, caravanId]);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    const r = await read();
    if ("error" in r) {
      // No open trip any more (404 no_trip): the decision was closed elsewhere.
      if (r.error.status === 404 && hasStale) onStale();
      else setLoadError(r.error);
      return;
    }
    setPreview(r.preview);
    // Chunk 23 QA S3: decided elsewhere → the Trail re-reads the trip and shows where it is now.
    if (!isOpen(r.preview) && hasStale) onStale();
  }, [read, isOpen, onStale, hasStale]);

  useEffect(() => {
    void load();
  }, [load]);

  const reread = async (kind: "bank" | "push"): Promise<void> => {
    setConfirm({ kind, preview: null, readError: null, lost: null });
    // Re-read the stakes before quoting them (README §4).
    const r = await read();
    if ("error" in r) {
      if (r.error.status === 404 && hasStale) {
        setConfirm(null);
        onStale();
        return;
      }
      setConfirm((c) => (c && c.kind === kind ? { ...c, readError: r.error } : c));
      return;
    }
    setPreview(r.preview);
    if (!isOpen(r.preview) && hasStale) {
      setConfirm(null);
      onStale();
      return;
    }
    setConfirm((c) => (c && c.kind === kind ? { ...c, preview: r.preview } : c));
  };

  const open = async (kind: "bank" | "push"): Promise<void> => {
    setError(null);
    await reread(kind);
  };

  const decide = async (): Promise<void> => {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.kind === "bank") onDecided({ kind: "banked", result: await api.bankTrip(caravanId, tripId, encounterIndex) });
      else onDecided({ kind: "pushed", result: await api.pushTrip(caravanId, tripId, encounterIndex) });
      setConfirm(null);
    } catch (err) {
      const e = asApiError(err);
      if (e.status === 0) {
        // The decision may have landed; the same body replays it, never decides twice.
        setConfirm((c) => (c ? { ...c, lost: e } : c));
      } else if ((e.status === 409 || e.status === 404) && hasStale) {
        // Decided elsewhere (or the trip is over): lead on to where the trip stands now.
        setConfirm(null);
        onStale();
      } else {
        setConfirm(null);
        setError(e);
        void load();
      }
    } finally {
      setBusy(false);
    }
  };

  if (loadError && !preview) {
    return (
      <section>
        <h1>{T.decideTitle(encounterIndex)}</h1>
        <ErrorBox error={loadError} heading={T.decideLoadFailed} onRetry={() => void load()} />
      </section>
    );
  }
  if (!preview) {
    return (
      <section>
        <h1>{T.decideTitle(encounterIndex)}</h1>
        <p className="hint" role="status">
          {STRINGS.app.loading}
        </p>
      </section>
    );
  }
  const open_ = isOpen(preview);
  const quote = confirm?.preview ?? null;
  const alive = (p: StakesPreview): number => p.units.filter((u) => u.alive).length;

  return (
    <section className="rs-decide" data-testid="bank-or-push" data-encounter={encounterIndex}>
      <h1 id="decide-heading" tabIndex={-1}>
        {T.decideTitle(encounterIndex)}
      </h1>
      <p className="hint">{T.decideIntro}</p>
      {loadError && <ErrorBox error={loadError} heading={T.decideLoadFailed} onRetry={() => void load()} />}
      {!open_ && (
        <div className="error" role="alert" data-testid="decide-closed">
          <p>{T.decideClosed}</p>
          {hasStale && (
            <button type="button" className="cv-btn cv-btn--primary cv-btn--block" onClick={onStale} data-testid="decide-back-to-trail">
              {T.decideBackToTrail}
            </button>
          )}
        </div>
      )}

      <Stakes preview={preview} />

      {error && <ErrorBox error={error} />}
      <div className="rs-choices">
        <div>
          <span className="rs-choice-cap" aria-hidden="true">
            {R.atRisk} · {preview.unbankedCoin.total} {R.coinWord}
          </span>
          <button type="button" className="cv-btn cv-btn--secondary cv-btn--block" disabled={!open_ || busy} onClick={() => void open("push")} data-testid="push-open">
            {T.pushButton(preview.nextEncounter.index)}
          </button>
        </div>
        <div>
          {preview.bankNow && (
            <span className="rs-choice-cap" aria-hidden="true">
              {R.toVault} · {preview.bankNow.total} {R.coinWord}
            </span>
          )}
          <button type="button" className="cv-btn cv-btn--primary cv-btn--block" disabled={!open_ || busy} onClick={() => void open("bank")} data-testid="bank-open">
            {T.bankButton}
          </button>
        </div>
      </div>

      {confirm && (
        <Modal
          title={confirm.kind === "bank" ? T.bankConfirmTitle : T.pushConfirmTitle(preview.nextEncounter.index)}
          busy={busy}
          onCancel={() => setConfirm(null)}
          testId={confirm.kind === "bank" ? "bank-dialog" : "push-dialog"}
          restoreFocusTo={() => document.getElementById("decide-heading")}
          actions={
            <>
              <button type="button" className="cv-btn cv-btn--secondary" disabled={busy} onClick={() => setConfirm(null)}>
                {T.decideNo}
              </button>
              <button
                type="button"
                className="cv-btn cv-btn--primary"
                disabled={busy || !quote || !isOpen(quote)}
                onClick={() => void decide()}
                data-testid={confirm.kind === "bank" ? "bank-confirm" : "push-confirm"}
              >
                {busy ? (confirm.kind === "bank" ? T.banking : T.pushing) : confirm.lost ? T.decisionTryAgain : confirm.kind === "bank" ? T.bankYes : T.pushYes}
              </button>
            </>
          }
        >
          {confirm.readError ? (
            <div data-testid="confirm-read-error">
              <ErrorBox error={confirm.readError} heading={T.confirmLoadFailed} onRetry={() => void reread(confirm.kind)} />
            </div>
          ) : !quote ? (
            <p className="hint" role="status">
              {STRINGS.app.loading}
            </p>
          ) : confirm.kind === "bank" && !quote.bankNow ? (
            <p className="error" data-testid="bank-quote-none">
              {T.bankNotYet}
            </p>
          ) : confirm.kind === "bank" && quote.bankNow ? (
            <>
              <p data-testid="bank-quote">{T.bankConfirmBody(quote.bankNow.total, quote.bankNow.forecast.wouldCredit, quote.bankNow.forecast.wouldDiscard)}</p>
              {quote.bankNow.unitsDeMerged.length === 0 ? (
                <p className="hint" data-testid="bank-quote-refit">
                  {T.bankConfirmRefit}
                </p>
              ) : (
                <>
                  <p data-testid="bank-quote-refit">{T.bankConfirmRefitDemerged(quote.bankNow.unitsDeMerged.length)}</p>
                  <DeMergedList units={quote.bankNow.unitsDeMerged} testId="bank-quote-demerged" />
                </>
              )}
            </>
          ) : (
            <>
              <p data-testid="push-quote">{T.pushConfirmBody(quote.ifOverrun.coinLost, alive(quote), quote.ifOverrun.unitsDeMergedNotDestroyed.length)}</p>
              <p>{T.nextReward(quote.nextEncounter.reward)}</p>
              <p className="hint">{T.pushConfirmNoRepair}</p>
            </>
          )}
          {quote && !isOpen(quote) && <p className="error">{T.decideClosed}</p>}
          {confirm.lost && (
            <div className="error" role="alert" data-testid="decision-unconfirmed">
              <div>{T.decisionUnconfirmed}</div>
              <div>{T.decisionUnconfirmedBody}</div>
              <div className="error__code">{confirm.lost.code}</div>
            </div>
          )}
        </Modal>
      )}
    </section>
  );
}
