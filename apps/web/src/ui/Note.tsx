/** A deckled note nailed at the top (UI-SYSTEM §4.2 paper): offers on the town scene, notices. */
import type { ReactNode } from "react";
import { cx } from "./Icon.tsx";

export interface NoteProps {
  readonly title?: string;
  readonly variant?: "paper" | "canvas" | "shade";
  readonly nail?: "iron" | "brass";
  readonly className?: string;
  readonly testId?: string;
  readonly children: ReactNode;
}

export function Note({ title, variant = "paper", nail = "iron", className, testId, children }: NoteProps): JSX.Element {
  const cls = cx("cv-note", variant !== "paper" && `cv-note--${variant}`, nail === "brass" && "cv-note--brass-nail", className);
  if (title === undefined) {
    return (
      <div className={cls} data-testid={testId}>
        {children}
      </div>
    );
  }
  return (
    <section className={cls} aria-label={title} data-testid={testId}>
      <div className="cv-label">{title}</div>
      {children}
    </section>
  );
}
