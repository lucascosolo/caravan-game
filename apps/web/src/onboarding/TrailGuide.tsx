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

/**
 * The smallest of the served parties, by the scout alone (QA N2): least total HP, then fewest
 * siege pieces (siege counters exactly the fence and trap the guide teaches), then fewest
 * raiders, then menu order. HP first, so fielding one strong raider does not make a party read
 * "smallest".
 */
export function smallestCandidate(candidates: readonly CandidateView[]): { readonly index: number; readonly raiders: number; readonly hp: number; readonly siege: number } | null {
  let best: { index: number; raiders: number; hp: number; siege: number } | null = null;
  candidates.forEach((c, index) => {
    const raiders = c.scout.units.length;
    const siege = c.scout.siege.length;
    const hp = c.scout.units.reduce((n, u) => n + u.hp, 0);
    const b = best as { index: number; raiders: number; hp: number; siege: number } | null;
    if (!b || hp < b.hp || (hp === b.hp && (siege < b.siege || (siege === b.siege && raiders < b.raiders)))) best = { index, raiders, hp, siege };
  });
  return best;
}

/**
 * QA D2: the bank-or-push advice, read off the server's stakes preview. Bank when the circle is
 * badly hurt — a packed unit still standing is under half its HP, none is standing, or every
 * trap is spent while more fence is broken than stands. Otherwise one push is suggested, to see
 * escalation. Advice only: the player chooses, and the guide goes on to the party either way.
 */
export function pushAdvice(p: StakesPreview): { readonly kind: "bank"; readonly reasons: readonly string[] } | { readonly kind: "push" } {
  const reasons: string[] = [];
  const alive = p.units.filter((u) => u.alive);
  for (const u of alive) if (u.hp * 2 < u.maxHp) reasons.push(G.reasonHurt(unitLabel(u), u.hp, u.maxHp));
  if (p.units.length > 0 && alive.length === 0) reasons.push(G.reasonNoneStanding);
  const trapsGone = p.traps.remaining.length === 0 && p.traps.spent.length > 0;
  const fenceGone = p.fences.destroyed.length > p.fences.intact.length;
  if (trapsGone && fenceGone) {
    reasons.push(G.reasonNoTrap, G.reasonFence(p.fences.destroyed.length, p.fences.intact.length));
  }
  return reasons.length > 0 ? { kind: "bank", reasons } : { kind: "push" };
}

export function DecideAdvice({ preview }: { preview: StakesPreview | null }): JSX.Element {
  if (!preview) return <p className="hint">{G.decideReading}</p>;
  const a = pushAdvice(preview);
  const coin = preview.unbankedCoin.total;
  return (
    <p data-testid="guide-advice" data-advice={a.kind}>
      {a.kind === "bank" ? G.decideAdviseBank(a.reasons.join("; "), coin) : G.decideAdvisePush(coin)}
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

export function ScoutGuide({ candidates }: { candidates: readonly CandidateView[] }): JSX.Element {
  const pick = smallestCandidate(candidates);
  const c = pick ? candidates[pick.index] : undefined;
  return (
    <GuideCard title={G.scoutTitle} testId="guide-scout">
      <p>{G.scoutBody}</p>
      {pick && c && (
        <p data-testid="guide-scout-pick" data-index={pick.index}>
          {G.scoutPick(c.owner.displayName, pick.raiders, pick.hp, pick.siege)}
        </p>
      )}
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
  const title = deciding ? (first ? G.decide1Title : G.decide2Title) : encounter.outcome === "caravan_held" ? G.heldTitle : G.stalemateTitle;
  const [preview, setPreview] = useState<StakesPreview | null>(null);
  const advise = deciding && first && !!api && !!caravanId;
  useEffect(() => {
    if (!advise) return;
    let live = true;
    api!.tripPreview(caravanId!).then(
      (p) => {
        if (live) setPreview(p);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [advise, api, caravanId]);
  return (
    <GuideCard title={title} testId="guide-result">
      {!deciding && <p>{G.heldBody}</p>}
      {!deciding && <p>{G.decideIntro}</p>}
      {deciding && first && <p>{G.decideIntro}</p>}
      {deciding && first && advise && <DecideAdvice preview={preview} />}
      {deciding && !first && <p>{G.decide2Body}</p>}
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
    { key: "gap", done: s.gapOpen, node: (c) => <Item key="gap" current={c} done={s.gapOpen} title={G.stepGap(s.gap)} why={G.stepGapWhy} action={btn(G.stepGapDo(s.gap), () => applyOpenGap(formation, scout), "guide-do-gap")} testId="guide-step-gap" /> },
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
