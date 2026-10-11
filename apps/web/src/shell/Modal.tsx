/**
 * A REAL modal (chunk 06 QA convention, generalized for chunk 17's merge preview, reroll,
 * recruit and ride-out confirms): rendered through a portal into <body>; every other body
 * child is `inert` while it is open; Tab / Shift+Tab cycle inside; Escape cancels (unless
 * busy); focus lands on the first focusable control on open and returns to the opener on
 * close — or, when the opener is gone (a list re-rendered under it), to `restoreFocusTo`'s
 * element, then to `main` (QA-17 N4, the same
 * fallback `ConfirmDialog` has); `aria-labelledby` / `aria-describedby` point at the title
 * and body.
 *
 * It renders only chrome: the caller supplies the body and the action buttons, so a
 * preview that is still loading, or that the server refused, is shown inside the same
 * dialog rather than a second one.
 */
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalProps {
  readonly title: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly testId?: string;
  readonly children: ReactNode;
  readonly actions: ReactNode;
  /** Fallback focus target on close, used when the opener is no longer in the document (QA-17 N4). */
  readonly restoreFocusTo?: () => HTMLElement | null;
}

export function Modal({ title, busy, onCancel, testId, children, actions, restoreFocusTo }: ModalProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const latest = useRef({ busy, onCancel, restoreFocusTo });
  latest.current = { busy, onCancel, restoreFocusTo };

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    const host = dialog?.parentElement ?? null;
    const made: Element[] = [];
    for (const el of Array.from(document.body.children)) {
      if (el === host || el.tagName === "SCRIPT" || el.hasAttribute("inert")) continue;
      el.setAttribute("inert", "");
      made.push(el);
    }
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (!latest.current.busy) latest.current.onCancel();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      const active = document.activeElement;
      const inside = dialog.contains(active);
      if (e.shiftKey && (active === firstEl || !inside)) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && (active === lastEl || !inside)) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      for (const el of made) el.removeAttribute("inert");
      if (opener?.isConnected) {
        opener.focus();
        return;
      }
      const fallback = latest.current.restoreFocusTo?.() ?? document.querySelector<HTMLElement>("main");
      if (fallback) {
        if (!fallback.matches(FOCUSABLE) && !fallback.hasAttribute("tabindex")) fallback.setAttribute("tabindex", "-1");
        fallback.focus();
      }
    };
  }, []);

  return createPortal(
    <div className="dialog-backdrop" data-testid={testId} onClick={() => !latest.current.busy && latest.current.onCancel()}>
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h2 id={titleId} style={{ marginTop: 0 }}>
          {title}
        </h2>
        <div id={bodyId}>{children}</div>
        <div className="dialog__actions">{actions}</div>
      </div>
    </div>,
    document.body,
  );
}
