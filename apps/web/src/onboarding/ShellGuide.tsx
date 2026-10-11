/**
 * The guide's cards outside the Trail's own (chunk 24): above whatever screen is showing, for
 * the town steps (take a unit, pack and ride out), a pointer back to the Trail while the first
 * trip is out, and — once it ends — the passive side: "while you were out, someone else's party
 * met a caravan", with the standing party pre-filled from the roster through the ordinary
 * `PUT /me/party` (chunk 09's rules: free, instant, a template that never loses a unit).
 *
 * Progress is read from the server, never guessed: while the guide waits on the town steps it
 * re-reads `/me` and the trip status (on every tab change and every few seconds), and moves the
 * account's guide on when the roster has a unit or a trip is out.
 */
import { PARTY_CONFIG_VERSION, type PartyConfig } from "@caravan/circle";
import { useCallback, useEffect, useState } from "react";
import type { Api } from "../api/client.ts";
import type { PartyView } from "../api/types.ts";
import { addUnit } from "../screens/party/partyModel.ts";
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
 * not in it yet, up to the slot cap, with the builder's own defaults (partyModel.addUnit). Null
 * when it would add no one.
 */
export function prefillParty(view: PartyView): PartyConfig | null {
  let config: PartyConfig = { v: PARTY_CONFIG_VERSION, units: view.config.units, siege: view.config.siege };
  for (const r of view.roster) {
    if (config.units.length >= view.caps.units) break;
    if (!r.unlocked || config.units.some((u) => u.ref === r.instanceId)) continue;
    config = addUnit(config, r.instanceId);
  }
  return config.units.length > view.config.units.length ? config : null;
}

interface Facts {
  readonly units: number;
  readonly tripOpen: boolean;
  readonly lastEnd: "banked" | "overrun" | null;
}

async function readFacts(api: Api): Promise<Facts | null> {
  const me = await api.me();
  const caravan = me.caravans[0];
  if (!caravan) return null;
  const status = await api.tripStatus(caravan.id);
  const trip = status.trip;
  return { units: caravan.units?.length ?? 0, tripOpen: !!trip && trip.phase !== "ended", lastEnd: trip && trip.phase === "ended" ? trip.endReason : null };
}

/** The step the server's state says the account has at least reached, from where it stands. */
export function stepForFacts(step: OnboardingStep, f: Facts): OnboardingStep | null {
  if (f.lastEnd !== null && stepRank(step) >= stepRank("roster") && stepRank(step) < stepRank("party")) return "party";
  if (f.tripOpen && stepRank(step) < stepRank("scout")) return "scout";
  if (f.units > 0 && step === "roster") return "outfit";
  return null;
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
      const f = await readFacts(api);
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
      const here = route === "party";
      return (
        <GuideCard
          title={here && raise.kind === "raised" ? G.partyHereTitle : G.partyTitle}
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
            <>
              <h3 className="h3">{G.overrunTitle}</h3>
              <p>{G.overrunBody}</p>
              <p className="hint">{G.partyOverrun}</p>
            </>
          )}
          <p>{G.partyBody}</p>
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
