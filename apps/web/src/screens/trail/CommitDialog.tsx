/**
 * The commit confirmation (chunk 08): a REAL modal (chunk 06 QA convention) — focus is
 * trapped inside, the app shell is `inert` while it is open, focus returns to the opener
 * on close, Escape cancels, and the body is the dialog's `aria-describedby`. It itemizes
 * exactly what will stand: every fence run and the open positions (as a count, never a
 * warning), every trap laid and how many are held back, every post with its stance.
 */
import { getFenceTier, getTrapType, getUnitType } from "@caravan/content";
import type { Formation, Manifest } from "@caravan/circle";
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { STRINGS } from "../../strings.ts";
import { fenceRuns, itemize, unplacedTraps } from "./placement.ts";

const T = STRINGS.trail;
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface CommitDialogProps {
  readonly manifest: Manifest;
  readonly formation: Formation;
  readonly gaps: number;
  readonly busy: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** Everything outside the dialog becomes inert while it is open; the opener gets focus back after. */
function useModal(onCancel: () => void): React.RefObject<HTMLDivElement> {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    const siblings = Array.from(document.body.children).filter((el) => el !== dialog?.parentElement && el.tagName !== "SCRIPT");
    for (const el of siblings) el.setAttribute("inert", "");
    const first = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? dialog)?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const firstEl = items[0]!;
      const lastEl = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      for (const el of siblings) el.removeAttribute("inert");
      opener?.focus?.();
    };
  }, [onCancel]);
  return ref;
}

export function CommitDialog({ manifest, formation, gaps, busy, onConfirm, onCancel }: CommitDialogProps): JSX.Element {
  const ref = useModal(onCancel);
  const titleId = useId();
  const bodyId = useId();
  const items = itemize(manifest, formation);
  const runs = fenceRuns(formation)
    .map((r) => (r.from === r.to ? `#${r.from}` : `#${r.from}–${r.to}`))
    .join(", ");
  const held = unplacedTraps(manifest, formation).length;
  const name = (kind: "fence" | "trap" | "post", typeId: string): string =>
    kind === "fence" ? (getFenceTier(typeId)?.displayName ?? typeId) : kind === "trap" ? (getTrapType(typeId)?.displayName ?? typeId) : (getUnitType(typeId)?.displayName ?? typeId);
  // A portal into <body>: the backdrop is then a sibling of #root, so `useModal` can make the
  // whole shell inert without touching the dialog.
  return createPortal(
    <div className="dialog-backdrop" data-testid="commit-dialog">
      <div ref={ref} className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={bodyId} tabIndex={-1}>
        <h2 id={titleId} style={{ marginTop: 0 }}>
          {T.confirmTitle}
        </h2>
        <div id={bodyId}>
          <p>{T.confirmIntro}</p>
          <ul className="plain">
            <li>{formation.fences.length === 0 ? T.confirmFencesNone : T.confirmFences(formation.fences.length, runs)}</li>
            <li>{T.confirmGaps(gaps)}</li>
            <li>
              {T.confirmTraps(formation.traps.length)}
              {held > 0 ? ` · ${T.confirmTrapsHeld(held)}` : ""}
            </li>
            <li>{T.confirmPosts(formation.posts.length)}</li>
          </ul>
          <ul className="plain dialog__items" aria-label={T.confirmIntro}>
            {items.map((it) => (
              <li key={it.ref} data-testid={`commit-item-${it.ref}`}>
                <span className="hint">{it.kind === "fence" ? T.kindFence : it.kind === "trap" ? T.kindTrap : T.kindPost}</span> {name(it.kind, it.typeId)} · {it.where}
                {it.detail ? ` · ${it.detail}` : ""}
              </li>
            ))}
          </ul>
        </div>
        <div className="dialog__actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {T.confirmNo}
          </button>
          <button type="button" className="btn btn--primary" onClick={onConfirm} disabled={busy} data-testid="commit-confirm">
            {busy ? T.committing : T.confirmYes}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
