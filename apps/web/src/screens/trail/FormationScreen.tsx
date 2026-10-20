/**
 * THE ENCOUNTER FORMATION SCREEN (chunk 08) — the game's primary gameplay screen.
 *
 * The player is mid-trip, facing ONE scouted party. They read it (ScoutPanel), see what
 * survives of what they packed (ManifestTray), and arrange the wagon circle against it on
 * the isometric scene: fence segments on the 28 ring positions under a budget that forces
 * gaps, traps and posts on free cells, a stance per post. The server decides legality on
 * every save and commit and its issue list is shown with the player's names for things;
 * where a drop may land is answered by @caravan/circle's own rules (placement.ts).
 *
 * Which way round: this is DEFENSE. The attackers are drawn at their scouted start cells
 * and never move here; the player's own units are what gets placed. Tapping an attacker
 * opens its scouting card (QA S14).
 *
 * The draft is saved to the server automatically a moment after each edit (QA S13). The
 * server keeps a draft only once every living unit is posted, so until then the
 * arrangement is also held in memory for this encounter, and a tab switch inside the app
 * does not lose it.
 */
import {
  CORE_CELLS,
  ENTRY_BAND_DEPTH,
  ENTRY_EDGES,
  GRID_HEIGHT,
  GRID_WIDTH,
  RING_ANCHORS,
  RING_SEGMENTS,
  formationGaps,
  ringSegment,
  type Cell,
  type DefensiveStance,
  type Formation,
  type Manifest,
} from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import { onViewerReset } from "../../auth/session.tsx";
import type { FormationView, IssueView, ManifestView } from "../../api/types.ts";
import { IsoCanvas, cellToWorld, type CellRect, type FrameRect, type HitResult, type IsoCanvasHandle, type IsoSceneState, type SceneGeometry } from "../../iso/index.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { Modal } from "../../shell/Modal.tsx";
import { formatWhen, humanizeIssue } from "../../shell/issues.ts";
import { STRINGS } from "../../strings.ts";
import { CommitDialog, type CommitCheck } from "./CommitDialog.tsx";
import { ManifestTray } from "./ManifestTray.tsx";
import {
  carryForward,
  clearAll,
  dropAt,
  dropRefusal,
  edgeReports,
  fenceBudget,
  fenceSide,
  gapCells,
  isEmptyFormation,
  isPlaced,
  kindOfRef,
  nextFenceRef,
  nextUnplacedOfKind,
  openOnSide,
  postReach,
  remove,
  setStance,
  snapToRing,
  unpostedUnits,
  type Refusal,
} from "./placement.ts";
import { PlacementPicker } from "./PlacementPicker.tsx";
import { ScoutPanel } from "./ScoutPanel.tsx";
import type { ScoutedEncounter } from "./scoutTypes.ts";
import { SelectionPanel } from "./SelectionPanel.tsx";
import { manifestNames } from "./stats.ts";
import { TrayGesture, TRAY_LONG_PRESS_MS } from "./trayGesture.ts";

const T = STRINGS.trail;

/** The entry sides a party's raiders start on, in ENTRY_EDGES order (r2 N11). */
export function sidesOf(units: readonly { readonly edge: string }[]): readonly string[] {
  return ENTRY_EDGES.filter((e) => units.some((u) => u.edge === e));
}

/** The lattice and fixed features, from the resolver's geometry (one source of truth). */
export const CIRCLE_GEOMETRY: SceneGeometry = {
  width: GRID_WIDTH,
  height: GRID_HEIGHT,
  coreCells: CORE_CELLS,
  ringCells: RING_SEGMENTS.map((s) => s.cell),
  anchorCells: RING_ANCHORS,
  entryBandDepth: ENTRY_BAND_DEPTH,
};

/** What "zoom to the ring" frames when a tray item is selected (QA S10): the ring plus a margin for posts around it. */
const RING_FOCUS_MARGIN = 4;
const RING_RECT: CellRect = (() => {
  const xs = RING_SEGMENTS.map((s) => s.cell.x);
  const ys = RING_SEGMENTS.map((s) => s.cell.y);
  return {
    x0: Math.max(0, Math.min(...xs) - RING_FOCUS_MARGIN),
    y0: Math.max(0, Math.min(...ys) - RING_FOCUS_MARGIN),
    x1: Math.min(GRID_WIDTH - 1, Math.max(...xs) + RING_FOCUS_MARGIN),
    y1: Math.min(GRID_HEIGHT - 1, Math.max(...ys) + RING_FOCUS_MARGIN),
  };
})();

/**
 * Final play-test review S3: the camera opens on the ring (plus a margin for the posts and
 * traps around it), not the whole island; pinch or scroll still zooms out to the entry bands.
 */
export const RING_OPEN_MARGIN = 3;
const CIRCLE_FRAME: FrameRect = (() => {
  const xs = RING_SEGMENTS.map((s) => s.cell.x);
  const ys = RING_SEGMENTS.map((s) => s.cell.y);
  const x0 = Math.max(0, Math.min(...xs) - RING_OPEN_MARGIN);
  const y0 = Math.max(0, Math.min(...ys) - RING_OPEN_MARGIN);
  return { x: x0, y: y0, w: Math.min(GRID_WIDTH, Math.max(...xs) + RING_OPEN_MARGIN + 1) - x0, h: Math.min(GRID_HEIGHT, Math.max(...ys) + RING_OPEN_MARGIN + 1) - y0 };
})();

/** AUTOSAVE_DEBOUNCE (presentation tunable): how long after the last edit the draft is sent to the server. */
export const AUTOSAVE_DEBOUNCE_MS = 1200;

/**
 * Unsaved arrangements, per encounter, for this page load only (QA S13). In memory: no
 * storage, nothing survives a reload — the server's draft is the durable copy.
 */
const localDrafts = new Map<string, Formation>();
// Sign-out forgets them (QA-17 S4's per-viewer reset): the next person never sees this arrangement.
onViewerReset(() => localDrafts.clear());
export function clearLocalDrafts(): void {
  localDrafts.clear();
}

export interface FormationScreenProps {
  readonly api: Api;
  readonly caravanId: string;
  /** The open manifest; `survivors` is what is left of the loadout NOW. */
  readonly trip: ManifestView;
  readonly encounterIndex: number;
  readonly initial: FormationView | null;
  readonly scout: ScoutedEncounter;
  /** Autosave debounce; tests pass a large value to keep it out of the way, or a small one to exercise it. */
  readonly autosaveMs?: number;
  /**
   * Chunk 23: the commit went through the trip loop (`POST /me/caravans/:id/trip/encounters/:n/commit`:
   * frozen AND queued for resolution); the Trail moves on to the fight.
   */
  readonly onCommitted?: () => void;
  /**
   * Chunk 24: the first-session guide's panel (encounter 1's guided arrangement), drawn under
   * the circle. It edits through `apply`, i.e. the same placement model and autosave as a drop.
   */
  readonly guide?: (ctx: FormationGuideContext) => ReactNode;
}

export interface FormationGuideContext {
  readonly manifest: Manifest;
  readonly formation: Formation;
  readonly locked: boolean;
  readonly names: ReadonlyMap<string, string>;
  readonly apply: (next: Formation) => void;
}

interface Drag {
  readonly ref: string;
  readonly cell: Cell | null;
  readonly refusal: Refusal | null;
}

type Focus = "notice" | "issues" | null;

export function FormationScreen({ api, caravanId, trip, encounterIndex, initial, scout, autosaveMs = AUTOSAVE_DEBOUNCE_MS, onCommitted, guide }: FormationScreenProps): JSX.Element {
  const manifest = trip.survivors;
  const draftKey = `${caravanId}:${encounterIndex}:${scout.candidateId}`;
  const [formation, setFormationRaw] = useState<Formation>(() => (initial?.committedAt ? initial.formation : (localDrafts.get(draftKey) ?? initial?.formation ?? clearAll())));
  const [saved, setSaved] = useState<FormationView | null>(initial);
  const [selectedRef, setSelectedRef] = useState<string | null>(null);
  const [selectedAttacker, setSelectedAttacker] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [showRadii, setShowRadii] = useState(true);
  const [showThreat, setShowThreat] = useState(true);
  const [serverIssues, setServerIssues] = useState<readonly IssueView[]>([]);
  const [autosaveIssues, setAutosaveIssues] = useState<readonly IssueView[]>([]);
  const [error, setError] = useState<ApiError | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [refused, setRefused] = useState<{ name: string; refusal: Refusal } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [check, setCheck] = useState<CommitCheck>({ state: "checking" });
  const [clearing, setClearing] = useState(false);
  const [scoutOpen, setScoutOpen] = useState(true);
  const [canvasDown, setCanvasDown] = useState<string | null>(null);
  const [focusAfter, setFocusAfter] = useState<Focus>(null);
  const isoRef = useRef<IsoCanvasHandle>(null);
  const openedWith = useRef(formation);
  const noticeRef = useRef<HTMLParagraphElement>(null);
  const issuesRef = useRef<HTMLDivElement>(null);

  const committedAt = saved?.committedAt ?? null;
  const locked = committedAt !== null || busy;
  const dirty = saved === null || JSON.stringify(saved.formation) !== JSON.stringify(formation);
  const names = useMemo(() => manifestNames(manifest), [manifest]);
  const nameOf = useCallback((ref: string) => names.get(ref) ?? T.unknownThing, [names]);

  const setFormation = useCallback(
    (next: Formation | ((f: Formation) => Formation)) => {
      setFormationRaw((f) => {
        const v = typeof next === "function" ? next(f) : next;
        localDrafts.set(draftKey, v);
        return v;
      });
    },
    [draftKey],
  );

  // ── derived: the scene ──────────────────────────────────────────────────────────────
  const placing = !locked && selectedRef && !drag && !isPlaced(formation, selectedRef) ? kindOfRef(manifest, selectedRef) : null;
  const scene = useMemo<IsoSceneState>(() => {
    const radiiOf = (ref: string, stance: DefensiveStance) => {
      const r = postReach(manifest, ref, stance);
      return r ? { aggroRadius: r.aggroReach, leashDistance: r.leash, attackRange: r.attackReach } : null;
    };
    const dragRadii = (() => {
      if (!drag || kindOfRef(manifest, drag.ref) !== "post") return undefined;
      const stance = formation.posts.find((p) => p.ref === drag.ref)?.stance ?? "guard";
      const r = radiiOf(drag.ref, stance);
      return r ? { ...r, stance } : undefined;
    })();
    const usedEdges = [...scout.scout.edges];
    const siegeByEdge = new Map<string, number>();
    const dragKind = drag ? kindOfRef(manifest, drag.ref) : null;
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
        const r = u ? radiiOf(p.ref, p.stance) : null;
        if (!u || !r) return [];
        return [{ id: p.ref, pos: cellToWorld(p.cell), typeId: u.typeId, mergeLevel: u.mergeLevel, stance: p.stance, hpFraction: u.maxHp > 0 ? u.hp / u.maxHp : 0, ...r, selected: selectedRef === p.ref }];
      }),
      attackers: scout.scout.units.map((u) => ({
        id: u.ref,
        pos: cellToWorld(u.cell),
        typeId: u.typeId,
        mergeLevel: u.mergeLevel,
        stance: u.stance,
        // A standing party is a template: it always arrives whole.
        hpFraction: 1,
        selected: selectedAttacker === u.ref,
      })),
      siege: scout.scout.siege.map((s) => {
        // Siege has no cell in the model; draw it beside the edge most of the party uses, spaced out.
        const edge = usedEdges[0] ?? "north";
        const n = siegeByEdge.get(edge) ?? 0;
        siegeByEdge.set(edge, n + 1);
        return { id: s.typeId, typeId: s.typeId, edge, along: 0.3 + n * 0.12 };
      }),
      drag:
        drag && dragKind
          ? {
              kind: dragKind,
              typeId:
                manifest.units.find((x) => x.ref === drag.ref)?.typeId ??
                manifest.traps.find((x) => x.ref === drag.ref)?.typeId ??
                manifest.fences.find((x) => x.ref === drag.ref)?.tierId ??
                "",
              cell: drag.cell,
              valid: drag.cell !== null && drag.refusal === null,
              ...(dragRadii ? { radii: dragRadii } : {}),
            }
          : null,
      threat: showThreat ? { entryEdges: usedEdges, gapCells: gapCells(formation) } : null,
      showRadii,
      placing,
    };
  }, [formation, manifest, drag, selectedRef, selectedAttacker, showRadii, showThreat, scout, placing]);

  const budget = fenceBudget(manifest, formation);
  const gaps = formationGaps(formation).length;
  const reports = useMemo(() => edgeReports(manifest, formation, scout.scout), [manifest, formation, scout]);
  const flagged = useMemo(() => new Set(serverIssues.flatMap((i) => (i.subject && names.has(i.subject) ? [i.subject] : []))), [serverIssues, names]);

  // ── drags (canvas and tray) ─────────────────────────────────────────────────────────
  const dragRef = useRef<Drag | null>(null);
  const formationRef = useRef(formation);
  formationRef.current = formation;
  const updateDrag = useCallback(
    (ref: string, cell: Cell | null) => {
      const prior = dragRef.current;
      if (prior && prior.ref === ref && prior.cell?.x === cell?.x && prior.cell?.y === cell?.y) return;
      const next: Drag = { ref, cell, refusal: cell ? dropRefusal(manifest, formationRef.current, ref, cell) : null };
      dragRef.current = next;
      setDrag(next);
    },
    [manifest],
  );
  const endDrag = useCallback(() => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (!d?.cell) return;
    if (d.refusal) {
      setRefused({ name: nameOf(d.ref), refusal: d.refusal });
      return;
    }
    setFormation((f) => dropAt(manifest, f, d.ref, d.cell!));
    setSelectedRef(d.ref);
    setRefused(null);
    setStatus(null);
  }, [manifest, nameOf, setFormation]);
  const cancelDrag = useCallback(() => {
    dragRef.current = null;
    setDrag(null);
  }, []);

  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  const onTrayDragStart = useCallback(
    (ref: string, e: ReactPointerEvent<HTMLButtonElement>): void => {
      if (lockedRef.current) return;
      const pointerId = e.pointerId;
      const gesture = new TrayGesture(e.pointerType || "mouse", e.clientX, e.clientY, performance.now());
      let raf: number | null = null;
      let last: { x: number; y: number } | null = null;
      const flush = (): void => {
        raf = null;
        if (last) updateDrag(ref, isoRef.current?.clientToCell(last.x, last.y) ?? null);
      };
      const timer = window.setTimeout(() => {
        if (gesture.longPress(performance.now()) === "begin") updateDrag(ref, null);
      }, TRAY_LONG_PRESS_MS);
      // No pointer capture on purpose: capturing would re-target the pointer-up to the chip
      // and the browser would then fire a `click` on it, toggling the selection the drop
      // just made. The window listeners below carry the drag wherever the pointer goes.
      const move = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return;
        const over = isoRef.current?.isOverCanvas(ev.clientX, ev.clientY) ?? false;
        const action = gesture.move(ev.clientX, ev.clientY, over);
        if (gesture.state !== "pressed") window.clearTimeout(timer);
        if (action === "none") return;
        ev.preventDefault();
        last = { x: ev.clientX, y: ev.clientY };
        // QA S2: at most one drag update per animation frame.
        if (raf === null) raf = requestAnimationFrame(flush);
      };
      // Once a touch drag has begun, the page must not scroll under it.
      const touchMove = (ev: TouchEvent): void => {
        if (gesture.dragging) ev.preventDefault();
      };
      const done = (): void => {
        window.clearTimeout(timer);
        if (raf !== null) cancelAnimationFrame(raf);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        window.removeEventListener("touchmove", touchMove);
      };
      const up = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return;
        done();
        const over = isoRef.current?.isOverCanvas(ev.clientX, ev.clientY) ?? false;
        const action = gesture.up(over);
        if (action === "drop") {
          updateDrag(ref, isoRef.current?.clientToCell(ev.clientX, ev.clientY) ?? null);
          endDrag();
        } else if (action === "cancel") cancelDrag();
      };
      const cancel = (ev: PointerEvent): void => {
        if (ev.pointerId !== pointerId) return;
        done();
        if (gesture.cancel() === "cancel") cancelDrag();
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
      window.addEventListener("touchmove", touchMove, { passive: false });
    },
    [updateDrag, endDrag, cancelDrag],
  );

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
  const placeSelected = useCallback(
    (at: Cell) => {
      if (locked || !selectedRef) return;
      // S3: a fence wants a ring position; a tap a cell off the ring snaps to the nearest one.
      const cell = kindOfRef(manifest, selectedRef) === "fence" ? (snapToRing(at) ?? at) : at;
      const why = dropRefusal(manifest, formation, selectedRef, cell);
      if (why) {
        setRefused({ name: nameOf(selectedRef), refusal: why });
        return;
      }
      const wasPlaced = isPlaced(formation, selectedRef);
      const next = dropAt(manifest, formation, selectedRef, cell);
      setFormation(next);
      setRefused(null);
      setStatus(null);
      // S3: placing something new from the wagon moves the selection on to the next one of its
      // kind, so "Place here" (or a tap) places the next segment instead of moving this one.
      if (!wasPlaced) setSelectedRef(nextUnplacedOfKind(manifest, next, selectedRef));
    },
    [locked, selectedRef, manifest, formation, nameOf, setFormation],
  );
  const onTapEntity = useCallback(
    (hit: HitResult, cell?: Cell | null) => {
      // Final play-test review r2 N7: with something selected to place, a tap that lands NEXT TO a
      // fence segment (its touch radius reaches a cell or more inside the ring) but on a cell where
      // the selection can legally go places it there. A tap the selection cannot use — on the
      // segment's own cell — still selects the segment. Posts and traps keep their touch circles:
      // tapping one is how its stance is changed, even while the next unit is auto-selected.
      if (!locked && selectedRef && cell && hit.kind === "fence" && hit.id !== selectedRef) {
        const target = kindOfRef(manifest, selectedRef) === "fence" ? (snapToRing(cell) ?? cell) : cell;
        if (!dropRefusal(manifest, formation, selectedRef, target)) {
          placeSelected(cell);
          return;
        }
        // Final play-test review r3 N3: a unit or trap being placed never loses its selection to a
        // fence segment it was tapped onto. The tap is treated as an attempt on that cell, so the
        // refusal says why (the ring is reserved), and the selection stays for the next tap.
        if (kindOfRef(manifest, selectedRef) !== "fence") {
          placeSelected(cell);
          return;
        }
      }
      if (hit.kind === "attacker") {
        setSelectedAttacker(hit.id);
        setScoutOpen(true);
        return;
      }
      setSelectedAttacker(null);
      setSelectedRef((cur) => (cur === hit.id ? null : hit.id));
    },
    [locked, selectedRef, manifest, formation, placeSelected],
  );
  const onTapCell = useCallback(
    (cell: Cell) => {
      if (locked) return;
      if (selectedRef) placeSelected(cell);
    },
    [locked, selectedRef, placeSelected],
  );
  const onPick = useCallback((ref: string) => {
    setSelectedAttacker(null);
    setRefused(null);
    setSelectedRef((cur) => (cur === ref ? null : ref));
  }, []);

  // S14: a tapped attacker's scouting card is scrolled to and focused.
  useEffect(() => {
    if (!selectedAttacker) return;
    const el = document.querySelector<HTMLElement>(`[data-testid="scout-unit-${CSS.escape(selectedAttacker)}"]`);
    el?.scrollIntoView?.({ block: "center" });
    el?.focus({ preventScroll: true });
  }, [selectedAttacker]);

  // S6: after a commit, focus the outcome (the committed notice, or the issues).
  useEffect(() => {
    if (focusAfter === "notice") noticeRef.current?.focus();
    if (focusAfter === "issues") issuesRef.current?.focus();
    if (focusAfter) setFocusAfter(null);
  }, [focusAfter]);

  // ── server calls: the server decides legality; its issues are shown with the player's names ──
  const inflight = useRef<Promise<unknown> | null>(null);
  const autosaveTimer = useRef<number | null>(null);
  const cancelAutosave = (): void => {
    if (autosaveTimer.current !== null) window.clearTimeout(autosaveTimer.current);
    autosaveTimer.current = null;
  };
  const fail = (err: unknown): ApiError => {
    const e = err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError);
    setError(e);
    setServerIssues(e.issues);
    return e;
  };

  // S13: autosave a moment after each edit. A refusal here is quiet (it is not an action the
  // player took): the issues are listed politely and the arrangement stays in memory.
  useEffect(() => {
    // Only after an edit: the arrangement the screen opened with is the server's (or this page's) already.
    if (!dirty || committedAt || busy || formation === openedWith.current) return;
    cancelAutosave();
    // N10: the server keeps a draft only once every living unit is posted; say so here
    // instead of sending a save it must refuse.
    const unposted = unpostedUnits(manifest, formation);
    if (unposted.length > 0) {
      setAutosaveIssues(unposted.map((u) => ({ code: "unit_not_posted", message: `living unit '${u.ref}' has no post`, subject: u.ref })));
      return;
    }
    autosaveTimer.current = window.setTimeout(() => {
      autosaveTimer.current = null;
      const sent = formation;
      const p = api
        .saveFormation(caravanId, encounterIndex, sent)
        .then((res) => {
          setSaved(res.formation);
          setAutosaveIssues([]);
          if (formationRef.current === sent) setStatus(T.autosaved);
        })
        .catch((err: unknown) => {
          setAutosaveIssues(err instanceof ApiError ? err.issues : []);
        })
        .finally(() => {
          if (inflight.current === p) inflight.current = null;
        });
      inflight.current = p;
    }, autosaveMs);
    return cancelAutosave;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formation, dirty, committedAt, busy]);

  const settle = async (): Promise<void> => {
    cancelAutosave();
    if (inflight.current) await inflight.current.catch(() => undefined);
  };

  const saveDraft = async (): Promise<FormationView | null> => {
    await settle();
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const res = (await api.saveFormation(caravanId, encounterIndex, formation)).formation;
      setSaved(res);
      setFormation(res.formation);
      setServerIssues([]);
      setAutosaveIssues([]);
      setStatus(T.saved);
      return res;
    } catch (err) {
      fail(err);
      return null;
    } finally {
      setBusy(false);
    }
  };

  // S7: the dialog opens with the server checking the arrangement; Commit is offered only once it accepts.
  const openCommit = async (): Promise<void> => {
    await settle();
    setError(null);
    setCheck({ state: "checking" });
    setConfirming(true);
    if (!dirty) {
      setCheck({ state: "ok" });
      return;
    }
    try {
      const res = (await api.saveFormation(caravanId, encounterIndex, formation)).formation;
      setSaved(res);
      setFormation(res.formation);
      setServerIssues([]);
      setAutosaveIssues([]);
      setCheck({ state: "ok" });
    } catch (err) {
      const e = err instanceof ApiError ? err : null;
      if (e && e.issues.length > 0) setCheck({ state: "refused", issues: e.issues });
      else {
        setConfirming(false);
        fail(err);
      }
    }
  };

  const commit = async (): Promise<void> => {
    await settle();
    setBusy(true);
    setError(null);
    try {
      if (dirty) {
        const res = (await api.saveFormation(caravanId, encounterIndex, formation)).formation;
        setSaved(res);
        setFormation(res.formation);
      }
      // Chunk 23: commit through the trip loop, which freezes the circle (chunk 07) and queues
      // its resolution against the chosen, scouted party in one transaction; then re-read it.
      await api.commitEncounter(caravanId, encounterIndex);
      // Chunk 24 QA S5: the fight may already have resolved and ended the trip (a fast overrun
      // closes the manifest), so the re-read can 404. The commit stood; the Trail re-reads its
      // own state from the server and moves on to the result or the summary.
      try {
        const res = await api.formationIfAny(caravanId, encounterIndex);
        if (res) {
          setSaved(res);
          setFormation(res.formation);
        }
      } catch (err) {
        if (!(err instanceof ApiError) || err.status !== 404) throw err;
      }
      localDrafts.delete(draftKey);
      setServerIssues([]);
      setAutosaveIssues([]);
      setConfirming(false);
      setSelectedRef(null);
      setStatus(null);
      setFocusAfter("notice");
      onCommitted?.();
    } catch (err) {
      setConfirming(false);
      fail(err);
      setFocusAfter("issues");
    } finally {
      setBusy(false);
    }
  };

  // ── S3: fast arranging ──────────────────────────────────────────────────────────────
  const [lastBusy, setLastBusy] = useState(false);
  const applyQuick = (next: Formation, message: string | null): void => {
    setFormation(next);
    setSelectedRef(null);
    setRefused(null);
    setStatus(message);
  };
  // Final play-test review r2 N11: which sides the LAST encounter's raiders came from, so "Start
  // from my last arrangement" says when it would face the wrong way. Best effort: a failed or
  // missing read just leaves the plain label.
  const [lastSides, setLastSides] = useState<readonly string[] | null>(null);
  useEffect(() => {
    if (encounterIndex <= 1 || locked) return;
    let live = true;
    api
      .candidates(caravanId, encounterIndex - 1)
      .then((r) => {
        const menu = r.menu;
        const chosen = menu?.chosen ? menu.candidates.find((c) => c.candidateId === menu.chosen!.candidateId) : undefined;
        if (live && chosen) setLastSides(sidesOf(chosen.scout.units));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [api, caravanId, encounterIndex, locked]);
  const nowSides = sidesOf(scout.scout.units);
  const sideList = (sides: readonly string[]): string => sides.map((e) => T.edgeName(e)).join(" and ");
  const lastOtherSides = lastSides !== null && lastSides.length > 0 && nowSides.length > 0 && lastSides.join() !== nowSides.join() ? { was: sideList(lastSides), now: sideList(nowSides) } : null;

  const startFromLast = async (): Promise<void> => {
    if (encounterIndex <= 1) return;
    setLastBusy(true);
    setError(null);
    try {
      const prev = await api.formationIfAny(caravanId, encounterIndex - 1);
      if (!prev) {
        setStatus(T.lastNone);
        return;
      }
      const next = carryForward(manifest, prev.formation);
      const message = isEmptyFormation(next) ? T.lastNothing : T.lastApplied(next.fences.length, next.traps.length, next.posts.length);
      applyQuick(next, lastOtherSides && !isEmptyFormation(next) ? `${message} ${T.lastAppliedOtherSides(lastOtherSides.was, lastOtherSides.now)}` : message);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setStatus(T.lastNone);
      else fail(err);
    } finally {
      setLastBusy(false);
    }
  };
  const fenceLeft = nextFenceRef(manifest, formation) !== null;

  const minGaps = RING_SEGMENTS.length - TUNABLES.FENCE_MATERIAL_BUDGET;
  const selectedUnplaced = selectedRef !== null && !isPlaced(formation, selectedRef);
  const focus = !locked && selectedUnplaced ? { key: selectedRef!, rect: RING_RECT } : null;

  const issueList = (issues: readonly IssueView[]) => (
    <ul className="issues">
      {issues.map((i, n) => (
        <li key={`${i.code}-${n}`} data-code={i.code}>
          {humanizeIssue(i, names)}
          {i.subject && names.has(i.subject) && kindOfRef(manifest, i.subject) && !locked && (
            <>
              {" "}
              <button type="button" className="btn btn--small" onClick={() => onPick(i.subject!)} data-testid={`issue-show-${i.subject}`}>
                {T.issueShow}
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );

  return (
    <section className="formation" data-testid="formation-screen" data-encounter={encounterIndex} data-committed={committedAt ? "true" : "false"}>
      <h1>{T.encounter(encounterIndex)}</h1>
      {committedAt && (
        <p className="notice" data-testid="committed-notice" tabIndex={-1} ref={noticeRef}>
          {T.committedAt(formatWhen(committedAt))}
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
        onDragCancel={cancelDrag}
        focus={focus}
        frame={CIRCLE_FRAME}
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

      {guide?.({
        manifest,
        formation,
        locked,
        names,
        apply: (next) => {
          setFormation(next);
          setRefused(null);
          setStatus(null);
        },
      })}

      {refused && (
        <p className="notice" role="status" data-testid="drop-refused" data-code={refused.refusal.code}>
          {T.refusedDrop(refused.name, refused.refusal.message)}
        </p>
      )}

      {!locked && (
        <section className="quick" aria-labelledby="quick-heading" data-testid="quick-arrange">
          <h2 id="quick-heading" className="h3">
            {T.quickHeading}
          </h2>
          {encounterIndex > 1 && (
            <button type="button" className="btn btn--block" disabled={lastBusy} onClick={() => void startFromLast()} data-testid="start-from-last">
              {lastBusy ? T.lastLoading : lastOtherSides ? T.lastButtonOtherSides(lastOtherSides.was, lastOtherSides.now) : T.lastButton}
            </button>
          )}
          <div className="quick__sides">
            {ENTRY_EDGES.map((edge) => {
              const open = openOnSide(formation, edge);
              const raiders = scout.scout.units.filter((u) => u.edge === edge).length;
              return (
                <button
                  key={edge}
                  type="button"
                  className="btn"
                  disabled={open === 0 || !fenceLeft}
                  onClick={() => applyQuick(fenceSide(manifest, formation, edge), null)}
                  data-testid={`fence-side-${edge}`}
                >
                  {T.fenceSide(T.edgeName(edge), raiders)}
                </button>
              );
            })}
          </div>
          <p className="hint">{T.quickHint}</p>
        </section>
      )}

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
      <p className="hint">{T.threatReachNote}</p>

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
      {selectedRef && !locked && selectedUnplaced && (
        <p className="hint" data-testid="tap-to-place-hint">
          {T.traySelectedHint(nameOf(selectedRef))}
        </p>
      )}
      {selectedRef && !locked && kindOfRef(manifest, selectedRef) && (
        <PlacementPicker manifest={manifest} formation={formation} itemRef={selectedRef} name={nameOf(selectedRef)} onPlace={placeSelected} />
      )}

      <ManifestTray manifest={manifest} formation={formation} selectedRef={selectedRef} locked={locked} flagged={flagged} onPick={onPick} onDragStart={onTrayDragStart} />

      {/* The full scouting report sits above the commit controls: nothing is committed without it on screen. */}
      <details open={scoutOpen} className="scout-details" onToggle={(e) => setScoutOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary className="btn btn--block">{T.scoutHeading}</summary>
        <p data-testid="facing-line">
          {T.chosenLine(scout.owner.displayName)} {T.candidateRating(scout.reputation.rating, scout.reputation.band.low, scout.reputation.band.high)}
        </p>
        <ScoutPanel scout={scout.scout} source={scout.source} selectedRef={selectedAttacker} />
      </details>

      {serverIssues.length > 0 && (
        <div className="error" role="alert" data-testid="server-issues" tabIndex={-1} ref={issuesRef}>
          <div>{T.serverIssuesHeading}</div>
          {issueList(serverIssues)}
        </div>
      )}
      {serverIssues.length === 0 && autosaveIssues.length > 0 && !committedAt && (
        <div className="notice" role="status" data-testid="autosave-pending">
          <div>{T.autosavePending}</div>
          {issueList(autosaveIssues)}
        </div>
      )}
      {error && serverIssues.length === 0 && (
        <div tabIndex={-1} ref={issuesRef}>
          <ErrorBox error={error} />
        </div>
      )}
      {status && (
        <p className="notice" role="status">
          {status}
        </p>
      )}

      {!committedAt && (
        <div className="actions">
          <button type="button" className="btn" disabled={busy || isEmptyFormation(formation)} onClick={() => setClearing(true)} data-testid="clear-open">
            {T.clear}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={() => void saveDraft()} data-testid="save-draft">
            {busy ? T.saving : T.saveDraft}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void openCommit()} data-testid="commit-open">
            {T.commit}
          </button>
        </div>
      )}

      {clearing && (
        <Modal
          title={T.clearTitle}
          busy={false}
          onCancel={() => setClearing(false)}
          testId="clear-dialog"
          actions={
            <>
              <button type="button" className="btn" onClick={() => setClearing(false)}>
                {T.clearNo}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setFormation(clearAll());
                  setSelectedRef(null);
                  setClearing(false);
                }}
                data-testid="clear-confirm"
              >
                {T.clearYes}
              </button>
            </>
          }
        >
          <p>{T.clearBody}</p>
        </Modal>
      )}

      {confirming && (
        <CommitDialog manifest={manifest} formation={formation} gaps={gaps} busy={busy} check={check} names={names} onConfirm={() => void commit()} onCancel={() => setConfirming(false)} />
      )}
    </section>
  );
}
