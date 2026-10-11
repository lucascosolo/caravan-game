/**
 * The commit confirmation (chunk 08): the shell's REAL modal (shell/Modal.tsx — focus
 * trapped, the app shell `inert`, Escape cancels, the opener captured ONCE and given focus
 * back, callbacks read through a ref so a re-render never re-runs the focus logic: QA S6).
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
import type { IssueView } from "../../api/types.ts";
import { Modal } from "../../shell/Modal.tsx";
import { humanizeIssue } from "../../shell/issues.ts";
import { STRINGS } from "../../strings.ts";
import { fenceBudget, fenceRuns, itemize, unplacedTraps, unpostedUnits } from "./placement.ts";

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
  return (
    <Modal
      title={T.confirmTitle}
      busy={busy}
      onCancel={onCancel}
      testId="commit-dialog"
      actions={
        <>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            {T.confirmNo}
          </button>
          <button type="button" className="btn btn--primary" onClick={onConfirm} disabled={!canCommit} data-testid="commit-confirm">
            {busy ? T.committing : T.confirmYes}
          </button>
        </>
      }
    >
      <p>{T.confirmIntro}</p>
      <ul className="plain">
        <li>{formation.fences.length === 0 ? T.confirmFencesNone : T.confirmFences(formation.fences.length, runs)}</li>
        <li>{T.confirmGaps(gaps)}</li>
        <li>{T.confirmFenceLeft(left)}</li>
        <li>{T.confirmTraps(formation.traps.length)}</li>
        {held.length > 0 && <li data-testid="commit-traps-held">{T.confirmTrapsHeldNames(held.map((t) => nameOf(t.ref)).join(", "))}</li>}
        <li>{T.confirmPosts(formation.posts.length)}</li>
        {unposted.length > 0 && <li data-testid="commit-unposted">{T.confirmUnposted(unposted.map((u) => nameOf(u.ref)).join(", "))}</li>}
      </ul>
      <ul className="plain dialog__items" aria-label={T.confirmIntro}>
        {items.map((it) => (
          <li key={it.ref} data-testid={`commit-item-${it.ref}`}>
            <span className="hint">{it.kind === "fence" ? T.kindFence : it.kind === "trap" ? T.kindTrap : T.kindPost}</span> {name(it.kind, it.typeId)} · {it.where}
            {it.detail ? ` · ${it.detail}` : ""}
          </li>
        ))}
      </ul>
      {check.state === "checking" && (
        <p className="hint" role="status">
          {T.confirmChecking}
        </p>
      )}
      {check.state === "refused" && (
        <div className="error" role="alert" data-testid="commit-refused">
          <div>{T.confirmRefused}</div>
          <ul className="issues">
            {check.issues.map((i, n) => (
              <li key={`${i.code}-${n}`}>
                {humanizeIssue(i, names)} <span className="error__code">{T.issueCode(i.code)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
