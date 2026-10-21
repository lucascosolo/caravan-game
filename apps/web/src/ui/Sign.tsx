/** A sawn plank hung on chain or rope (UI-SYSTEM §8.18): building names, screen titles, "Closed". */
import type { ReactNode } from "react";
import { cx } from "./Icon.tsx";

export interface SignProps {
  readonly children: ReactNode;
  readonly variant?: "chain" | "rope" | "dark" | "title" | "nailed";
  readonly onClick?: () => void;
  readonly badge?: number;
  readonly badgeLabel?: string;
  readonly className?: string;
  readonly testId?: string;
}

export function Sign({ children, variant = "chain", onClick, badge, badgeLabel, className, testId }: SignProps): JSX.Element {
  const cls = cx("cv-sign", variant !== "chain" && `cv-sign--${variant}`, className);
  const inner = (
    <>
      {children}
      {badge !== undefined && (
        <span className="cv-badge" aria-hidden={badgeLabel ? "true" : undefined}>
          {badge}
        </span>
      )}
      {badgeLabel && <span className="cv-sr"> ({badgeLabel})</span>}
    </>
  );
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} data-testid={testId}>
      {inner}
    </button>
  ) : (
    <span className={cls} data-testid={testId}>
      {inner}
    </span>
  );
}
