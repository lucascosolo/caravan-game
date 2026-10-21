/** A nailed paper slip (UI-SYSTEM §8.8): toasts are polite; an error is a nailed note with a rose disc. */
import type { ReactNode } from "react";
import { STRINGS } from "../strings.ts";
import { Icon, cx } from "./Icon.tsx";
import { Medallion } from "./Medallion.tsx";

export interface ToastProps {
  readonly tone?: "info" | "ok" | "error";
  readonly title?: ReactNode;
  readonly icon?: string;
  readonly onDismiss?: () => void;
  readonly className?: string;
  readonly testId?: string;
  readonly children?: ReactNode;
}

export function Toast({ tone = "info", title, icon, onDismiss, className, testId, children }: ToastProps): JSX.Element {
  const dismiss = onDismiss && <Medallion label={STRINGS.ui.dismiss} icon="cross" size="sm" onClick={onDismiss} />;
  if (tone === "error") {
    return (
      <div className={cx("cv-error", className)} role="alert" data-testid={testId}>
        <span className="cv-error__plate">
          <Icon name={icon ?? "cross"} />
        </span>
        <span className="cv-error__text">
          {title !== undefined && <b>{title}</b>}
          {children}
        </span>
        {dismiss}
      </div>
    );
  }
  return (
    <div className={cx("cv-toast", className)} role="status" data-testid={testId}>
      <Icon name={icon ?? (tone === "ok" ? "tick" : "info")} />
      <span className="cv-toast__text">
        {title !== undefined && <b>{title} </b>}
        {children}
      </span>
      {dismiss}
    </div>
  );
}
