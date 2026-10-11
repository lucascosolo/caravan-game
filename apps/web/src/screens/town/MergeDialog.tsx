/**
 * The merge preview → confirm → commit dialog (chunk 17; chunk 16's routes). A real modal
 * (src/shell/Modal.tsx). On open it asks the server for the preview — the legibility
 * contract (GUARDRAILS §4): the cost, the balance it will be checked against INCLUDING the
 * trickle pending right now, the resulting stats, the slots freed, and which consumed units
 * ride in the standing party. Nothing is spent until the player confirms; a unit the party
 * names needs its own explicit confirmation (`confirmInParty`, chunk 09 QA S3).
 *
 * Every number here is the server's. A refusal (insufficient Coin, the caravan on a trip,
 * the inputs changed) is shown verbatim in the same dialog.
 *
 * Copy rule (GUARDRAILS §2): a merged unit is never "stronger" than its parts — the produced
 * units are shown beside the consumed ones COMBINED, and the gain named is slots.
 */
import { useEffect, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { MergePreview, MergeResultView, UnitStatsView } from "../../api/types.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { Modal } from "../../shell/Modal.tsx";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.town;

export interface MergeDialogProps {
  readonly api: Api;
  readonly caravanId: string;
  /** The units to consume, drop target first (the product lands on its cell). */
  readonly instanceIds: readonly string[];
  readonly onDone: (result: MergeResultView) => void;
  readonly onCancel: () => void;
  /** Focus target on close when the opener (a chip the merge consumed) is gone (QA-17 N4). */
  readonly restoreFocusTo?: () => HTMLElement | null;
}

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

/** mult / den as decimal text with up to two places, integer arithmetic only. */
export function ratioText(mult: number, den: number): string {
  const hundredths = Math.round((mult * 100) / den);
  const whole = Math.trunc(hundredths / 100);
  const frac = hundredths % 100;
  if (frac === 0) return String(whole);
  const f = frac < 10 ? `0${frac}` : String(frac);
  return `${whole}.${f.replace(/0$/, "")}`;
}

function StatsColumn({ heading, count, stats, testId }: { heading: string; count: number; stats: UnitStatsView; testId: string }): JSX.Element {
  return (
    <div data-testid={testId}>
      <div className="h3">{T.statsColumn(heading, count)}</div>
      <dl className="statlist statlist--compact">
        <dt>{T.statHp}</dt>
        <dd>{stats.hp}</dd>
        <dt>{T.statHit}</dt>
        <dd>{stats.referenceHit}</dd>
        <dt>{T.statOffense}</dt>
        <dd>{stats.offense}</dd>
        <dt>{T.statDefense}</dt>
        <dd>{stats.defense}</dd>
      </dl>
    </div>
  );
}

export function MergeDialog({ api, caravanId, instanceIds, onDone, onCancel, restoreFocusTo }: MergeDialogProps): JSX.Element {
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [commitError, setCommitError] = useState<ApiError | null>(null);
  const [inPartyOk, setInPartyOk] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .previewMerge(caravanId, instanceIds)
      .then((p) => live && setPreview(p))
      .catch((err: unknown) => live && setLoadError(asApiError(err)));
    return () => {
      live = false;
    };
  }, [api, caravanId, instanceIds]);

  const commit = async (): Promise<void> => {
    if (!preview) return;
    setBusy(true);
    setCommitError(null);
    try {
      const res = await api.commitMerge(caravanId, preview.requiresConfirmInParty ? { instanceIds, confirmInParty: inPartyOk } : { instanceIds });
      onDone(res);
    } catch (err) {
      setCommitError(asApiError(err));
      setBusy(false);
    }
  };

  const canConfirm = !!preview && preview.affordable && (!preview.requiresConfirmInParty || inPartyOk) && !busy;

  return (
    <Modal
      title={T.previewTitle}
      busy={busy}
      onCancel={onCancel}
      testId="merge-dialog"
      {...(restoreFocusTo ? { restoreFocusTo } : {})}
      actions={
        <>
          <button type="button" className="btn" disabled={busy} onClick={onCancel}>
            {T.previewCancel}
          </button>
          {preview && (
            <button type="button" className="btn btn--primary" disabled={!canConfirm} onClick={() => void commit()} data-testid="merge-confirm">
              {busy ? T.merging : T.previewConfirm(preview.totalCost)}
            </button>
          )}
        </>
      }
    >
      {!preview && !loadError && (
        <p className="hint" role="status">
          {T.previewLoading}
        </p>
      )}
      {loadError && <ErrorBox error={loadError} heading={T.mergeRefused} />}
      {preview && (
        <div data-testid="merge-preview">
          <p data-testid="merge-line">{T.previewLine(preview.recipe.spend, preview.fromLevel, preview.recipe.produce, preview.toLevel, preview.unitDisplayName)}</p>
          <p data-testid="merge-cost">
            <strong>{T.previewCost(preview.totalCost, preview.costPerUnit)}</strong>
          </p>
          <p data-testid="merge-balance">{T.previewBalance(preview.balance, preview.pendingTrickle)}</p>
          {!preview.affordable && (
            <p className="error" role="alert" data-testid="merge-unaffordable">
              {T.previewUnaffordable}
            </p>
          )}
          <p data-testid="merge-slots">{T.previewSlots(preview.slotsFreed, preview.consumed.slots, preview.produced.slots)}</p>
          <div className="h3">{T.previewStats}</div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <StatsColumn heading={T.previewBefore} count={preview.consumed.count} stats={preview.consumed.combined} testId="merge-consumed" />
            <StatsColumn heading={T.previewAfter} count={preview.produced.count} stats={preview.produced.combined} testId="merge-produced" />
          </div>
          <p className="hint">{T.statDamageMult(ratioText(preview.produced.perUnit.damageOutputMult, preview.produced.perUnit.multDen))}</p>
          <p className="hint">{T.previewAbility(preview.ability.displayName)}</p>
          <p className="hint">{T.previewNotStronger}</p>
          {preview.requiresConfirmInParty && (
            <div className="error" role="alert" data-testid="merge-in-party">
              <p style={{ marginTop: 0 }}>{T.previewInParty(preview.consumed.inParty.length)}</p>
              <label className="toggles" style={{ margin: 0, minHeight: "var(--tap)", alignItems: "center" }}>
                <input type="checkbox" checked={inPartyOk} disabled={busy} onChange={(e) => setInPartyOk(e.target.checked)} data-testid="merge-in-party-confirm" />{" "}
                {T.previewInPartyCheckbox}
              </label>
            </div>
          )}
          {commitError && <ErrorBox error={commitError} heading={T.mergeRefused} />}
        </div>
      )}
    </Modal>
  );
}
