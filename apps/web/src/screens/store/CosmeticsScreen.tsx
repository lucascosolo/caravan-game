/**
 * THE COSMETICS SCREEN (chunk 20 web; PHASE-2 §28, minimal): what the account owns, grouped by
 * kind and then by equip slot, with equip / unequip per slot. A cosmetic is a DRAWING
 * PREFERENCE and nothing else (GUARDRAILS §2): it never reaches a formation, a party, a
 * manifest or the resolver, and the screen says so plainly. There are no numbers to show
 * because a cosmetic has none.
 *
 * Every write is the server's to accept: `POST /me/cosmetics/equip {cosmeticId}` and
 * `POST /me/cosmetics/unequip {slot}`. A refusal (409 `not_owned`, 404 `unknown_cosmetic`,
 * 400 `invalid_slot`) is shown with the server's own message — ids replaced by the names on
 * screen (src/shell/issues.ts) — and the screen re-reads after every write, refused or not.
 * Equipping and unequipping are idempotent preferences (no Coin moves), so a lost answer is
 * simply re-read rather than retried.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { CosmeticInfoView, CosmeticsView, OwnedCosmeticView } from "../../api/types.ts";
import { useApi } from "../../auth/session.tsx";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { formatWhen, humanizeText } from "../../shell/issues.ts";
import { navigate } from "../../shell/router.tsx";
import { STRINGS } from "../../strings.ts";
import { CosmeticLine, appliesToText } from "./PackParts.tsx";

const T = STRINGS.cosmetics;
const S = STRINGS.store;

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

/** The server's refusal, with every cosmetic id it names replaced by the cosmetic's name. */
function humanized(e: ApiError, names: ReadonlyMap<string, string>): ApiError {
  if (e.status === 0) return e;
  return new ApiError(e.status, e.code, humanizeText(e.message, names), e.detail, e.issues, e.body);
}

interface SlotGroup {
  readonly slot: string;
  readonly sample: CosmeticInfoView;
  readonly items: readonly OwnedCosmeticView[];
}

/** Owned cosmetics by kind (in the server's kind order), then by slot (in first-seen order). */
export function groupOwned(view: CosmeticsView): readonly { readonly kind: CosmeticInfoView["kind"]; readonly slots: readonly SlotGroup[]; readonly count: number }[] {
  return view.kinds
    .map((kind) => {
      const mine = view.owned.filter((o) => o.kind === kind);
      const slots = new Map<string, OwnedCosmeticView[]>();
      for (const o of mine) slots.set(o.slot, [...(slots.get(o.slot) ?? []), o]);
      return { kind, count: mine.length, slots: [...slots].map(([slot, items]) => ({ slot, sample: items[0]!, items })) };
    })
    .filter((g) => g.count > 0);
}

export interface CosmeticsScreenProps {
  /** Injected for tests; defaults to the session's client. */
  readonly api?: Api;
}

export function CosmeticsScreen(props: CosmeticsScreenProps = {}): JSX.Element {
  const api = useApi(props.api);
  const [view, setView] = useState<CosmeticsView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      setView(await api.cosmetics());
      setLoadError(null);
    } catch (err) {
      setLoadError(asApiError(err));
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const names = useMemo(() => new Map((view?.catalog ?? []).map((c) => [c.id, c.displayName] as const)), [view]);

  const act = async (key: string, write: () => Promise<string>): Promise<void> => {
    setBusy(key);
    setError(null);
    setStatus(null);
    try {
      setStatus(await write());
    } catch (err) {
      setError(humanized(asApiError(err), names));
    } finally {
      setBusy(null);
      await load();
    }
  };

  const equip = (c: OwnedCosmeticView): Promise<void> =>
    act(`equip:${c.id}`, async () => {
      await api.equipCosmetic(c.id);
      return T.equipped(c.displayName);
    });

  const unequip = (slot: string, name: string): Promise<void> =>
    act(`unequip:${slot}`, async () => {
      const r = await api.unequipCosmetic(slot);
      return r.cleared ? T.unequipped(name) : T.alreadyClear;
    });

  const top = (
    <>
      <div className="row row--spread">
        <button type="button" className="btn" onClick={() => navigate("town")}>
          {T.back}
        </button>
        <button type="button" className="btn" onClick={() => navigate("packs")}>
          {T.toPacks}
        </button>
      </div>
      <h1>{T.title}</h1>
      <p className="notice" role="note" data-testid="cosmetics-visual-only">
        {T.visualOnly}
      </p>
    </>
  );

  if (!view) {
    return (
      <section data-testid="cosmetics-screen">
        {top}
        {loadError ? (
          <ErrorBox error={loadError} heading={T.loadFailed} onRetry={() => void load()} />
        ) : (
          <p className="hint" role="status">
            {STRINGS.app.loading}
          </p>
        )}
      </section>
    );
  }

  const groups = groupOwned(view);

  return (
    <section data-testid="cosmetics-screen">
      {top}
      {loadError && <ErrorBox error={loadError} heading={T.loadFailed} onRetry={() => void load()} />}
      {status && (
        <p className="notice" role="status" data-testid="cosmetics-status">
          {status}
        </p>
      )}
      {error && <ErrorBox error={error} heading={T.refused} />}

      <h2>{T.ownedHeading}</h2>
      {groups.length === 0 && <p data-testid="cosmetics-none">{T.noneOwned}</p>}
      {groups.map((g) => (
        <section key={g.kind} aria-labelledby={`kind-${g.kind}`} data-testid={`kind-${g.kind}`}>
          <h3 id={`kind-${g.kind}`} className="h3">
            {T.kindHeading(S.cosmeticKind(g.kind), g.count)}
          </h3>
          {g.slots.map((s) => {
            const equippedId = view.equipped[s.slot];
            const equippedName = equippedId ? (names.get(equippedId) ?? equippedId) : null;
            return (
              <div key={s.slot} className="card cosmetic-slot" data-testid={`slot-${s.slot}`} data-equipped={equippedId ?? ""}>
                <div className="hint">{T.slotLine(`${S.cosmeticKind(s.sample.kind)} ${appliesToText(s.sample)}`)}</div>
                <div data-testid={`slot-${s.slot}-state`}>{equippedName ? T.slotEquipped(equippedName) : T.slotEmpty}</div>
                <ul className="plain pack-contents">
                  {s.items.map((c) => {
                    const on = equippedId === c.id;
                    return (
                      <li key={c.id} data-cosmetic={c.id}>
                        <div className="card__head">
                          <span>
                            <CosmeticLine cosmetic={c} />
                          </span>
                          {on && (
                            <span className="badge">
                              <span aria-hidden="true">✓ </span>
                              {T.equippedBadge}
                            </span>
                          )}
                        </div>
                        <div className="hint">{T.grantedAt(formatWhen(c.grantedAt))}</div>
                        {on ? (
                          <button type="button" className="btn btn--block" disabled={busy !== null} onClick={() => void unequip(s.slot, c.displayName)} data-testid={`unequip-${c.id}`}>
                            {busy === `unequip:${s.slot}` ? T.working : T.unequip(c.displayName)}
                          </button>
                        ) : (
                          <button type="button" className="btn btn--primary btn--block" disabled={busy !== null} onClick={() => void equip(c)} data-testid={`equip-${c.id}`}>
                            {busy === `equip:${c.id}` ? T.working : T.equip(c.displayName)}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </section>
      ))}

      <details className="disclosure" data-testid="cosmetics-catalog">
        <summary>{T.catalogHeading}</summary>
        <ul className="plain pack-contents">
          {view.catalog.map((c) => (
            <li key={c.id} data-cosmetic={c.id}>
              <CosmeticLine cosmetic={c} />
              <div className="hint">{c.owned ? T.catalogOwned : c.nextOffer ? T.catalogNext(c.nextOffer.weekIndex, c.nextOffer.tier) : T.catalogNotSoon}</div>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
