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
import type { ReactNode } from "react";
import type { CandidateView } from "../api/types.ts";
import type { TripEncounterView } from "../api/tripTypes.ts";
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

/** The smallest of the served parties: fewest raiders, then least total HP, then menu order. A reading of the scout only. */
export function smallestCandidate(candidates: readonly CandidateView[]): { readonly index: number; readonly raiders: number; readonly hp: number } | null {
  let best: { index: number; raiders: number; hp: number } | null = null;
  candidates.forEach((c, index) => {
    const raiders = c.scout.units.length;
    const hp = c.scout.units.reduce((n, u) => n + u.hp, 0);
    if (!best || raiders < best.raiders || (raiders === best.raiders && hp < best.hp)) best = { index, raiders, hp };
  });
  return best;
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
          {G.scoutPick(c.owner.displayName, pick.raiders, pick.hp)}
        </p>
      )}
    </GuideCard>
  );
}

export function ResultGuide({ encounter, deciding }: { encounter: TripEncounterView; deciding: boolean }): JSX.Element {
  const first = encounter.index <= 1;
  const title = deciding ? (first ? G.decide1Title : G.decide2Title) : encounter.outcome === "caravan_held" ? G.heldTitle : G.stalemateTitle;
  return (
    <GuideCard title={title} testId="guide-result">
      {!deciding && <p>{G.heldBody}</p>}
      <p>{first ? G.decide1Body : G.decide2Body}</p>
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

function Item({ done, title, why, action, testId }: { done: boolean; title: string; why: string; action: ReactNode; testId: string }): JSX.Element {
  return (
    <li className="guide__item" data-testid={testId} data-done={done ? "true" : "false"}>
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

export function ArrangeGuide({ manifest, formation, scout, locked, names, apply }: ArrangeGuideProps): JSX.Element {
  const s = arrangeStatus(manifest, formation, scout);
  const edge = T.edgeName(s.edge);
  const btn = (label: string, next: () => Formation, testId: string): ReactNode =>
    locked ? null : (
      <button type="button" className="btn btn--block" onClick={() => apply(next())} data-testid={testId}>
        {label}
      </button>
    );
  const firstUnposted = s.nextPost ? (names.get(s.nextPost.ref) ?? T.unknownThing) : null;
  const firstUnit = names.get(manifest.units[0]?.ref ?? "") ?? T.unknownThing;
  const trapName = s.nextTrap ? (names.get(s.nextTrap.ref) ?? T.unknownThing) : (names.get(manifest.traps[0]?.ref ?? "") ?? T.unknownThing);
  const postCell = s.nextPost?.cell ?? null;
  const trapCell = s.nextTrap?.cell ?? null;
  return (
    <GuideCard title={G.arrangeTitle} testId="guide-arrange">
      <p>{G.arrangeBody(edge, s.raidersOnEdge, s.raidersTotal)}</p>
      <ol className="guide__list">
        <Item done={s.fenceDone} title={G.stepFence(edge)} why={G.stepFenceWhy(edge, s.gap)} action={btn(G.stepFenceDo(edge), () => applyMainFence(manifest, formation, scout), "guide-do-fence")} testId="guide-step-fence" />
        <Item done={s.gapOpen} title={G.stepGap(s.gap)} why={G.stepGapWhy} action={btn(G.stepGapDo(s.gap), () => applyOpenGap(formation, scout), "guide-do-gap")} testId="guide-step-gap" />
        <Item
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
        {s.trapAvailable ? (
          <Item
            done={s.trapDone}
            title={G.stepTrap(trapName)}
            why={trapCell ? G.stepTrapWhy(trapCell.x, trapCell.y) : G.stepGapWhy}
            action={trapCell ? btn(G.stepTrapDo(trapName, trapCell.x, trapCell.y), () => applyTrap(manifest, formation, scout), "guide-do-trap") : null}
            testId="guide-step-trap"
          />
        ) : (
          <li className="hint" data-testid="guide-step-trap" data-done="true">
            {G.stepTrapNone}
          </li>
        )}
        <Item done={s.fenceLeft === 0} title={G.stepRest} why={G.stepRestWhy} action={btn(G.stepRestDo, () => applyRestOfFence(manifest, formation, scout), "guide-do-rest")} testId="guide-step-rest" />
      </ol>
      <h3 className="h3">{G.whyTitle}</h3>
      <p data-testid="guide-why">{G.why(edge, s.raidersOnEdge, s.gap)}</p>
      <p className="hint">{G.whyHonest}</p>
      <p className="hint">{G.whyCommit}</p>
    </GuideCard>
  );
}
