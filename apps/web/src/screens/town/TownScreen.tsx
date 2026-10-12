/**
 * THE HOME TOWN (chunk 17) — the screen the player sees most. A settlement on the shared
 * isometric island (src/iso: one renderer), never a wagon circle and never attacked
 * (GUARDRAILS §0): it holds the roster, the merge board, the mine and the banked Coin.
 *
 *   - the caravan's state, honestly: in town / packed, waiting to ride out / on a trip — from
 *     the trip loop's status (chunk 15), with the trip cap and, when packed, "Ride out" (chunk 23);
 *   - the merge board: BOARD_SLOTS cells at the centre, units STATIC where the player left
 *     them, the overflow beyond; drag (or tap, tap) a unit onto one of the same type and
 *     level to open the merge preview; the 5 → 3 recipe has its own button per group;
 *   - the mine: the passive trickle visualized, nothing to upgrade;
 *   - acquisition: the refugee menu and mercenary recruit — both always land, the overflow
 *     takes what the board cannot (open question 2);
 *   - navigation to everything else, including "outfit the caravan" (open question 1).
 *
 * No simulation runs here: no resolver import, no tick loop, no unit motion. The only
 * ambient animation is the mine wheel's cosmetic turn inside the renderer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { TripStatusView } from "../../api/tripTypes.ts";
import type { CaravanSummary, EconomyView, ManifestView, RecruitView, RefugeeView } from "../../api/types.ts";
import { useApi } from "../../auth/session.tsx";
import { IsoCanvas, MIN_HIT_RADIUS_PX, type HitResult, type IsoCanvasHandle } from "../../iso/index.ts";
import type { FrameRect } from "../../iso/IsoCanvas.tsx";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { navigate } from "../../shell/router.tsx";
import { STRINGS } from "../../strings.ts";
import { BOARD_ORIGIN, BOARD_SIDE, boardCells, isBoardCell, layoutBoard, moveUnit, productHints, toOverflow, type BoardLayout, type RosterUnit } from "./board.ts";
import { BoardPanel, unitName } from "./BoardPanel.tsx";
import { MergeDialog } from "./MergeDialog.tsx";
import { MinePanel } from "./MinePanel.tsx";
import { OutfitScreen } from "./OutfitScreen.tsx";
import { RecruitPanel } from "./RecruitPanel.tsx";
import { RefugeePanel } from "./RefugeePanel.tsx";
import { RideOutPanel, TripCapLine } from "./RideOutPanel.tsx";
import { TOWN_GEOMETRY, dropMeaning, loadLayout, saveLayout, townSceneState, type TownDrag } from "./townScene.ts";

const T = STRINGS.town;

/**
 * QA-17 S1: the town opens framed on the merge board, each cell's diamond at least a touch
 * target wide (2 × MIN_HIT_RADIUS_PX = 44 px); pinch or wheel out to see the whole island.
 */
const BOARD_FRAME: FrameRect = { x: BOARD_ORIGIN.x, y: BOARD_ORIGIN.y, w: BOARD_SIDE, h: BOARD_SIDE, minCellPx: 2 * MIN_HIT_RADIUS_PX };

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

type Part<V> = { readonly kind: "ok"; readonly value: V } | { readonly kind: "error"; readonly error: ApiError };

const settle = async <V,>(p: Promise<V>): Promise<Part<V>> => {
  try {
    return { kind: "ok", value: await p };
  } catch (err) {
    return { kind: "error", error: asApiError(err) };
  }
};

interface Loaded {
  /** The signed-in account: the board layout is kept per account AND caravan (QA-17 D1). */
  readonly accountId: string;
  readonly caravan: CaravanSummary;
  readonly units: readonly RosterUnit[];
  readonly economy: EconomyView;
  readonly forecast: EconomyView | null;
  /** The open manifest (packed, waiting to ride out, or out on the trail), or null in town with nothing packed. */
  readonly manifest: Part<ManifestView | null>;
  readonly refugees: Part<RefugeeView>;
  readonly refugeesReadAt: number;
  readonly recruit: Part<RecruitView>;
  /** Chunk 23: the trip loop's status — the caravan's real state and the trip cap. */
  readonly trip: Part<TripStatusView>;
}

function rosterOf(caravan: CaravanSummary): readonly RosterUnit[] {
  return (caravan.units ?? []).map((u) => ({ id: u.id, typeId: u.unit_type_id, mergeLevel: u.merge_level }));
}

async function readManifest(api: Api, caravanId: string): Promise<ManifestView | null> {
  try {
    const m = (await api.manifest(caravanId)).manifest;
    return m.closedAt ? null : m;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404 && err.code === "no_open_manifest") return null;
    throw err;
  }
}

export interface TownScreenProps {
  /** Injected for tests; defaults to the session's client. */
  readonly api?: Api;
}

export function TownScreen(props: TownScreenProps = {}): JSX.Element {
  const api = useApi(props.api);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [view, setView] = useState<"town" | "outfit">("town");
  const [layout, setLayout] = useState<BoardLayout>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [drag, setDrag] = useState<TownDrag | null>(null);
  const [mergeIds, setMergeIds] = useState<readonly string[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [canvasDown, setCanvasDown] = useState(false);
  const isoRef = useRef<IsoCanvasHandle>(null);
  const dragRef = useRef<TownDrag | null>(null);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  /** Unit ids the board has laid out (null until the first load reads them from storage). */
  const knownRef = useRef<ReadonlySet<string> | null>(null);

  const load = useCallback(
    async (opts: { readonly hints?: BoardLayout; readonly quiet?: boolean } = {}): Promise<void> => {
      if (!opts.quiet) setLoadError(null);
      try {
        const me = await api.me();
        const caravan = me.caravans[0];
        if (!caravan) throw new ApiError(0, "bad_payload", STRINGS.app.badPayload, "GET /me caravans: expected at least one caravan");
        const economy = await api.economy();
        const shortestTrip = (economy.earn.encounterSchedule[0] ?? 0) + economy.earn.bankedTripBonus;
        const [forecast, manifest, refugees, recruit, trip] = await Promise.all([
          settle(api.economy(shortestTrip)),
          settle(readManifest(api, caravan.id)),
          settle(api.refugees(caravan.id)),
          settle(api.recruitList(caravan.id)),
          settle(api.tripStatus(caravan.id)),
        ]);
        const units = rosterOf(caravan);
        const accountId = me.account.id;
        const stored = knownRef.current === null ? loadLayout(accountId, caravan.id) : { layout: layoutRef.current, known: knownRef.current };
        // A unit the board already knew but has no cell for was sent to the overflow: it stays there.
        const keep = new Set([...stored.known].filter((id) => !stored.layout.has(id)));
        const next = layoutBoard(units, stored.layout, opts.hints ?? new Map(), keep);
        const known = new Set(units.map((u) => u.id));
        knownRef.current = known;
        setLayout(next);
        saveLayout(accountId, caravan.id, next, known);
        setLoaded({
          accountId,
          caravan,
          units,
          economy,
          forecast: forecast.kind === "ok" ? forecast.value : null,
          manifest,
          refugees,
          refugeesReadAt: Date.now(),
          recruit,
          trip,
        });
        setLoadError(null);
      } catch (err) {
        setLoadError(asApiError(err));
      }
    },
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const caravanId = loaded?.caravan.id ?? "";
  const accountId = loaded?.accountId ?? "";
  const units = useMemo(() => loaded?.units ?? [], [loaded]);
  const tripStatus = loaded?.trip.kind === "ok" ? loaded.trip.value : null;
  // The trip loop's own read is the truth about the caravan (chunk 15 moves the state); /me's copy is the fallback.
  const onTrip = (tripStatus?.caravan.state ?? loaded?.caravan.state) === "on_trip";
  const manifest = loaded?.manifest.kind === "ok" ? loaded.manifest.value : null;
  const packedIds = useMemo(() => new Set(manifest ? manifest.packed.units.map((u) => u.ref) : []), [manifest]);
  const mergeBlocked = onTrip ? T.mergeOnTrip : null;

  const commitLayout = useCallback(
    (next: BoardLayout) => {
      setLayout(next);
      if (caravanId && accountId) saveLayout(accountId, caravanId, next, knownRef.current ?? []);
    },
    [accountId, caravanId],
  );

  const openMerge = useCallback(
    (ids: readonly string[]) => {
      if (mergeBlocked || ids.some((id) => packedIds.has(id))) return;
      setStatus(null);
      setMergeIds(ids);
    },
    [mergeBlocked, packedIds],
  );

  // ── canvas gestures: drag a unit onto another to merge, onto a free cell to move ──
  const updateDrag = useCallback(
    (id: string, cell: { x: number; y: number } | null) => {
      // QA-17 N1: a pointer move inside the same cell changes nothing; skip the re-render.
      const prev = dragRef.current;
      if (prev && prev.id === id && (prev.cell === cell || (prev.cell !== null && cell !== null && prev.cell.x === cell.x && prev.cell.y === cell.y))) return;
      const meaning = dropMeaning(units, layoutRef.current, id, cell, isBoardCell);
      const valid = meaning.kind === "move" || (meaning.kind === "merge" && !mergeBlocked && !packedIds.has(id) && !packedIds.has(meaning.targetId));
      const next: TownDrag = { id, cell, valid };
      dragRef.current = next;
      setDrag(next);
    },
    [units, mergeBlocked, packedIds],
  );
  const canDrag = useCallback((hit: HitResult) => hit.kind === "unit", []);
  const onDragBegin = useCallback(
    (hit: HitResult) => {
      dragRef.current = null;
      updateDrag(hit.id, null);
    },
    [updateDrag],
  );
  const onDragMove = useCallback((cell: { x: number; y: number } | null) => dragRef.current && updateDrag(dragRef.current.id, cell), [updateDrag]);
  const onDragEnd = useCallback(
    (cell: { x: number; y: number } | null) => {
      const d = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!d || !cell) return;
      const meaning = dropMeaning(units, layoutRef.current, d.id, cell, isBoardCell);
      if (meaning.kind === "move") commitLayout(moveUnit(layoutRef.current, d.id, cell));
      else if (meaning.kind === "merge") openMerge([meaning.targetId, d.id]);
    },
    [units, commitLayout, openMerge],
  );
  const onTapEntity = useCallback(
    (hit: HitResult) => {
      if (hit.kind !== "unit") return;
      const sel = selectedId;
      if (sel && sel !== hit.id && dropMeaning(units, layoutRef.current, sel, layoutRef.current.get(hit.id) ?? null, isBoardCell).kind === "merge") {
        openMerge([hit.id, sel]);
        return;
      }
      setSelectedId(sel === hit.id ? null : hit.id);
    },
    [selectedId, units, openMerge],
  );
  const onTapCell = useCallback(
    (cell: { x: number; y: number }) => {
      if (selectedId && dropMeaning(units, layoutRef.current, selectedId, cell, isBoardCell).kind === "move") {
        commitLayout(moveUnit(layoutRef.current, selectedId, cell));
        return;
      }
      setSelectedId(null);
    },
    [selectedId, units, commitLayout],
  );

  const scene = useMemo(
    () => townSceneState({ units, layout, selectedId, drag, mineActive: loaded ? !loaded.economy.atCap : false }),
    [units, layout, selectedId, drag, loaded],
  );

  const reloadRefugees = useCallback(async (): Promise<void> => {
    if (!caravanId) return;
    const r = await settle(api.refugees(caravanId));
    setLoaded((l) => (l ? { ...l, refugees: r, refugeesReadAt: Date.now() } : l));
  }, [api, caravanId]);

  if (loadError && !loaded) {
    return (
      <section>
        <h1>{T.title}</h1>
        <ErrorBox error={loadError} heading={T.loadFailed} onRetry={() => void load()} />
      </section>
    );
  }
  if (!loaded) {
    return (
      <section>
        <h1>{T.title}</h1>
        <p className="hint" role="status">
          {STRINGS.app.loading}
        </p>
      </section>
    );
  }

  if (view === "outfit") {
    return (
      <OutfitScreen
        api={api}
        caravanId={caravanId}
        units={units}
        onBack={() => {
          setView("town");
          void load({ quiet: true });
        }}
        onPacked={() => void load({ quiet: true })}
        onRodeOut={() => navigate("trail")}
      />
    );
  }

  const stateLine = onTrip ? T.stateOnTrip : manifest ? T.statePacked : T.stateInTown;
  const stateKind = onTrip ? "on_trip" : manifest ? "packed" : "in_town";

  return (
    <section className="formation town" data-testid="town-screen">
      <h1>{T.title}</h1>
      <p className="hint">{T.intro}</p>
      <p className="notice" data-testid="caravan-state" data-state={stateKind}>
        <strong>{loaded.caravan.name}:</strong> {stateLine}
      </p>
      {tripStatus && !(manifest && !onTrip) && <TripCapLine status={tripStatus} />}
      {tripStatus && manifest && !onTrip && (
        <RideOutPanel
          api={api}
          caravanId={caravanId}
          status={tripStatus}
          onStarted={(_s, replayed) => {
            if (replayed) setStatus(STRINGS.trip.rideOutAlreadyWent);
            navigate("trail");
          }}
        />
      )}
      {loaded.trip.kind === "error" && <ErrorBox error={loaded.trip.error} onRetry={() => void load()} />}
      <p data-testid="town-balance">{T.balanceLine(loaded.economy.balance, loaded.economy.cap)}</p>
      {loadError && (
        // QA-17 S3: a failed RE-read (after a write, or a Retry) is shown above the board, never
        // swallowed: what is drawn below is the last good read and may be out of date.
        <div data-testid="town-reload-error">
          <ErrorBox error={loadError} heading={T.reloadFailed} onRetry={() => void load()} />
        </div>
      )}

      <IsoCanvas
        ref={isoRef}
        geometry={TOWN_GEOMETRY}
        state={scene}
        label={T.canvasLabel}
        canDrag={canDrag}
        onTapCell={onTapCell}
        onTapEntity={onTapEntity}
        onDragBegin={onDragBegin}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onUnavailable={() => setCanvasDown(true)}
        frame={BOARD_FRAME}
      />
      {canvasDown && <p className="hint">{T.canvasUnavailable}</p>}

      {status && (
        <p className="notice" role="status" data-testid="town-status">
          {status}
        </p>
      )}

      <BoardPanel
        units={units}
        layout={layout}
        selectedId={selectedId}
        merge={loaded.economy.merge}
        mergeBlocked={mergeBlocked}
        packedIds={packedIds}
        onSelect={setSelectedId}
        onToBoard={(id) => {
          const taken = new Set([...layout.values()].map((c) => `${c.x},${c.y}`));
          const cell = boardCells().find((c) => !taken.has(`${c.x},${c.y}`));
          if (cell) commitLayout(moveUnit(layout, id, cell));
        }}
        onToOverflow={(id) => {
          commitLayout(toOverflow(layout, id));
        }}
        onMerge={openMerge}
      />

      <MinePanel economy={loaded.economy} forecast={loaded.forecast?.overflow ?? null} />

      {loaded.refugees.kind === "ok" ? (
        <RefugeePanel
          api={api}
          caravanId={caravanId}
          view={loaded.refugees.value}
          readAt={loaded.refugeesReadAt}
          onView={(v, at) => setLoaded((l) => (l ? { ...l, refugees: { kind: "ok", value: v }, refugeesReadAt: at } : l))}
          onReload={() => void reloadRefugees()}
          onRosterChanged={() => void load({ quiet: true })}
        />
      ) : (
        <section>
          <h2>{T.refugeesHeading}</h2>
          <ErrorBox error={loaded.refugees.error} onRetry={() => void reloadRefugees()} />
        </section>
      )}

      {loaded.recruit.kind === "ok" ? (
        <RecruitPanel api={api} caravanId={caravanId} view={loaded.recruit.value} onRecruited={() => void load({ quiet: true })} />
      ) : (
        <section>
          <h2>{T.recruitHeading}</h2>
          <ErrorBox error={loaded.recruit.error} onRetry={() => void load()} />
        </section>
      )}

      <section aria-labelledby="nav-heading" data-testid="town-nav">
        <h2 id="nav-heading">{T.navHeading}</h2>
        <p className="hint">{T.navIntro}</p>
        <ul className="cards">
          <li className="card">
            <button type="button" className="btn btn--primary btn--block" disabled={onTrip || !!manifest} onClick={() => setView("outfit")} data-testid="nav-outfit">
              {T.navOutfit}
            </button>
            <p className="hint">{onTrip ? T.stateOnTrip : manifest ? T.navOutfitPacked : T.navOutfitBody}</p>
          </li>
          <li className="card">
            <button type="button" className="btn btn--block" onClick={() => navigate("trail")}>
              {T.navTrail}
            </button>
            <p className="hint">{T.navTrailBody}</p>
          </li>
          <li className="card">
            <button type="button" className="btn btn--block" onClick={() => navigate("party")}>
              {T.navParty}
            </button>
            <p className="hint">{T.navPartyBody}</p>
          </li>
          <li className="card">
            <button type="button" className="btn btn--block" onClick={() => navigate("webs")}>
              {T.navWebs}
            </button>
            <p className="hint">{T.navWebsBody}</p>
          </li>
          <li className="card">
            <button type="button" className="btn btn--block" onClick={() => navigate("packs")} data-testid="nav-packs">
              {T.navPacks}
            </button>
            <p className="hint">{T.navPacksBody}</p>
          </li>
          <li className="card">
            <button type="button" className="btn btn--block" onClick={() => navigate("cosmetics")} data-testid="nav-cosmetics">
              {T.navCosmetics}
            </button>
            <p className="hint">{T.navCosmeticsBody}</p>
          </li>
        </ul>
        {loaded.manifest.kind === "error" && <ErrorBox error={loaded.manifest.error} onRetry={() => void load()} />}
      </section>

      {mergeIds && (
        <MergeDialog
          api={api}
          caravanId={caravanId}
          instanceIds={mergeIds}
          rosterSize={loaded.units.length}
          onCancel={() => setMergeIds(null)}
          restoreFocusTo={() => document.getElementById("board-heading")}
          onDone={(res) => {
            const hints = productHints(layoutRef.current, mergeIds, res.producedInstanceIds);
            const name = loaded.units.find((u) => u.id === mergeIds[0]);
            setMergeIds(null);
            setSelectedId(null);
            setStatus(res.replayed ? T.mergeReplayed : T.mergeDone(res.producedInstanceIds.length, name ? unitName(name.typeId) : "", res.merged.toLevel, res.balanceAfter));
            void load({ hints, quiet: true });
          }}
        />
      )}
    </section>
  );
}
