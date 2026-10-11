/**
 * The pieces the Packs screen and its confirm share (chunk 20): the exact contents of a pack
 * and the overflow forecast. Both render the SERVER's lists and numbers and nothing else —
 * the contents list is `contents` (the exact grant the purchase records), each cosmetic
 * described by the offer's own `cosmetics` entry (the payload guard has already checked the
 * two agree), and the forecast is chunk 16's `overflowForecast` as the server computed it.
 *
 * A state is never carried by colour alone: the forecast says "Fits" / "Over the cap" in words.
 */
import { getUnitType } from "@caravan/content";
import type { CosmeticInfoView, PackContentView, StoreOverflowView } from "../../api/types.ts";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.store;

/** "for your Dust Rider units" / "for your caravan's wagons": what a cosmetic is drawn on. */
export function appliesToText(c: Pick<CosmeticInfoView, "kind" | "appliesTo">): string {
  if (c.appliesTo !== null) return T.appliesToUnit(getUnitType(c.appliesTo)?.displayName ?? c.appliesTo);
  return T.appliesToKind(c.kind);
}

export function CosmeticLine({ cosmetic }: { readonly cosmetic: CosmeticInfoView }): JSX.Element {
  return (
    <>
      <span className="card__name">{cosmetic.displayName}</span>
      <span className="hint">
        {" "}
        · {T.cosmeticKind(cosmetic.kind)} {appliesToText(cosmetic)}
      </span>
      <div className="hint">{cosmetic.description}</div>
    </>
  );
}

export interface PackContentsProps {
  readonly contents: readonly PackContentView[];
  readonly cosmetics: readonly CosmeticInfoView[];
  /** Cosmetic ids the account already owns: marked "not granted twice". */
  readonly owned?: ReadonlySet<string>;
  readonly testId?: string;
}

/** Every entry of `contents`, in order: the Coin amount, then each cosmetic by name, kind and what it applies to. */
export function PackContents({ contents, cosmetics, owned, testId }: PackContentsProps): JSX.Element {
  const byId = new Map(cosmetics.map((c) => [c.id, c]));
  return (
    <ul className="plain pack-contents" data-testid={testId}>
      {contents.map((c, i) =>
        c.kind === "coin" ? (
          <li key={`coin-${i}`} data-kind="coin">
            <span className="card__name">{T.coinItem(c.amount)}</span>
          </li>
        ) : (
          <li key={c.cosmeticId} data-kind="cosmetic" data-cosmetic={c.cosmeticId}>
            {byId.has(c.cosmeticId) ? <CosmeticLine cosmetic={byId.get(c.cosmeticId)!} /> : <span className="card__name">{T.unknownCosmetic(c.cosmeticId)}</span>}
            {owned?.has(c.cosmeticId) && <div className="hint">{T.confirmOwned}</div>}
          </li>
        ),
      )}
    </ul>
  );
}

/** The forecast for crediting an amount right now: a word, the numbers, and the server's own sentence. */
export function OverflowLine({ overflow, testId }: { readonly overflow: StoreOverflowView; readonly testId?: string }): JSX.Element {
  return (
    <div className={overflow.warn ? "forecast forecast--warn" : "forecast"} data-testid={testId} data-warn={overflow.warn ? "yes" : "no"}>
      <strong>
        <span aria-hidden="true">{overflow.warn ? "▲ " : "✓ "}</span>
        {overflow.warn ? T.overflowWarn : T.overflowOk}:
      </strong>{" "}
      {T.overflowLine(overflow.wouldCredit, overflow.wouldDiscard)}
      <div className="hint">{overflow.message}</div>
    </div>
  );
}
