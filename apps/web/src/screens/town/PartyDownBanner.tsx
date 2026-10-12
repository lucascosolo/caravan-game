/**
 * Final play-test review r2 D2: the Town says so when the standing party is down.
 *
 * A party loses the slots of units that were lost or merged (round 1 S2's self-repair); when the
 * last one goes, the party is "down" and is served nowhere until its owner adds a unit. The
 * orchestrator decided against refilling it automatically (the template is the owner's choice),
 * so this banner offers the refill as one tap: "Raise from my roster" saves the server's
 * `suggested` party (the saved one plus free unlocked roster units and unlocked siege) through
 * the ordinary `PUT /me/party`, the same rule the guide's raise uses (`prefillParty`).
 *
 * Shown only while the guide is not running (the guide has its own party step), and only when
 * the party really is empty. A failed read shows nothing: the inbox notice still says it.
 */
import { useCallback, useEffect, useState } from "react";
import type { Api } from "../../api/client.ts";
import type { PartyConfigBody, PartyView } from "../../api/types.ts";
import { prefillParty } from "../../onboarding/ShellGuide.tsx";
import { navigate } from "../../shell/router.tsx";
import { STRINGS } from "../../strings.ts";

const T = STRINGS.town;

/** The party the banner's one tap would save, or null when there is nothing to raise it from. */
export function raiseConfig(view: PartyView): PartyConfigBody | null {
  const suggested = view.suggested ?? null;
  if (suggested && suggested.units.length > 0) return suggested;
  const filled = prefillParty(view);
  return filled && filled.units.length > 0 ? filled : null;
}

export function PartyDownBanner({ api, guideActive, rosterVersion }: { api: Api; guideActive: boolean; rosterVersion: number }): JSX.Element | null {
  const [view, setView] = useState<PartyView | null>(null);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "raised"; n: number } | { kind: "failed"; message: string }>({ kind: "idle" });

  const read = useCallback(async (): Promise<void> => {
    try {
      setView((await api.party()).party);
    } catch {
      setView(null);
    }
  }, [api]);

  useEffect(() => {
    if (guideActive) return;
    void read();
  }, [read, guideActive, rosterVersion]);

  if (guideActive) return null;
  if (state.kind === "raised") {
    return (
      <p className="notice" role="status" data-testid="party-raised-banner">
        {T.partyRaised(state.n)}
      </p>
    );
  }
  if (!view || view.config.units.length > 0) return null;
  const config = raiseConfig(view);

  const raise = async (): Promise<void> => {
    if (!config) return;
    setState({ kind: "busy" });
    try {
      const saved = (await api.saveParty(config)).party;
      setView(saved);
      setState({ kind: "raised", n: saved.config.units.length });
    } catch (err) {
      setState({ kind: "failed", message: err instanceof Error ? err.message : STRINGS.app.genericError });
    }
  };

  return (
    <div className="card card--danger" role="region" aria-labelledby="party-down-title" data-testid="party-down-banner">
      <h2 id="party-down-title">{T.partyDownTitle}</h2>
      <p>{config ? T.partyDownBody : T.partyDownNoUnits}</p>
      {config && (
        <button type="button" className="btn btn--primary btn--block" disabled={state.kind === "busy"} onClick={() => void raise()} data-testid="party-down-raise">
          {state.kind === "busy" ? T.partyRaising : T.partyDownRaise(config.units.length)}
        </button>
      )}
      <button type="button" className="btn btn--block" onClick={() => navigate("party")}>
        {T.partyDownOpen}
      </button>
      {state.kind === "failed" && (
        <p className="error" role="alert">
          {state.message}
        </p>
      )}
    </div>
  );
}
