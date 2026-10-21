/**
 * The candidates screen (chunk 08, fed by chunk 14): the three scoutable parties for the
 * next encounter, each a wanted poster. Each is shown IN FULL (ScoutPanel, one tap under its
 * summary and ABOVE its "Face …" button, QA N1) with its owner, Reputation band, gap from the
 * caravan, the part of that gap beyond the band searched, and the earn multiplier (the bounty).
 * How much of the menu is authored, and whether it reached outside the band to fill, is said as
 * the server reports it (B1).
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
import { useState } from "react";
import { ApiError } from "../../api/client.ts";
import type { CaravanLoadoutView, CandidateMenuView, CandidateView } from "../../api/types.ts";
import { monotonic, useAnchoredCountdown } from "../../shell/countdown.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { STRINGS } from "../../strings.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Medallion } from "../../ui/Medallion.tsx";
import { Note } from "../../ui/Note.tsx";
import { Pop } from "../../ui/Pop.tsx";
import { Poster } from "../../ui/Poster.tsx";
import { Sign } from "../../ui/Sign.tsx";
import { Toast } from "../../ui/Toast.tsx";
import { rangedCount } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { ScoutPanel } from "./ScoutPanel.tsx";
import type { ScoutedParty } from "./scoutTypes.ts";
import "./trail.css";

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
  // Round 3 S1 / N9: how many raiders shoot from range, by shape and word (@caravan/circle rangedCount).
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

const COMPASS = [
  ["north", "n"],
  ["east", "e"],
  ["south", "s"],
  ["west", "w"],
] as const;

/** Entry sides as counts on the rim; an open side reads 0 on a parchment pill. The words are in the summary beside it. */
function Compass({ scout }: { scout: ScoutedParty }): JSX.Element {
  const counts = COMPASS.map(([edge, key]) => ({ edge, key, n: scout.units.filter((u) => u.edge === edge).length }));
  const approach = counts
    .filter((c) => c.n > 0)
    .map((c) => `${T.edgeName(c.edge)} ${c.n}`)
    .join(", ");
  return (
    <span className="cv-compass cv-compass--sm" role="img" aria-label={T.candidateCompassLabel(approach)}>
      {counts.map((c) => (
        <span key={c.key} className={`cv-pill${c.n > 0 ? "" : " cv-pill--parch is-open"} cv-compass__edge cv-compass__edge--${c.key}`} aria-hidden="true">
          {c.n}
        </span>
      ))}
    </span>
  );
}

/** The encounter stops: those behind you nailed up and stamped Held, this one on a canvas note. */
export function EncounterStops({ index }: { index: number }): JSX.Element {
  return (
    <div className="trail-stops" role="group" aria-label={T.stopsLabel}>
      {Array.from({ length: index - 1 }, (_, i) => (
        <span key={i} className="trail-stop">
          <Sign variant="nailed">{T.encounter(i + 1)}</Sign>
          <span className="trail-stamp">{T.stopHeld}</span>
        </span>
      ))}
      <Note variant="canvas" nail="brass">
        <h1 className="trail-stop__now">{T.encounter(index)}</h1>
      </Note>
    </div>
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
    <li data-testid={`candidate-${index}`} data-candidate-id={candidate.candidateId}>
      <Poster
        className="trail-poster"
        kicker={T.wantedKicker}
        title={T.candidateOwner(candidate.owner.displayName)}
        plaque={candidate.owner.authored ? T.candidateAuthored : undefined}
        bounty={T.candidateSandbag(pct)}
      >
        {candidate.owner.flavor && (
          <p className="cv-poster__flavour cv-small" data-testid={`candidate-flavor-${index}`}>
            {candidate.owner.flavor}
          </p>
        )}
        <p className="cv-small trail-poster__line">
          {T.candidateRating(rep.rating, rep.band.low, rep.band.high)} · {T.candidateGap(rep.gapFromCaravan)} · {T.candidateBeyondBand(rep.gapBeyondBand)}
        </p>
        <div className="trail-poster__body">
          <Compass scout={candidate.scout} />
          <div className="trail-poster__facts">
            <ScoutSummary scout={candidate.scout} index={index} loadout={loadout} />
          </div>
        </div>
        {/* N5: the full report is collapsed under the summary: one tap away, nothing hidden. */}
        <details className="trail-poster__details">
          <summary>{T.scoutFullReport}</summary>
          <ScoutPanel scout={candidate.scout} idSuffix={`-${index}`} />
        </details>
        <div className="trail-poster__choose">
          <Button variant="primary" block disabled={busy} onClick={() => onChoose(candidate)} testId={`choose-${index}`}>
            {busy ? T.choosing : T.chooseButton(candidate.owner.displayName)}
          </Button>
        </div>
      </Poster>
    </li>
  );
}

export function CandidatesScreen({ encounterIndex, menu, busy, error, onSearchAgain, onChoose, now = monotonic }: CandidatesScreenProps): JSX.Element {
  const [infoOpen, setInfoOpen] = useState(false);
  const waitMs = menu.reroll.available ? 0 : Math.max(0, menu.reroll.availableAtMs - menu.searchedAtMs);
  const left = useAnchoredCountdown(menu, waitMs, now);
  const refusal = error?.code === "reroll_cooldown" ? error : null;
  const retryAfter = refusal && typeof refusal.body["retryAfterSeconds"] === "number" ? (refusal.body["retryAfterSeconds"] as number) : 0;
  const refusedLeft = useAnchoredCountdown(refusal, retryAfter * 1000, now);
  const canReroll = left === 0 && refusedLeft === 0 && !busy;
  const share = menu.authoredShare;
  const wait = Math.max(left, refusedLeft);
  return (
    <section className="trail" data-testid="candidates-screen" data-encounter={encounterIndex}>
      <EncounterStops index={encounterIndex} />
      <h2 className="trail-h2">{T.candidatesHeading}</h2>
      <Note>
        <div className="trail-meta">
          <p className="cv-small">{T.candidatesIntro}</p>
          <p className="cv-small" data-testid="caravan-band">
            {T.caravanBand(menu.caravan.rating, menu.caravan.band.low, menu.caravan.band.high)}
          </p>
          {/* N6: say where this search looked, relative to the caravan, not "within your band". */}
          <p className="cv-small" data-testid="search-centre">
            {T.searchCentre(menu.centre, menu.caravan.rating, encounterIndex)}
            {menu.raiderCap ? ` ${T.raiderCap(menu.raiderCap.cap, menu.raiderCap.packedUnits, menu.raiderCap.relaxed)}` : ""}
          </p>
          {menu.widened && <p className="cv-small">{T.widened}</p>}
          {menu.authoredOutsideBand && (
            <p className="cv-small" data-testid="authored-outside-band">
              {T.authoredFallback}
            </p>
          )}
          {/* Final play-test review r3: an authored-only menu says why, never the live pool's 30 % share. */}
          <p className="cv-small" data-testid="authored-share" data-authored-only={menu.authoredOnlyTrip === true ? "true" : "false"}>
            {menu.authoredOnlyTrip === true ? T.authoredOnlyTrip(TUNABLES.AUTHORED_ONLY_UNTIL_BANKS) : T.authoredShare(share.authored, share.of, Math.round(share.maxShareBp / 100))}
          </p>
          {menu.authoredOnlyTrip !== true && menu.authoredServed?.weightedDown && <p className="cv-small">{T.authoredWeightedDown}</p>}
          <div className="trail-meta__row">
            <Medallion label={T.searchDetailLabel} icon="info" size="sm" pressed={infoOpen} onClick={() => setInfoOpen((o) => !o)} />
          </div>
          {infoOpen && (
            <Pop tail="top" className="trail-pop">
              {T.menuMeta(menu.searchSeq, menu.centre, menu.bandWidthUsed)}
            </Pop>
          )}
        </div>
      </Note>

      <button type="button" className={`cv-btn cv-btn--secondary cv-btn--block${canReroll ? "" : " is-disabled"}`} disabled={!canReroll} aria-disabled={!canReroll} onClick={onSearchAgain} data-testid="reroll" data-seconds-left={wait}>
        <Icon name="hourglass" off={!canReroll} />
        <span>{busy ? T.searching : wait > 0 ? T.rerollIn(wait) : T.rerollButton}</span>
      </button>

      {refusal ? (
        <Toast tone="error" testId="reroll-refused">
          <span>{refusal.message}</span> <span>{T.rerollRefused(refusedLeft)}</span> <code className="cv-small">{refusal.code}</code>
        </Toast>
      ) : (
        error && <ErrorBox error={error} />
      )}

      <ul className="trail-posters" aria-label={T.candidatesHeading} data-testid="candidate-list">
        {menu.candidates.map((c, i) => (
          <CandidateCard key={c.candidateId} candidate={c} busy={busy} onChoose={onChoose} index={i} loadout={menu.caravanLoadout ?? null} />
        ))}
      </ul>
    </section>
  );
}
