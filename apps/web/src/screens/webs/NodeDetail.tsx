/**
 * The detail note for a selected node: what it grants (kind, flavor, the full stat block,
 * locked or not), its cost, prerequisites, state, and — only when the SERVER says the node
 * is affordable — the unlock button that opens the confirm sheet. The copy says "access"
 * every time: unlocking never hands over an instance, and the reached-state line says
 * where the type is actually used (recruit in town / deploy in the circle / add to the
 * party) per kind (QA-06 S6).
 *
 * It stays on the page (not a modal) so the web remains tappable beside it. Focus (QA-06 S4):
 * opening it, or switching it to another node, moves focus to its heading; closing it returns
 * focus to that node's card in the graph.
 */
import { useEffect, useRef } from "react";
import type { UnlockNodeView } from "../../api/types.ts";
import { STRINGS } from "../../strings.ts";
import { Button } from "../../ui/Button.tsx";
import { AffinityIcon } from "./AffinityIcon.tsx";
import { describeType, displayNameOf } from "./catalogue.ts";
import { StateBadge, lockedReason, nodeState } from "./NodeCard.tsx";
import "./webs.css";

export interface NodeDetailProps {
  readonly node: UnlockNodeView;
  readonly onUnlock: (node: UnlockNodeView) => void;
  readonly onClose: () => void;
}

/** The graph card for a node id, if it is on the page. */
export function cardFor(nodeId: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>("[data-node-id]"))) {
    if (el.dataset["nodeId"] === nodeId) return el;
  }
  return null;
}

export function NodeDetail({ node, onUnlock, onClose }: NodeDetailProps): JSX.Element {
  const granted = describeType(node.id);
  const state = nodeState(node);
  const reason = lockedReason(node);
  const w = STRINGS.webs;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const lastNodeId = useRef(node.id);
  lastNodeId.current = node.id;

  useEffect(() => {
    headingRef.current?.focus();
  }, [node.id]);
  useEffect(() => {
    return () => {
      cardFor(lastNodeId.current)?.focus();
    };
  }, []);

  return (
    <aside className="cv-note webs-detail" role="region" aria-label={w.detailsFor(granted.displayName)} data-testid="node-detail">
      <div className="webs-detail__head">
        <h2 ref={headingRef} tabIndex={-1} className="cv-title">
          {granted.displayName}
        </h2>
        <Button variant="tertiary" icon="cross" onClick={onClose}>
          {w.close}
        </Button>
      </div>
      <p className="cv-small">
        {w.tier(node.tier)} · {node.starting ? w.costFree : w.cost(node.cost)} · <StateBadge state={state} />
      </p>
      <p className="cv-small">{node.requires.length === 0 ? w.requiresNone : `${w.requires}: ${node.requires.map(displayNameOf).join(", ")}`}</p>
      {reason && <p className="cv-reason">{reason}</p>}
      <p className="cv-body">{state === "reached" ? w.accessGranted(granted.kind) : w.accessNote}</p>

      <h3 className="cv-label">
        {w.grantsHeading}: {granted.kindLabel}
      </h3>
      {granted.flavor && <p className="cv-small cv-soft">{granted.flavor}</p>}
      {granted.affinity && (
        <p className="cv-small">
          {w.affinity}: <AffinityIcon affinity={granted.affinity} />
        </p>
      )}
      <dl className="cv-stats" aria-label={w.statsHeading}>
        {granted.stats.map((st) => (
          <div key={st.label} className="cv-stat">
            <dt>{st.label}</dt>
            <dd className="cv-num">{st.value}</dd>
          </div>
        ))}
      </dl>

      {state === "affordable" && (
        <Button variant="primary" block icon="coin-pip" onClick={() => onUnlock(node)}>
          {w.unlockButton(granted.displayName, node.cost)}
        </Button>
      )}
    </aside>
  );
}
