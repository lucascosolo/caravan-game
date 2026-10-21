import type { ReactNode } from "react";
import { Icon } from "../../ui/Icon.tsx";
import { Note } from "../../ui/Note.tsx";
import "./town.css";

/** A refusal on a plate: the cross disc and the words (never colour alone). */
export function ErrorPlate({ heading, testId, children }: { readonly heading?: string; readonly testId?: string; readonly children: ReactNode }): JSX.Element {
  return (
    <div className="cv-error" role="alert" data-testid={testId}>
      <span className="cv-error__plate">
        <Icon name="cross" />
      </span>
      <span className="cv-error__text">
        {heading && <b>{heading}</b>}
        {children}
      </span>
    </div>
  );
}

/** A status line on a nailed note. */
export function StatusNote({ testId, children }: { readonly testId?: string; readonly children: ReactNode }): JSX.Element {
  return (
    <div role="status" data-testid={testId}>
      <Note variant="canvas">{children}</Note>
    </div>
  );
}

export function Meter({ label, fill, over = false }: { readonly label: string; readonly fill: number; readonly over?: boolean }): JSX.Element {
  return (
    <span className={`town-meter${over ? " is-over" : ""}`} role="img" aria-label={label}>
      <span className="town-meter__fill" style={{ width: `${Math.max(0, Math.min(100, fill))}%` }} />
    </span>
  );
}
