/** A pointing pop-up (UI-SYSTEM §8.8): a parchment bubble whose tail points at what it describes. */
import type { CSSProperties, ReactNode } from "react";
import { cx } from "./Icon.tsx";

export interface PopProps {
  readonly tail?: "top" | "bottom" | "left" | "right";
  /** Where along that side the tail sits, in percent. */
  readonly at?: number;
  readonly who?: ReactNode;
  readonly id?: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  readonly children: ReactNode;
}

export function Pop({ tail = "bottom", at, who, id, className, style, children }: PopProps): JSX.Element {
  const s = at === undefined ? style : ({ ...style, "--at": `${at}%` } as CSSProperties);
  return (
    <div id={id} className={cx("cv-pop", `cv-pop--tail-${tail}`, className)} style={s}>
      <span>
        {who !== undefined && <span className="cv-pop__who">{who}</span>}
        {children}
      </span>
    </div>
  );
}
