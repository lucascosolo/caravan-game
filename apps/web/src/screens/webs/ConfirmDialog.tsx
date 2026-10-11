/** A modal confirm step. Nothing is sent to the server until `onConfirm` fires. */
import { useEffect, useRef } from "react";

export interface ConfirmDialogProps {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function ConfirmDialog(p: ConfirmDialogProps): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !p.busy) p.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);
  return (
    <div className="dialog-backdrop" onClick={() => !p.busy && p.onCancel()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="confirm-title" style={{ marginTop: 0 }}>
          {p.title}
        </h2>
        <p>{p.body}</p>
        <div className="dialog__actions">
          <button ref={cancelRef} type="button" className="btn" onClick={p.onCancel} disabled={p.busy}>
            {p.cancelLabel}
          </button>
          <button type="button" className="btn btn--primary" onClick={p.onConfirm} disabled={p.busy}>
            {p.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
