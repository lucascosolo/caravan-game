/**
 * The results summary of ONE encounter (chunk 23): outcome, how far the attackers got, the
 * Coin it accrued (unbanked), and what the fight cost — units killed and damaged, traps
 * spent, fence segments broken — exactly as the server projected them from the resolution
 * (`TripEncounterView.result`). Nothing is derived here beyond turning fixed-point depth
 * into a percentage for display.
 *
 * "Watch the fight" is the hand-off to chunk 22's replay player (`result.jobId` is the key):
 * it opens the player over this screen, so the trip flow is never left.
 */
import { useId } from "react";
import type { Api } from "../../api/client.ts";
import type { TripEncounterView } from "../../api/tripTypes.ts";
import { depthPercent } from "../replay/depth.ts";
import { WatchFight } from "../replay/WatchFight.tsx";
import { CoinRibbon, DepthMeter, OutcomeBanner, momentOf } from "../replay/Moments.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { STRINGS } from "../../strings.ts";

import { fenceLabel, trapTypeName, unitLabel } from "./tripNames.ts";

const T = STRINGS.trip;

function Group({ heading, items, testId, icon }: { heading: string; items: readonly string[]; testId: string; icon: string }): JSX.Element {
  return (
    <div className="rs-group" data-testid={testId}>
      <h3 className="cv-label">{heading}</h3>
      {items.length === 0 ? (
        <p className="hint">{T.none}</p>
      ) : (
        <ul className="rs-ledger">
          {items.map((s, i) => (
            <li key={`${i}-${s}`}>
              <Icon name={icon} />
              <span>{s}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReplayAffordance({ jobId, encounterIndex, api, autoplay = false }: { readonly jobId: string; readonly encounterIndex: number; readonly api?: Api; readonly autoplay?: boolean }): JSX.Element {
  const noteId = useId();
  return (
    <div>
      <WatchFight jobId={jobId} encounterIndex={encounterIndex} label={T.watchFight} describedBy={noteId} autoOpen={autoplay} className="cv-btn cv-btn--secondary cv-btn--block" {...(api ? { api } : {})} />
      <p className="hint" id={noteId}>
        {T.watchFightNote}
      </p>
    </div>
  );
}

/** `autoplay` (final play-test review S4): the fight was just committed, so its replay opens playing at once. */
export function EncounterResult({ encounter, headingLevel = 2, api, autoplay = false }: { readonly encounter: TripEncounterView; readonly headingLevel?: 2 | 3; readonly api?: Api; readonly autoplay?: boolean }): JSX.Element {
  const r = encounter.result;
  // Chunk 22 QA S6: "reached the core" only for an overrun; otherwise floored and capped at 99 %.
  const pct = depthPercent(encounter.depth, encounter.outcome === "caravan_overrun");
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="cv-card rs-result" data-testid={`encounter-result-${encounter.index}`} data-outcome={encounter.outcome}>
      <OutcomeBanner moment={momentOf(encounter.outcome)} sub={STRINGS.results.encounterSub(encounter.index)} clean={encounter.outcome !== "caravan_overrun" && pct <= 0} />
      <div className="rs-result__head">
        <Heading>{T.resultTitle(encounter.index)}</Heading>
      </div>
      <p data-testid="result-outcome">
        <strong>{T.outcome(encounter.outcome)}</strong>
      </p>
      <DepthMeter pct={pct}>
        <span data-testid="result-depth">{T.depth(pct)}</span>
      </DepthMeter>
      <div className="rs-coinline">
        {encounter.coinAccrued > 0 && <CoinRibbon amount={encounter.coinAccrued} />}
        <p data-testid="result-coin">{encounter.coinAccrued > 0 ? T.coinAccrued(encounter.coinAccrued) : T.coinNone}</p>
      </div>
      {r ? (
        <>
          <Group heading={T.killedHeading} testId="result-killed" icon="grave" items={r.unitsKilled.map((u) => `${unitLabel(u)} · ${T.killedAt(u.hpBefore, u.maxHp)}`)} />
          <Group heading={T.damagedHeading} testId="result-damaged" icon="wounded" items={r.unitsDamaged.map((u) => `${unitLabel(u)} · ${T.hpChange(u.hpBefore, u.hpAfter, u.maxHp)}`)} />
          {r.unitsUnhurt.length > 0 && <Group heading={T.unhurtHeading} testId="result-unhurt" icon="heart" items={r.unitsUnhurt.map((u) => `${unitLabel(u)} · ${T.hpOf(u.hp, u.maxHp)}`)} />}
          <Group heading={T.trapsSpentHeading} testId="result-traps" icon="trap-jaw-sprung" items={r.trapsSpent.map((t) => trapTypeName(t.typeId))} />
          {r.trapsUnfired.length > 0 && <Group heading={T.trapsUnfiredHeading} testId="result-traps-unfired" icon="trap-jaw" items={r.trapsUnfired.map((t) => trapTypeName(t.typeId))} />}
          <Group heading={T.fencesBrokenHeading} testId="result-fences" icon="fence-rail-broken" items={r.fencesBroken.map((f) => fenceLabel(f))} />
          {r.fencesDamaged.length > 0 && (
            <Group heading={T.fencesDamagedHeading} testId="result-fences-damaged" icon="fence-rail" items={r.fencesDamaged.map((f) => `${fenceLabel(f)} · ${T.hpChange(f.hpBefore, f.hpAfter, f.maxHp)}`)} />
          )}
        </>
      ) : (
        <p className="hint">{T.resultUnreadable}</p>
      )}
      {r && <ReplayAffordance jobId={r.jobId} encounterIndex={encounter.index} autoplay={autoplay} {...(api ? { api } : {})} />}
    </section>
  );
}
