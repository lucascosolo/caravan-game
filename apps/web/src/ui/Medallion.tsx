/** A round brass / wood / leather medallion button (UI-SYSTEM §8.19): icon buttons, stances, close. */
import { useId } from "react";
import { Icon, cx } from "./Icon.tsx";

export interface MedallionProps {
  readonly label: string;
  readonly icon: string;
  readonly size?: "sm" | "md" | "lg";
  readonly material?: "wood" | "brass" | "leather";
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly badge?: number;
  readonly caption?: string;
  readonly className?: string;
  readonly onClick?: () => void;
}

export function Medallion({ label, icon, size = "md", material = "wood", pressed, disabled = false, disabledReason, badge, caption, className, onClick }: MedallionProps): JSX.Element {
  const reasonId = useId();
  const showReason = disabled && disabledReason !== undefined;
  const button = (
    <button
      type="button"
      className={cx("cv-medal", size !== "md" && `cv-medal--${size}`, material !== "wood" && `cv-medal--${material}`, pressed && "is-on", !caption && className)}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : pressed}
      aria-describedby={showReason ? reasonId : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} off={disabled} />
      {badge !== undefined && <span className="cv-badge">{badge}</span>}
    </button>
  );
  const reason = showReason && (
    <span id={reasonId} className="cv-reason">
      {disabledReason}
    </span>
  );
  if (!caption) {
    return reason ? (
      <span className="cv-btn-wrap">
        {button}
        {reason}
      </span>
    ) : (
      button
    );
  }
  return (
    <span className={cx("cv-medlab", pressed && "is-on", className)}>
      {button}
      <span className="cv-medlab__word" aria-hidden="true">
        {caption}
      </span>
      {reason}
    </span>
  );
}
