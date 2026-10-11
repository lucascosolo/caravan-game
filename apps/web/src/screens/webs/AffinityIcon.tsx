/**
 * Affinity categories are told apart by SHAPE and a word, never colour alone
 * (PHASE-2 §35): grit = square, powder = triangle, beast = circle.
 */
import type { AffinityCategory } from "@caravan/content";
import { STRINGS } from "../../strings.ts";

const SHAPES: Record<AffinityCategory, JSX.Element> = {
  grit: <rect x="1" y="1" width="10" height="10" />,
  powder: <polygon points="6,0.5 11.5,11.5 0.5,11.5" />,
  beast: <circle cx="6" cy="6" r="5.5" />,
};

export function AffinityIcon({ affinity }: { affinity: AffinityCategory }): JSX.Element {
  const name = STRINGS.webs.affinityName(affinity);
  return (
    <span className="affinity" data-affinity={affinity}>
      <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        {SHAPES[affinity]}
      </svg>
      <span>{name}</span>
    </span>
  );
}
