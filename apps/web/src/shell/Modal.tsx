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
import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "./useModalFocus.ts";

export interface ModalProps {
  readonly title: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly testId?: string;
  readonly children: ReactNode;
  readonly actions: ReactNode;
  /** Fallback focus target on close, used when the opener is no longer in the document (QA-17 N4). */
  readonly restoreFocusTo?: () => HTMLElement | null;
  /** "full" (chunk 22, the replay player): the whole viewport on a phone, a wide column on desktop. */
  readonly size?: "full";
}

export function Modal({ title, busy, onCancel, testId, children, actions, restoreFocusTo, size }: ModalProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const bodyId = useId();
  const latest = useRef({ busy, onCancel, restoreFocusTo });
  latest.current = { busy, onCancel, restoreFocusTo };

  useModalFocus(ref, latest);

  return createPortal(
    <div className={size === "full" ? "dialog-backdrop dialog-backdrop--full" : "dialog-backdrop"} data-testid={testId} onClick={() => !latest.current.busy && latest.current.onCancel()}>
      <div ref={ref} className={size === "full" ? "dialog dialog--full" : "dialog"} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
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
