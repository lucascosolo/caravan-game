/**
 * The game-moment pieces shared by the replay and the post-fight screens (C4c, UI-SYSTEM §8.9, §8.11,
 * §14.7–14.9): the outcome banner with its pre-drawn stamp, the depth meter and the Coin ribbon. They
 * word what the server recorded; nothing here decides an outcome.
 */
import type { ReactNode } from "react";
import { Icon, cx } from "../../ui/Icon.tsx";
import { STRINGS } from "../../strings.ts";
import "./results.css";

const R = STRINGS.results;

export type Moment = "held" | "overrun" | "delivered" | "theyHeld" | "brokeThrough" | "voided";

const STAMP: Partial<Record<Moment, string>> = { held: "held", overrun: "overrun", delivered: "delivered", theyHeld: "they-held", brokeThrough: "broke-through" };
const EMBLEM: Record<Moment, string> = { held: "strongbox", overrun: "broken-wheel", delivered: "strongbox", theyHeld: "shield", brokeThrough: "outlaw", voided: "torn-page" };

/** The moment a recorded outcome is, from the side that is looking at it. */
export function momentOf(kind: string, viewer: "caravan" | "party_owner" = "caravan"): Moment {
  const overrun = kind === "caravan_overrun";
  if (viewer === "party_owner") return overrun ? "brokeThrough" : "theyHeld";
  return overrun ? "overrun" : "held";
}

/** A pre-drawn stamp (never rotated by CSS), read out by its word. */
export function Stamp({ name, word }: { readonly name: string; readonly word: string }): JSX.Element {
  return <i role="img" aria-label={word} className={`cv-art cv-stamp cv-stamp-${name} is-thunk rs-stamp`} />;
}

/** THE CIRCLE HELD! on the canvas swallowtail; OVERRUN on the torn shade note; shape, emblem and word differ, never only colour. */
export function OutcomeBanner({ moment, sub, clean = false, testId, className }: { readonly moment: Moment; readonly sub?: ReactNode; readonly clean?: boolean; readonly testId?: string; readonly className?: string }): JSX.Element {
  const dark = moment === "overrun" || moment === "brokeThrough" || moment === "voided";
  const stamp = clean ? "clean-hold" : STAMP[moment];
  const word = clean ? R.stamp.cleanHold : R.stamp[moment];
  return (
    <div className={cx("cv-outcome rs-outcome", dark && "cv-outcome--overrun", className)} data-testid={testId} data-moment={moment}>
      <div className="cv-outcome__word">
        {dark && <Icon name={EMBLEM[moment]} className="rs-outcome__emblem" />}
        <span>{R.moment[moment]}</span>
      </div>
      {sub !== undefined && <div className="cv-outcome__sub">{sub}</div>}
      {stamp && word && <Stamp name={stamp} word={word} />}
    </div>
  );
}

/** The mini ring with the wedge filled from the outside in, the percentage and the sentence (§8.11). */
export function DepthMeter({ pct, testId, children }: { readonly pct: number; readonly testId?: string; readonly children: ReactNode }): JSX.Element {
  const step = Math.max(0, Math.min(100, Math.round(pct / 10) * 10));
  return (
    <div className="cv-depth rs-depth" data-testid={testId}>
      <i aria-hidden="true" className={`cv-art cv-mtr-depth-${String(step).padStart(3, "0")}`} />
      <span className="cv-num rs-depth__pct" aria-hidden="true">
        {R.depthPct(pct)}
      </span>
      <span className="rs-depth__words">{children}</span>
    </div>
  );
}

/** Coin gained, on the brass reward ribbon ("+600"). */
export function CoinRibbon({ amount, sign = true }: { readonly amount: number; readonly sign?: boolean }): JSX.Element {
  return (
    <span className="cv-reward rs-ribbon" aria-hidden="true">
      <span className="cv-reward__in">
        <Icon name="coin" />
        <span className="cv-num">
          {sign ? "+" : ""}
          {amount}
        </span>
      </span>
    </span>
  );
}
