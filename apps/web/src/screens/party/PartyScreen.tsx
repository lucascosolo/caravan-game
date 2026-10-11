/**
 * THE STANDING RAID PARTY BUILDER (chunk 17 UI for chunk 09's routes; its build notes
 * deferred the builder to this screen). Which way round: this is the PASSIVE OFFENSE layer.
 * The party is configured here at leisure, served into OTHER players' trips, and its owner
 * is never there. It is a TEMPLATE (GUARDRAILS §0): never consumed, never loses a unit,
 * costs nothing to leave up or to edit.
 *
 *   - composition: add roster units (a unit may ride in the party and be packed on a trip);
 *   - a stance per unit (the server's `rules.stances`);
 *   - where each unit starts: drag it on the shared iso renderer onto one of the four entry
 *     bands of the wagon circle it will attack (or set the edge from the list);
 *   - siege picks, each with the exact fence tiers / trap types it counters;
 *   - save (free, instant): the server re-validates everything and its issue list is shown
 *     exactly; then what defenders will scout, byte for byte, and the results feed.
 *
 * QA-17 S4: the feed's Retry re-reads only the feed; an unsaved draft survives a tab switch
 * (in memory, `draftStore.ts`) and is never thrown away without a confirm ("Reload the
 * saved party" asks first when there are unsaved edits).
 */
import { ENTRY_EDGES, type Cell, type EntryEdge, type PartyConfig, type TargetingStance } from "@caravan/circle";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { IssueView, PartyFeedPage, PartyView } from "../../api/types.ts";
import { useApi } from "../../auth/session.tsx";
import { IsoCanvas, cellToWorld, type HitResult, type IsoCanvasHandle, type IsoSceneState } from "../../iso/index.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { Modal } from "../../shell/Modal.tsx";
import { STRINGS } from "../../strings.ts";
import { CIRCLE_GEOMETRY } from "../trail/FormationScreen.tsx";
import { ScoutPanel } from "../trail/ScoutPanel.tsx";
import { displayNameOf } from "../webs/catalogue.ts";
import { ENTRY_BAND_DEPTH } from "@caravan/circle";
import { addUnit, alongOf, canDropAt, configKey, countsByEdge, depthOf, edgeLength, moveTo, removeUnit, setEdge, setStance, setStart, toggleSiege } from "./partyModel.ts";
import { formatWhen, humanizeIssue } from "../../shell/issues.ts";
import { keepDraft, keptDraft } from "./draftStore.ts";
import { WatchFight } from "../replay/WatchFight.tsx";

const T = STRINGS.party;

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

interface Drag {
  readonly ref: string;
  readonly cell: Cell | null;
  readonly valid: boolean;
}

export interface PartyScreenProps {
  readonly api?: Api;
}

export function PartyScreen(props: PartyScreenProps = {}): JSX.Element {
  const api = useApi(props.api);
  const [party, setParty] = useState<PartyView | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [draft, setDraft] = useState<PartyConfig | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [issues, setIssues] = useState<readonly IssueView[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [feed, setFeed] = useState<PartyFeedPage | null>(null);
  const [feedError, setFeedError] = useState<ApiError | null>(null);
  const [canvasDown, setCanvasDown] = useState(false);
  const [restored, setRestored] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const isoRef = useRef<IsoCanvasHandle>(null);
  const dragRef = useRef<Drag | null>(null);

  /** Read the saved party. `discard` drops an unsaved draft (only after the player confirmed). */
  const loadParty = useCallback(
    async (opts: { readonly discard?: boolean } = {}): Promise<void> => {
      setLoadError(null);
      try {
        const p = (await api.party()).party;
        const kept = opts.discard ? null : keptDraft(p.id);
        if (opts.discard) keepDraft(p.id, null);
        setParty(p);
        setDraft(kept ?? p.config);
        setRestored(kept !== null && configKey(kept) !== configKey(p.config));
      } catch (err) {
        setLoadError(asApiError(err));
      }
    },
    [api],
  );
  /** Read the results feed alone: its Retry never touches the draft (QA-17 S4). */
  const loadFeed = useCallback(async (): Promise<void> => {
    try {
      setFeed(await api.partyFeed());
      setFeedError(null);
    } catch (err) {
      setFeedError(asApiError(err));
    }
  }, [api]);

  useEffect(() => {
    void loadParty();
    void loadFeed();
  }, [loadParty, loadFeed]);

  const roster = party?.roster ?? [];
  const entry = (ref: string) => roster.find((r) => r.instanceId === ref);
  const dirty = !!party && !!draft && configKey(party.config) !== configKey(draft);

  // Keep an unsaved draft for when the player comes back to this tab (QA-17 S4).
  useEffect(() => {
    if (party && draft) keepDraft(party.id, dirty ? draft : null);
  }, [party, draft, dirty]);

  const scene = useMemo<IsoSceneState>(() => {
    const units = draft?.units ?? [];
    const usedEdges = [...new Set(units.map((u) => u.edge))];
    const siegeBy = new Map<string, number>();
    return {
      fences: [],
      traps: [],
      posts: [],
      attackers: units.map((u) => {
        const r = roster.find((x) => x.instanceId === u.ref);
        return { id: u.ref, pos: cellToWorld(u.cell), typeId: r?.typeId ?? "", mergeLevel: r?.mergeLevel ?? 1, stance: u.stance, hpFraction: 1, selected: selected === u.ref };
      }),
      siege: (draft?.siege ?? []).map((typeId) => {
        const edge = usedEdges[0] ?? "north";
        const n = siegeBy.get(edge) ?? 0;
        siegeBy.set(edge, n + 1);
        return { id: typeId, typeId, edge, along: 0.3 + n * 0.12 };
      }),
      drag: drag ? { kind: "attacker", typeId: entry(drag.ref)?.typeId ?? "", cell: drag.cell, valid: drag.valid } : null,
      // The entry bands: all four while a unit is dragged (the drop targets), the used ones at rest.
      threat: drag ? { entryEdges: [...ENTRY_EDGES], gapCells: [] } : usedEdges.length > 0 ? { entryEdges: usedEdges, gapCells: [] } : null,
      showRadii: false,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, roster, selected, drag]);

  const updateDrag = useCallback((ref: string, cell: Cell | null) => {
    // QA-17 N1: a pointer move inside the same cell changes nothing; skip the re-render.
    const prev = dragRef.current;
    if (prev && prev.ref === ref && (prev.cell === cell || (prev.cell !== null && cell !== null && prev.cell.x === cell.x && prev.cell.y === cell.y))) return;
    const next: Drag = { ref, cell, valid: !!cell && canDropAt(cell) };
    dragRef.current = next;
    setDrag(next);
  }, []);
  const canDrag = useCallback((hit: HitResult) => hit.kind === "attacker" && !busy, [busy]);
  const onDragBegin = useCallback(
    (hit: HitResult) => {
      dragRef.current = null;
      updateDrag(hit.id, null);
    },
    [updateDrag],
  );
  const onDragMove = useCallback((cell: Cell | null) => dragRef.current && updateDrag(dragRef.current.ref, cell), [updateDrag]);
  const onDragEnd = useCallback((cell: Cell | null) => {
    const d = dragRef.current;
    dragRef.current = null;
    setDrag(null);
    if (d && cell && canDropAt(cell)) {
      setDraft((c) => (c ? moveTo(c, d.ref, cell) : c));
      setSelected(d.ref);
      setStatus(null);
    }
  }, []);
  const onTapEntity = useCallback((hit: HitResult) => {
    if (hit.kind === "attacker") setSelected((cur) => (cur === hit.id ? null : hit.id));
  }, []);
  const onTapCell = useCallback(
    (cell: Cell) => {
      if (selected && canDropAt(cell)) {
        setDraft((c) => (c ? moveTo(c, selected, cell) : c));
        setStatus(null);
      } else setSelected(null);
    },
    [selected],
  );

  const edit = (fn: (c: PartyConfig) => PartyConfig): void => {
    setDraft((c) => (c ? fn(c) : c));
    setStatus(null);
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setSaveError(null);
    setIssues([]);
    setStatus(null);
    try {
      const p = (await api.saveParty(draft)).party;
      setParty(p);
      setDraft(p.config);
      setStatus(T.saved);
    } catch (err) {
      const e = asApiError(err);
      setSaveError(e);
      setIssues(e.issues);
    } finally {
      setBusy(false);
    }
  };

  const moreFeed = async (): Promise<void> => {
    if (!feed) return;
    try {
      const next = await api.partyFeed(feed.nextBefore);
      setFeed({ entries: [...feed.entries, ...next.entries], nextBefore: next.nextBefore, hasMore: next.hasMore });
    } catch (err) {
      setFeedError(asApiError(err));
    }
  };

  if (loadError && !party) {
    return (
      <section>
        <h1>{T.title}</h1>
        <ErrorBox error={loadError} heading={T.loadFailed} onRetry={() => void loadParty()} />
      </section>
    );
  }
  if (!party || !draft) {
    return (
      <section>
        <h1>{T.title}</h1>
        <p className="hint" role="status">
          {STRINGS.app.loading}
        </p>
      </section>
    );
  }

  const stances = party.rules.stances as readonly TargetingStance[];
  // Server issue refs (instance ids, type ids) shown by the names the player knows (chunk 08 QA S8).
  const names = new Map<string, string>([
    ...roster.map((r): [string, string] => [r.typeId, r.displayName]),
    ...roster.map((r): [string, string] => [r.instanceId, T.memberName(r.displayName, r.mergeLevel)]),
    ...party.siegeCatalog.map((sc): [string, string] => [sc.typeId, sc.displayName]),
  ]);

  return (
    <section className="formation party" data-testid="party-screen" data-dirty={dirty ? "true" : "false"}>
      <h1>{T.title}</h1>
      <p className="hint">{T.intro}</p>

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
        onUnavailable={() => setCanvasDown(true)}
      />
      {canvasDown && <p className="hint">{T.canvasUnavailable}</p>}

      <p data-testid="party-caps">{T.caps(draft.units.length, party.caps.units, draft.siege.length, party.caps.siege)}</p>
      <p className="hint" data-testid="party-approach">
        {countsByEdge(draft)
          .filter((e) => e.count > 0)
          .map((e) => T.approachCount(T.edgeName(e.edge), e.count))
          .join(" · ") || T.approachNone}
      </p>
      {party.valid ? (
        <p className="notice" data-testid="party-valid">
          {T.valid}
        </p>
      ) : (
        <div className="error" role="alert" data-testid="party-invalid">
          <div>{T.invalid}</div>
          <ul className="issues">
            {party.issues.map((i, n) => (
              <li key={`${i.code}-${n}`}>
                {humanizeIssue(i, names)}
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="hint">{dirty ? T.unsaved : T.savedAt(formatWhen(party.savedAt))}</p>
      {dirty && restored && (
        <p className="notice" data-testid="party-draft-kept">
          {T.draftKept}
        </p>
      )}
      {loadError && <ErrorBox error={loadError} heading={T.loadFailed} onRetry={() => void loadParty()} />}

      <h2>{T.membersHeading}</h2>
      <p className="hint">{T.membersIntro}</p>
      {draft.units.length === 0 && <p className="hint">{T.membersNone}</p>}
      <ul className="cards" data-testid="party-members">
        {draft.units.map((u) => {
          const r = entry(u.ref);
          const name = r?.displayName ?? T.unknownUnit;
          return (
            <li key={u.ref} className={`card card--attacker${selected === u.ref ? " chip--selected" : ""}`} data-ref={u.ref}>
              <div className="card__head">
                <button type="button" className="btn" aria-pressed={selected === u.ref} onClick={() => setSelected((c) => (c === u.ref ? null : u.ref))}>
                  {T.memberName(name, r?.mergeLevel ?? 0)}
                </button>
                <button type="button" className="btn" disabled={busy} onClick={() => edit((c) => removeUnit(c, u.ref))}>
                  {T.memberRemove}
                </button>
              </div>
              {r && (
                <div className="card__line hint">
                  {T.memberStats(r.offense, r.defense, r.hp)}
                  {r.packedOnTrip ? ` · ${T.rosterPacked}` : ""}
                </div>
              )}
              <div className="card__line" data-testid="member-line">
                {T.memberLine(T.edgeName(u.edge), u.cell.x, u.cell.y)}
              </div>
              <div className="h3">{T.stanceHeading}</div>
              <div className="stances__row" role="group" aria-label={T.stanceHeading}>
                {stances.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`btn${u.stance === s ? " stances__btn--on" : ""}`}
                    aria-pressed={u.stance === s}
                    disabled={busy}
                    onClick={() => edit((c) => setStance(c, u.ref, s))}
                  >
                    {T.stanceName(s)}
                  </button>
                ))}
              </div>
              <p className="hint">{T.stanceDesc(u.stance)}</p>
              <div className="h3">{T.edgeHeading}</div>
              <div className="stances__row" role="group" aria-label={T.edgeHeading}>
                {ENTRY_EDGES.map((e: EntryEdge) => (
                  <button
                    key={e}
                    type="button"
                    className={`btn${u.edge === e ? " stances__btn--on" : ""}`}
                    aria-pressed={u.edge === e}
                    disabled={busy}
                    onClick={() => edit((c) => setEdge(c, u.ref, e))}
                  >
                    {T.edgeName(e)}
                  </button>
                ))}
              </div>
              <div className="row" style={{ marginTop: "0.5rem" }}>
                <label className="field" style={{ flex: 1, marginBottom: 0 }}>
                  <span className="field__label">{T.startAlong(T.edgeName(u.edge))}</span>
                  <select value={alongOf(u.cell, u.edge)} disabled={busy} onChange={(ev) => edit((c) => setStart(c, u.ref, Number(ev.target.value), depthOf(u.cell, u.edge)))} data-testid="member-along">
                    {Array.from({ length: edgeLength(u.edge) }, (_, i) => (
                      <option key={i} value={i}>
                        {T.startAlongOption(u.edge, i)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field" style={{ flex: 1, marginBottom: 0 }}>
                  <span className="field__label">{T.startDepth}</span>
                  <select value={depthOf(u.cell, u.edge)} disabled={busy} onChange={(ev) => edit((c) => setStart(c, u.ref, alongOf(u.cell, u.edge), Number(ev.target.value)))} data-testid="member-depth">
                    {Array.from({ length: ENTRY_BAND_DEPTH }, (_, i) => (
                      <option key={i} value={i}>
                        {T.startDepthOption(i)}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </li>
          );
        })}
      </ul>

      <h2>{T.rosterHeading}</h2>
      <p className="hint">{T.rosterIntro}</p>
      <ul className="chips" data-testid="party-roster">
        {roster.map((r) => {
          const inDraft = draft.units.some((u) => u.ref === r.instanceId);
          return (
            <li key={r.instanceId} className={`chip${inDraft ? " chip--selected" : ""}`} data-unit={r.instanceId}>
              <button
                type="button"
                className="chip__btn"
                style={{ cursor: "pointer", touchAction: "pan-y" }}
                disabled={busy}
                aria-pressed={inDraft}
                onClick={() => edit((c) => (inDraft ? removeUnit(c, r.instanceId) : addUnit(c, r.instanceId)))}
              >
                <span className="chip__name">{inDraft ? T.rosterRemove(r.displayName, r.mergeLevel) : T.rosterAdd(r.displayName, r.mergeLevel)}</span>
                <span className="chip__sub">
                  {T.memberStats(r.offense, r.defense, r.hp)}
                  {!r.unlocked ? ` · ${T.rosterLocked}` : ""}
                  {r.packedOnTrip ? ` · ${T.rosterPacked}` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <h2>{T.siegeHeading}</h2>
      <p className="hint">{T.siegeIntro}</p>
      <ul className="cards" data-testid="party-siege">
        {party.siegeCatalog.map((s) => {
          const on = draft.siege.includes(s.typeId);
          return (
            <li key={s.typeId} className="card card--siege" data-type={s.typeId}>
              <label className="toggles" style={{ margin: 0, minHeight: "var(--tap)", alignItems: "center" }}>
                <input type="checkbox" checked={on} disabled={busy || (!s.unlocked && !on)} onChange={() => edit((c) => toggleSiege(c, s.typeId))} />{" "}
                <span className="card__name">{T.siegeToggle(s.displayName)}</span>
                {!s.unlocked && <span className="hint"> · {T.siegeLocked}</span>}
              </label>
              <div className="card__line">{T.siegeCounters(s.counters.category, s.counters.kind)}</div>
              <div className="card__line hint">{T.siegeEffect(s.effect)}</div>
              <div className="card__line hint">{T.siegeTargets(s.targetTypeIds.map(displayNameOf).join(", "))}</div>
            </li>
          );
        })}
      </ul>

      {issues.length > 0 && (
        <div className="error" role="alert" data-testid="party-issues">
          <div>{T.refused}</div>
          <ul className="issues">
            {issues.map((i, n) => (
              <li key={`${i.code}-${n}`}>
                {humanizeIssue(i, names)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {saveError && issues.length === 0 && <ErrorBox error={saveError} heading={T.refused} />}
      {status && (
        <p className="notice" role="status">
          {status}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn btn--primary btn--block" disabled={busy || !dirty} onClick={() => void save()} data-testid="party-save">
          {busy ? T.saving : T.save}
        </button>
        <button
          type="button"
          className="btn btn--block"
          disabled={busy}
          onClick={() => (dirty ? setConfirmDiscard(true) : void loadParty({ discard: true }))}
          data-testid="party-reload"
        >
          {T.reload}
        </button>
      </div>
      {confirmDiscard && (
        <Modal
          title={T.discardTitle}
          busy={false}
          onCancel={() => setConfirmDiscard(false)}
          testId="party-discard-dialog"
          restoreFocusTo={() => document.querySelector<HTMLElement>("[data-testid=party-reload]")}
          actions={
            <>
              <button type="button" className="btn" onClick={() => setConfirmDiscard(false)}>
                {T.discardNo}
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setConfirmDiscard(false);
                  setStatus(null);
                  void loadParty({ discard: true });
                }}
                data-testid="party-discard-confirm"
              >
                {T.discardYes}
              </button>
            </>
          }
        >
          <p>{T.discardBody}</p>
        </Modal>
      )}

      {party.scout && (
        <details className="scout-details">
          <summary className="btn btn--block">{T.previewHeading}</summary>
          <p className="hint">{T.previewIntro}</p>
          <ScoutPanel scout={party.scout} idSuffix="-own" />
        </details>
      )}

      <section aria-labelledby="feed-heading" data-testid="party-feed">
        <h2 id="feed-heading">{T.feedHeading}</h2>
        <p className="hint">{T.feedIntro}</p>
        {feedError && <ErrorBox error={feedError} onRetry={() => void loadFeed()} />}
        {feed && feed.entries.length === 0 && <p className="hint">{T.feedEmpty}</p>}
        {feed && feed.entries.length > 0 && (
          <ul className="cards">
            {feed.entries.map((e) => (
              <li key={e.seq} className="card">
                <div className="card__name">
                  {T.feedEntry(e.defender.username ?? T.unknownDefender, e.defender.caravanName ?? T.unknownDefender, e.encounterIndex === null ? "" : T.feedEncounter(e.encounterIndex))}
                </div>
                <div className="card__line">{(e.outcomeKind ? T.feedOutcomeKind(e.outcomeKind) : null) ?? T.feedOutcomeUnknown}</div>
                <div className="card__line hint">
                  {T.feedCoin(e.coinEarned)} · {T.feedReputation(e.reputationDelta)} · {T.feedLadder(e.ladderPointsGained)} · {formatWhen(e.occurredAt)}
                </div>
                {/* Chunk 22: the owner watches where their party struck, from its own side. */}
                {e.jobId !== null && e.encounterIndex !== null && (
                  <WatchFight
                    jobId={e.jobId}
                    encounterIndex={e.encounterIndex}
                    label={T.feedWatch}
                    api={api}
                    settled={{ coin: e.coinEarned, reputation: e.reputationDelta, ladder: e.ladderPointsGained }}
                    testId={`feed-watch-${e.seq}`}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
        {feed?.hasMore && (
          <button type="button" className="btn btn--block" onClick={() => void moreFeed()}>
            {T.feedMore}
          </button>
        )}
      </section>
    </section>
  );
}
