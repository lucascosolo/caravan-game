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
import { Icon } from "../../ui/Icon.tsx";
import { Note } from "../../ui/Note.tsx";
import { Pop } from "../../ui/Pop.tsx";

const T = STRINGS.trail;
const side = (e: string): string => T.edgeName(e).toLowerCase();

function nameOf(kind: LeftOut["kind"], typeId: string): string {
  const found = kind === "fence" ? getFenceTier(typeId) : kind === "trap" ? getTrapType(typeId) : getUnitType(typeId);
  return found?.displayName ?? typeId;
}

export function LayoutLeftOutNote({ layout }: { readonly layout: LayoutView }): JSX.Element | null {
  if (layout.unavailable) {
    return (
      <Note testId="layout-unavailable" className="cv-leftout">
        {T.layoutUnavailable}
      </Note>
    );
  }
  if (layout.leftOut.length === 0) return null;
  return (
    <Note testId="layout-left-out" className="cv-leftout fm-leftout">
      <p>{T.layoutLeftOutHeading}</p>
      <ul>
        {layout.leftOut.map((l, i) => (
          <li key={i} data-testid="layout-left-out-item" data-reason={l.reason}>
            {T.layoutLeftOutItem(nameOf(l.kind, l.typeId), side(l.edge), T.layoutReason(l.reason))}
          </li>
        ))}
      </ul>
    </Note>
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
    <div className="fm-hints">
      {hints.map((h) => (
        <div key={keyOf(h)} data-testid="layout-hint" data-hint={keyOf(h)}>
          <Pop tail="top" at={82}>
            <span>{textOf(h, names)}</span>
            <button type="button" className="cv-medal cv-medal--sm" aria-label={T.layoutHintDismiss} data-testid="layout-hint-dismiss" onClick={() => setDismissed((d) => new Set([...d, keyOf(h)]))}>
              <Icon name="cross" />
            </button>
          </Pop>
        </div>
      ))}
    </div>
  );
}
