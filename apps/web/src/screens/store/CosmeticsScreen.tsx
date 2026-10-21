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
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Note } from "../../ui/Note.tsx";
import { CosmeticLine, appliesToText } from "./PackParts.tsx";
import "./store.css";

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
      <div className="store__bar">
        <Button variant="tertiary" onClick={() => navigate("town")}>
          {T.back}
        </Button>
        <Button variant="secondary" onClick={() => navigate("packs")}>
          {T.toPacks}
        </Button>
      </div>
      <h1 className="cv-title">{T.title}</h1>
      <div className="cv-banner-sign store__sign" role="note" data-testid="cosmetics-visual-only">
        <Icon name="info" />
        <p className="cv-banner-sign__text">{T.visualOnly}</p>
      </div>
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
        <div className="cv-banner-sign store__sign" role="status" data-testid="cosmetics-status">
          <p className="cv-banner-sign__text">{status}</p>
        </div>
      )}
      {error && <ErrorBox error={error} heading={T.refused} />}

      <h2 className="cv-label">{T.ownedHeading}</h2>
      {groups.length === 0 && <p data-testid="cosmetics-none">{T.noneOwned}</p>}
      {groups.map((g) => (
        <section key={g.kind} aria-labelledby={`kind-${g.kind}`} data-testid={`kind-${g.kind}`}>
          <h3 id={`kind-${g.kind}`} className="cv-label">
            {T.kindHeading(S.cosmeticKind(g.kind), g.count)}
          </h3>
          {g.slots.map((s) => {
            const equippedId = view.equipped[s.slot];
            const equippedName = equippedId ? (names.get(equippedId) ?? equippedId) : null;
            return (
              <div key={s.slot} data-testid={`slot-${s.slot}`} data-equipped={equippedId ?? ""}>
                <Note className="store__note">
                <div className="hint">{T.slotLine(`${S.cosmeticKind(s.sample.kind)} ${appliesToText(s.sample)}`)}</div>
                <div data-testid={`slot-${s.slot}-state`}>{equippedName ? T.slotEquipped(equippedName) : T.slotEmpty}</div>
                <ul className="store__contents">
                  {s.items.map((c) => {
                    const on = equippedId === c.id;
                    return (
                      <li key={c.id} data-cosmetic={c.id}>
                        <div className="store__top">
                          <span>
                            <CosmeticLine cosmetic={c} />
                          </span>
                          {on && (
                            <span className="cv-pill cv-pill--brass cv-pill--sm">
                              <span aria-hidden="true">✓ </span>
                              {T.equippedBadge}
                            </span>
                          )}
                        </div>
                        <div className="hint">{T.grantedAt(formatWhen(c.grantedAt))}</div>
                        {on ? (
                          <Button variant="secondary" block disabled={busy !== null} onClick={() => void unequip(s.slot, c.displayName)} testId={`unequip-${c.id}`}>
                            {busy === `unequip:${s.slot}` ? T.working : T.unequip(c.displayName)}
                          </Button>
                        ) : (
                          <Button variant="primary" block disabled={busy !== null} onClick={() => void equip(c)} testId={`equip-${c.id}`}>
                            {busy === `equip:${c.id}` ? T.working : T.equip(c.displayName)}
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
                </Note>
              </div>
            );
          })}
        </section>
      ))}

      <details className="disclosure" data-testid="cosmetics-catalog">
        <summary className="store__summary cv-label">{T.catalogHeading}</summary>
        <ul className="store__contents">
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
