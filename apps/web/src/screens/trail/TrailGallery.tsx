/**
 * Dev-only visual check of the trail and formation screens on kit v2 (C4b), from the test fixtures:
 * gallery-trail.html?s=map|candidates|formation|rideout. Not in the production build.
 */
import { CORE_CENTER_CELL, type Formation } from "@caravan/circle";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "../../theme.css";
import "../../ui/kit.css";
import type { Api } from "../../api/client.ts";
import type { CandidateMenuView, LayoutView, ManifestView } from "../../api/types.ts";
import { SessionProvider } from "../../auth/session.tsx";
import { survivorsManifest } from "../../test/circleFixtures.ts";
import { statusArranging, statusPacked } from "../../test/tripFixtures.ts";
import { RideOutPanel } from "../town/RideOutPanel.tsx";
import { CandidatesScreen } from "./CandidatesScreen.tsx";
import { FormationScreen } from "./FormationScreen.tsx";
import { fixtureCandidate, fixtureEncounter } from "./scoutFixture.ts";
import { TrailScreen } from "./TrailScreen.tsx";

const menu: CandidateMenuView = {
  tripId: "t1",
  encounterIndex: 2,
  searchSeq: 1,
  caravan: { rating: 1000, ratingPool: "living", band: { index: 1, low: 1000, high: 1099 } },
  centre: 1000,
  escalation: { applied: 0, perEncounter: 25, nextEncounter: 25 },
  bandWidthUsed: 100,
  widened: false,
  authoredOutsideBand: true,
  authoredShare: { authored: 3, of: 3, shareBp: 10_000, maxShareBp: 3_000 },
  authoredServed: null,
  candidates: [fixtureCandidate(1, "a".repeat(32)), fixtureCandidate(2, "b".repeat(32)), fixtureCandidate(3, "c".repeat(32))],
  searchedAtMs: Date.now(),
  reroll: { gate: "time", cooldownSeconds: 60, availableAtMs: Date.now() + 179_000, available: false },
  chosen: null,
};

const survivors = survivorsManifest();
const trip: ManifestView = { id: "m1", caravanId: "c1", encountersResolved: 1, createdAt: "", closedAt: null, packed: survivors, survivors, summary: { unitsAlive: 2, unitsDead: 1, trapsUnspent: 1, trapsSpent: 1, fencesIntact: 19, fencesDestroyed: 1 }, formations: [] };
const base = fixtureEncounter(2);
const scout = { ...base, scout: { ...base.scout, units: base.scout.units.map((u, i) => ({ ...u, edge: i % 2 ? ("east" as const) : ("north" as const) })) } };
const loaded: Formation = { v: 3, fences: [], traps: [{ ref: "t1", cell: { x: CORE_CENTER_CELL.x - 5, y: CORE_CENTER_CELL.y } }], posts: [{ ref: "u-rider", cell: { x: 12, y: 12 }, stance: "guard" }] };
const layout: LayoutView = {
  loaded,
  leftOut: [{ kind: "trap", typeId: "trap.spike_pit", instanceId: null, edge: "south", reason: "spent" }],
  savedSides: ["north", "south"],
  hintsOn: true,
  unavailable: null,
};

const api = new Proxy(
  {
    me: async () => ({ account: { id: "acc", username: "dev" }, caravans: [{ id: "c1", name: "x", region_id: "desert", units: [] }] }),
    tripStatus: async () => statusArranging(2),
    candidates: async () => ({ menu: null, searched: false }),
    formationIfAny: async () => null,
    saveFormation: async (_c: string, n: number, formation: Formation) => ({ formation: { manifestId: "m1", encounterIndex: n, formation, hash: "h", gaps: [], committedAt: null } }),
  },
  { get: (t, k) => (k in t ? (t as Record<string | symbol, unknown>)[k] : async () => new Promise(() => undefined)) },
) as unknown as Api;

function Screen({ s }: { readonly s: string }): JSX.Element {
  if (s === "map") return <TrailScreen api={api} />;
  if (s === "formation") return <FormationScreen api={api} caravanId="c1" trip={trip} encounterIndex={2} initial={null} layout={layout} scout={scout} autosaveMs={3_600_000} />;
  if (s === "rideout") return <RideOutPanel api={api} caravanId="c1" status={statusPacked()} onStarted={() => undefined} />;
  return <CandidatesScreen encounterIndex={2} menu={menu} busy={false} error={null} onSearchAgain={() => undefined} onChoose={() => undefined} />;
}

const stubFetch = (async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
const s = new URLSearchParams(location.search).get("s") ?? "candidates";

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
