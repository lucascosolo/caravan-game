/**
 * Dev-only visual check of the replay and post-fight screens on kit v2 (C4c), from the contract
 * fixtures: gallery-results.html?s=replay|result|decide|delivered|overrun. Not in the production build.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../theme.css";
import "../../ui/kit.css";
import type { Api } from "../../api/client.ts";
import { SessionProvider } from "../../auth/session.tsx";
import { expectShape } from "../../api/shape.ts";
import { replayShape } from "../../api/replayShapes.ts";
import replayJson from "../../test/contract/replay.json";
import { bankAfter2, previewAfter1, statusBanked, statusDecide, statusOverrun } from "../../test/tripFixtures.ts";
import { BankOrPushScreen } from "../trail/BankOrPushScreen.tsx";
import { EncounterResult } from "../trail/EncounterResult.tsx";
import { TripSummary } from "../trail/TripSummary.tsx";
import { ReplayPlayer } from "./ReplayPlayer.tsx";

const replay = expectShape(replayShape, replayJson.body);
const api = {
  replay: async () => replay,
  tripPreview: async () => previewAfter1(),
} as unknown as Api;

function Screen({ s }: { readonly s: string }): JSX.Element {
  if (s === "replay") return <ReplayPlayer jobId={replay.jobId} api={api} autoPlay initialSpeed={4} />;
  if (s === "decide") {
    const p = previewAfter1();
    return <BankOrPushScreen api={api} caravanId="c1" tripId={p.tripId} encounterIndex={p.decisionFor ?? 1} onDecided={() => undefined} />;
  }
  if (s === "delivered") return <TripSummary trip={statusBanked().trip!} bank={bankAfter2()} />;
  if (s === "overrun") return <TripSummary trip={statusOverrun().trip!} />;
  return <EncounterResult encounter={statusDecide().trip!.encounters[0]!} api={api} />;
}

const stubFetch = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
const s = new URLSearchParams(location.search).get("s") ?? "result";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionProvider fetchImpl={stubFetch} autoResume={false}>
      <div className="shell cv-root" style={{ minHeight: "100vh" }}>
        <main className="cv-page" style={{ paddingTop: 16 }}>
          <Screen s={s} />
        </main>
      </div>
    </SessionProvider>
  </StrictMode>,
);
