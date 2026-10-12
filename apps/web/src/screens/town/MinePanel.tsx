/**
 * The mine (chunk 17, open question 3 decided as proposed: PURELY PRESENTATIONAL). It is
 * the diegetic home of the passive Coin trickle (PROJECT.md §14): the balance the server
 * computed lazily as of its read, the flat rate, the storage cap and the room under it
 * right now. There is no upgrade, no Coin sink and no rate change here — the rate shown is
 * the server's `trickle.ratePerHour` (COIN_TRICKLE_RATE), the same for everyone.
 *
 * No number on this panel ticks. The balance is the one the server returned, labelled with
 * the instant it was computed for; it changes when the screen re-reads, never on a timer.
 */
import type { EconomyView } from "../../api/types.ts";
import { formatWhen } from "../../shell/issues.ts";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.town;

export function MinePanel({ economy, forecast }: { economy: EconomyView; forecast: EconomyView["overflow"] | null }): JSX.Element {
  const fill = economy.cap > 0 ? Math.min(100, (economy.balance / economy.cap) * 100) : 100;
  const warn = economy.atCap || (forecast?.warn ?? false);
  return (
    <section aria-labelledby="mine-heading" data-testid="mine-panel" data-at-cap={economy.atCap ? "true" : "false"}>
      <h2 id="mine-heading">{T.mineHeading}</h2>
      <p data-testid="mine-balance">
        <strong>{T.mineBalance(economy.balance, economy.cap)}</strong>
      </p>
      <span className="meter" role="img" aria-label={T.mineBalance(economy.balance, economy.cap)}>
        <span className="meter__fill" style={{ width: `${fill}%` }} />
      </span>
      <p data-testid="mine-rate">{T.mineRate(economy.trickle.ratePerHour)}</p>
      {warn && (
        <p className="error" role="alert" data-testid="mine-warn">
          {economy.atCap ? T.mineAtCap : forecast ? T.mineNearCap(forecast.message) : null}
        </p>
      )}
      {/* Final play-test review r2 N13: the explanation is one tap away, not a screenful. */}
      <details className="disclosure" data-testid="mine-details">
        <summary>{T.mineMore}</summary>
        <p className="hint">{T.mineIntro}</p>
        {economy.trickle.pending > 0 && <p className="hint">{T.minePending(economy.trickle.pending)}</p>}
        <p data-testid="mine-room">{T.mineRoom(economy.room)}</p>
        <p className="hint" data-testid="mine-accrued">
          {T.mineAccrued(formatWhen(economy.trickle.accruedThroughMs))}
        </p>
        <p className="hint">{T.mineNoUpgrade}</p>
      </details>
    </section>
  );
}
