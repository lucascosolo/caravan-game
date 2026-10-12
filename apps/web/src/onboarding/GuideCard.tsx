/**
 * One card of the first-session guide (chunk 24): a short title, a line or two, the step's
 * actions, and — once past the first screen — "Skip the guide" behind a confirm. Sits in the
 * normal flow of the screen it guides (never an overlay over the controls it points at).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "../shell/Modal.tsx";
import { STRINGS } from "../strings.ts";
import { useOnboarding } from "./OnboardingProvider.tsx";

const G = STRINGS.guide;

export interface GuideCardProps {
  readonly title: string;
  readonly testId: string;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
}

export function GuideCard({ title, testId, children, actions }: GuideCardProps): JSX.Element {
  const ob = useOnboarding();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const canSkip = ob?.view?.canSkip ?? false;
  // Final play-test review N2: a new step's card is brought into view (the player may be
  // scrolled down at the panel the last step pointed at). "nearest": a card already on screen does not move.
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [testId]);

  const skip = async (): Promise<void> => {
    if (!ob) return;
    setBusy(true);
    setFailed(false);
    try {
      await ob.skip();
      setConfirming(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="guide" aria-label={G.label} data-testid={testId} ref={ref}>
      <p className="guide__label">{G.label}</p>
      <h2 className="guide__title">{title}</h2>
      {children}
      {ob?.saveFailed && <p className="hint">{G.saveFailed}</p>}
      {actions && <div className="actions">{actions}</div>}
      {canSkip && (
        <button type="button" className="btn btn--block guide__skip" onClick={() => setConfirming(true)} data-testid="guide-skip">
          {G.skip}
        </button>
      )}
      {confirming && (
        <Modal
          title={G.skipTitle}
          busy={busy}
          onCancel={() => setConfirming(false)}
          testId="guide-skip-dialog"
          actions={
            <>
              <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(false)}>
                {G.skipNo}
              </button>
              <button type="button" className="btn btn--primary" disabled={busy} onClick={() => void skip()} data-testid="guide-skip-confirm">
                {busy ? G.skipping : G.skipYes}
              </button>
            </>
          }
        >
          <p>{G.skipBody}</p>
          {failed && (
            <p className="error" role="alert">
              {STRINGS.app.genericError}
            </p>
          )}
        </Modal>
      )}
    </aside>
  );
}
