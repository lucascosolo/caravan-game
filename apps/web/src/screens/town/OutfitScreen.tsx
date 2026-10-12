/**
 * "Outfit the caravan" (chunk 17, open question 1 decided as proposed): the loadout
 * decision made in town before a trip. Living units from the roster against
 * DEPLOYMENT_SLOT_CAP, traps against TRAP_SLOT_CAP, fence material against
 * FENCE_MATERIAL_BUDGET (below the ring's position count, so gaps are forced), the Coin
 * cap forecast for the trip, then a real-modal confirm that packs the manifest
 * (`POST /caravans/:id/manifest`). It is not the merge board and not the wagon circle.
 *
 * Chunk 23: the confirm is "Pack and ride out": the manifest is packed (`POST …/manifest`)
 * and the trip started (`POST /me/caravans/:id/trip/start`, one trip-cap use) in one step. The
 * dialog quotes the trip cap from the server's status read. If the start is refused (no trip
 * available yet, or any other refusal) the caravan stays packed and the screen becomes the
 * "Packed, waiting to ride out" panel (RideOutPanel) with the server's reason and countdown.
 * The server's packer decides legality; its issue list is shown exactly.
 */
import { TUNABLES, getFenceTier, getTrapType } from "@caravan/content";
import { useCallback, useEffect, useRef, useState } from "react";
import { useOnboarding } from "../../onboarding/OnboardingProvider.tsx";
import { ApiError, type Api } from "../../api/client.ts";
import type { TripStatusView } from "../../api/tripTypes.ts";
import type { EconomyView, IssueView, ManifestView } from "../../api/types.ts";
import { formatSeconds } from "../../shell/countdown.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { humanizeIssue } from "../../shell/issues.ts";
import { Modal } from "../../shell/Modal.tsx";
import { STRINGS } from "../../strings.ts";
import type { RosterUnit } from "./board.ts";
import { unitName } from "./BoardPanel.tsx";
import { RideOutPanel, TripCapLine } from "./RideOutPanel.tsx";
import {
  EMPTY_OUTFIT,
  FENCE_BUDGET,
  RING_POSITIONS,
  addTrap,
  outfitMeters,
  packRequest,
  removeTrap,
  setFenceCount,
  setFenceTier,
  toggleUnit,
  trapCount,
  type Meter,
  type OutfitDraft,
} from "./outfitModel.ts";

const T = STRINGS.outfit;

export interface OutfitScreenProps {
  readonly api: Api;
  readonly caravanId: string;
  readonly units: readonly RosterUnit[];
  readonly onBack: () => void;
  /** The manifest is packed: the town re-reads its state. */
  readonly onPacked: (manifest: ManifestView) => void;
  /** The trip started (chunk 23): the caller moves to the Trail. */
  readonly onRodeOut: (replayed: boolean) => void;
}

interface Catalog {
  readonly traps: readonly string[];
  readonly fences: readonly string[];
  readonly forecast: EconomyView | null;
  readonly shortestTrip: number;
  /** The trip cap as of this read (null if it could not be read; the server still decides). */
  readonly trip: TripStatusView | null;
}

/**
 * Final play-test review S1: the guide's pre-fill packs at most roster − GUIDE_RESERVE living
 * units (highest merge level first, within the slot cap), so a first-trip overrun can never
 * take the whole roster. At least one unit is always ticked so the trip can ride. Pure.
 */
export function guidePrefill(units: readonly RosterUnit[], reserve: number = TUNABLES.GUIDE_RESERVE, slots: number = TUNABLES.DEPLOYMENT_SLOT_CAP): readonly string[] {
  if (units.length === 0) return [];
  const n = Math.max(1, Math.min(slots, units.length - Math.max(0, reserve)));
  return [...units]
    .sort((a, b) => b.mergeLevel - a.mergeLevel || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, n)
    .map((u) => u.id);
}

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

function MeterBar({ m, label, testId }: { m: Meter; label: string; testId: string }): JSX.Element {
  return (
    <>
      <p data-testid={testId} data-over={m.over > 0 ? "true" : "false"}>
        {label}
      </p>
      <span className="meter" role="img" aria-label={label}>
        <span className="meter__fill" style={{ width: `${Math.min(100, m.cap > 0 ? (m.chosen / m.cap) * 100 : 100)}%`, background: m.over > 0 ? "var(--warn)" : undefined }} />
      </span>
    </>
  );
}

export function OutfitScreen({ api, caravanId, units, onBack, onPacked, onRodeOut }: OutfitScreenProps): JSX.Element {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState<OutfitDraft>(EMPTY_OUTFIT);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [issues, setIssues] = useState<readonly IssueView[]>([]);
  const [packed, setPacked] = useState<ManifestView | null>(null);
  const [startError, setStartError] = useState<ApiError | null>(null);
  const [packedStatus, setPackedStatus] = useState<TripStatusView | null>(null);
  const onboarding = useOnboarding();
  const guiding = onboarding?.active === true && onboarding.step === "outfit";
  const prefilled = useRef(false);
  const [guideFilled, setGuideFilled] = useState<number | null>(null);
  useEffect(() => {
    if (!guiding || prefilled.current || units.length === 0) return;
    prefilled.current = true;
    const ids = guidePrefill(units);
    setDraft((d) => (d.units.length > 0 ? d : { ...d, units: [...ids] }));
    setGuideFilled(ids.length);
  }, [guiding, units]);

  const load = useCallback(async (): Promise<void> => {
    setLoadError(null);
    setCatalog(null);
    try {
      const [unlocks, economy, trip] = await Promise.all([api.unlocks(), api.economy(), api.tripStatus(caravanId).catch(() => null)]);
      const reached = unlocks.webs.filter((w) => w.pool === "trap").flatMap((w) => w.nodes.filter((n) => n.reached).map((n) => n.id));
      // The forecast is for the shortest trip: one encounter survived, then banked — both the server's numbers.
      const shortestTrip = (economy.earn.encounterSchedule[0] ?? 0) + economy.earn.bankedTripBonus;
      const forecast = await api.economy(shortestTrip);
      setCatalog({ traps: reached.filter((id) => !!getTrapType(id)), fences: reached.filter((id) => !!getFenceTier(id)), forecast, shortestTrip, trip });
    } catch (err) {
      setLoadError(asApiError(err));
    }
  }, [api, caravanId]);

  useEffect(() => {
    void load();
  }, [load]);

  const meters = outfitMeters(draft);
  const wholeRoster = units.length > 0 && units.every((u) => draft.units.includes(u.id));

  const pack = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setIssues([]);
    let manifest: ManifestView;
    try {
      manifest = (await api.packManifest(caravanId, packRequest(draft))).manifest;
    } catch (err) {
      const e = asApiError(err);
      setError(e);
      setIssues(e.issues);
      setConfirming(false);
      setBusy(false);
      return;
    }
    onPacked(manifest);
    // Packed: now ride out. A refusal leaves the caravan packed, waiting, with the server's reason.
    try {
      await api.startTrip(caravanId);
      setConfirming(false);
      setBusy(false);
      onRodeOut(false);
      return;
    } catch (err) {
      setStartError(asApiError(err));
    }
    setPackedStatus(await api.tripStatus(caravanId).catch(() => catalog?.trip ?? null));
    setPacked(manifest);
    setConfirming(false);
    setBusy(false);
  };

  const head = (
    <>
      <button type="button" className="btn" onClick={onBack} data-testid="outfit-back">
        {T.back}
      </button>
      <h1 id="outfit-heading" tabIndex={-1}>
        {T.title}
      </h1>
    </>
  );

  if (packed) {
    return (
      <section data-testid="outfit-packed">
        {head}
        <p className="notice" role="status">
          <strong>{T.packed}</strong>
        </p>
        <p data-testid="packed-summary">{T.packedSummary(packed.packed.units.length, packed.packed.traps.length, packed.packed.fences.length)}</p>
        <p className="hint">{T.packedBody}</p>
        {packedStatus ? (
          <RideOutPanel api={api} caravanId={caravanId} status={packedStatus} initialError={startError} onStarted={(_s, replayed) => onRodeOut(replayed)} />
        ) : (
          startError && <ErrorBox error={startError} />
        )}
      </section>
    );
  }
  if (loadError) {
    return (
      <section>
        {head}
        <ErrorBox error={loadError} heading={T.loadFailed} onRetry={() => void load()} />
      </section>
    );
  }
  if (!catalog) {
    return (
      <section>
        {head}
        <p className="hint" role="status">
          {STRINGS.app.loading}
        </p>
      </section>
    );
  }

  // Server issue refs shown by the names the player sees (chunk 08 QA S8).
  const issueNames = new Map<string, string>([
    ...units.map((u): [string, string] => [u.typeId, unitName(u.typeId)]),
    ...units.map((u): [string, string] => [u.id, T.unitToggle(unitName(u.typeId), u.mergeLevel)]),
    ...catalog.traps.map((id): [string, string] => [id, getTrapType(id)?.displayName ?? id]),
    ...catalog.fences.map((id): [string, string] => [id, getFenceTier(id)?.displayName ?? id]),
  ]);
  const fenceTierName = draft.fence ? (getFenceTier(draft.fence.tierId)?.displayName ?? draft.fence.tierId) : "";
  const overflow = catalog.forecast?.overflow ?? null;
  // Final play-test review N9: with no trip available, packing would lock the manifest with nowhere to go; wait instead.
  const noTrip =
    catalog.trip && catalog.trip.cap.available === 0
      ? formatSeconds(catalog.trip.cap.nextRegenAtMs === null ? 0 : Math.max(0, catalog.trip.cap.nextRegenAtMs - catalog.trip.nowMs) / 1000)
      : null;

  return (
    <section data-testid="outfit-screen">
      {head}
      <p className="hint">{T.intro}</p>

      <h2>{T.unitsHeading}</h2>
      <MeterBar m={meters.units} label={T.unitsMeter(meters.units.chosen, meters.units.cap)} testId="outfit-units-meter" />
      <p className="hint">{T.unitsNote}</p>
      {meters.units.over > 0 && (
        <p className="error" role="alert" data-testid="outfit-units-over">
          {T.unitsOver(meters.units.over)}
        </p>
      )}
      {meters.noUnits && <p className="hint">{T.unitsNone}</p>}
      {guideFilled !== null && (
        <p className="hint" data-testid="outfit-guide-reserve">
          {T.guideReserve(guideFilled, units.length - guideFilled)}
        </p>
      )}
      {wholeRoster && (
        <p className="notice" role="status" data-testid="outfit-whole-roster">
          {T.wholeRoster(units.length)}
        </p>
      )}
      <p className="hint" data-testid="outfit-stakes">
        {T.stakesLine}
      </p>
      <ul className="chips" data-testid="outfit-units">
        {units.map((u) => {
          const on = draft.units.includes(u.id);
          return (
            <li key={u.id} className={`chip${on ? " chip--selected" : ""}`} data-unit={u.id}>
              <label className="chip__btn" style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem", cursor: "pointer", touchAction: "pan-y" }}>
                <input type="checkbox" checked={on} onChange={() => setDraft((d) => toggleUnit(d, u.id))} style={{ width: "1.25rem", height: "1.25rem" }} />
                <span className="chip__name">{T.unitToggle(unitName(u.typeId), u.mergeLevel)}</span>
              </label>
            </li>
          );
        })}
      </ul>

      <h2>{T.trapsHeading}</h2>
      <MeterBar m={meters.traps} label={T.trapsMeter(meters.traps.chosen, meters.traps.cap)} testId="outfit-traps-meter" />
      <p className="hint">{T.trapsNote}</p>
      {meters.traps.over > 0 && (
        <p className="error" role="alert" data-testid="outfit-traps-over">
          {T.trapsOver(meters.traps.over)}
        </p>
      )}
      {catalog.traps.length === 0 && <p className="hint">{T.trapsNone}</p>}
      <ul className="cards" data-testid="outfit-traps">
        {catalog.traps.map((id) => {
          const name = getTrapType(id)?.displayName ?? id;
          const n = trapCount(draft, id);
          return (
            <li key={id} className="card" data-type={id}>
              <div className="card__head">
                <span className="card__name">{name}</span>
                <span>{T.trapCount(n)}</span>
              </div>
              <div className="row" style={{ marginTop: "0.375rem" }}>
                <button type="button" className="btn" disabled={n === 0} onClick={() => setDraft((d) => removeTrap(d, id))}>
                  {T.trapRemove(name)}
                </button>
                <button type="button" className="btn" onClick={() => setDraft((d) => addTrap(d, id))}>
                  {T.trapAdd(name)}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <h2>{T.fenceHeading}</h2>
      {catalog.fences.length === 0 ? (
        <p className="hint">{T.fenceNone}</p>
      ) : (
        <>
          <label className="field">
            <span className="field__label">{T.fenceTier}</span>
            <select value={draft.fence?.tierId ?? ""} onChange={(e) => setDraft((d) => setFenceTier(d, e.target.value === "" ? null : e.target.value))} data-testid="outfit-fence-tier">
              <option value="">{T.fenceNoneTier}</option>
              {catalog.fences.map((id) => (
                <option key={id} value={id}>
                  {getFenceTier(id)?.displayName ?? id}
                </option>
              ))}
            </select>
          </label>
          {draft.fence && (
            <label className="field">
              <span className="field__label">{T.fenceCount}</span>
              <input type="number" inputMode="numeric" min={0} max={FENCE_BUDGET} value={draft.fence.count} onChange={(e) => setDraft((d) => setFenceCount(d, Number(e.target.value)))} data-testid="outfit-fence-count" />
            </label>
          )}
          <MeterBar m={meters.fence} label={T.fenceMeter(meters.fence.chosen, FENCE_BUDGET, RING_POSITIONS)} testId="outfit-fence-meter" />
          {meters.fence.over > 0 && (
            <p className="error" role="alert" data-testid="outfit-fence-over">
              {T.fenceOver(meters.fence.over)}
            </p>
          )}
        </>
      )}

      <h2>{STRINGS.trip.rideOut}</h2>
      {catalog.trip ? <TripCapLine status={catalog.trip} /> : <p className="hint">{T.capLoadFailed}</p>}

      <h2>{T.coinHeading}</h2>
      {overflow && (
        <>
          <p data-testid="outfit-forecast" className={overflow.warn ? "error" : undefined} role={overflow.warn ? "alert" : undefined}>
            {T.coinForecast(overflow.message)}
          </p>
          <p className="hint">{T.coinForecastNote(catalog.shortestTrip)}</p>
          {overflow.warn && <p className="hint">{T.coinWarn}</p>}
        </>
      )}

      {issues.length > 0 && (
        <div className="error" role="alert" data-testid="outfit-issues">
          <div>{T.issuesHeading}</div>
          <ul className="issues">
            {issues.map((i, n) => (
              <li key={`${i.code}-${n}`}>
                {humanizeIssue(i, issueNames)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && issues.length === 0 && <ErrorBox error={error} heading={T.issuesHeading} />}

      {noTrip !== null && (
        <p className="hint" role="status" data-testid="outfit-no-trip">
          {T.noTripNow(noTrip)}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn btn--primary btn--block" disabled={busy || noTrip !== null} onClick={() => setConfirming(true)} data-testid="outfit-ride-out">
          {noTrip !== null ? T.rideOutWaiting(noTrip) : T.rideOut}
        </button>
      </div>

      {confirming && (
        <Modal
          title={T.confirmTitle}
          busy={busy}
          onCancel={() => setConfirming(false)}
          testId="outfit-dialog"
          restoreFocusTo={() => document.getElementById("outfit-heading")}
          actions={
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>
                {T.confirmNo}
              </button>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void pack()} data-testid="outfit-confirm">
                {busy ? T.packing : T.confirmYes}
              </button>
            </>
          }
        >
          <p>{T.confirmIntro}</p>
          <ul className="plain dialog__items">
            <li>{T.confirmUnits(draft.units.length)}</li>
            <li>{T.confirmTraps(draft.traps.length)}</li>
            <li>{T.confirmFence(draft.fence?.count ?? 0, fenceTierName)}</li>
          </ul>
          {catalog.trip && (
            <p data-testid="outfit-confirm-trip">
              {catalog.trip.cap.available > 0
                ? T.confirmTrip(catalog.trip.cap.available, catalog.trip.cap.cap)
                : T.confirmNoTrip(formatSeconds(catalog.trip.cap.nextRegenAtMs === null ? 0 : Math.max(0, catalog.trip.cap.nextRegenAtMs - catalog.trip.nowMs) / 1000))}
            </p>
          )}
          {wholeRoster && <p className="notice">{T.wholeRoster(units.length)}</p>}
          <p className="hint">{T.stakesLine}</p>
          {(meters.anyOver || meters.noUnits) && <p className="error">{T.confirmOverCaps}</p>}
        </Modal>
      )}
    </section>
  );
}
