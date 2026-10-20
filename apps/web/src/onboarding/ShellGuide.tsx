/**
 * The guide's cards outside the Trail's own (chunk 24): above whatever screen is showing, for
 * the town steps (take a unit, pack and ride out), a pointer back to the Trail while the first
 * trip is out, and — once it ends — the passive side: "whose parties you just fought", with the standing party pre-filled from the roster through the ordinary
 * `PUT /me/party` (chunk 09's rules: free, instant, a template that never loses a unit).
 *
 * Progress is read from the server, never guessed: while the guide waits on the town steps it
 * re-reads `/me` and the trip status (on every tab change and every few seconds), and moves the
 * account's guide on when the roster has a unit or a trip is out.
 */
import { PARTY_CONFIG_VERSION, type PartyConfig } from "@caravan/circle";
import { TUNABLES } from "@caravan/content";
import { useCallback, useEffect, useState } from "react";
import type { Api } from "../api/client.ts";
import type { TripEndingView } from "../api/tripTypes.ts";
import type { PartyView } from "../api/types.ts";
import { addUnit } from "../screens/party/partyModel.ts";
import { unitLabel } from "../screens/trail/tripNames.ts";
import { navigate, type Route } from "../shell/router.tsx";
import { STRINGS } from "../strings.ts";
import { GuideCard } from "./GuideCard.tsx";
import { useOnboarding } from "./OnboardingProvider.tsx";
import { stepRank, type OnboardingStep } from "./steps.ts";

const G = STRINGS.guide;

/** How often the town steps re-read the server while waiting (presentation, not balance). */
export const GUIDE_POLL_MS = 3000;

/**
 * The standing party the guide offers to raise: the saved one plus every unlocked roster unit
 * not in it yet, up to SUGGESTED_PARTY_MAX (r4 D1; the saved party is never cut), with the builder's own defaults (partyModel.addUnit), plus
 * (final play-test review D5) every siege type the server says this account has unlocked, up to
 * the siege cap — so the passive side's siege ladder grows by default. The same rule as the
 * server's `suggested` read. Siege rides only with at least one unit (an empty party is never
 * served). Null when it would add nothing.
 */
export function prefillParty(view: PartyView): PartyConfig | null {
  let config: PartyConfig = { v: PARTY_CONFIG_VERSION, units: view.config.units, siege: view.config.siege };
  // Final guardrail review r4 D1: the raised party stops at SUGGESTED_PARTY_MAX (the guide's packed size), as the server's `suggested` does.
  const max = Math.min(view.caps.units, TUNABLES.SUGGESTED_PARTY_MAX);
  for (const r of view.roster) {
    if (config.units.length >= max) break;
    if (!r.unlocked || config.units.some((u) => u.ref === r.instanceId)) continue;
    config = addUnit(config, r.instanceId);
  }
  if (config.units.length > 0) {
    const siege = [...config.siege];
    for (const s of view.siegeCatalog) {
      if (siege.length >= view.caps.siege) break;
      if (s.unlocked && !siege.includes(s.typeId)) siege.push(s.typeId);
    }
    config = { ...config, siege };
  }
  return config.units.length > view.config.units.length || config.siege.length > view.config.siege.length ? config : null;
}

export interface Facts {
  readonly units: number;
  /**
   * The caravan has taken a refugee (the current menu is claimed, or an earlier one was). Read
   * only on the roster step: every caravan starts with a starting roster (chunk 24 QA D1), so a
   * unit in the roster no longer means the player has learnt where units come from.
   */
  readonly refugeeClaimed: boolean;
  readonly tripOpen: boolean;
  readonly lastEnd: "banked" | "overrun" | "voided" | null;
  /** The ended trip's own record of what it cost (QA S2), when the last trip has ended. */
  readonly ending: TripEndingView | null;
}

async function readFacts(api: Api, step: OnboardingStep): Promise<Facts | null> {
  const me = await api.me();
  const caravan = me.caravans[0];
  if (!caravan) return null;
  const status = await api.tripStatus(caravan.id);
  const trip = status.trip;
  let refugeeClaimed = false;
  if (step === "roster") {
    const menu = (await api.refugees(caravan.id)).menu;
    refugeeClaimed = menu.claimed !== null || menu.sequence > 1;
  }
  const ended = !!trip && trip.phase === "ended";
  return { units: caravan.units?.length ?? 0, refugeeClaimed, tripOpen: !!trip && !ended, lastEnd: ended ? trip.endReason : null, ending: ended ? trip.ending : null };
}

/** The step the server's state says the account has at least reached, from where it stands. */
export function stepForFacts(step: OnboardingStep, f: Pick<Facts, "refugeeClaimed" | "tripOpen" | "lastEnd">): OnboardingStep | null {
  if (f.lastEnd !== null && stepRank(step) >= stepRank("roster") && stepRank(step) < stepRank("party")) return "party";
  if (f.tripOpen && stepRank(step) < stepRank("scout")) return "scout";
  if (f.refugeeClaimed && step === "roster") return "outfit";
  return null;
}

/** QA S2: the overrun card says what the ended trip recorded, never "what you packed is lost". */
export function overrunLines(ending: TripEndingView | null): string[] {
  if (!ending || ending.kind !== "overrun") return [G.overrunGeneric];
  const names = (us: readonly { typeId: string; mergeLevel: number }[]): string => us.map(unitLabel).join(", ");
  const lines = [ending.unitsLostOutright.length > 0 ? G.overrunLostOutright(names(ending.unitsLostOutright)) : G.overrunLostNone];
  if (ending.unitsDeMerged.length > 0) lines.push(G.overrunDeMerged(ending.unitsDeMerged.map((u) => unitLabel({ typeId: u.typeId, mergeLevel: u.mergeLevelAfter })).join(", ")));
  lines.push(G.overrunCoin(ending.coinLost));
  return lines;
}

export interface ShellGuideProps {
  readonly api: Api;
  readonly route: Route;
  /** Called after the guide saved the party, so a Party screen already open re-reads it. */
  readonly onPartySaved?: () => void;
  readonly pollMs?: number;
}

type Raise = { kind: "idle" } | { kind: "busy" } | { kind: "raised"; n: number } | { kind: "empty" } | { kind: "failed" };

export function ShellGuide({ api, route, onPartySaved, pollMs = GUIDE_POLL_MS }: ShellGuideProps): JSX.Element | null {
  const ob = useOnboarding();
  const step = ob?.active ? ob.step : null;
  const [facts, setFacts] = useState<Facts | null>(null);
  const [raise, setRaise] = useState<Raise>({ kind: "idle" });
  const [finishing, setFinishing] = useState(false);
  const reach = ob?.reach;

  const check = useCallback(async (): Promise<void> => {
    if (!step || step === "welcome" || step === "done" || !reach) return;
    try {
      const f = await readFacts(api, step);
      if (!f) return;
      setFacts(f);
      const next = stepForFacts(step, f);
      if (next) await reach(next);
    } catch {
      // A failed read changes nothing: the next tab change or tick tries again.
    }
  }, [api, step, reach]);

  useEffect(() => {
    void check();
  }, [check, route]);

  const waiting = step === "roster" || step === "outfit";
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => void check(), pollMs);
    return () => window.clearInterval(t);
  }, [waiting, check, pollMs]);

  if (!step || step === "welcome" || step === "done") return null;

  const raiseParty = async (): Promise<void> => {
    setRaise({ kind: "busy" });
    try {
      const view = (await api.party()).party;
      const config = prefillParty(view);
      if (!config) {
        setRaise(view.config.units.length > 0 ? { kind: "raised", n: view.config.units.length } : { kind: "empty" });
        return;
      }
      const saved = (await api.saveParty(config)).party;
      setRaise({ kind: "raised", n: saved.config.units.length });
      onPartySaved?.();
      navigate("party");
      // QA N8: land at the top of the Party screen (the status and Finish), not at the Trail's scroll offset.
      window.scrollTo?.(0, 0);
    } catch {
      setRaise({ kind: "failed" });
    }
  };

  const finish = async (): Promise<void> => {
    setFinishing(true);
    await reach?.("done");
    setFinishing(false);
  };

  switch (step) {
    case "roster":
      return (
        <GuideCard
          title={G.rosterTitle}
          testId="guide-roster"
          actions={
            route !== "town" ? (
              <button type="button" className="btn btn--primary btn--block" onClick={() => navigate("town")}>
                {G.toTown}
              </button>
            ) : undefined
          }
        >
          <p>{G.rosterBody}</p>
        </GuideCard>
      );
    case "outfit":
      return (
        <GuideCard
          title={G.outfitTitle}
          testId="guide-outfit"
          actions={
            route !== "town" ? (
              <button type="button" className="btn btn--primary btn--block" onClick={() => navigate("town")}>
                {G.toTown}
              </button>
            ) : undefined
          }
        >
          <p>{G.outfitBody}</p>
          <p className="hint">{G.outfitStakes}</p>
        </GuideCard>
      );
    case "party": {
      const overrun = facts?.lastEnd === "overrun";
      const voided = facts?.lastEnd === "voided" && facts.ending?.kind === "voided" ? facts.ending : null;
      const firstFightLost = overrun && facts?.ending?.kind === "overrun" && facts.ending.encounterIndex <= 1;
      const here = route === "party";
      // QA S3: after an overrun (or a void) the card leads with what happened to the player's own
      // caravan, and the passive side follows under a heading that says whose party meets whose caravan.
      const lead = here && raise.kind === "raised" ? G.partyHereTitle : overrun ? G.overrunTitle : voided ? G.voidedTitle : G.partyTitle;
      const passiveHeading = lead === G.overrunTitle || lead === G.voidedTitle;
      return (
        <GuideCard
          title={lead}
          testId="guide-party"
          actions={
            <>
              {raise.kind !== "raised" && raise.kind !== "empty" && (
                <button type="button" className="btn btn--primary btn--block" disabled={raise.kind === "busy"} onClick={() => void raiseParty()} data-testid="guide-raise-party">
                  {raise.kind === "busy" ? G.partyRaising : G.partyRaise}
                </button>
              )}
              {!here && (
                <button type="button" className="btn btn--block" onClick={() => navigate("party")} data-testid="guide-open-party">
                  {G.partyOpen}
                </button>
              )}
              <button type="button" className={`btn btn--block${raise.kind === "raised" || raise.kind === "empty" ? " btn--primary" : ""}`} disabled={finishing} onClick={() => void finish()} data-testid="guide-finish">
                {finishing ? G.finishing : G.finish}
              </button>
            </>
          }
        >
          {overrun && (
            <div data-testid="guide-overrun">
              {lead !== G.overrunTitle && <h3 className="h3">{G.overrunTitle}</h3>}
              <p>{G.overrunLead}</p>
              <ul className="plain" data-testid="guide-overrun-losses">
                {overrunLines(facts?.ending ?? null).map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <p className="hint">{firstFightLost ? G.partyOverrunFirst : G.partyOverrun}</p>
            </div>
          )}
          {voided && (
            <div data-testid="guide-voided">
              {lead !== G.voidedTitle && <h3 className="h3">{G.voidedTitle}</h3>}
              <p>{G.voidedBody(voided.voidedEncounter, voided.encountersSurvived)}</p>
            </div>
          )}
          {passiveHeading && <h3 className="h3">{G.partyPassiveTitle}</h3>}
          <p>{voided && voided.voidedEncounter <= 1 ? G.partyBodyNoFight : firstFightLost ? G.partyBodyOne : G.partyBody}</p>
          {raise.kind === "raised" && (
            <p className="notice" role="status" data-testid="guide-party-raised">
              {G.partyRaised(raise.n)}
            </p>
          )}
          {raise.kind === "raised" && here && <p>{G.partyHereBody}</p>}
          {raise.kind === "empty" && <p data-testid="guide-party-empty">{G.partyEmpty}</p>}
          {raise.kind === "failed" && (
            <p className="error" role="alert">
              {G.partyFailed}
            </p>
          )}
        </GuideCard>
      );
    }
    default:
      // The first trip is out (scout … bank): the Trail carries the guide; elsewhere, point back to it.
      return route === "trail" ? null : (
        <GuideCard
          title={G.onTrailTitle}
          testId="guide-to-trail"
          actions={
            <button type="button" className="btn btn--primary btn--block" onClick={() => navigate("trail")}>
              {G.toTrail}
            </button>
          }
        >
          <p>{G.onTrailBody}</p>
        </GuideCard>
      );
  }
}
