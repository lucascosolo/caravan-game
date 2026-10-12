/**
 * "Watch the fight" (chunk 22): the one entry point to the replay player, used by both
 * participants' screens — the caravan's encounter results on the Trail (chunk 23) and the
 * standing party's results feed on the Party tab (chunk 09). It opens the player in a
 * full-viewport dialog over the screen it was opened from, so closing it lands the player
 * back exactly where they were (the trip flow is never left).
 *
 * PHASE-2 §36: the player is a LAZY chunk. The Trail, Party and Inbox screens carry only this
 * button; the replay player, its model and the resolver package's replay reader load the first
 * time a fight is opened (the iso renderer they draw through is its own chunk already).
 *
 * QA-36 S4: a chunk that fails to load (offline, a flaky connection, or a deploy that removed the
 * old hashed file) is shown INSIDE the dialog — "Couldn't load the replay", Retry, and a reload
 * hint — never as the app's render error. A rejected import is not cached: Retry calls import()
 * again (the module promise is cleared on rejection and the lazy component is re-created per
 * attempt; React caches a lazy component's rejection forever).
 */
import { Component, Suspense, lazy, useMemo, useState, type ReactNode } from "react";
import type { Api } from "../../api/client.ts";
import { Modal } from "../../shell/Modal.tsx";
import { STRINGS } from "../../strings.ts";
import type { ReplaySettled } from "./ReplayPlayer.tsx";

const T = STRINGS.replay;

type PlayerModule = typeof import("./ReplayPlayer.tsx");
let importPlayer: () => Promise<PlayerModule> = () => import("./ReplayPlayer.tsx");
let playerModule: Promise<PlayerModule> | null = null;

/** The replay player's chunk, loaded once; a failed load is forgotten so the next attempt imports again. */
export function loadReplayPlayer(): Promise<PlayerModule> {
  if (!playerModule) {
    playerModule = importPlayer().catch((err: unknown) => {
      playerModule = null;
      throw err;
    });
  }
  return playerModule;
}

/** Tests only: replace the chunk import (a failing one), or restore the real one with no argument. */
export function setReplayPlayerImporterForTests(f?: () => Promise<PlayerModule>): void {
  importPlayer = f ?? (() => import("./ReplayPlayer.tsx"));
  playerModule = null;
}

/** Catches the lazy chunk's failure inside the dialog (QA-36 S4). */
class ReplayChunkBoundary extends Component<{ readonly children: ReactNode; readonly onRetry: () => void }, { readonly failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override componentDidCatch(error: unknown): void {
    console.error("replay chunk failed to load", error);
  }
  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <section className="card" role="alert" data-testid="replay-chunk-error">
        <h3>{T.chunkFailedTitle}</h3>
        <p>{T.chunkFailedBody}</p>
        <button type="button" className="btn" data-testid="replay-chunk-retry" onClick={this.props.onRetry}>
          {T.chunkRetry}
        </button>
      </section>
    );
  }
}

export interface WatchFightProps {
  readonly jobId: string;
  readonly encounterIndex: number;
  readonly label: string;
  readonly api?: Api;
  readonly settled?: ReplaySettled | null;
  readonly testId?: string;
  readonly className?: string;
  readonly describedBy?: string;
}

export function WatchFight({ jobId, encounterIndex, label, api, settled = null, testId = "watch-fight", className = "btn btn--block", describedBy }: WatchFightProps): JSX.Element {
  const [open, setOpen] = useState(false);
  // A new lazy component per attempt: React would otherwise replay the cached rejection.
  const [attempt, setAttempt] = useState(0);
  const ReplayPlayer = useMemo(() => lazy(() => loadReplayPlayer().then((m) => ({ default: m.ReplayPlayer }))), [attempt]);
  return (
    <>
      <button type="button" className={className} data-testid={testId} aria-describedby={describedBy} onClick={() => {
          // A fresh lazy component per opening: a chunk that failed before is imported again (the
          // module promise is kept once it loads, so a loaded player opens at once).
          setAttempt((n) => n + 1);
          setOpen(true);
        }}>
        {label}
      </button>
      {open && (
        <Modal
          title={T.title(encounterIndex)}
          busy={false}
          size="full"
          testId="replay-dialog"
          onCancel={() => setOpen(false)}
          actions={
            <button type="button" className="btn" data-testid="replay-close" onClick={() => setOpen(false)}>
              {T.close}
            </button>
          }
        >
          <ReplayChunkBoundary key={attempt} onRetry={() => setAttempt((n) => n + 1)}>
            <Suspense
              fallback={
                <p className="hint" role="status" data-testid="replay-loading">
                  {T.loading}
                </p>
              }
            >
              <ReplayPlayer jobId={jobId} encounterIndex={encounterIndex} settled={settled} {...(api ? { api } : {})} />
            </Suspense>
          </ReplayChunkBoundary>
        </Modal>
      )}
    </>
  );
}
