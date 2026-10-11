/**
 * The replay player (chunk 22): plays a stored fight for EITHER participant — the caravan's
 * player, who was there, and the standing party's owner, who never is (the passive side's
 * only way to see where its party struck and how it did). Each sees the fight from their own
 * side: "your Well Digger" / "the raiders' Dust Rider" for the caravan; "your Dust Rider" /
 * "the caravan's Well Digger" for the party's owner.
 *
 * Order on screen (QA S3): the STAGE first and pinned at the top of the dialog — the scene
 * through the ONE isometric renderer (apps/web/src/iso), the party's siege, and a strip of the
 * latest key moments directly under it, so the field and what is happening are read together.
 * Then the transport (play / pause, scrub, 1× 2× 4× — 2× by default, remembered for the
 * session only — back / forward one keyframe interval, skip to the end), the results summary
 * (collapsed under one line that states the recorded outcome: outcome, depth with the
 * DEPTH_METRIC sentence, loot, what it settled from the ledger, the tally, how each fighter
 * fared) and the event feed (one line per log row; Key moments by default; tap a line to
 * highlight its units on the field). At the end of the fight the last frame is HELD for a
 * second so the deciding row is seen (QA S1), then an end card restates the recorded outcome;
 * the player can dismiss it to look at the field.
 *
 * Nothing here simulates: replayModel.ts reads the log with the resolver package's REPLAY
 * READER and renders frames; seeking renders the keyframe-based frame and plays forward by
 * interpolation. A log that cannot be read is refused with the reason, never drawn.
 *
 * Mobile-shaped: the scrub is a native range input (touch drag works, and it is keyboard
 * operable; holding it pauses playback, QA N2); every control is ≥ 44 px; it fits 320 px
 * wide; a vertical swipe on the field scrolls the dialog (QA S2). No storage of any kind.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { ReplayView } from "../../api/replayTypes.ts";
import { useApi } from "../../auth/session.tsx";
import { IsoCanvas } from "../../iso/index.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { STRINGS } from "../../strings.ts";
import { depthPercent } from "./depth.ts";
import { END_HOLD_SECONDS, REPLAY_GEOMETRY, clock, nextKeyframe, openReplay, prevKeyframe, type FeedLine, type ReplayModel } from "./replayModel.ts";

const T = STRINGS.replay;
/** The speeds offered (PHASE-2 §22). */
export const REPLAY_SPEEDS = [1, 2, 4] as const;
type Speed = (typeof REPLAY_SPEEDS)[number];
/** QA D4: 2× by default; the player's choice is remembered for this session only (module state, no storage). */
export const DEFAULT_REPLAY_SPEED: Speed = 2;
let sessionSpeed: Speed = DEFAULT_REPLAY_SPEED;
/** Tests reset the remembered speed. */
export function resetReplaySpeed(): void {
  sessionSpeed = DEFAULT_REPLAY_SPEED;
}
/** How many feed lines are kept on screen (newest first); the full log is always reachable by scrubbing. */
const FEED_LINES_SHOWN = 60;
/** How many key moments the strip under the stage shows. */
const STRIP_LINES = 3;

/** What the party's owner was credited for this fight, from their results feed (chunk 09): shown only while the ledger itemization is not written yet. */
export interface ReplaySettled {
  readonly coin: number;
  readonly reputation: number;
  readonly ladder: number;
}

export interface ReplayPlayerProps {
  readonly jobId: string;
  /** The encounter asked for: a body for another encounter is refused (QA N7). */
  readonly encounterIndex?: number;
  readonly api?: Api;
  readonly settled?: ReplaySettled | null;
  /** Tests start the clock themselves; the app always uses requestAnimationFrame. */
  readonly autoPlay?: boolean;
}

type Load = { readonly k: "loading" } | { readonly k: "error"; readonly error: ApiError } | { readonly k: "ready"; readonly view: ReplayView };

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

export function ReplayPlayer({ jobId, encounterIndex, api: apiProp, settled = null, autoPlay = false }: ReplayPlayerProps): JSX.Element {
  const api = useApi(apiProp);
  const [load, setLoad] = useState<Load>({ k: "loading" });
  const fetchIt = useCallback(async (): Promise<void> => {
    setLoad({ k: "loading" });
    try {
      setLoad({ k: "ready", view: await api.replay(jobId) });
    } catch (err) {
      setLoad({ k: "error", error: asApiError(err) });
    }
  }, [api, jobId]);
  useEffect(() => {
    void fetchIt();
  }, [fetchIt]);

  if (load.k === "loading") {
    return (
      <p className="hint" role="status" data-testid="replay-loading">
        {T.loading}
      </p>
    );
  }
  if (load.k === "error") {
    const e = load.error;
    const known =
      e.status === 409 && e.code === "not_resolved"
        ? T.notResolved
        : e.status === 409 && e.code === "resolution_unavailable"
          ? T.unavailable
          : e.status === 410
            ? T.expired
            : e.status === 404
              ? T.notFound
              : null;
    return known ? (
      <div className="card" role="status" data-testid="replay-unavailable" data-code={e.code}>
        <p>{known}</p>
        {/* QA N6: a fight still being resolved can be asked for again. */}
        {e.code === "not_resolved" && (
          <button type="button" className="btn btn--block" data-testid="replay-retry" onClick={() => void fetchIt()}>
            {STRINGS.app.retry}
          </button>
        )}
      </div>
    ) : (
      <ErrorBox error={e} heading={T.loadFailed} onRetry={() => void fetchIt()} />
    );
  }
  return <ReplayBody view={load.view} expected={{ jobId, ...(encounterIndex !== undefined ? { encounterIndex } : {}) }} settled={settled} autoPlay={autoPlay} />;
}

function ReplayBody({ view, expected, settled, autoPlay }: { readonly view: ReplayView; readonly expected: { jobId: string; encounterIndex?: number }; readonly settled: ReplaySettled | null; readonly autoPlay: boolean }): JSX.Element {
  const opened = useMemo(() => openReplay(view, expected), [view, expected.jobId, expected.encounterIndex]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!opened.ok) {
    return (
      <div data-testid="replay-not-renderable" data-no-log={opened.noLog ? "true" : "false"}>
        <section className="card" role="status">
          <h3>{opened.noLog ? T.noLogTitle : T.cannotPlayTitle}</h3>
          <p>{opened.noLog ? T.noLogBody : T.cannotPlayBody}</p>
          {/* QA N6: the reader's raw reason, kept, but under the plain sentence. */}
          <details className="disclosure">
            <summary>{T.reasonDetail}</summary>
            <p className="hint" data-testid="replay-reason">
              {T.reason(opened.reason)}
            </p>
          </details>
        </section>
        <Summary view={view} model={null} settled={settled} />
      </div>
    );
  }
  return <Playback view={view} model={opened.model} settled={settled} autoPlay={autoPlay} />;
}

/** The ledger's itemization of what this encounter settled for the viewer (QA S8 / D3). The client words it and computes nothing. */
function settledLines(view: ReplayView, fallback: ReplaySettled | null): string[] {
  const s = view.settled;
  const out: string[] = [];
  if (!s.applied) {
    if (view.viewer === "party_owner" && fallback) out.push(T.settledOwner(fallback.coin, fallback.reputation, fallback.ladder));
    else out.push(T.settledNotYet);
    return out;
  }
  for (const c of s.coin) out.push(T.settledCoin(c.reason, c.amount) + (c.discarded > 0 ? T.settledDiscarded(c.discarded) : ""));
  if (s.trip?.unbankedCoin !== null && s.trip?.unbankedCoin !== undefined && s.trip.unbankedCoin > 0) out.push(T.settledUnbanked(s.trip.unbankedCoin));
  if (s.coinLost) out.push(T.settledLost(s.coinLost.amount, s.coinLost.transferred, s.coinLost.destroyed));
  for (const u of s.deMerged) out.push(T.settledDeMerged(u.displayName, u.fromLevel, u.toLevel));
  for (const u of s.destroyed) out.push(T.settledDestroyed(u.displayName, u.mergeLevel));
  for (const r of s.reputation) out.push(T.settledReputation(T.settledPool(r.pool), r.delta));
  for (const l of s.ladder) out.push(T.settledLadder(T.settledPool(l.pool), l.pointsDelta, l.levelBefore, l.levelAfter));
  for (const p of s.unlockPoints) out.push(T.settledUnlock(T.settledPool(p.pool), p.points));
  if (out.length === 0) out.push(T.settledNothing);
  if (s.trip && !s.trip.ended) out.push(T.settledDeMergesLater);
  if (view.viewer === "party_owner") out.push(T.settledOwnerTemplate);
  return out;
}

/** The results summary: the recorded outcome, depth (with the DEPTH_METRIC sentence), loot, what it settled, what fell and how each fared. */
function Summary({ view, model, settled }: { readonly view: ReplayView; readonly model: ReplayModel | null; readonly settled: ReplaySettled | null }): JSX.Element {
  const o = view.outcome;
  const v = view.viewer;
  const t = model?.tally;
  const pct = o ? depthPercent(o.depth, o.kind === "caravan_overrun" || (t?.coreReached ?? false)) : 0;
  const lines = settledLines(view, settled);
  return (
    <section className="card" data-testid="replay-summary" data-outcome={o?.kind ?? ""}>
      <h3>{T.summaryHeading}</h3>
      <p data-testid="replay-outcome">
        <strong>{o ? T.outcome(o.kind, v) : T.outcomeUnknown}</strong>
      </p>
      {o && (
        <>
          <p data-testid="replay-depth">
            {T.depth(pct, v)} {model?.deepestName ? T.deepest(model.deepestName) : null}
          </p>
          <p className="hint" data-testid="replay-depth-explained">
            {T.depthExplained}
          </p>
          <p data-testid="replay-loot">{v === "caravan" ? T.lootCaravan(o.loot) : T.lootOwner(o.loot)}</p>
        </>
      )}
      <div className="h3">{T.settledHeading}</div>
      <ul className="plain" data-testid="replay-settled" data-applied={view.settled.applied ? "true" : "false"}>
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {t && (
        <>
          <div className="h3">{T.tallyHeading}</div>
          <ul className="plain" data-testid="replay-tally">
            {t.raiders > 0 && <li>{T.tallyRaiders(t.raidersFallen, t.raiders, v)}</li>}
            {t.defenders > 0 && <li>{T.tallyDefenders(t.defendersFallen, t.defenders, v)}</li>}
            {t.fences > 0 && <li>{T.tallyFences(t.fencesBroken, t.fences)}</li>}
            {t.traps > 0 && <li>{T.tallyTraps(t.trapsSprung, t.traps)}</li>}
            {t.trapsNullified > 0 && <li>{T.tallyNullified(t.trapsNullified)}</li>}
            {t.coreReached && <li>{T.tallyCore}</li>}
          </ul>
        </>
      )}
      {model && model.fates.length > 0 && (
        <>
          <div className="h3">{T.fatesHeading(v)}</div>
          <ul className="plain" data-testid="replay-fates">
            {model.fates.map((f) => (
              <li key={f.u} data-side={f.side}>
                {f.text}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function Playback({ view, model, settled, autoPlay }: { readonly view: ReplayView; readonly model: ReplayModel; readonly settled: ReplaySettled | null; readonly autoPlay: boolean }): JSX.Element {
  const last = model.ticks - 1;
  const [at, setAt] = useState(0);
  const [playing, setPlaying] = useState(autoPlay);
  const [speed, setSpeedState] = useState<Speed>(sessionSpeed);
  const [keyOnly, setKeyOnly] = useState(true);
  const [endDismissed, setEndDismissed] = useState(false);
  const [highlight, setHighlight] = useState<{ readonly key: number; readonly units: ReadonlySet<number> } | null>(null);
  const setSpeed = (s: Speed): void => {
    sessionSpeed = s;
    setSpeedState(s);
  };
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const atRef = useRef(at);
  atRef.current = at;
  const hasClock = typeof requestAnimationFrame === "function";
  // QA S1: the clock runs past the last tick for END_HOLD_SECONDS of wall time; the frame clamps there and the final rows' marks play out.
  const holdTicks = hasClock ? END_HOLD_SECONDS * model.tickRate * speed : 0;
  const endAt = last + holdTicks;
  const holding = at >= last && at < endAt;
  const running = playing || holding;

  // The clock: fight time advances at tickRate × speed while playing (and through the end hold). Presentation only.
  useEffect(() => {
    if (!running || !hasClock) return;
    let prev: number | null = null;
    let raf = 0;
    const step = (now: number): void => {
      const dt = prev === null ? 0 : Math.min(250, now - prev);
      prev = now;
      const end = last + END_HOLD_SECONDS * model.tickRate * speedRef.current;
      const next = Math.min(end, atRef.current + (dt / 1000) * model.tickRate * speedRef.current);
      atRef.current = next;
      setAt(next);
      if (next >= end) setPlaying(false);
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [running, hasClock, last, model.tickRate]);

  const scene = useMemo(() => model.scene(at, { speed, ...(highlight ? { highlight: highlight.units } : {}) }), [model, at, speed, highlight]);
  const tick = Math.min(last, Math.floor(at));
  const atEnd = at >= last;
  const showEnd = at >= endAt && !endDismissed;
  useEffect(() => {
    if (!atEnd) setEndDismissed(false);
  }, [atEnd]);
  const lines = useMemo(() => {
    const out: FeedLine[] = [];
    for (let i = model.feed.length - 1; i >= 0 && out.length < FEED_LINES_SHOWN; i--) {
      const l = model.feed[i]!;
      if (l.tick > tick) continue;
      if (keyOnly && l.kind === "hit") continue;
      out.push(l);
    }
    return out;
  }, [model, tick, keyOnly]);
  const strip = useMemo(() => {
    const out: FeedLine[] = [];
    for (let i = model.feed.length - 1; i >= 0 && out.length < STRIP_LINES; i--) {
      const l = model.feed[i]!;
      if (l.tick <= tick && l.kind !== "hit") out.push(l);
    }
    return out;
  }, [model, tick]);
  const total = clock(last, model.tickRate);
  const now = clock(tick, model.tickRate);
  const seek = (t: number): void => setAt(Math.max(0, Math.min(last, t)));
  const intro = view.viewer === "caravan" ? T.introCaravan : T.introOwner(T.edgeList(model.entryEdges.map((e) => T.edgeName(e))));
  const o = view.outcome;
  const pct = o ? depthPercent(o.depth, o.kind === "caravan_overrun" || model.tally.coreReached) : 0;
  // QA N2: holding the scrub pauses playback; letting go resumes it if it was playing.
  const resumeAfterScrub = useRef(false);
  const scrubStart = (): void => {
    if (playing) {
      resumeAfterScrub.current = true;
      setPlaying(false);
    }
  };
  const scrubEnd = (): void => {
    if (resumeAfterScrub.current) {
      resumeAfterScrub.current = false;
      if (atRef.current < last) setPlaying(true);
    }
  };
  const step = model.keyframeSeconds;

  return (
    <div className="replay" data-testid="replay-player" data-viewer={view.viewer}>
      <div className="replay__stage" data-testid="replay-stage">
        <div className="replay__field">
          <IsoCanvas geometry={REPLAY_GEOMETRY} state={scene} label={T.canvasLabel} frame={model.frameRect} touchScroll sleepWhenIdle />
          {showEnd && (
            <section className="replay__end card" data-testid="replay-end-card" data-outcome={o?.kind ?? ""} aria-live="polite">
              <h3>{T.endTitle}</h3>
              <p>
                <strong>{o ? T.outcome(o.kind, view.viewer) : T.outcomeUnknown}</strong>
              </p>
              {o && (
                <>
                  <p>{T.depth(pct, view.viewer)}</p>
                  <p>{view.viewer === "caravan" ? T.lootCaravan(o.loot) : T.lootOwner(o.loot)}</p>
                </>
              )}
              <div className="replay__row">
                <button type="button" className="btn" data-testid="replay-end-dismiss" onClick={() => setEndDismissed(true)}>
                  {T.endDismiss}
                </button>
                <button
                  type="button"
                  className="btn btn--primary"
                  data-testid="replay-end-again"
                  onClick={() => {
                    setAt(0);
                    setPlaying(true);
                  }}
                >
                  {T.replayAgain}
                </button>
              </div>
            </section>
          )}
        </div>
        {/* D1: the party's siege, under the field (an overlay hid the ring's top at phone width). */}
        {model.siegeNames.length > 0 && (
          <p className="hint replay__siege" data-testid="replay-siege">
            {T.siegeLegend(model.siegeNames.join(", "))}
          </p>
        )}
        <ol className="plain replay__strip" data-testid="replay-strip" aria-label={T.stripLabel}>
          {strip.length === 0 ? (
            <li className="hint">{T.feedEmpty}</li>
          ) : (
            strip.map((l) => (
              <li key={l.key} className={`replay__line--${l.kind}`} data-kind={l.kind}>
                <span className="hint replay__at">{T.feedAt(clock(l.tick, model.tickRate))}</span> {l.text}
              </li>
            ))
          )}
        </ol>
      </div>
      <div className="replay__controls" data-testid="replay-controls">
        <div className="replay__row">
          <button
            type="button"
            className="btn btn--primary replay__play"
            data-testid="replay-play"
            onClick={() => {
              if (atEnd) {
                setAt(0);
                setPlaying(true);
              } else setPlaying((p) => !p);
            }}
          >
            {playing ? T.pause : atEnd ? T.replayAgain : T.play}
          </button>
          <span className="replay__time" data-testid="replay-time" aria-hidden="true">
            {T.timeOf(now, total)}
          </span>
        </div>
        <input
          type="range"
          className="replay__scrub"
          data-testid="replay-scrub"
          min={0}
          max={last}
          step={1}
          value={tick}
          aria-label={T.scrubLabel}
          aria-valuetext={T.scrubValue(now, total)}
          onPointerDown={scrubStart}
          onPointerUp={scrubEnd}
          onPointerCancel={scrubEnd}
          onBlur={scrubEnd}
          onChange={(e) => seek(Number(e.currentTarget.value))}
        />
        <div className="replay__row">
          <button type="button" className="btn" data-testid="replay-prev-keyframe" onClick={() => seek(prevKeyframe(model, at))}>
            <span aria-hidden="true">⏮ </span>
            {T.back(step)}
          </button>
          <button type="button" className="btn" data-testid="replay-next-keyframe" onClick={() => seek(nextKeyframe(model, at))}>
            {T.forward(step)}
            <span aria-hidden="true"> ⏭</span>
          </button>
          <button
            type="button"
            className="btn"
            data-testid="replay-to-end"
            onClick={() => {
              setPlaying(false);
              seek(last);
            }}
          >
            {T.toEnd}
          </button>
        </div>
        <div className="replay__row" role="group" aria-label={T.speedLabel}>
          <span className="hint">{T.speedLabel}</span>
          {REPLAY_SPEEDS.map((s) => (
            <button key={s} type="button" className="btn" aria-pressed={speed === s} data-testid={`replay-speed-${s}`} onClick={() => setSpeed(s)}>
              {T.speedName(s)}
            </button>
          ))}
        </div>
        {model.hasStances && <p className="hint">{T.stanceLegend}</p>}
      </div>
      <p className="hint" data-testid="replay-intro">
        {intro}
      </p>
      <details className="disclosure replay__summary" data-testid="replay-summary-toggle">
        <summary>{T.summaryToggle(o ? T.outcome(o.kind, view.viewer) : T.outcomeUnknown)}</summary>
        <Summary view={view} model={model} settled={settled} />
      </details>
      <section className="replay__feed" aria-labelledby="replay-feed-heading">
        <div className="sheet__head">
          <h3 id="replay-feed-heading">{T.feedHeading}</h3>
          <div role="group" aria-label={T.feedFilterLabel} className="replay__row">
            <button type="button" className="btn btn--small" aria-pressed={!keyOnly} data-testid="replay-feed-all" onClick={() => setKeyOnly(false)}>
              {T.feedAll}
            </button>
            <button type="button" className="btn btn--small" aria-pressed={keyOnly} data-testid="replay-feed-key" onClick={() => setKeyOnly(true)}>
              {T.feedKey}
            </button>
          </div>
        </div>
        {/* A live region only while paused: at 4× a screen reader would drown in hits. */}
        <ol className="plain replay__lines" data-testid="replay-feed" role="log" aria-live={playing ? "off" : "polite"}>
          {lines.length === 0 ? (
            <li className="hint">{T.feedEmpty}</li>
          ) : (
            lines.map((l) => (
              <li key={l.key} className={`replay__line replay__line--${l.kind}`} data-kind={l.kind}>
                {l.units.length > 0 ? (
                  // QA N5: tap a line to see its units on the field.
                  <button
                    type="button"
                    className="replay__line-btn"
                    aria-pressed={highlight?.key === l.key}
                    aria-label={T.showOnField(l.text)}
                    onClick={() => setHighlight((h) => (h?.key === l.key ? null : { key: l.key, units: new Set(l.units) }))}
                  >
                    <span className="hint replay__at">{T.feedAt(clock(l.tick, model.tickRate))}</span> {l.text}
                  </button>
                ) : (
                  <>
                    <span className="hint replay__at">{T.feedAt(clock(l.tick, model.tickRate))}</span> {l.text}
                  </>
                )}
              </li>
            ))
          )}
        </ol>
      </section>
    </div>
  );
}
