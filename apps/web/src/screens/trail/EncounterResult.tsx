/**
 * The results summary of ONE encounter (chunk 23): outcome, how far the attackers got, the
 * Coin it accrued (unbanked), and what the fight cost — units killed and damaged, traps
 * spent, fence segments broken — exactly as the server projected them from the resolution
 * (`TripEncounterView.result`). Nothing is derived here beyond turning fixed-point depth
 * into a percentage for display.
 *
 * "Watch the fight" is the hand-off to chunk 22's replay player, which is not built: the
 * button is present, disabled and labelled "replay coming", so the flow's shape is final
 * and chunk 22 only wires it (`result.jobId` is the key).
 */
import { FIXED_ONE } from "@caravan/content";
import { useId } from "react";
import type { TripEncounterView } from "../../api/tripTypes.ts";
import { STRINGS } from "../../strings.ts";
import { fenceLabel, trapTypeName, unitLabel } from "./tripNames.ts";

const T = STRINGS.trip;
const DEPTH_ONE = FIXED_ONE;

function Group({ heading, items, testId }: { heading: string; items: readonly string[]; testId: string }): JSX.Element {
  return (
    <div data-testid={testId}>
      <h3>{heading}</h3>
      {items.length === 0 ? (
        <p className="hint">{T.none}</p>
      ) : (
        <ul className="plain">
          {items.map((s, i) => (
            <li key={`${i}-${s}`}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function ReplayAffordance(): JSX.Element {
  const noteId = useId();
  return (
    <div>
      <button type="button" className="btn btn--block" disabled aria-describedby={noteId} data-testid="watch-fight">
        {T.watchFight} <span className="hint">({T.replayComing})</span>
      </button>
      <p className="hint" id={noteId}>
        {T.replayNote}
      </p>
    </div>
  );
}

export function EncounterResult({ encounter, headingLevel = 2 }: { readonly encounter: TripEncounterView; readonly headingLevel?: 2 | 3 }): JSX.Element {
  const r = encounter.result;
  const pct = Math.round((encounter.depth * 100) / DEPTH_ONE);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <section className="card" data-testid={`encounter-result-${encounter.index}`} data-outcome={encounter.outcome}>
      <Heading>{T.resultTitle(encounter.index)}</Heading>
      <p data-testid="result-outcome">
        <strong>{T.outcome(encounter.outcome)}</strong>
      </p>
      <p data-testid="result-depth">{T.depth(pct)}</p>
      <p data-testid="result-coin">{encounter.coinAccrued > 0 ? T.coinAccrued(encounter.coinAccrued) : T.coinNone}</p>
      {r ? (
        <>
          <Group heading={T.killedHeading} testId="result-killed" items={r.unitsKilled.map((u) => `${unitLabel(u)} · ${T.killedAt(u.hpBefore, u.maxHp)}`)} />
          <Group heading={T.damagedHeading} testId="result-damaged" items={r.unitsDamaged.map((u) => `${unitLabel(u)} · ${T.hpChange(u.hpBefore, u.hpAfter, u.maxHp)}`)} />
          {r.unitsUnhurt.length > 0 && <Group heading={T.unhurtHeading} testId="result-unhurt" items={r.unitsUnhurt.map((u) => `${unitLabel(u)} · ${T.hpOf(u.hp, u.maxHp)}`)} />}
          <Group heading={T.trapsSpentHeading} testId="result-traps" items={r.trapsSpent.map((t) => trapTypeName(t.typeId))} />
          {r.trapsUnfired.length > 0 && <Group heading={T.trapsUnfiredHeading} testId="result-traps-unfired" items={r.trapsUnfired.map((t) => trapTypeName(t.typeId))} />}
          <Group heading={T.fencesBrokenHeading} testId="result-fences" items={r.fencesBroken.map((f) => fenceLabel(f))} />
          {r.fencesDamaged.length > 0 && (
            <Group heading={T.fencesDamagedHeading} testId="result-fences-damaged" items={r.fencesDamaged.map((f) => `${fenceLabel(f)} · ${T.hpChange(f.hpBefore, f.hpAfter, f.maxHp)}`)} />
          )}
        </>
      ) : (
        <p className="hint">{T.resultUnreadable}</p>
      )}
      <ReplayAffordance />
    </section>
  );
}
