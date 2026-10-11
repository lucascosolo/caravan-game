/**
 * THE ENCOUNTER FORMATION SCREEN (chunk 08) — the game's primary gameplay screen.
 *
 * The player is mid-trip, facing ONE scouted party (scoutFeed.ts). They read it (ScoutPanel),
 * see what survives of what they packed (ManifestTray), and arrange the wagon circle
 * against it on the isometric scene: fence segments on the 28 ring positions under a
 * budget that forces gaps, traps and posts on free cells, a stance per post. Then they
 * save a draft or commit. The server decides legality on every save and commit and its
 * issue list is shown exactly; this screen only gates where a drop can land.
 *
 * Which way round: this is DEFENSE. The attackers are drawn at their scouted start cells
 * and never move here; the player's own units are what gets placed.
 */
import {
  CORE_CELLS,
  ENTRY_BAND_DEPTH,
  GRID_HEIGHT,
  GRID_WIDTH,
  RING_ANCHORS,
  RING_SEGMENTS,
  formationGaps,
  ringSegment,
  type Cell,
  type DefensiveStance,
  type Formation,
} from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { FormationView, IssueView, ManifestView } from "../../api/types.ts";
import { IsoCanvas, cellToWorld, type HitResult, type IsoCanvasHandle, type IsoSceneState, type SceneGeometry } from "../../iso/index.ts";
import { STRINGS } from "../../strings.ts";
import { CommitDialog } from "./CommitDialog.tsx";
import { ManifestTray } from "./ManifestTray.tsx";
import { canDropAt, clearAll, dropAt, edgeReports, fenceBudget, gapCells, kindOfRef, remove, setStance } from "./placement.ts";
import { ScoutPanel } from "./ScoutPanel.tsx";
import type { ScoutedEncounter } from "./scoutTypes.ts";
import { SelectionPanel } from "./SelectionPanel.tsx";
import { defenderCard } from "./stats.ts";

const T = STRINGS.trail;

/** The lattice and fixed features, from the resolver's geometry (one source of truth). */
export const CIRCLE_GEOMETRY: SceneGeometry = {
  width: GRID_WIDTH,
  height: GRID_HEIGHT,
  coreCells: CORE_CELLS,
  ringCells: RING_SEGMENTS.map((s) => s.cell),
  anchorCells: RING_ANCHORS,
  entryBandDepth: ENTRY_BAND_DEPTH,
};

export interface FormationScreenProps {
  readonly api: Api;
  readonly caravanId: string;
  /** The open manifest; `survivors` is what is left of the loadout NOW. */
  readonly trip: ManifestView;
  readonly encounterIndex: number;
  readonly initial: FormationView | null;
  readonly scout: ScoutedEncounter;
}

interface Drag {
  readonly ref: string;
  readonly cell: Cell | null;
  readonly valid: boolean;
}

export function ErrorBox({ error }: { error: ApiError }): JSX.Element {
  return (
    <div className="error" role="alert" data-testid="error-box">
      <div>{error.message}</div>
      <div className="error__code">
        {error.status > 0 ? `${error.status} ` : ""}
        {error.code}
        {error.detail && error.detail !== error.message ? <span className="error__detail"> · {error.detail}</span> : null}
      </div>
    </div>
  );
}

export function FormationScreen({ api, caravanId, trip, encounterIndex, initial, scout }: FormationScreenProps): JSX.Element {
  const manifest = trip.survivors;
  const [formation, setFormation] = useState<Formation>(initial?.formation ?? clearAll());
  const [saved, setSaved] = useState<FormationView | null>(initial);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [showRadii, setShowRadii] = useState(true);
  const [showThreat, setShowThreat] = useState(true);
  const [serverIssues, setServerIssues] = useState<readonly IssueView[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [canvasDown, setCanvasDown] = useState<string | null>(null);
  const isoRef = useRef<IsoCanvasHandle>(null);

  const committedAt = saved?.committedAt ?? null;
  const locked = committedAt !== null || busy;
  const dirty = saved === null || JSON.stringify(saved.formation) !== JSON.stringify(formation);

  // ── derived: the scene ──────────────────────────────────────────────────────────────
  const scene = useMemo<IsoSceneState>(() => {
    const dragRadii = (() => {
      if (!drag) return undefined;
      const u = manifest.units.find((x) => x.ref === drag.ref);
      const c = u ? defenderCard(u) : null;
      if (!c) return undefined;
      const st = formation.posts.find((p) => p.ref === drag.ref)?.stance ?? "guard";
      return { aggroRadius: c.aggroRadius, leashDistance: c.leashDistance, attackRange: c.attackRange, stance: st };
    })();
    const usedEdges = [...scout.scout.edges];
    const siegeByEdge = new Map<string, number>();
    return {
      fences: formation.fences.flatMap((p) => {
        const f = manifest.fences.find((x) => x.ref === p.ref);
        return f ? [{ id: p.ref, cell: ringSegment(p.segment).cell, tierId: f.tierId, hp: f.hp, maxHp: f.maxHp, selected: selectedRef === p.ref }] : [];
      }),
      traps: formation.traps.flatMap((p) => {
        const t = manifest.traps.find((x) => x.ref === p.ref);
        return t ? [{ id: p.ref, pos: cellToWorld(p.cell), typeId: t.typeId, spent: t.spent, selected: selectedRef === p.ref }] : [];
      }),
      posts: formation.posts.flatMap((p) => {
        const u = manifest.units.find((x) => x.ref === p.ref);
        const c = u ? defenderCard(u) : null;
        if (!u || !c) return [];
        return [
          {
            id: p.ref,
            pos: cellToWorld(p.cell),
            typeId: u.typeId,
            mergeLevel: u.mergeLevel,
            stance: p.stance,
            hpFraction: u.maxHp > 0 ? u.hp / u.maxHp : 0,
            aggroRadius: c.aggroRadius,
            leashDistance: c.leashDistance,
            attackRange: c.attackRange,
            selected: selectedRef === p.ref,
          },
        ];
      }),
      attackers: scout.scout.units.map((u) => ({
        id: u.ref,
        pos: cellToWorld(u.cell),
        typeId: u.typeId,
        mergeLevel: u.mergeLevel,
        stance: u.stance,
        // A standing party is a template: it always arrives whole.
        hpFraction: 1,
      })),
      siege: scout.scout.siege.map((s) => {
        // Siege has no cell in the model; draw it beside the edge most of the party uses, spaced out.
        const edge = usedEdges[0] ?? "north";
        const n = siegeByEdge.get(edge) ?? 0;
        siegeByEdge.set(edge, n + 1);
        return { id: s.typeId, typeId: s.typeId, edge, along: 0.3 + n * 0.12 };
      }),
      drag:
        drag && kindOfRef(manifest, drag.ref)
          ? {
              kind: kindOfRef(manifest, drag.ref)!,
              typeId:
                manifest.units.find((x) => x.ref === drag.ref)?.typeId ??
                manifest.traps.find((x) => x.ref === drag.ref)?.typeId ??
                manifest.fences.find((x) => x.ref === drag.ref)?.tierId ??
                "",
              cell: drag.cell,
              valid: drag.valid,
              ...(dragRadii ? { radii: dragRadii } : {}),
            }
          : null,
      threat: showThreat ? { entryEdges: usedEdges, gapCells: gapCells(formation) } : null,
      showRadii,
    };
  }, [formation, manifest, drag, selectedRef, showRadii, showThreat, scout]);

  const budget = fenceBudget(manifest, formation);
  const gaps = formationGaps(formation).length;
  const reports = edgeReports(manifest, formation, scout.scout);

  // ── drags that start in the tray ────────────────────────────────────────────────────
  const dragRef = useRef<Drag | null>(null);
  const updateDrag = useCallback(
    (ref: string, cell: Cell | null) => {
      const next: Drag = { ref, cell, valid: cell ? canDropAt(manifest, formation, ref, cell) : false };
      dragRef.current = next;
      setDrag(next);
    },
    [manifest, formation],
  );
  const endDrag = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (d?.cell && d.valid) {
      setFormation((f) => dropAt(manifest, f, d.ref, d.cell!));
      setSelectedRef(d.ref);
      setStatus(null);
    }
  }, [manifest]);

  const onTrayDragStart = (ref: string, e: ReactPointerEvent<HTMLButtonElement>): void => {
    if (locked) return;
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    const pointerId = e.pointerId;
    // No pointer capture on purpose: capturing would re-target the pointer-up to the chip
    // and the browser would then fire a `click` on it, toggling the selection the drop
    // just made. The window listeners below carry the drag wherever the pointer goes.
    const move = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 8) return;
        started = true;
      }
      ev.preventDefault();
      updateDrag(ref, isoRef.current?.clientToCell(ev.clientX, ev.clientY) ?? null);
    };
    const up = (ev: PointerEvent): void => {
      if (ev.pointerId !== pointerId) return;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (started) endDrag();
    };
    const cancel = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      dragRef.current = null;
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
  };

  // ── gestures on the canvas ──────────────────────────────────────────────────────────
  const canDrag = useCallback((hit: HitResult) => !locked && hit.kind !== "attacker", [locked]);
  const onDragBegin = useCallback((hit: HitResult) => updateDrag(hit.id, null), [updateDrag]);
  const onDragMove = useCallback((cell: Cell | null) => dragRef.current && updateDrag(dragRef.current.ref, cell), [updateDrag]);
  const onDragEnd = useCallback(
    (cell: Cell | null) => {
      if (dragRef.current) updateDrag(dragRef.current.ref, cell);
      endDrag();
    },
    [updateDrag, endDrag],
  );
  const onTapEntity = useCallback((hit: HitResult) => {
    if (hit.kind === "attacker") return;
    setSelectedRef((cur) => (cur === hit.id ? null : hit.id));
  }, []);
  const onTapCell = useCallback(
    (cell: Cell) => {
      if (locked) return;
      if (selectedRef && canDropAt(manifest, formation, selectedRef, cell)) {
        setFormation((f) => dropAt(manifest, f, selectedRef, cell));
        setStatus(null);
      } else setSelectedRef(null);
    },
    [locked, selectedRef, manifest, formation],
  );
  // ── server calls: the server decides legality; its issues are shown exactly ─────────
  const fail = (err: unknown): void => {
    const e = err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError);
    setError(e);
    setServerIssues(e.issues);
  };
  const saveDraft = async (): Promise<FormationView | null> => {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = (await api.saveFormation(caravanId, encounterIndex, formation)).formation;
      setSaved(res);
      setFormation(res.formation);
      setServerIssues([]);
      setStatus(T.saved);
      return res;
    } catch (err) {
      fail(err);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const commit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (dirty) {
        const res = (await api.saveFormation(caravanId, encounterIndex, formation)).formation;
        setSaved(res);
        setFormation(res.formation);
      }
      const res = (await api.commitFormation(caravanId, encounterIndex)).formation;
      setSaved(res);
      setFormation(res.formation);
      setServerIssues([]);
      setConfirming(false);
      setSelectedRef(null);
      setStatus(null);
    } catch (err) {
      setConfirming(false);
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  const minGaps = RING_SEGMENTS.length - TUNABLES.FENCE_MATERIAL_BUDGET;

  return (
    <section className="formation" data-testid="formation-screen" data-encounter={encounterIndex} data-committed={committedAt ? "true" : "false"}>
      <h1>{T.encounter(encounterIndex)}</h1>
      {committedAt && (
        <p className="notice" data-testid="committed-notice">
          {T.committedAt(committedAt)}
        </p>
      )}

      <IsoCanvas
        ref={isoRef}
        geometry={CIRCLE_GEOMETRY}
        state={scene}
        label={T.canvasLabel}
        canDrag={canDrag}
        onTapCell={onTapCell}
        onTapEntity={onTapEntity}
        onDragBegin={onDragBegin}
        onDragMove={onDragMove}
        onDragEnd={onDragEnd}
        onUnavailable={() => setCanvasDown(T.canvasUnavailable)}
      />
      {canvasDown && <p className="hint">{canvasDown}</p>}

      <div className="toggles">
        <label>
          <input type="checkbox" checked={showRadii} onChange={(e) => setShowRadii(e.target.checked)} /> {T.showRadii}
        </label>
        <label>
          <input type="checkbox" checked={showThreat} onChange={(e) => setShowThreat(e.target.checked)} /> {T.showThreat}
        </label>
      </div>

      <h2>{T.ringHeading}</h2>
      <p data-testid="budget-meter">{T.budgetMeter(budget.placed, budget.placed + budget.remaining, budget.ring)}</p>
      <span className="meter" role="img" aria-label={T.budgetMeter(budget.placed, budget.placed + budget.remaining, budget.ring)}>
        <span className="meter__fill" style={{ width: `${(budget.placed / budget.ring) * 100}%` }} />
      </span>
      <p className="hint">{T.budgetNote(minGaps)}</p>
      <p data-testid="gaps-line">{T.gapsLine(gaps)}</p>

      <h3 className="h3">{T.threatHeading}</h3>
      <p className="hint">{T.threatIntro}</p>
      <ul className="plain" data-testid="edge-reports">
        {reports.map((r) => (
          <li key={r.edge} data-edge={r.edge}>
            {T.edgeReport(T.edgeName(r.edge), r.attackers, r.gaps, r.ringPositions, r.postsWatching)}
          </li>
        ))}
      </ul>

      {selectedRef && (
        <SelectionPanel
          manifest={manifest}
          formation={formation}
          selectedRef={selectedRef}
          locked={locked}
          onStance={(ref, s: DefensiveStance) => {
            setFormation((f) => setStance(f, ref, s));
            setStatus(null);
          }}
          onRemove={(ref) => {
            setFormation((f) => remove(f, ref));
            setStatus(null);
          }}
          onClose={() => setSelectedRef(null)}
        />
      )}
      {selectedRef && !locked && !formation.posts.some((p) => p.ref === selectedRef) && !formation.traps.some((p) => p.ref === selectedRef) && !formation.fences.some((p) => p.ref === selectedRef) && (
        <p className="hint" data-testid="tap-to-place-hint">
          {T.traySelectedHint(selectedRef)}
        </p>
      )}

      <ManifestTray manifest={manifest} formation={formation} selectedRef={selectedRef} locked={locked} onPick={(ref) => setSelectedRef((cur) => (cur === ref ? null : ref))} onDragStart={onTrayDragStart} />

      {/* The full scouting report sits above the commit controls: nothing is committed without it on screen. */}
      <details open className="scout-details">
        <summary className="btn btn--block">{T.scoutHeading}</summary>
        <p data-testid="facing-line">
          {T.chosenLine(scout.owner.displayName)} {T.candidateRating(scout.reputation.rating, scout.reputation.band.low, scout.reputation.band.high)}
        </p>
        <ScoutPanel scout={scout.scout} source={scout.source} />
      </details>

      {serverIssues.length > 0 && (
        <div className="error" role="alert" data-testid="server-issues">
          <div>{T.serverIssuesHeading}</div>
          <ul className="issues">
            {serverIssues.map((i, n) => (
              <li key={`${i.code}-${n}`}>
                {i.message} <span className="error__code">{T.issueCode(i.code)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && serverIssues.length === 0 && <ErrorBox error={error} />}
      {status && (
        <p className="notice" role="status">
          {status}
        </p>
      )}

      {!committedAt && (
        <div className="actions">
          <button type="button" className="btn" disabled={busy || formation === clearAll()} onClick={() => setFormation(clearAll())}>
            {T.clear}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void saveDraft()} data-testid="save-draft">
            {busy ? T.saving : T.saveDraft}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => setConfirming(true)} data-testid="commit-open">
            {T.commit}
          </button>
        </div>
      )}

      {confirming &&<CommitDialog manifest={manifest} formation={formation} gaps={gaps} busy={busy} onConfirm={() => void commit()} onCancel={() => setConfirming(false)} />}
    </section>
  );
}
