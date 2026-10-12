/**
 * The trip summary (chunk 23), shown when a trip ends — banked, overrun or voided (chunk 15 QA D3) — and on the Trail
 * tab afterwards until the caravan is packed again. Everything comes from the trip status
 * (`trip.ending`, as the `trip_banked` / `trip_overrun` / `trip_voided` ledger event recorded it, and each
 * encounter's `result`); a just-made bank adds the balance its answer carried. It feeds the
 * replay (chunk 22) through each encounter's "Watch the fight".
 */
import type { BankResult, TripView } from "../../api/tripTypes.ts";
import { navigate } from "../../shell/router.tsx";
import { STRINGS } from "../../strings.ts";
import { EncounterResult } from "./EncounterResult.tsx";
import { DeMergedList } from "./BankOrPushScreen.tsx";
import { unitLabel, unitTypeName } from "./tripNames.ts";
import { GuestSavePrompt } from "../account/GuestSavePrompt.tsx";

const T = STRINGS.trip;

export interface TripSummaryProps {
  readonly trip: TripView;
  /** The answer of a bank made just now (for the balance after); null otherwise. */
  readonly bank?: BankResult | null;
  /** The town's balance read from the economy, when there is no bank answer to quote (a later visit). */
  readonly balance?: number | null;
  /** True when this is the last trip, shown later on the Trail tab. */
  readonly past?: boolean;
  /** S4: the trip's last fight was just committed (an overrun ended it): its replay opens playing. */
  readonly autoplayLast?: boolean;
}

export function TripSummary({ trip, bank = null, balance = null, past = false, autoplayLast = false }: TripSummaryProps): JSX.Element {
  const e = trip.ending;
  const balanceNow = bank && bank.balanceAfter !== null ? bank.balanceAfter : balance;
  return (
    <section data-testid="trip-summary" data-end={trip.endReason ?? "open"}>
      <h1 id="trip-summary-heading" tabIndex={-1}>
        {past ? T.lastTrip : T.summaryTitle}
      </h1>
      {/* QA-30 D1: the end of a trip is a moment of value — a guest is asked to save it (never blocking). */}
      {!past && <GuestSavePrompt place="trip_end" />}
      {e?.kind === "banked" && (
        <div className="notice" data-testid="summary-banked">
          <p>
            <strong>{T.summaryBanked(e.encountersSurvived)}</strong>
          </p>
          <p>{T.summaryDelivered(e.unbankedCoin, e.deliveryBonus, e.requested)}</p>
          <p data-testid="summary-credited">{T.summaryCredited(e.credited, e.discarded)}</p>
          {balanceNow !== null && <p data-testid="summary-balance">{T.summaryBalance(balanceNow)}</p>}
          <p>{T.summaryRefit(e.restored.unitsHealed.length, e.restored.trapsRestocked, e.restored.fenceSegmentsRebuilt)}</p>
          {e.restored.deMerged.length > 0 && (
            <>
              <p>{T.summaryBankDemerged}</p>
              <DeMergedList units={e.restored.deMerged} testId="summary-bank-demerged" />
            </>
          )}
        </div>
      )}
      {e?.kind === "overrun" && (
        <div className="error" data-testid="summary-overrun">
          <p>
            <strong>{T.summaryOverrun(e.encounterIndex)}</strong>
          </p>
          <p data-testid="summary-coin-lost">{T.summaryCoinLost(e.coinLost)}</p>
          <p>{T.summaryLost}</p>
          <ul className="plain" data-testid="summary-lost">
            {e.unitsLostOutright.length === 0 ? <li className="hint">{T.none}</li> : e.unitsLostOutright.map((u) => <li key={u.ref}>{unitLabel(u)}</li>)}
          </ul>
          <p>{T.summaryDemerged}</p>
          <ul className="plain" data-testid="summary-demerged">
            {e.unitsDeMerged.length === 0 ? (
              <li className="hint">{T.none}</li>
            ) : (
              e.unitsDeMerged.map((u) => (
                <li key={u.ref} data-testid={`summary-demerged-${u.ref}`}>
                  {T.levelChange(unitTypeName(u.typeId), u.mergeLevel, u.mergeLevelAfter)}
                </li>
              ))
            )}
          </ul>
          <p className="hint">{e.lossesApplied ? T.summaryLossesApplied : T.summaryLossesPending}</p>
        </div>
      )}
      {e?.kind === "voided" && (
        <div className="notice" data-testid="summary-voided">
          <p>
            <strong>{T.summaryVoided(e.voidedEncounter)}</strong>
          </p>
          <p data-testid="summary-voided-nothing">{T.summaryVoidedNothingApplied(e.voidedEncounter)}</p>
          {e.encountersSurvived === 0 ? (
            <p data-testid="summary-voided-none">{T.summaryVoidedNoneSurvived}</p>
          ) : (
            <>
              <p>{T.summaryVoidedBanked(e.encountersSurvived)}</p>
              <p>{T.summaryDelivered(e.unbankedCoin, e.deliveryBonus, e.requested)}</p>
              <p data-testid="summary-credited">{T.summaryCredited(e.credited, e.discarded)}</p>
              {balanceNow !== null && <p data-testid="summary-balance">{T.summaryBalance(balanceNow)}</p>}
              <p>{T.summaryRefit(e.restored.unitsHealed.length, e.restored.trapsRestocked, e.restored.fenceSegmentsRebuilt)}</p>
              {e.restored.deMerged.length > 0 && (
                <>
                  <p>{T.summaryBankDemerged}</p>
                  <DeMergedList units={e.restored.deMerged} testId="summary-voided-demerged" />
                </>
              )}
            </>
          )}
          <p data-testid="summary-voided-cap">{T.summaryVoidedCapSpent}</p>
          {e.reason !== "" && (
            <details>
              <summary>{T.summaryVoidedReason}</summary>
              <p className="hint" data-testid="summary-voided-reason">
                {e.reason}
              </p>
            </details>
          )}
        </div>
      )}
      <p className="hint">{T.summaryRestoreNote}</p>

      <h2>{T.summaryEncounters}</h2>
      <ul className="cards">
        {trip.encounters.map((enc) => (
          <li key={enc.index}>
            <EncounterResult encounter={enc} headingLevel={3} autoplay={autoplayLast && enc.index === trip.encounters[trip.encounters.length - 1]?.index} />
          </li>
        ))}
      </ul>

      <div className="actions">
        <button type="button" className="btn btn--primary btn--block" onClick={() => navigate("town")} data-testid="summary-to-town">
          {T.toTown}
        </button>
      </div>
    </section>
  );
}
