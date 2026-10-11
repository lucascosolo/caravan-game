/**
 * The replay player (chunk 22): plays a stored fight for EITHER participant — the caravan's
 * player, who was there, and the standing party's owner, who never is (the passive side's
 * only way to see where its party struck and how it did). Each sees the fight from their own
 * side: "your Well Digger" / "the raiders' Dust Rider" for the caravan; "your Dust Rider" /
 * "the caravan's Well Digger" for the party's owner.
 *
 * Order on screen: the results summary first (outcome as the server recorded it, depth with
 * the DEPTH_METRIC sentence, loot, what fell) — then the scene through the ONE isometric
 * renderer (apps/web/src/iso), the transport (play / pause, scrub, 1× 2× 4×, previous / next
 * keyframe, skip to the end) and the event feed (one line per log row). At the end of the
 * fight an end card restates the recorded outcome.
 *
 * Nothing here simulates: replayModel.ts reads the log with the resolver package's REPLAY
 * READER and renders frames; seeking renders the keyframe-based frame and plays forward by
 * interpolation. A log that cannot be read is refused with the reason, never drawn.
 *
 * Mobile-shaped: the scrub is a native range input (touch drag works, and it is keyboard
 * operable); every control is ≥ 44 px; it fits 320 px wide. No storage of any kind.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, type Api } from "../../api/client.ts";
import type { ReplayView } from "../../api/replayTypes.ts";
import { useApi } from "../../auth/session.tsx";
import { IsoCanvas } from "../../iso/index.ts";
import { ErrorBox } from "../../shell/ErrorBox.tsx";
import { STRINGS } from "../../strings.ts";
import { REPLAY_GEOMETRY, clock, nextKeyframe, openReplay, prevKeyframe, type FeedLine, type ReplayModel } from "./replayModel.ts";

const T = STRINGS.replay;
/** The speeds offered (PHASE-2 §22). */
export const REPLAY_SPEEDS = [1, 2, 4] as const;
/** How many feed lines are kept on screen (newest first); the full log is always reachable by scrubbing. */
const FEED_LINES_SHOWN = 60;
const DEPTH_ONE = 1024;

/** What the party's owner was credited for this fight, from their results feed (chunk 09), shown with the summary. */
export interface ReplaySettled {
  readonly coin: number;
  readonly reputation: number;
  readonly ladder: number;
}

export interface ReplayPlayerProps {
  readonly jobId: string;
  readonly api?: Api;
  readonly settled?: ReplaySettled | null;
  /** Tests start the clock themselves; the app always uses requestAnimationFrame. */
  readonly autoPlay?: boolean;
}

type Load = { readonly k: "loading" } | { readonly k: "error"; readonly error: ApiError } | { readonly k: "ready"; readonly view: ReplayView };

const asApiError = (err: unknown): ApiError => (err instanceof ApiError ? err : new ApiError(0, "unknown", STRINGS.app.genericError));

export function ReplayPlayer({ jobId, api: apiProp, settled = null, autoPlay = false }: ReplayPlayerProps): JSX.Element {
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
    const known = e.status === 409 && e.code === "not_resolved" ? T.notResolved : e.status === 410 ? T.expired : e.status === 404 ? T.notFound : null;
    return known ? (
      <p className="card" role="status" data-testid="replay-unavailable" data-code={e.code}>
        {known}
      </p>
    ) : (
      <ErrorBox error={e} heading={T.loadFailed} onRetry={() => void fetchIt()} />
    );
  }
  return <ReplayBody view={load.view} settled={settled} autoPlay={autoPlay} />;
}

function ReplayBody({ view, settled, autoPlay }: { readonly view: ReplayView; readonly settled: ReplaySettled | null; readonly autoPlay: boolean }): JSX.Element {
  const opened = useMemo(() => openReplay(view), [view]);
  if (!opened.ok) {
    return (
      <div data-testid="replay-not-renderable" data-no-log={opened.noLog ? "true" : "false"}>
        <section className="card" role="status">
          <h3>{opened.noLog ? T.noLogTitle : T.cannotPlayTitle}</h3>
          <p>{opened.noLog ? T.noLogBody : T.cannotPlayBody}</p>
          <p className="hint" data-testid="replay-reason">
            {T.reason(opened.reason)}
          </p>
        </section>
        <Summary view={view} model={null} settled={settled} />
      </div>
    );
  }
  return <Playback view={view} model={opened.model} settled={settled} autoPlay={autoPlay} />;
}

/** The results summary: the recorded outcome, depth (with the server's one-sentence DEPTH_METRIC), loot, and what the log shows fell. */
function Summary({ view, model, settled, testId = "replay-summary", heading = T.summaryHeading }: { readonly view: ReplayView; readonly model: ReplayModel | null; readonly settled: ReplaySettled | null; readonly testId?: string; readonly heading?: string }): JSX.Element {
  const o = view.outcome;
  const v = view.viewer;
  const pct = o ? Math.round((o.depth * 100) / DEPTH_ONE) : 0;
  const t = model?.tally;
  return (
    <section className="card" data-testid={testId} data-outcome={o?.kind ?? ""}>
      <h3>{heading}</h3>
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
      {v === "party_owner" && settled && <p data-testid="replay-settled">{T.settledOwner(settled.coin, settled.reputation, settled.ladder)}</p>}
      {t && (
        <>
          <div className="h3">{T.tallyHeading}</div>
          <ul className="plain" data-testid="replay-tally">
            <li>{T.tallyRaiders(t.raidersFallen, t.raiders, v)}</li>
            <li>{T.tallyDefenders(t.defendersFallen, t.defenders, v)}</li>
            {t.fences > 0 && <li>{T.tallyFences(t.fencesBroken, t.fences)}</li>}
            {t.traps > 0 && <li>{T.tallyTraps(t.trapsSprung, t.traps)}</li>}
            {t.coreReached && <li>{T.tallyCore}</li>}
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
  const [speed, setSpeed] = useState<(typeof REPLAY_SPEEDS)[number]>(1);
  const [keyOnly, setKeyOnly] = useState(false);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const atRef = useRef(at);
  atRef.current = at;

  // The clock: fight time advances at tickRate × speed while playing. Presentation only.
  useEffect(() => {
    if (!playing || typeof requestAnimationFrame !== "function") return;
    let prev: number | null = null;
    let raf = 0;
    const step = (now: number): void => {
      const dt = prev === null ? 0 : Math.min(250, now - prev);
      prev = now;
      const next = Math.min(last, atRef.current + (dt / 1000) * model.tickRate * speedRef.current);
      atRef.current = next;
      setAt(next);
      if (next >= last) setPlaying(false);
      else raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, last, model.tickRate]);

  const scene = useMemo(() => model.scene(at), [model, at]);
  const tick = Math.floor(at);
  const atEnd = tick >= last;
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
  const total = clock(last, model.tickRate);
  const now = clock(tick, model.tickRate);
  const seek = (t: number): void => setAt(Math.max(0, Math.min(last, t)));
  const intro = view.viewer === "caravan" ? T.introCaravan : T.introOwner(T.edgeList(model.entryEdges.map((e) => T.edgeName(e))));

  return (
    <div className="replay" data-testid="replay-player" data-viewer={view.viewer}>
      <p className="hint" data-testid="replay-intro">
        {intro}
      </p>
      <Summary view={view} model={model} settled={settled} />
      <div className="replay__stage">
        <IsoCanvas geometry={REPLAY_GEOMETRY} state={scene} label={T.canvasLabel} />
        {atEnd && (
          <section className="replay__end card" data-testid="replay-end-card" data-outcome={view.outcome?.kind ?? ""} aria-live="polite">
            <h3>{T.endTitle}</h3>
            <p>
              <strong>{view.outcome ? T.outcome(view.outcome.kind, view.viewer) : T.outcomeUnknown}</strong>
            </p>
            {view.outcome && (
              <>
                <p>{T.depth(Math.round((view.outcome.depth * 100) / DEPTH_ONE), view.viewer)}</p>
                <p>{view.viewer === "caravan" ? T.lootCaravan(view.outcome.loot) : T.lootOwner(view.outcome.loot)}</p>
              </>
            )}
          </section>
        )}
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
          onChange={(e) => seek(Number(e.currentTarget.value))}
        />
        <div className="replay__row">
          <button type="button" className="btn" data-testid="replay-prev-keyframe" onClick={() => seek(prevKeyframe(model, at))}>
            <span aria-hidden="true">⏮ </span>
            {T.prevKeyframe}
          </button>
          <button type="button" className="btn" data-testid="replay-next-keyframe" onClick={() => seek(nextKeyframe(model, at))}>
            {T.nextKeyframe}
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
      </div>
      <section className="replay__feed" aria-labelledby="replay-feed-heading">
        <div className="sheet__head">
          <h3 id="replay-feed-heading">{T.feedHeading}</h3>
          <div role="group" aria-label={T.feedFilterLabel} className="replay__row">
            <button type="button" className="btn btn--small" aria-pressed={!keyOnly} onClick={() => setKeyOnly(false)}>
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
                <span className="hint replay__at">{T.feedAt(clock(l.tick, model.tickRate))}</span> {l.text}
              </li>
            ))
          )}
        </ol>
      </section>
    </div>
  );
}
