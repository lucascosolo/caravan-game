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
import { STRINGS } from "../../strings.ts";
import { Button, CommitBanner } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { Sign } from "../../ui/Sign.tsx";
import type { RosterUnit } from "./board.ts";
import { unitName } from "./BoardPanel.tsx";
import { RideOutPanel, TripCapLine } from "./RideOutPanel.tsx";
import { ErrorPlate, Meter as MeterTrack, StatusNote } from "./townBits.tsx";
import {
  EMPTY_OUTFIT,
  FENCE_BUDGET,
  RING_POSITIONS,
  addTrap,
  loadLastOutfit,
  outfitMeters,
  packRequest,
  reapplyOutfit,
  removeTrap,
  saveLastOutfit,
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
      <MeterTrack label={label} fill={m.cap > 0 ? (m.chosen / m.cap) * 100 : 100} over={m.over > 0} />
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
      const [unlocks, economy, trip] = await Promise.all([api.unlocks(), api.economy(undefined, caravanId), api.tripStatus(caravanId).catch(() => null)]);
      const reached = unlocks.webs.filter((w) => w.pool === "trap").flatMap((w) => w.nodes.filter((n) => n.reached).map((n) => n.id));
      // The forecast is for the shortest trip: one encounter survived, then banked — the server's
      // number at this caravan's band (r4 N1); the base schedule only if the server sent none.
      const shortestTrip = economy.earn.caravan?.shortestTrip ?? (economy.earn.encounterSchedule[0] ?? 0) + economy.earn.bankedTripBonus;
      const forecast = await api.economy(shortestTrip);
      setCatalog({ traps: reached.filter((id) => !!getTrapType(id)), fences: reached.filter((id) => !!getFenceTier(id)), forecast, shortestTrip, trip });
    } catch (err) {
      setLoadError(asApiError(err));
    }
  }, [api, caravanId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Final play-test review r2 N5: a returning player opens with the last trip's traps and fence
  // (re-checked against what is unlocked now); "Pack the same as last trip" adds its units back.
  const [last] = useState<OutfitDraft | null>(() => loadLastOutfit(caravanId));
  const restored = useRef(false);
  useEffect(() => {
    if (!catalog || !last || guiding || restored.current) return;
    restored.current = true;
    setDraft((d) => (d.units.length > 0 || d.traps.length > 0 || d.fence ? d : reapplyOutfit(last, { units: units.map((u) => u.id), traps: catalog.traps, fences: catalog.fences }, false)));
  }, [catalog, last, guiding, units]);
  const lastAgain = last && catalog ? reapplyOutfit(last, { units: units.map((u) => u.id), traps: catalog.traps, fences: catalog.fences }, true) : null;

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
    saveLastOutfit(caravanId, draft);
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
      <Button icon="chevron-left" onClick={onBack} testId="outfit-back">
        {T.back}
      </Button>
      <h1 id="outfit-heading" tabIndex={-1}>
        <Sign variant="title">{T.title}</Sign>
      </h1>
    </>
  );

  if (packed) {
    return (
      <section className="town town-panel" data-testid="outfit-packed">
        {head}
        <StatusNote>
          <strong>{T.packed}</strong>
        </StatusNote>
        <p data-testid="packed-summary">{T.packedSummary(packed.packed.units.length, packed.packed.traps.length, packed.packed.fences.length)}</p>
        <p className="cv-small">{T.packedBody}</p>
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
      <section className="town town-panel">
        {head}
        <ErrorBox error={loadError} heading={T.loadFailed} onRetry={() => void load()} />
      </section>
    );
  }
  if (!catalog) {
    return (
      <section className="town town-panel">
        {head}
        <p className="cv-small" role="status">
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
    <section className="town town-panel" data-testid="outfit-screen">
      {head}
      <p className="cv-small">{T.intro}</p>

      {lastAgain && lastAgain.units.length > 0 && (
        <div className="town-panel" data-testid="outfit-last">
          <Button block icon="rotate" onClick={() => setDraft(lastAgain)} testId="outfit-same-as-last">
            {T.sameAsLast(lastAgain.units.length, lastAgain.traps.length, lastAgain.fence?.count ?? 0)}
          </Button>
          {last && lastAgain.units.length < last.units.length && <p className="cv-small">{T.sameAsLastLost(last.units.length - lastAgain.units.length)}</p>}
        </div>
      )}

      <h2>{T.unitsHeading}</h2>
      <MeterBar m={meters.units} label={T.unitsMeter(meters.units.chosen, meters.units.cap)} testId="outfit-units-meter" />
      <p className="cv-small">{T.unitsNote}</p>
      {meters.units.over > 0 && (
        <ErrorPlate testId="outfit-units-over">{T.unitsOver(meters.units.over)}</ErrorPlate>
      )}
      {meters.noUnits && <p className="cv-small">{T.unitsNone}</p>}
      {guideFilled !== null && (
        <p className="cv-small" data-testid="outfit-guide-reserve">
          {T.guideReserve(guideFilled, units.length - guideFilled)}
        </p>
      )}
      {wholeRoster && (
        <StatusNote testId="outfit-whole-roster">{T.wholeRoster(units.length)}</StatusNote>
      )}
      <div className="cv-strip" data-testid="outfit-stakes">
        <Icon name="info" />
        <span className="cv-small">{T.stakesLine}</span>
      </div>
      <ul className="town-list" data-testid="outfit-units">
        {units.map((u) => {
          const on = draft.units.includes(u.id);
          return (
            <li key={u.id} data-unit={u.id}>
              <label className={`cv-card town-unit${on ? " is-selected" : ""}`} style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={on} onChange={() => setDraft((d) => toggleUnit(d, u.id))} style={{ width: "1.5rem", height: "1.5rem" }} />
                <span className="town-name">{T.unitToggle(unitName(u.typeId), u.mergeLevel)}</span>
              </label>
            </li>
          );
        })}
      </ul>

      <h2>{T.trapsHeading}</h2>
      <MeterBar m={meters.traps} label={T.trapsMeter(meters.traps.chosen, meters.traps.cap)} testId="outfit-traps-meter" />
      <p className="cv-small">{T.trapsNote}</p>
      {meters.traps.over > 0 && (
        <ErrorPlate testId="outfit-traps-over">{T.trapsOver(meters.traps.over)}</ErrorPlate>
      )}
      {catalog.traps.length === 0 && <p className="cv-small">{T.trapsNone}</p>}
      <ul className="town-list" data-testid="outfit-traps">
        {catalog.traps.map((id) => {
          const name = getTrapType(id)?.displayName ?? id;
          const n = trapCount(draft, id);
          return (
            <li key={id} className="cv-card town-panel" data-type={id}>
              <div className="town-row">
                <span className="town-name town-grow">{name}</span>
                <span className="cv-pill cv-pill--parch cv-pill--sm">{T.trapCount(n)}</span>
              </div>
              <div className="town-actions">
                <Button icon="minus" disabled={n === 0} onClick={() => setDraft((d) => removeTrap(d, id))}>
                  {T.trapRemove(name)}
                </Button>
                {/* Final play-test review r3 N7: no Add past the trap slot cap (the server refuses it, 422 slot_cap_traps). */}
                <Button icon="plus" disabled={meters.traps.chosen >= meters.traps.cap} onClick={() => setDraft((d) => addTrap(d, id))}>
                  {T.trapAdd(name)}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      <h2>{T.fenceHeading}</h2>
      {catalog.fences.length === 0 ? (
        <p className="cv-small">{T.fenceNone}</p>
      ) : (
        <>
          <label className="town-field">
            <span className="cv-label">{T.fenceTier}</span>
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
            <label className="town-field">
              <span className="cv-label">{T.fenceCount}</span>
              <input type="number" inputMode="numeric" min={0} max={FENCE_BUDGET} value={draft.fence.count} onChange={(e) => setDraft((d) => setFenceCount(d, Number(e.target.value)))} data-testid="outfit-fence-count" />
            </label>
          )}
          <MeterBar m={meters.fence} label={T.fenceMeter(meters.fence.chosen, FENCE_BUDGET, RING_POSITIONS)} testId="outfit-fence-meter" />
          {meters.fence.over > 0 && (
            <ErrorPlate testId="outfit-fence-over">{T.fenceOver(meters.fence.over)}</ErrorPlate>
          )}
        </>
      )}

      <h2>{STRINGS.trip.rideOut}</h2>
      {catalog.trip ? <TripCapLine status={catalog.trip} /> : <p className="cv-small">{T.capLoadFailed}</p>}

      <h2>{T.coinHeading}</h2>
      {overflow && (
        <>
          {overflow.warn ? (
            <ErrorPlate testId="outfit-forecast">{T.coinForecast(overflow.message)}</ErrorPlate>
          ) : (
            <p data-testid="outfit-forecast">{T.coinForecast(overflow.message)}</p>
          )}
          <p className="cv-small">{T.coinForecastNote(catalog.shortestTrip)}</p>
          {overflow.warn && <p className="cv-small">{T.coinWarn}</p>}
        </>
      )}

      {issues.length > 0 && (
        <ErrorPlate heading={T.issuesHeading} testId="outfit-issues">
          <ul className="town-list">
            {issues.map((i, n) => (
              <li key={`${i.code}-${n}`}>{humanizeIssue(i, issueNames)}</li>
            ))}
          </ul>
        </ErrorPlate>
      )}
      {error && issues.length === 0 && <ErrorBox error={error} heading={T.issuesHeading} />}

      {noTrip !== null && (
        <p className="cv-small" role="status" data-testid="outfit-no-trip">
          {T.noTripNow(noTrip)}
        </p>
      )}
      <div className="town-shelf">
        <CommitBanner icon="wheel" disabled={busy || noTrip !== null || meters.noUnits} onClick={() => setConfirming(true)} testId="outfit-ride-out">
          {noTrip !== null ? T.rideOutWaiting(noTrip) : T.rideOut}
        </CommitBanner>
      </div>

      {confirming && (
        <Sheet
          title={T.confirmTitle}
          question
          busy={busy}
          onClose={() => setConfirming(false)}
          testId="outfit-dialog"
          restoreFocusTo={() => document.getElementById("outfit-heading")}
          footer={
            <div className="town-actions">
              <Button disabled={busy} onClick={() => setConfirming(false)}>
                {T.confirmNo}
              </Button>
              <Button variant="primary" icon="wheel" disabled={busy} onClick={() => void pack()} testId="outfit-confirm">
                {busy ? T.packing : T.confirmYes}
              </Button>
            </div>
          }
        >
          <p>{T.confirmIntro}</p>
          <ul className="town-list">
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
          {wholeRoster && <p>{T.wholeRoster(units.length)}</p>}
          <div className="cv-strip">
            <Icon name="info" />
            <span className="cv-small">{T.stakesLine}</span>
          </div>
          {(meters.anyOver || meters.noUnits) && <ErrorPlate>{T.confirmOverCaps}</ErrorPlate>}
        </Sheet>
      )}
    </section>
  );
}
