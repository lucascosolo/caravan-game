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
import { ApiError } from "../../api/client.ts";
import type { CaravanLoadoutView, CandidateMenuView, CandidateView } from "../../api/types.ts";
import { monotonic, useAnchoredCountdown } from "../../shell/countdown.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { STRINGS } from "../../strings.ts";
import { rangedCount } from "../../onboarding/guideRule.ts";
import { ScoutPanel } from "./ScoutPanel.tsx";
import type { ScoutedParty } from "./scoutTypes.ts";

const T = STRINGS.trail;

/**
 * Final play-test review N5: the one-glance line a candidate card leads with — raiders by
 * targeting stance, total HP, the siege and what it counters, and the approach by side. Every
 * number is the scout's own; the full report stays one tap away below it.
 */
export function scoutSummary(scout: ScoutedParty, loadout: CaravanLoadoutView | null = null): { readonly stances: string; readonly ranged: string; readonly rangedCount: number; readonly hp: number; readonly siege: string; readonly approach: string } {
  const by = (s: string) => scout.units.filter((u) => u.stance === s).length;
  const stances = (["core", "nearest", "traps"] as const)
    .filter((s) => by(s) > 0)
    .map((s) => T.summaryStance(s, by(s)))
    .join(" · ");
  const hp = scout.units.reduce((n, u) => n + u.hp, 0);
  // N5: set each siege piece against the caravan's OWN packed fence and traps (the server's caravanLoadout).
  const vsYours = (kind: string, category: string): string => {
    if (!loadout) return "";
    const n = kind === "fence" ? loadout.fences.filter((f) => f.category === category).reduce((a, f) => a + f.standing, 0) : loadout.traps.filter((t) => t.category === category).reduce((a, t) => a + t.ready, 0);
    return ` ${T.summarySiegeVsYours(n, kind)}`;
  };
  const siege = scout.siege.length === 0 ? T.summaryNoSiege : scout.siege.map((s) => T.summarySiege(s.displayName, s.counters.kind, s.counters.category) + vsYours(s.counters.kind, s.counters.category)).join("; ");
  const approach = (["north", "east", "south", "west"] as const)
    .map((e) => ({ e, n: scout.units.filter((u) => u.edge === e).length }))
    .filter((x) => x.n > 0)
    .map((x) => `${T.edgeName(x.e)} ${x.n}`)
    .join(", ");
  // Round 3 S1 / N9: how many raiders shoot from range, by shape and word (guideRule's reading).
  const r = rangedCount(scout);
  return { stances, ranged: T.summaryRanged(r.ranged, r.total), rangedCount: r.ranged, hp, siege, approach };
}

function ScoutSummary({ scout, index, loadout }: { scout: ScoutedParty; index: number; loadout: CaravanLoadoutView | null }): JSX.Element {
  const s = scoutSummary(scout, loadout);
  return (
    <dl className="scout-summary" data-testid={`scout-summary-${index}`}>
      <dt>{T.summaryRaiders(scout.units.length)}</dt>
      <dd>{s.stances}</dd>
      <dt>{T.summaryRangedLabel}</dt>
      <dd data-testid={`scout-ranged-${index}`} data-ranged={s.rangedCount}>
        {s.ranged}
      </dd>
      <dt>{T.summaryHpLabel}</dt>
      <dd>{s.hp}</dd>
      <dt>{T.summarySiegeLabel}</dt>
      <dd>{s.siege}</dd>
      <dt>{T.summaryApproachLabel}</dt>
      <dd>{s.approach}</dd>
    </dl>
  );
}

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

// The countdown moved to shell/countdown.ts (chunk 23 reuses it for the trip cap); re-exported for existing imports.
export { useAnchoredCountdown };

export function CandidateCard({ candidate, busy, onChoose, index, loadout = null }: { candidate: CandidateView; busy: boolean; onChoose: (c: CandidateView) => void; index: number; loadout?: CaravanLoadoutView | null }): JSX.Element {
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
      <ScoutSummary scout={candidate.scout} index={index} loadout={loadout} />
      {/* N5: the full report is collapsed under the summary: one tap away, nothing hidden. */}
      <details className="scout-details">
        <summary className="btn btn--block">{T.scoutFullReport}</summary>
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
      {/* N6: say where this search looked, relative to the caravan, not "within your band". */}
      <p className="hint" data-testid="search-centre">
        {T.searchCentre(menu.centre, menu.caravan.rating, encounterIndex)}
        {menu.raiderCap ? ` ${T.raiderCap(menu.raiderCap.cap, menu.raiderCap.packedUnits, menu.raiderCap.relaxed)}` : ""}
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
          <CandidateCard key={c.candidateId} candidate={c} busy={busy} onChoose={onChoose} index={i} loadout={menu.caravanLoadout ?? null} />
        ))}
      </ul>
    </section>
  );
}
