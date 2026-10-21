/** The HUD rope with hanging resource chips (UI-SYSTEM §8.6). */
import type { ReactNode } from "react";
import { STRINGS } from "../strings.ts";
import { Icon, cx } from "./Icon.tsx";

export function ChipStrap({ label = STRINGS.ui.resources, children, end }: { readonly label?: string; readonly children: ReactNode; readonly end?: ReactNode }): JSX.Element {
  return (
    <header className="cv-hud" aria-label={label}>
      {children}
      {end !== undefined && (
        <>
          <span className="cv-hud__spacer" />
          {end}
        </>
      )}
    </header>
  );
}

export interface ChipProps {
  readonly kind?: "disc" | "purse" | "badge" | "vault" | "risk";
  readonly icon: string;
  readonly label: string;
  readonly value: ReactNode;
  readonly caption?: ReactNode;
  readonly testId?: string;
}

export function Chip({ kind = "disc", icon, label, value, caption, testId }: ChipProps): JSX.Element {
  const num = <span className="cv-num">{value}</span>;
  return (
    <div className={cx("cv-chip", kind !== "disc" && `cv-chip--${kind}`)} data-testid={testId}>
      <Icon name={icon} />
      <span className="cv-sr">{label} </span>
      {caption === undefined ? (
        num
      ) : (
        <span className="cv-chip__stack">
          {num}
          <span className="cv-chip__cap">{caption}</span>
        </span>
      )}
    </div>
  );
}
