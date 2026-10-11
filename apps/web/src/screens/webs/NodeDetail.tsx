/**
 * The bottom sheet for a selected node: what it grants (kind, flavor, the full stat block,
 * locked or not), its cost, prerequisites, state, and — only when the SERVER says the node
 * is affordable — the unlock button that opens the confirm step. The copy says "access"
 * every time: unlocking never hands over an instance.
 */
import type { UnlockNodeView } from "../../api/types.ts";
import { STRINGS } from "../../strings.ts";
import { AffinityIcon } from "./AffinityIcon.tsx";
import { describeType, displayNameOf } from "./catalogue.ts";
import { StateBadge, lockedReason, nodeState } from "./NodeCard.tsx";

export interface NodeDetailProps {
  readonly node: UnlockNodeView;
  readonly available: number;
  readonly onUnlock: (node: UnlockNodeView) => void;
  readonly onClose: () => void;
}

export function NodeDetail({ node, available, onUnlock, onClose }: NodeDetailProps): JSX.Element {
  const granted = describeType(node.id);
  const state = nodeState(node);
  const reason = lockedReason(node, available);
  const w = STRINGS.webs;
  return (
    <aside className="sheet" role="region" aria-label={w.detailsFor(granted.displayName)} data-testid="node-detail">
      <div className="sheet__head">
        <h2 style={{ margin: 0 }}>{granted.displayName}</h2>
        <button type="button" className="btn" onClick={onClose}>
          {w.close}
        </button>
      </div>
      <p className="hint">
        {w.tier(node.tier)} · {node.starting ? w.costFree : w.cost(node.cost)} · <StateBadge state={state} />
      </p>
      <p className="hint">
        {node.requires.length === 0 ? w.requiresNone : `${w.requires}: ${node.requires.map(displayNameOf).join(", ")}`}
        {reason ? ` — ${reason}` : ""}
      </p>
      <p>{state === "reached" ? w.accessGranted : w.accessNote}</p>

      <h3 style={{ fontSize: 15, margin: "12px 0 4px" }}>
        {w.grantsHeading}: {granted.kindLabel}
      </h3>
      {granted.flavor && <p className="flavor">{granted.flavor}</p>}
      {granted.affinity && (
        <p>
          {w.affinity}: <AffinityIcon affinity={granted.affinity} />
        </p>
      )}
      <dl className="statlist" aria-label={w.statsHeading}>
        {granted.stats.map((s) => (
          <div key={s.label} style={{ display: "contents" }}>
            <dt>{s.label}</dt>
            <dd>{s.value}</dd>
          </div>
        ))}
      </dl>

      {state === "affordable" && (
        <button type="button" className="btn btn--primary btn--block" onClick={() => onUnlock(node)}>
          {w.unlockButton(granted.displayName, node.cost)}
        </button>
      )}
    </aside>
  );
}
