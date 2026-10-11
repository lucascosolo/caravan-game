/**
 * The web as a DAG: one row per tier (tier 0, the free starting nodes, at the top; the
 * capstone at the bottom, so it reads top-down in portrait), nodes in authored order
 * within a row, and prerequisite edges drawn in an SVG overlay from measured card
 * positions. The layout is a pure function of the authored node list, so it is identical
 * on every load for every player (chunk 06 DoD: stable across sessions and reloads).
 *
 * The grid here is a layout convenience for this screen only; it has nothing to do with
 * the battlefield placement lattice.
 */
import { useLayoutEffect, useRef, useState } from "react";
import type { UnlockNodeView, UnlockWebView } from "../../api/types.ts";
import { STRINGS } from "../../strings.ts";
import { NodeCard } from "./NodeCard.tsx";

interface Edge {
  readonly from: string;
  readonly to: string;
  readonly met: boolean;
  readonly d: string;
}

export function tiersOf(nodes: readonly UnlockNodeView[]): readonly (readonly UnlockNodeView[])[] {
  const maxTier = nodes.reduce((m, n) => Math.max(m, n.tier), 0);
  const rows: UnlockNodeView[][] = Array.from({ length: maxTier + 1 }, () => []);
  for (const n of nodes) rows[n.tier]!.push(n);
  return rows.filter((r) => r.length > 0);
}

export interface WebGraphProps {
  readonly web: UnlockWebView;
  readonly selectedId: string | null;
  readonly onSelect: (nodeId: string) => void;
}

export function WebGraph({ web, selectedId, onSelect }: WebGraphProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState<readonly Edge[]>([]);
  const reached = new Set(web.nodes.filter((n) => n.reached).map((n) => n.id));

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = (): void => {
      const box = container.getBoundingClientRect();
      const pos = new Map<string, { x: number; top: number; bottom: number }>();
      container.querySelectorAll<HTMLElement>("[data-node-id]").forEach((el) => {
        const r = el.getBoundingClientRect();
        pos.set(el.dataset["nodeId"] ?? "", { x: r.left - box.left + r.width / 2, top: r.top - box.top, bottom: r.bottom - box.top });
      });
      const next: Edge[] = [];
      for (const n of web.nodes) {
        const to = pos.get(n.id);
        if (!to) continue;
        for (const req of n.requires) {
          const from = pos.get(req);
          if (!from) continue;
          const midY = (from.bottom + to.top) / 2;
          next.push({
            from: req,
            to: n.id,
            met: reached.has(req),
            d: `M ${from.x} ${from.bottom} C ${from.x} ${midY}, ${to.x} ${midY}, ${to.x} ${to.top}`,
          });
        }
      }
      setEdges(next);
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(container);
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
    // Re-measure whenever the node list (and so the reached set) changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [web]);

  return (
    <div className="graph" ref={containerRef} role="group" aria-label={STRINGS.webs.graphLabel(STRINGS.webs.poolName(web.pool))}>
      <svg className="graph__edges" aria-hidden="true" focusable="false">
        {edges.map((e) => (
          <path key={`${e.from}->${e.to}`} className={`graph__edge${e.met ? " graph__edge--met" : ""}`} d={e.d} />
        ))}
      </svg>
      {tiersOf(web.nodes).map((row) => (
        <div key={row[0]!.tier} className="graph__tier" data-tier={row[0]!.tier}>
          <span className="graph__tierlabel">{STRINGS.webs.tier(row[0]!.tier)}</span>
          {row.map((n) => (
            <NodeCard key={n.id} node={n} available={web.points.available} selected={selectedId === n.id} onSelect={onSelect} />
          ))}
        </div>
      ))}
    </div>
  );
}
