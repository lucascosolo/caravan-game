/**
 * Chunk 51: what the formation screen says about the loaded layout. The left-out note lists every
 * piece the load could not place, with why, and never fades (GUARDRAILS §4). Hints are information
 * about the current formation against this scout: each is dismissible for this encounter (page
 * state only), none blocks lock-in, none edits anything.
 */
import { layoutHints, type Formation, type GuideScoutLike, type LayoutHint, type LeftOut } from "@caravan/circle";
import { getFenceTier, getTrapType, getUnitType } from "@caravan/content";
import { useState, type JSX } from "react";
import type { LayoutView } from "../../api/types.ts";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.trail;
const side = (e: string): string => T.edgeName(e).toLowerCase();

function nameOf(kind: LeftOut["kind"], typeId: string): string {
  const found = kind === "fence" ? getFenceTier(typeId) : kind === "trap" ? getTrapType(typeId) : getUnitType(typeId);
  return found?.displayName ?? typeId;
}

export function LayoutLeftOutNote({ layout }: { readonly layout: LayoutView }): JSX.Element | null {
  if (layout.unavailable) {
    return (
      <p className="notice" data-testid="layout-unavailable">
        {T.layoutUnavailable}
      </p>
    );
  }
  if (layout.leftOut.length === 0) return null;
  return (
    <section className="notice" data-testid="layout-left-out">
      <p>{T.layoutLeftOutHeading}</p>
      <ul>
        {layout.leftOut.map((l, i) => (
          <li key={i} data-testid="layout-left-out-item" data-reason={l.reason}>
            {T.layoutLeftOutItem(nameOf(l.kind, l.typeId), side(l.edge), T.layoutReason(l.reason))}
          </li>
        ))}
      </ul>
    </section>
  );
}

const keyOf = (h: LayoutHint): string => (h.code === "trap_unused_side" ? `trap_unused_side:${h.ref}` : h.code);

function textOf(h: LayoutHint, names: ReadonlyMap<string, string>): string {
  const list = (es: readonly string[]) => es.map(side).join(" and ");
  if (h.code === "gap_faces_main") return T.layoutHintGap(side(h.edge), h.raiders, h.total);
  if (h.code === "trap_unused_side") return T.layoutHintTrap(names.get(h.ref) ?? h.ref, side(h.edge));
  return T.layoutHintDirection(list(h.was), list(h.now));
}

export function LayoutHints({ layout, formation, scout, names }: { readonly layout: LayoutView; readonly formation: Formation; readonly scout: GuideScoutLike; readonly names: ReadonlyMap<string, string> }): JSX.Element | null {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  if (!layout.hintsOn || layout.unavailable) return null;
  const hints = layoutHints(formation, scout, layout.savedSides).filter((h) => !dismissed.has(keyOf(h)));
  if (hints.length === 0) return null;
  return (
    <div className="layout-hints">
      {hints.map((h) => (
        <p key={keyOf(h)} className="hint" data-testid="layout-hint" data-hint={keyOf(h)}>
          {textOf(h, names)}{" "}
          <button type="button" className="btn btn--small" data-testid="layout-hint-dismiss" onClick={() => setDismissed((d) => new Set([...d, keyOf(h)]))}>
            {T.layoutHintDismiss}
          </button>
        </p>
      ))}
    </div>
  );
}
