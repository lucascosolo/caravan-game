/**
 * One node of the web as a tappable card: name, tier, exact cost, prerequisites by name,
 * and the server's state for it. State is carried by a word AND an icon AND the border
 * style; colour is the third cue, never the only one.
 */
import type { UnlockNodeView } from "../../api/types.ts";
import { STRINGS } from "../../strings.ts";
import { AffinityIcon } from "./AffinityIcon.tsx";
import { describeType, displayNameOf } from "./catalogue.ts";

export type NodeState = "reached" | "affordable" | "locked";

export function nodeState(node: UnlockNodeView): NodeState {
  if (node.reached) return "reached";
  if (node.affordable) return "affordable";
  return "locked";
}

const STATE_ICON: Record<NodeState, string> = { reached: "✓", affordable: "→", locked: "⊘" };

export function stateLabel(state: NodeState): string {
  return state === "reached" ? STRINGS.webs.stateReached : state === "affordable" ? STRINGS.webs.stateAffordable : STRINGS.webs.stateLocked;
}

/** Why a node is locked, in the server's terms: unmet prerequisites first, then points. */
export function lockedReason(node: UnlockNodeView, available: number): string | null {
  if (node.reached || node.affordable) return null;
  if (node.missing.length > 0) return STRINGS.webs.lockedMissing(node.missing.map(displayNameOf).join(", "));
  if (node.cost > available) return STRINGS.webs.lockedShort(node.cost - available);
  return STRINGS.webs.stateLocked;
}

export function StateBadge({ state }: { state: NodeState }): JSX.Element {
  return (
    <span className="node__state" data-state={state}>
      <span className="state-icon" aria-hidden="true">
        {STATE_ICON[state]}
      </span>
      <span>{stateLabel(state)}</span>
    </span>
  );
}

export interface NodeCardProps {
  readonly node: UnlockNodeView;
  readonly available: number;
  readonly selected: boolean;
  readonly onSelect: (nodeId: string) => void;
}

export function NodeCard({ node, available, selected, onSelect }: NodeCardProps): JSX.Element {
  const granted = describeType(node.id);
  const state = nodeState(node);
  const reason = lockedReason(node, available);
  return (
    <button
      type="button"
      className={`node node--${state}`}
      data-node-id={node.id}
      data-state={state}
      aria-pressed={selected}
      aria-label={`${granted.displayName}, ${node.starting ? STRINGS.webs.costFree : STRINGS.webs.cost(node.cost)}, ${stateLabel(state)}`}
      onClick={() => onSelect(node.id)}
    >
      <span className="node__name">{granted.displayName}</span>
      {granted.affinity && <AffinityIcon affinity={granted.affinity} />}
      <span className="node__cost">{node.starting ? STRINGS.webs.costFree : STRINGS.webs.cost(node.cost)}</span>
      <StateBadge state={state} />
      <span className="node__req">
        {node.requires.length === 0 ? STRINGS.webs.requiresNone : `${STRINGS.webs.requires}: ${node.requires.map(displayNameOf).join(", ")}`}
      </span>
      {reason && <span className="node__req">{reason}</span>}
    </button>
  );
}
