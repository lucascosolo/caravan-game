/**
 * The point economy for one web: granted / spent / available, which ladder rung the pool
 * is on, and how far the next rung (the only source of points) is.
 */
import type { PoolProgressView, UnlockWebView } from "../../api/types.ts";
import { STRINGS } from "../../strings.ts";

export interface PointsPanelProps {
  readonly web: UnlockWebView;
  readonly progress: PoolProgressView | undefined;
  readonly scopeLine: string;
}

export function PointsPanel({ web, progress, scopeLine }: PointsPanelProps): JSX.Element {
  const w = STRINGS.webs;
  const ladder = progress?.ladder;
  const cells: readonly { key: string; n: number; label: string }[] = [
    { key: "available", n: web.points.available, label: w.lblAvailable },
    { key: "granted", n: web.points.granted, label: w.lblGranted },
    { key: "spent", n: web.points.spent, label: w.lblSpent },
  ];
  return (
    <section aria-label={w.points} data-testid="points-panel">
      <p className="hint">{scopeLine}</p>
      <div className="pointbox">
        {cells.map((c) => (
          <div key={c.key} className="pointbox__cell">
            <span className="pointbox__num" data-testid={`points-${c.key}`}>
              {c.n}
            </span>
            <span className="pointbox__lbl">{c.label}</span>
          </div>
        ))}
      </div>
      {ladder && (
        <p className="hint" data-testid="next-rung">
          {w.ladderLine(ladder.level, ladder.cap)}.{" "}
          {ladder.capped || ladder.pointsToNextRung === null || ladder.nextRungUnlockPoints === null
            ? w.ladderCapped
            : w.nextRung(ladder.pointsToNextRung, ladder.nextRungUnlockPoints)}
        </p>
      )}
    </section>
  );
}
