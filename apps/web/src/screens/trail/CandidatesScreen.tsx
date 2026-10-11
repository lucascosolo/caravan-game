/**
 * The candidates screen (chunk 08, fed by chunk 14): the three scoutable parties for the
 * next encounter. Each is shown IN FULL (ScoutPanel) with its owner, Reputation band, gap
 * from the caravan and the earn multiplier, and a "Face …" button. The reroll is free and
 * time-gated: the countdown to the next free search is always visible; a 409
 * `reroll_cooldown` from the server is shown with its exact `availableAtMs`. There is no
 * Coin anywhere on this screen (GUARDRAILS §2: search behaviour is identical for every
 * account).
 *
 * The server decides everything here — who is offered, whether a search is open, whether
 * a choice stands. The screen only renders the menu and relays the player's choice.
 */
import { useEffect, useState } from "react";
import { ApiError } from "../../api/client.ts";
import type { CandidateMenuView, CandidateView } from "../../api/types.ts";
import { STRINGS } from "../../strings.ts";
import { ErrorBox } from "./FormationScreen.tsx";
import { ScoutPanel } from "./ScoutPanel.tsx";

const T = STRINGS.trail;

export interface CandidatesScreenProps {
  readonly encounterIndex: number;
  readonly menu: CandidateMenuView;
  readonly busy: boolean;
  readonly error: ApiError | null;
  readonly onSearchAgain: () => void;
  readonly onChoose: (candidate: CandidateView) => void;
}

/** Seconds until `atMs`, re-read every second; 0 once passed. */
function useCountdown(atMs: number): number {
  const calc = (): number => Math.max(0, Math.ceil((atMs - Date.now()) / 1000));
  const [left, setLeft] = useState(calc);
  useEffect(() => {
    setLeft(calc());
    const id = window.setInterval(() => setLeft(calc()), 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atMs]);
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
      <p className="card__line">
        {T.candidateRating(rep.rating, rep.band.low, rep.band.high)} · {T.candidateGap(rep.gapFromCaravan)} · {T.candidateSandbag(pct)}
      </p>
      <button type="button" className="btn btn--primary btn--block" disabled={busy} onClick={() => onChoose(candidate)} data-testid={`choose-${index}`}>
        {busy ? T.choosing : T.chooseButton(candidate.owner.displayName)}
      </button>
      <details className="scout-details">
        <summary className="btn btn--block">{T.scoutHeading}</summary>
        <ScoutPanel scout={candidate.scout} idSuffix={`-${index}`} />
      </details>
    </li>
  );
}

export function CandidatesScreen({ encounterIndex, menu, busy, error, onSearchAgain, onChoose }: CandidatesScreenProps): JSX.Element {
  const left = useCountdown(menu.reroll.availableAtMs);
  const refusedAt = error?.code === "reroll_cooldown" && typeof error.body["availableAtMs"] === "number" ? (error.body["availableAtMs"] as number) : null;
  const refusedLeft = useCountdown(refusedAt ?? 0);
  const canReroll = left === 0 && !busy;
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
      {menu.usedAuthoredFallback && <p className="hint">{T.authoredFallback}</p>}

      <div className="actions">
        <button type="button" className="btn" disabled={!canReroll} aria-disabled={!canReroll} onClick={onSearchAgain} data-testid="reroll" data-seconds-left={left}>
          {busy ? T.searching : left > 0 ? T.rerollIn(left) : T.rerollButton}
        </button>
      </div>

      {error && error.code === "reroll_cooldown" ? (
        <div className="error" role="alert" data-testid="reroll-refused">
          <div>{error.message}</div>
          <div>{T.rerollRefused(refusedLeft)}</div>
          <div className="error__code">{error.code}</div>
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
