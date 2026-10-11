/**
 * The candidates screen (chunk 08, fed by chunk 14): the three scoutable parties for the
 * next encounter. Each is shown IN FULL (ScoutPanel, open by default and ABOVE its "Face …"
 * button, QA N1) with its owner, Reputation band, gap from the caravan, the part of that
 * gap beyond the band searched, and the earn multiplier. How much of the menu is authored,
 * and whether it reached outside the band to fill, is said as the server reports it (B1).
 *
 * The reroll is free and time-gated (GUARDRAILS §2; no Coin anywhere on this screen). Its
 * countdown never reads the device clock against server timestamps (QA S4): at receipt it
 * is `reroll.available ? 0 : availableAtMs − searchedAtMs` — exact for a fresh search, an
 * upper bound for a menu read later — and counts down on the monotonic clock from the
 * moment the menu arrived, so a fast or slow device clock can neither open it early nor
 * hold it shut. A 409 `reroll_cooldown` restarts it from the server's `retryAfterSeconds`,
 * anchored at the refusal's receipt.
 *
 * The server decides everything here — who is offered, whether a search is open, whether
 * a choice stands. The screen only renders the menu and relays the player's choice.
 */
import { useEffect, useState } from "react";
import { ApiError } from "../../api/client.ts";
import type { CandidateMenuView, CandidateView } from "../../api/types.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { STRINGS } from "../../strings.ts";
import { ScoutPanel } from "./ScoutPanel.tsx";

const T = STRINGS.trail;

export interface CandidatesScreenProps {
  readonly encounterIndex: number;
  readonly menu: CandidateMenuView;
  readonly busy: boolean;
  readonly error: ApiError | null;
  readonly onSearchAgain: () => void;
  readonly onChoose: (candidate: CandidateView) => void;
  /** Monotonic clock (ms); tests inject one. */
  readonly now?: () => number;
}

const monotonic = (): number => performance.now();

/**
 * Whole seconds left of `durationMs`, counted on `now` from the moment `anchor` (an object
 * identity: the menu, the refusal) arrived. Re-read every second; 0 once elapsed.
 */
export function useAnchoredCountdown(anchor: unknown, durationMs: number, now: () => number = monotonic): number {
  const calc = (from: number): number => Math.max(0, Math.ceil((durationMs - (now() - from)) / 1000));
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil(durationMs / 1000)));
  useEffect(() => {
    const t0 = now();
    setLeft(calc(t0));
    if (durationMs <= 0) return;
    const id = window.setInterval(() => setLeft(calc(t0)), 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, durationMs]);
  return left;
}

export function CandidateCard({ candidate, busy, onChoose, index }: { candidate: CandidateView; busy: boolean; onChoose: (c: CandidateView) => void; index: number }): JSX.Element {
  const rep = candidate.reputation;
  const pct = Math.round((rep.sandbagEarnMultiplier * 100) / 1024);
  return (
    <li className="candidate" data-testid={`candidate-${index}`} data-candidate-id={candidate.candidateId}>
      <div className="card__head">
        <span className="card__name">{T.candidateOwner(candidate.owner.displayName)}</span>
        {candidate.owner.authored && <span className="hint">{T.candidateAuthored}</span>}
      </div>
      {candidate.owner.flavor && (
        <p className="hint" data-testid={`candidate-flavor-${index}`}>
          {candidate.owner.flavor}
        </p>
      )}
      <p className="card__line">
        {T.candidateRating(rep.rating, rep.band.low, rep.band.high)} · {T.candidateGap(rep.gapFromCaravan)} · {T.candidateBeyondBand(rep.gapBeyondBand)} · {T.candidateSandbag(pct)}
      </p>
      <details className="scout-details" open>
        <summary className="btn btn--block">{T.scoutHeading}</summary>
        <ScoutPanel scout={candidate.scout} idSuffix={`-${index}`} />
      </details>
      <button type="button" className="btn btn--primary btn--block" disabled={busy} onClick={() => onChoose(candidate)} data-testid={`choose-${index}`}>
        {busy ? T.choosing : T.chooseButton(candidate.owner.displayName)}
      </button>
    </li>
  );
}

export function CandidatesScreen({ encounterIndex, menu, busy, error, onSearchAgain, onChoose, now = monotonic }: CandidatesScreenProps): JSX.Element {
  const waitMs = menu.reroll.available ? 0 : Math.max(0, menu.reroll.availableAtMs - menu.searchedAtMs);
  const left = useAnchoredCountdown(menu, waitMs, now);
  const refusal = error?.code === "reroll_cooldown" ? error : null;
  const retryAfter = refusal && typeof refusal.body["retryAfterSeconds"] === "number" ? (refusal.body["retryAfterSeconds"] as number) : 0;
  const refusedLeft = useAnchoredCountdown(refusal, retryAfter * 1000, now);
  const canReroll = left === 0 && refusedLeft === 0 && !busy;
  const share = menu.authoredShare;
  return (
    <section data-testid="candidates-screen" data-encounter={encounterIndex}>
      <h1>{T.encounter(encounterIndex)}</h1>
      <h2>{T.candidatesHeading}</h2>
      <p className="hint">{T.candidatesIntro}</p>
      <p className="hint" data-testid="caravan-band">
        {T.caravanBand(menu.caravan.rating, menu.caravan.band.low, menu.caravan.band.high)}
      </p>
      <p className="hint">{T.menuMeta(menu.searchSeq, menu.centre, menu.bandWidthUsed)}</p>
      {menu.widened && <p className="hint">{T.widened}</p>}
      {menu.authoredOutsideBand && (
        <p className="hint" data-testid="authored-outside-band">
          {T.authoredFallback}
        </p>
      )}
      <p className="hint" data-testid="authored-share">
        {T.authoredShare(share.authored, share.of, Math.round(share.maxShareBp / 100))}
      </p>
      {menu.authoredServed?.weightedDown && <p className="hint">{T.authoredWeightedDown}</p>}

      <div className="actions">
        <button type="button" className="btn" disabled={!canReroll} aria-disabled={!canReroll} onClick={onSearchAgain} data-testid="reroll" data-seconds-left={Math.max(left, refusedLeft)}>
          {busy ? T.searching : Math.max(left, refusedLeft) > 0 ? T.rerollIn(Math.max(left, refusedLeft)) : T.rerollButton}
        </button>
      </div>

      {refusal ? (
        <div className="error" role="alert" data-testid="reroll-refused">
          <div>{refusal.message}</div>
          <div>{T.rerollRefused(refusedLeft)}</div>
          <div className="error__code">{refusal.code}</div>
        </div>
      ) : (
        error && <ErrorBox error={error} />
      )}

      <ul className="cards" aria-label={T.candidatesHeading} data-testid="candidate-list">
        {menu.candidates.map((c, i) => (
          <CandidateCard key={c.candidateId} candidate={c} busy={busy} onChoose={onChoose} index={i} />
        ))}
      </ul>
    </section>
  );
}
