/**
 * The authored-only phase's help (final play-test review round 3 decision). Until the caravan has
 * banked AUTHORED_ONLY_UNTIL_BANKS trips, once the onboarding guide is done, the guide still reads
 * the scout (ScoutGuide, rendered by the Trail from the menu), advises at bank or push, and offers
 * an OPTIONAL "Arrange for me" (the shared guidedFormation) — one button and a short line, never
 * the onboarding checklist. Each piece gates itself on the server's own `authoredOnlyTrip` flag on
 * the encounter's menu, so it goes away by itself from the third banked trip on.
 *
 * Presentation only: nothing here changes a rule, and the player can always arrange freely.
 */
import { guidedFormation, mainEdge, type Formation, type Manifest } from "@caravan/circle";
import { useEffect, useState } from "react";
import type { Api } from "../api/client.ts";
import type { CandidateView } from "../api/types.ts";
import type { StakesPreview, TripEncounterView } from "../api/tripTypes.ts";
import type { ScoutedParty } from "../screens/trail/scoutTypes.ts";
import { STRINGS } from "../strings.ts";
import { GuideCard } from "./GuideCard.tsx";
import { DecideAdvice } from "./TrailGuide.tsx";

const G = STRINGS.guide;

/** The menu of encounter `n` as the server reads it back (null while unknown or unreadable). */
export function useEncounterMenu(api: Api, caravanId: string, n: number): { readonly authoredOnly: boolean; readonly candidates: readonly CandidateView[] } | null {
  const [menu, setMenu] = useState<{ readonly authoredOnly: boolean; readonly candidates: readonly CandidateView[] } | null>(null);
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(() => api.candidates(caravanId, n))
      .then(
        (r) => {
          if (live) setMenu({ authoredOnly: r.menu?.authoredOnlyTrip === true, candidates: r.menu?.candidates ?? [] });
        },
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [api, caravanId, n]);
  return menu;
}

export interface AssistArrangeProps {
  readonly api: Api;
  readonly caravanId: string;
  readonly encounterIndex: number;
  readonly manifest: Manifest;
  readonly formation: Formation;
  readonly scout: ScoutedParty;
  readonly locked: boolean;
  readonly apply: (next: Formation) => void;
}

/** One optional button: the guide's layout (guidedFormation) on what is left, against this party's sides. */
export function AssistArrange({ api, caravanId, encounterIndex, manifest, scout, locked, apply }: AssistArrangeProps): JSX.Element | null {
  const menu = useEncounterMenu(api, caravanId, encounterIndex);
  if (!menu?.authoredOnly || locked) return null;
  return (
    <section className="assist" data-testid="assist-arrange">
      <p className="hint">{G.assistArrangeLine(G.edgeWord(mainEdge(scout)))}</p>
      <button type="button" className="btn btn--block" data-testid="assist-arrange-do" onClick={() => apply(guidedFormation(manifest, scout))}>
        {G.assistArrangeDo}
      </button>
    </section>
  );
}

/** The bank-or-push advice outside the onboarding guide, during the authored-only phase. */
export function AssistAdvice({ api, caravanId, encounter }: { api: Api; caravanId: string; encounter: TripEncounterView }): JSX.Element | null {
  const menu = useEncounterMenu(api, caravanId, encounter.index);
  const [preview, setPreview] = useState<StakesPreview | null>(null);
  const on = menu?.authoredOnly === true;
  useEffect(() => {
    if (!on) return;
    let live = true;
    api.tripPreview(caravanId).then(
      (p) => {
        if (live) setPreview(p);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [on, api, caravanId]);
  if (!on || !menu) return null;
  return (
    <GuideCard title={G.assistAdviceTitle} testId="assist-advice">
      <DecideAdvice preview={preview} menu={menu.candidates} encounterIndex={encounter.index} />
    </GuideCard>
  );
}
