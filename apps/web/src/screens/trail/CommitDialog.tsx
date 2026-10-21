/**
 * The commit confirmation (chunk 08): the kit Sheet in question mode, whose useModalFocus is the
 * real modal (focus trapped, the app shell `inert`, Escape cancels, focus given back: QA S6).
 *
 * It itemizes exactly what will stand: every fence run, the open positions (as a count,
 * never a warning), every trap laid and the ones held back BY NAME, the fence material
 * left in the wagon, every post with its stance, and any living unit not yet posted (QA S7).
 * Before it offers Commit, the screen has the server check the arrangement (`check`): if
 * the server refuses it, its issues are shown here and Commit stays disabled — the
 * server's verdict, not the client's.
 */
import { getFenceTier, getTrapType, getUnitType } from "@caravan/content";
import type { Formation, Manifest } from "@caravan/circle";
import { useId } from "react";
import type { IssueView } from "../../api/types.ts";
import { humanizeIssue } from "../../shell/issues.ts";
import { STRINGS } from "../../strings.ts";
import { Button } from "../../ui/Button.tsx";
import { Sheet } from "../../ui/Sheet.tsx";
import { Toast } from "../../ui/Toast.tsx";
import { fenceBudget, fenceRuns, fencesBySide, itemize, unplacedTraps, unpostedUnits } from "./placement.ts";

const T = STRINGS.trail;

export type CommitCheck = { readonly state: "checking" } | { readonly state: "ok" } | { readonly state: "refused"; readonly issues: readonly IssueView[] };

export interface CommitDialogProps {
  readonly manifest: Manifest;
  readonly formation: Formation;
  readonly gaps: number;
  readonly busy: boolean;
  readonly check: CommitCheck;
  readonly names: ReadonlyMap<string, string>;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

export function CommitDialog({ manifest, formation, gaps, busy, check, names, onConfirm, onCancel }: CommitDialogProps): JSX.Element {
  const items = itemize(manifest, formation);
  const runs = fenceRuns(formation)
    .map((r) => (r.from === r.to ? `#${r.from}` : `#${r.from}–${r.to}`))
    .join(", ");
  const held = unplacedTraps(manifest, formation);
  const unposted = unpostedUnits(manifest, formation);
  const left = fenceBudget(manifest, formation).remaining;
  const nameOf = (ref: string): string => names.get(ref) ?? T.unknownThing;
  const name = (kind: "fence" | "trap" | "post", typeId: string): string =>
    (kind === "fence" ? getFenceTier(typeId)?.displayName : kind === "trap" ? getTrapType(typeId)?.displayName : getUnitType(typeId)?.displayName) ?? T.unknownThing;
  const canCommit = !busy && check.state === "ok";
  const summaryId = useId();
  return (
    <Sheet
      title={T.confirmTitle}
      question
      busy={busy}
      onClose={onCancel}
      testId="commit-dialog"
      describedBy={summaryId}
      footer={
        <div className="fm-pair">
          <Button disabled={busy} onClick={onCancel}>
            {T.confirmNo}
          </Button>
          <Button variant="primary" hold icon="wheel" disabled={!canCommit} onClick={onConfirm} testId="commit-confirm">
            {busy ? T.committing : T.confirmYes}
          </Button>
        </div>
      }
    >
      <p>{T.confirmIntro}</p>
      <ul className="plain" id={summaryId}>
        <li>{formation.fences.length === 0 ? T.confirmFencesNone : T.confirmFences(formation.fences.length, runs)}</li>
        {/* Final play-test review N14: the fence by side, at a glance. */}
        {formation.fences.length > 0 && (
          <li data-testid="commit-by-side">
            {T.confirmBySide(
              fencesBySide(formation)
                .map((s) => T.confirmSide(T.edgeName(s.edge), s.placed, s.open))
                .join(" · "),
            )}
          </li>
        )}
        <li>{T.confirmGaps(gaps)}</li>
        <li>{T.confirmFenceLeft(left)}</li>
        <li>{T.confirmTraps(formation.traps.length)}</li>
        {held.length > 0 && <li data-testid="commit-traps-held">{T.confirmTrapsHeldNames(held.map((t) => nameOf(t.ref)).join(", "))}</li>}
        <li>{T.confirmPosts(formation.posts.length)}</li>
        {unposted.length > 0 && <li data-testid="commit-unposted">{T.confirmUnposted(unposted.map((u) => nameOf(u.ref)).join(", "))}</li>}
      </ul>
      <details className="disclosure" data-testid="commit-items">
        <summary>{T.confirmEveryItem(items.length)}</summary>
        <ul className="plain dialog__items" aria-label={T.confirmIntro}>
          {items.map((it) => (
            <li key={it.ref} data-testid={`commit-item-${it.ref}`}>
              <span className="cv-small">{it.kind === "fence" ? T.kindFence : it.kind === "trap" ? T.kindTrap : T.kindPost}</span> {name(it.kind, it.typeId)} · {it.where}
              {it.detail ? ` · ${it.detail}` : ""}
            </li>
          ))}
        </ul>
      </details>
      {check.state === "checking" && (
        <p className="cv-small" role="status">
          {T.confirmChecking}
        </p>
      )}
      {check.state === "refused" && (
        <Toast tone="error" title={T.confirmRefused} testId="commit-refused">
          <ul className="issues">
            {check.issues.map((i, n) => (
              <li key={`${i.code}-${n}`} data-code={i.code}>
                {humanizeIssue(i, names)}
              </li>
            ))}
          </ul>
        </Toast>
      )}
    </Sheet>
  );
}
