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
import { TUNABLES } from "@caravan/content";
import { useEffect, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { MergePreview, MergeResultView, UnitStatsView } from "../../api/types.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { STRINGS } from "../../strings.ts";
import { Button } from "../../ui/Button.tsx";
import { Note } from "../../ui/Note.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { ErrorPlate } from "./townBits.tsx";

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
  /** Final play-test review D2: the roster's size, to say when merging lowers what the caravan can pack. */
  readonly rosterSize?: number;
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
    <div className="cv-card town-panel" data-testid={testId}>
      <div className="town-name">{T.statsColumn(heading, count)}</div>
      {(
        [
          [T.statHp, stats.hp],
          [T.statHit, stats.referenceHit],
          [T.statOffense, stats.offense],
          [T.statDefense, stats.defense],
        ] as const
      ).map(([label, value]) => (
        <div key={label} className="cv-stat">
          <span>{label}</span>
          <span className="cv-num">{value}</span>
        </div>
      ))}
    </div>
  );
}

export function MergeDialog({ api, caravanId, instanceIds, onDone, onCancel, restoreFocusTo, rosterSize }: MergeDialogProps): JSX.Element {
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
    <Sheet
      title={T.previewTitle}
      busy={busy}
      onClose={onCancel}
      testId="merge-dialog"
      {...(restoreFocusTo ? { restoreFocusTo } : {})}
      footer={
        <div className="town-actions">
          <Button disabled={busy} onClick={onCancel}>
            {T.previewCancel}
          </Button>
          {preview && (
            <Button variant="primary" icon="coin" disabled={!canConfirm} onClick={() => void commit()} testId="merge-confirm">
              {busy ? T.merging : T.previewConfirm(preview.totalCost)}
            </Button>
          )}
        </div>
      }
    >
      {!preview && !loadError && (
        <p className="cv-small" role="status">
          {T.previewLoading}
        </p>
      )}
      {loadError && <ErrorBox error={loadError} heading={T.mergeRefused} />}
      {preview && (
        <div className="town-panel" data-testid="merge-preview">
          <p data-testid="merge-line">{T.previewLine(preview.recipe.spend, preview.fromLevel, preview.recipe.produce, preview.toLevel, preview.unitDisplayName)}</p>
          <p data-testid="merge-cost">
            <strong>{T.previewCost(preview.totalCost, preview.costPerUnit)}</strong>
          </p>
          <p data-testid="merge-balance">{T.previewBalance(preview.balance, preview.pendingTrickle)}</p>
          {!preview.affordable && (
            <ErrorPlate testId="merge-unaffordable">{T.previewUnaffordable}</ErrorPlate>
          )}
          <p data-testid="merge-slots">{T.previewSlots(preview.slotsFreed, preview.consumed.slots, preview.produced.slots)}</p>
          <div className="town-name">{T.previewStats}</div>
          <div className="town-stats">
            <StatsColumn heading={T.previewBefore} count={preview.consumed.count} stats={preview.consumed.combined} testId="merge-consumed" />
            <StatsColumn heading={T.previewAfter} count={preview.produced.count} stats={preview.produced.combined} testId="merge-produced" />
          </div>
          <p className="cv-small">{T.statDamageMult(ratioText(preview.produced.perUnit.damageOutputMult, preview.produced.perUnit.multDen))}</p>
          <p className="cv-small">{T.previewAbility(preview.ability.displayName)}</p>
          <p className="cv-small">{T.previewNotStronger}</p>
          {rosterSize !== undefined && rosterSize < TUNABLES.DEPLOYMENT_SLOT_CAP && (
            <Note variant="canvas" testId="merge-below-slots">
              {T.previewBelowSlots(rosterSize, TUNABLES.DEPLOYMENT_SLOT_CAP, rosterSize - preview.slotsFreed)}
            </Note>
          )}
          {preview.requiresConfirmInParty && (
            <ErrorPlate testId="merge-in-party">
              <span style={{ display: "block" }}>{T.previewInParty(preview.consumed.inParty.length)}</span>
              <label style={{ display: "flex", gap: 8, alignItems: "center", minHeight: 44 }}>
                <input type="checkbox" checked={inPartyOk} disabled={busy} onChange={(e) => setInPartyOk(e.target.checked)} data-testid="merge-in-party-confirm" /> {T.previewInPartyCheckbox}
              </label>
            </ErrorPlate>
          )}
          {commitError && <ErrorBox error={commitError} heading={T.mergeRefused} />}
        </div>
      )}
    </Sheet>
  );
}
