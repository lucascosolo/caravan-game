/**
 * A modal confirm step. Nothing is sent to the server until `onConfirm` fires.
 *
 * Modal for real (QA-06 S1): rendered through a portal into its own host under <body>,
 * every other child of <body> is made `inert` while it is open (no tabbing or clicking
 * behind it, hidden from assistive tech), Tab / Shift+Tab cycle inside it, Escape cancels,
 * and the element that had focus when it opened gets focus back when it closes (or
 * `restoreFocusTo`'s element if that opener is gone). `aria-describedby` points at the
 * body text so a screen reader reads the quoted cost on open.
 */
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export interface ConfirmDialogProps {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  /** Fallback focus target on close, used when the opener is no longer in the document. */
  readonly restoreFocusTo?: () => HTMLElement | null;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function useDialogHost(): HTMLElement | null {
  const ref = useRef<HTMLElement | null>(null);
  if (ref.current === null && typeof document !== "undefined") {
    const host = document.createElement("div");
    host.setAttribute("data-dialog-host", "");
    ref.current = host;
  }
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    document.body.appendChild(host);
    return () => {
      host.remove();
    };
  }, []);
  return ref.current;
}

export function ConfirmDialog(p: ConfirmDialogProps): JSX.Element | null {
  const host = useDialogHost();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const latest = useRef(p);
  latest.current = p;

  // Open: remember the opener, inert everything else, focus Cancel. Close: undo, restore focus.
  useEffect(() => {
    if (!host) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const made: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === host || el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      made.push(el);
    }
    cancelRef.current?.focus();
    return () => {
      for (const el of made) el.removeAttribute("inert");
      const target = opener && opener.isConnected ? opener : (latest.current.restoreFocusTo?.() ?? null);
      target?.focus();
    };
  }, [host]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { busy, onCancel } = latest.current;
      if (e.key === "Escape") {
        e.preventDefault();
        if (!busy) onCancel();
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = dialogRef.current.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  if (!host) return null;
  return createPortal(
    <div className="dialog-backdrop" onClick={() => !p.busy && p.onCancel()}>
      <div ref={dialogRef} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId} style={{ marginTop: 0 }}>
          {p.title}
        </h2>
        <p id={bodyId}>{p.body}</p>
        <div className="dialog__actions">
          <button ref={cancelRef} type="button" className="btn" onClick={p.onCancel} disabled={p.busy}>
            {p.cancelLabel}
          </button>
          <button type="button" className="btn btn--primary" onClick={p.onConfirm} disabled={p.busy}>
            {p.confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    host,
  );
}
