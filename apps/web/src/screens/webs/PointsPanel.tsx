/**
 * The point economy for one web: granted / spent / available, which ladder rung the pool
 * is on, and how far the next rung (the only source of points) is.
 */
import type { PoolProgressView, UnlockWebView } from "../../api/types.ts";
import { STRINGS } from "../../strings.ts";
import { Chip } from "../../ui/ChipStrap.tsx";
import { Note } from "../../ui/Note.tsx";

export interface PointsPanelProps {
  readonly web: UnlockWebView;
  readonly progress: PoolProgressView | undefined;
  readonly scopeLine: string;
}

export function PointsPanel({ web, progress, scopeLine }: PointsPanelProps): JSX.Element {
  const w = STRINGS.webs;
  const ladder = progress?.ladder;
  const cells: readonly { key: string; n: number; label: string; icon: string; kind: "purse" | "badge" | "disc" }[] = [
    { key: "available", n: web.points.available, label: w.lblAvailable, icon: "coin-pip", kind: "purse" },
    { key: "granted", n: web.points.granted, label: w.lblGranted, icon: "tag", kind: "badge" },
    { key: "spent", n: web.points.spent, label: w.lblSpent, icon: "padlock", kind: "disc" },
  ];
  return (
    <section aria-label={w.points} data-testid="points-panel">
      <span className="cv-plaque webs-scope">{scopeLine}</span>
      <div className="webs-chips">
        {cells.map((c) => (
          <div key={c.key} className="webs-chipcell">
            <Chip kind={c.kind} icon={c.icon} label={c.label} value={<span data-testid={`points-${c.key}`}>{c.n}</span>} />
            <span className="cv-small" aria-hidden="true">{c.label}</span>
          </div>
        ))}
      </div>
      {ladder && (
        <Note variant="shade" nail="brass">
          <p className="cv-small" data-testid="next-rung">
            {w.ladderLine(ladder.level, ladder.cap)}.{" "}
            {ladder.capped || ladder.pointsToNextRung === null || ladder.nextRungUnlockPoints === null
              ? w.ladderCapped
              : w.nextRung(ladder.pointsToNextRung, ladder.nextRungUnlockPoints)}
          </p>
        </Note>
      )}
    </section>
  );
}
