/**
 * The unlock confirm step as a kit Sheet whose question hangs on the title sign. Nothing is sent to the
 * server until `onConfirm` fires. Modal behaviour (inert page, focus trap, Escape, focus return) is the
 * Sheet's; this opens on Cancel (the safe choice) and the dialog is described by the body text.
 */
import { useEffect, useId, useRef } from "react";
import { Button } from "../../ui/Button.tsx";
import { Sheet } from "../../ui/Sheet.tsx";

export interface ConfirmDialogProps {
  readonly title: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly restoreFocusTo?: () => HTMLElement | null;
}

export function ConfirmDialog(p: ConfirmDialogProps): JSX.Element {
  const bodyId = useId();
  const bodyRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    const sheet = bodyRef.current?.closest<HTMLElement>("[role=dialog]");
    sheet?.setAttribute("aria-describedby", bodyId);
    sheet?.querySelector<HTMLElement>("[data-testid=confirm-cancel]")?.focus();
  }, [bodyId]);
  return (
    <Sheet
      title={p.title}
      question
      busy={p.busy}
      onClose={p.onCancel}
      testId="unlock-confirm"
      {...(p.restoreFocusTo ? { restoreFocusTo: p.restoreFocusTo } : {})}
      footer={
        <>
          <Button variant="secondary" testId="confirm-cancel" disabled={p.busy} onClick={p.onCancel}>
            {p.cancelLabel}
          </Button>
          <Button variant="primary" busy={p.busy} onClick={p.onConfirm}>
            {p.confirmLabel}
          </Button>
        </>
      }
    >
      <p id={bodyId} ref={bodyRef} className="cv-body">
        {p.body}
      </p>
    </Sheet>
  );
}
