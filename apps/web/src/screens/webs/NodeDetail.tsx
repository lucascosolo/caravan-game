/**
 * The bottom sheet for a selected node: what it grants (kind, flavor, the full stat block,
 * locked or not), its cost, prerequisites, state, and — only when the SERVER says the node
 * is affordable — the unlock button that opens the confirm step. The copy says "access"
 * every time: unlocking never hands over an instance, and the reached-state line says
 * where the type is actually used (recruit in town / deploy in the circle / add to the
 * party) per kind (QA-06 S6).
 *
 * Focus (QA-06 S4): opening the sheet, or switching it to another node, moves focus to its
 * heading so the change is announced and the next Tab lands inside it; closing it returns
 * focus to that node's card in the graph.
 */
import { useEffect, useRef } from "react";
import type { UnlockNodeView } from "../../api/types.ts";
import { STRINGS } from "../../strings.ts";
import { AffinityIcon } from "./AffinityIcon.tsx";
import { describeType, displayNameOf } from "./catalogue.ts";
import { StateBadge, lockedReason, nodeState } from "./NodeCard.tsx";

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
    <aside className="sheet" role="region" aria-label={w.detailsFor(granted.displayName)} data-testid="node-detail">
      <div className="sheet__head">
        <h2 ref={headingRef} tabIndex={-1} className="sheet__title">
          {granted.displayName}
        </h2>
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
      <p>{state === "reached" ? w.accessGranted(granted.kind) : w.accessNote}</p>

      <h3 className="sheet__subtitle">
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
