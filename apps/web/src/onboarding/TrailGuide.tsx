/**
 * The guide on the Trail (chunk 24): which card goes with which state of the first trip, the
 * step each state means, the scouting recommendation, and the guided arrangement panel the
 * formation screen hosts at encounter 1.
 *
 * Everything here reads what the Trail already has from the server (the menu, the scouted
 * party, the resolved encounter). It never changes a rule, never picks for the player and
 * never shows an outcome the server did not record: a held fight says held, an overrun says
 * overrun.
 */
import type { Formation, Manifest } from "@caravan/circle";
import { useEffect, useState, type ReactNode } from "react";
import type { Api } from "../api/client.ts";
import type { CandidateView } from "../api/types.ts";
import type { StakesPreview, TripEncounterView } from "../api/tripTypes.ts";
import { fenceLabel, unitLabel } from "../screens/trail/tripNames.ts";
import type { ScoutedParty } from "../screens/trail/scoutTypes.ts";
import { STRINGS } from "../strings.ts";
import { applyMainFence, applyOpenGap, applyPosts, applyRestOfFence, applyTrap, arrangeStatus } from "./arrangeGuide.ts";
import { GuideCard } from "./GuideCard.tsx";
import * as rule from "@caravan/circle";
import { isAfter, type OnboardingStep } from "./steps.ts";

const G = STRINGS.guide;
const T = STRINGS.trail;

/** The Trail states the guide reacts to (a projection of TrailScreen's own state). */
export type TrailMoment =
  | { readonly kind: "arranging"; readonly encounterIndex: number; readonly searched: boolean; readonly chosen: boolean }
  | { readonly kind: "resolving"; readonly encounterIndex: number }
  | { readonly kind: "decide"; readonly encounterIndex: number }
  | { readonly kind: "ended" }
  | { readonly kind: "other" };

/** The step a Trail moment means for the first trip (null: no change). Forward-only on the server. */
export function stepForMoment(m: TrailMoment): OnboardingStep | null {
  switch (m.kind) {
    case "arranging":
      if (m.encounterIndex <= 1) return m.chosen ? "arrange" : "scout";
      return "free";
    case "resolving":
      return m.encounterIndex <= 1 ? "arrange" : "free";
    case "decide":
      return m.encounterIndex <= 1 ? "result" : "bank";
    case "ended":
      return "party";
    case "other":
      return null;
  }
}

/** Whether the guide still has something to say at `moment`, given where the account stands. */
export function showsAt(step: OnboardingStep | null, moment: TrailMoment): boolean {
  const target = stepForMoment(moment);
  if (step === null || target === null || target === "party") return false;
  return !isAfter(step, target);
}

// Round 3 S1: the pick and advice rules live in @caravan/circle guide.ts as pure functions (no React, no DOM),
// so the balance harness can run the very same code. These are the client-typed wrappers.
export { GUIDE_RANGED_MIN_CELLS, isRangedRaider } from "@caravan/circle";

/** Every raider in the party is ranged (an empty party is not). */
export function isRangedOnly(c: CandidateView): boolean {
  return rule.isRangedOnly(c.scout);
}

/**
 * The guide's pick from the served menu (QA N2; r2 S2; r3 S1): pass over ranged-only parties
 * whenever another candidate exists, then the smallest by the scout — least total HP, then fewest
 * siege, then fewest raiders, then menu order. Applied at every guided encounter.
 */
export function smallestCandidate(candidates: readonly CandidateView[]): { readonly index: number; readonly raiders: number; readonly hp: number; readonly siege: number } | null {
  const p = rule.guidePick(candidates.map((c) => c.scout));
  return p ? { index: p.index, raiders: p.raiders, hp: p.hp, siege: p.siege } : null;
}

function reasonText(r: rule.AdviceReason, p: StakesPreview): string {
  switch (r.kind) {
    case "hurt": {
      const u = p.units.find((x) => x.ref === r.ref);
      return G.reasonHurt(u ? unitLabel(u) : T.unknownThing, r.hp, r.maxHp);
    }
    case "none_standing":
      return G.reasonNoneStanding;
    case "no_trap":
      return G.reasonNoTrap;
    case "fence":
      return G.reasonFence(r.destroyed, r.intact);
    case "ranged_menu":
      return G.reasonRangedMenu(r.parties);
    case "stakes":
      return [r.worn ? G.reasonLateWorn : "", r.rangedParties > 0 ? G.reasonLateRanged(r.rangedParties) : ""].filter(Boolean).join(" ");
  }
}

/** The shared rule on the client's types (@caravan/circle pushAdvice). */
export function adviceFor(p: StakesPreview, menu: readonly CandidateView[] | null, encounterIndex: number): rule.Advice {
  return rule.pushAdvice(p, menu ? menu.map((c) => c.scout) : null, encounterIndex);
}

/**
 * QA D2 / r3 S1 / r4 D1: the bank-or-push advice, read off the server's stakes preview and the menu
 * the player just faced, for the decision after encounter `encounterIndex`. Advice only.
 */
export function pushAdvice(p: StakesPreview, menu: readonly CandidateView[] | null = null, encounterIndex = 1): { readonly kind: "bank"; readonly reasons: readonly string[] } | { readonly kind: "push" } {
  const a = adviceFor(p, menu, encounterIndex);
  return a.kind === "bank" ? { kind: "bank", reasons: a.reasons.map((r) => reasonText(r, p)) } : a;
}

/** The advice's words: encounter 1's copy, or (r4 D1) the stakes-led copy from encounter 2 on. */
export function adviceText(a: rule.Advice, preview: StakesPreview, encounterIndex: number): string {
  const coin = preview.unbankedCoin.total;
  if (encounterIndex >= 2) {
    const standing = preview.units.filter((u) => u.alive).length;
    if (a.kind === "push") return G.decideAdvisePushLate(encounterIndex, coin, standing);
    const stakes = a.reasons.find((r): r is Extract<rule.AdviceReason, { kind: "stakes" }> => r.kind === "stakes");
    const bad = a.reasons.filter((r) => r.kind !== "stakes").map((r) => reasonText(r, preview));
    const worn = bad.length > 0 ? G.reasonLateWornDetail(bad.join("; ")) : stakes?.worn ? G.reasonLateWorn : "";
    const why = [worn, stakes && stakes.rangedParties > 0 ? G.reasonLateRanged(stakes.rangedParties) : ""].filter(Boolean).join(" ");
    return G.decideAdviseBankLate(encounterIndex, why, coin, standing);
  }
  if (a.kind === "push") return G.decideAdvisePush(coin);
  // r3 S1: the ranged-menu reason alone is not "badly hurt"; it gets its own lead.
  if (a.reasons.every((r) => r.kind === "ranged_menu")) return G.decideAdviseBankRanged(a.reasons.length > 0 ? reasonText(a.reasons[0]!, preview) : "", coin);
  return G.decideAdviseBank(a.reasons.map((r) => reasonText(r, preview)).join("; "), coin);
}

export function DecideAdvice({ preview, menu = null, encounterIndex = 1 }: { preview: StakesPreview | null; menu?: readonly CandidateView[] | null; encounterIndex?: number }): JSX.Element {
  if (!preview) return <p className="hint">{G.decideReading}</p>;
  const a = adviceFor(preview, menu, encounterIndex);
  return (
    <p data-testid="guide-advice" data-advice={a.kind} data-encounter={encounterIndex} data-reasons={a.kind === "bank" ? a.reasons.map((r) => r.kind).join(" ") : ""}>
      {adviceText(a, preview, encounterIndex)}
    </p>
  );
}

export function SearchGuide(): JSX.Element {
  return (
    <GuideCard title={G.searchTitle} testId="guide-search">
      <p>{G.searchBody}</p>
    </GuideCard>
  );
}

/**
 * The scout reading (r3 S1: at EVERY guided encounter, not only the first). The pick and the
 * "passes over" note lead; the how-to-read body is one tap away (N13), so the three parties start
 * on the first screen.
 */
export function ScoutGuide({ candidates, encounterIndex = 1 }: { candidates: readonly CandidateView[]; encounterIndex?: number }): JSX.Element {
  const pick = smallestCandidate(candidates);
  const c = pick ? candidates[pick.index] : undefined;
  const passed = candidates.some((x) => !isRangedOnly(x)) ? candidates.filter(isRangedOnly).map((x) => x.owner.displayName) : [];
  return (
    <GuideCard title={encounterIndex <= 1 ? G.scoutTitle : G.scoutTitleLater(encounterIndex)} testId="guide-scout">
      {pick && c && (
        <p data-testid="guide-scout-pick" data-index={pick.index}>
          {(encounterIndex <= 1 ? G.scoutPick : G.scoutPickLater)(c.owner.displayName, pick.raiders, pick.hp, pick.siege, passed.length > 0)}
        </p>
      )}
      {pick && passed.length > 0 && <p data-testid="guide-scout-ranged">{G.scoutRangedNote(passed.join(", "))}</p>}
      <details className="guide__all" data-testid="guide-scout-how">
        <summary className="btn btn--block">{G.scoutHowTitle}</summary>
        <p>{G.scoutBody}</p>
      </details>
    </GuideCard>
  );
}

export interface ResultGuideProps {
  readonly encounter: TripEncounterView;
  readonly deciding: boolean;
  /** With these, the deciding card reads the server's stakes preview for its advice (QA D2). */
  readonly api?: Api;
  readonly caravanId?: string;
}

export function ResultGuide({ encounter, deciding, api, caravanId }: ResultGuideProps): JSX.Element {
  const first = encounter.index <= 1;
  const [preview, setPreview] = useState<StakesPreview | null>(null);
  const [menu, setMenu] = useState<readonly CandidateView[] | null>(null);
  // r3 S1: the guide advises at EVERY guided decision, reading the stakes and the menu just faced.
  const advise = deciding && !!api && !!caravanId;
  useEffect(() => {
    if (!advise) return;
    let live = true;
    api!.tripPreview(caravanId!).then(
      (p) => {
        if (live) setPreview(p);
      },
      () => undefined,
    );
    // The menu of the encounter just fought: the best reading of the next search (one escalation step up).
    Promise.resolve()
      .then(() => api!.candidates(caravanId!, encounter.index))
      .then(
        (r) => {
          if (live) setMenu(r.menu?.candidates ?? null);
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [advise, api, caravanId, encounter.index]);
  // r4 D1: the deciding card's title follows the advice it shows ("Bank the trip" only over a bank).
  const advice = advise && preview ? adviceFor(preview, menu, encounter.index).kind : null;
  const title = deciding ? G.decideTitleFor(advice) : encounter.outcome === "caravan_held" ? G.heldTitle : G.stalemateTitle;
  return (
    <GuideCard title={title} testId="guide-result">
      {!deciding && <p>{G.heldBody}</p>}
      {!deciding && <p>{G.decideIntro}</p>}
      {deciding && first && <p>{G.decideIntro}</p>}
      {deciding && !first && <p>{G.decide2Body}</p>}
      {advise && <DecideAdvice preview={preview} menu={menu} encounterIndex={encounter.index} />}
    </GuideCard>
  );
}

export function FreeGuide(): JSX.Element {
  return (
    <GuideCard title={G.freeTitle} testId="guide-free">
      <p>{G.freeBody}</p>
    </GuideCard>
  );
}

// ── the guided arrangement (encounter 1) ─────────────────────────────────────────────

export interface ArrangeGuideProps {
  readonly manifest: Manifest;
  readonly formation: Formation;
  readonly scout: ScoutedParty;
  readonly locked: boolean;
  readonly names: ReadonlyMap<string, string>;
  readonly apply: (next: Formation) => void;
}

function Item({ done, title, why, action, testId, current }: { done: boolean; title: string; why: string; action: ReactNode; testId: string; current?: boolean }): JSX.Element {
  return (
    <li className="guide__item" data-testid={testId} data-done={done ? "true" : "false"} aria-current={current ? "step" : undefined}>
      <span className="guide__mark" aria-hidden="true">
        {done ? "✓" : "○"}
      </span>
      <div>
        <p className="guide__itemTitle">
          {title} <span className="hint">· {done ? G.stepDone : G.stepTodo}</span>
        </p>
        <p className="hint">{why}</p>
        {!done && action}
      </div>
    </li>
  );
}

/**
 * QA S4: after a "do it for me" edit, bring the circle back into view so the change is seen
 * (presentation only; jsdom and old browsers without scrollIntoView simply skip it).
 */
function showCircle(): void {
  const host = typeof document !== "undefined" ? document.querySelector<HTMLElement>("[data-testid=formation-screen] [data-testid=iso-host]") : null;
  host?.scrollIntoView?.({ block: "start", behavior: "auto" });
}

export function ArrangeGuide({ manifest, formation, scout, locked, names, apply }: ArrangeGuideProps): JSX.Element {
  const s = arrangeStatus(manifest, formation, scout);
  const edge = G.edgeWord(s.edge);
  const btn = (label: string, next: () => Formation, testId: string): ReactNode =>
    locked ? null : (
      <button
        type="button"
        className="btn btn--block"
        onClick={() => {
          apply(next());
          showCircle();
        }}
        data-testid={testId}
      >
        {label}
      </button>
    );
  const firstUnposted = s.nextPost ? (names.get(s.nextPost.ref) ?? T.unknownThing) : null;
  const firstUnit = names.get(manifest.units[0]?.ref ?? "") ?? T.unknownThing;
  const trapName = s.nextTrap ? (names.get(s.nextTrap.ref) ?? T.unknownThing) : (names.get(manifest.traps[0]?.ref ?? "") ?? T.unknownThing);
  const postCell = s.nextPost?.cell ?? null;
  const trapCell = s.nextTrap?.cell ?? null;
  // QA S4: the steps, in order. Only the next undone one is shown in full, directly under the
  // circle (this card is the formation screen's slot right below the canvas); the rest are a
  // collapsed list, so the step being taken and the circle it changes share the screen.
  const steps: { key: string; done: boolean; node: (current: boolean) => ReactNode }[] = [
    { key: "fence", done: s.fenceDone, node: (c) => <Item key="fence" current={c} done={s.fenceDone} title={G.stepFence(edge)} why={G.stepFenceWhy(edge, s.gap)} action={btn(G.stepFenceDo(edge), () => applyMainFence(manifest, formation, scout), "guide-do-fence")} testId="guide-step-fence" /> },
    { key: "gap", done: s.fenceDone && s.gapOpen, node: (c) => <Item key="gap" current={c} done={s.fenceDone && s.gapOpen} title={G.stepGap(s.gap)} why={G.stepGapWhy} action={btn(G.stepGapDo(s.gap), () => applyOpenGap(formation, scout), "guide-do-gap")} testId="guide-step-gap" /> },
    {
      key: "post",
      done: s.postDone && s.unposted === 0,
      node: (c) => (
        <Item
          key="post"
          current={c}
          done={s.postDone && s.unposted === 0}
          title={G.stepPost(firstUnposted ?? firstUnit)}
          why={postCell ? G.stepPostWhy(postCell.x, postCell.y) : G.stepGapWhy}
          action={
            s.nextPost && postCell
              ? btn(s.postDone ? G.stepPostMore(s.unposted) : G.stepPostDo(firstUnposted ?? firstUnit, postCell.x, postCell.y), () => applyPosts(manifest, formation, scout), "guide-do-post")
              : null
          }
          testId="guide-step-post"
        />
      ),
    },
    {
      key: "trap",
      done: s.trapDone,
      node: (c) =>
        s.trapAvailable ? (
          <Item
            key="trap"
            current={c}
            done={s.trapDone}
            title={G.stepTrap(trapName)}
            why={trapCell ? G.stepTrapWhy(trapCell.x, trapCell.y) : G.stepGapWhy}
            action={trapCell ? btn(G.stepTrapDo(trapName, trapCell.x, trapCell.y), () => applyTrap(manifest, formation, scout), "guide-do-trap") : null}
            testId="guide-step-trap"
          />
        ) : (
          <li key="trap" className="hint" data-testid="guide-step-trap" data-done="true">
            {G.stepTrapNone}
          </li>
        ),
    },
    { key: "rest", done: s.fenceLeft === 0, node: (c) => <Item key="rest" current={c} done={s.fenceLeft === 0} title={G.stepRest} why={G.stepRestWhy} action={btn(G.stepRestDo, () => applyRestOfFence(manifest, formation, scout), "guide-do-rest")} testId="guide-step-rest" /> },
  ];
  const nextIdx = steps.findIndex((st) => !st.done);
  const doneCount = steps.filter((st) => st.done).length;
  const why = (
    <>
      <h3 className="h3">{G.whyTitle}</h3>
      <p data-testid="guide-why">{G.why(edge, s.raidersOnEdge, s.gap)}</p>
      <p className="hint">{G.whyHonest}</p>
      <p className="hint">{G.whyCommit}</p>
    </>
  );
  return (
    <GuideCard title={G.arrangeTitle} testId="guide-arrange">
      <p>{G.arrangeBody(edge, s.raidersOnEdge, s.raidersTotal)}</p>
      {nextIdx >= 0 ? (
        <>
          <p className="hint" data-testid="guide-next-step">
            {G.nextStep(nextIdx + 1, steps.length)}
          </p>
          <ol className="guide__list" start={nextIdx + 1} data-testid="guide-current">
            {steps[nextIdx]!.node(true)}
          </ol>
        </>
      ) : (
        <p data-testid="guide-steps-done">{G.stepsDone}</p>
      )}
      <details className="guide__all" data-testid="guide-all-steps">
        <summary className="btn btn--block">{G.allSteps(doneCount, steps.length)}</summary>
        <ol className="guide__list">{steps.map((st, i) => (i === nextIdx ? null : st.node(false)))}</ol>
      </details>
      {nextIdx >= 0 ? (
        <details className="guide__all">
          <summary className="btn btn--block">{G.whyTitle}</summary>
          {why}
        </details>
      ) : (
        why
      )}
    </GuideCard>
  );
}
