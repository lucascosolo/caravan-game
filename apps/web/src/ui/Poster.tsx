/** The wanted poster (UI-SYSTEM §8.14): deckled, stained, two nails. */
import type { ReactNode } from "react";
import { cx } from "./Icon.tsx";

export interface PosterProps {
  readonly kicker: ReactNode;
  readonly title: ReactNode;
  readonly flavour?: ReactNode;
  readonly plaque?: ReactNode;
  readonly bounty?: ReactNode;
  readonly className?: string;
  readonly children?: ReactNode;
}

export function Poster({ kicker, title, flavour, plaque, bounty, className, children }: PosterProps): JSX.Element {
  return (
    <article className={cx("cv-poster", className)}>
      {plaque !== undefined && <span className="cv-plaque cv-poster__plaque">{plaque}</span>}
      <span className="cv-sheet__kicker">{kicker}</span>
      <h3 className="cv-poster__title">{title}</h3>
      {flavour !== undefined && <p className="cv-poster__flavour">{flavour}</p>}
      {children}
      {bounty !== undefined && (
        <span className="cv-reward cv-poster__bounty">
          <span className="cv-reward__in">{bounty}</span>
        </span>
      )}
    </article>
  );
}
