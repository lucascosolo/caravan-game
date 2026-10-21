/**
 * The bottom sheet (UI-SYSTEM §8.7): torn parchment top with a leather grip, detents peek / half / full.
 * A question that confirms a commit hangs on the title sign; every other sheet heads inside the body.
 * Modal behaviour (inert, focus trap, Escape, focus return) is Modal's, via useModalFocus.
 */
import { useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useModalFocus } from "../shell/useModalFocus.ts";
import { STRINGS } from "../strings.ts";
import { cx } from "./Icon.tsx";
import { Medallion } from "./Medallion.tsx";

export type Detent = "peek" | "half" | "full";
const NEXT: Record<Detent, Detent> = { peek: "half", half: "full", full: "peek" };

export interface SheetProps {
  readonly title: string;
  readonly question?: boolean;
  readonly kicker?: ReactNode;
  readonly detent?: Detent;
  readonly busy?: boolean;
  readonly onClose: () => void;
  readonly footer?: ReactNode;
  readonly testId?: string;
  readonly restoreFocusTo?: () => HTMLElement | null;
  readonly children: ReactNode;
}

export function Sheet({ title, question = false, kicker, detent = "half", busy = false, onClose, footer, testId, restoreFocusTo, children }: SheetProps): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [at, setAt] = useState<Detent>(detent);
  const latest = useRef({ busy, onCancel: onClose, restoreFocusTo });
  latest.current = { busy, onCancel: onClose, restoreFocusTo };
  useModalFocus(ref, latest);

  const close = <Medallion label={STRINGS.ui.close} icon="cross" size="sm" disabled={busy} onClick={onClose} />;
  return createPortal(
    <div className="cv-root cv-sheet-host" data-testid={testId} onClick={() => !latest.current.busy && onClose()}>
      <div ref={ref} className={cx("cv-sheet", `cv-sheet--${at}`)} data-detent={at} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="cv-sheet__rail">
          <button type="button" className="cv-sheet__peg" aria-label={STRINGS.ui.resize} onClick={() => setAt((d) => NEXT[d])} />
        </div>
        {question && (
          <div className="cv-sheet__awning">
            <h2 id={titleId} className="cv-title">
              {title}
            </h2>
            {close}
          </div>
        )}
        <div className="cv-sheet__body">
          {!question && (
            <div className="cv-sheet__head">
              <div>
                {kicker !== undefined && <span className="cv-sheet__kicker">{kicker}</span>}
                <h2 id={titleId} className="cv-title">
                  {title}
                </h2>
              </div>
              {close}
            </div>
          )}
          {children}
        </div>
        {footer !== undefined && <div className="cv-sheet__foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
