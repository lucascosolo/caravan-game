/**
 * The guide's first screen (chunk 24, PHASE-2 §24): which side the player plays actively
 * (defense: the wagon circle, on a trip) and which passively (offense: the standing raid
 * party, served into other players' trips), that the town is never raided, and that the
 * region chosen at registration is permanent for this caravan. Not skippable; "Begin" moves
 * the account's guide on and lands in the town.
 */
import { REGIONS } from "@caravan/content";
import { useEffect, useState } from "react";
import type { Api } from "../api/client.ts";
import { navigate } from "../shell/router.tsx";
import { STRINGS } from "../strings.ts";
import { useOnboarding } from "./OnboardingProvider.tsx";

const G = STRINGS.guide;

export function WelcomeScreen({ api }: { api: Api }): JSX.Element {
  const ob = useOnboarding();
  const [region, setRegion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api.me().then(
      (me) => {
        const id = me.caravans[0]?.region_id;
        const r = REGIONS.find((x) => x.id === id);
        if (live && r) setRegion(r.displayName);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [api]);

  const begin = async (): Promise<void> => {
    setBusy(true);
    await ob?.reach("roster");
    setBusy(false);
    navigate("town");
  };

  return (
    <section className="welcome" data-testid="onboarding-welcome">
      <h1>{G.welcomeTitle}</h1>
      <p className="welcome__lead">{G.welcomeLead}</p>
      <div className="welcome__side" data-side="active">
        <h2>
          <span aria-hidden="true">⛨ </span>
          {G.welcomeActiveHeading}
        </h2>
        <p>{G.welcomeActive}</p>
      </div>
      <div className="welcome__side" data-side="passive">
        <h2>
          <span aria-hidden="true">⚑ </span>
          {G.welcomePassiveHeading}
        </h2>
        <p>{G.welcomePassive}</p>
      </div>
      <div className="welcome__side" data-side="town">
        <h2>
          <span aria-hidden="true">⌂ </span>
          {G.welcomeTownHeading}
        </h2>
        <p>{G.welcomeTown}</p>
      </div>
      <p className="notice" data-testid="welcome-region">
        {region ? G.welcomeRegion(region) : G.welcomeRegionUnknown}
      </p>
      <p>{G.welcomePlan}</p>
      <p className="hint">{G.welcomeNoGifts}</p>
      <button type="button" className="btn btn--primary btn--block" disabled={busy} onClick={() => void begin()} data-testid="welcome-begin">
        {busy ? G.welcomeSaving : G.welcomeBegin}
      </button>
    </section>
  );
}
