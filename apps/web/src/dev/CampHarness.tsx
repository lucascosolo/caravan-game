/**
 * C3 visual harness (dev only, never in the app bundle): the formation scene and a replay frame
 * drawn by the ONE iso renderer from fixture data, so the camp can be screenshot from a file://
 * URL with no server. Built by `vite build -c vite.harness.config.ts` (see that file).
 *
 * The formation is hand-placed on the round ring (circle package geometry); the replay frame is
 * the contract fixture's recorded fight (src/test/contract/replay.json) through the real replay
 * model, at a tick chosen by `?tick=` (default: just after the first fence breaks), so breaks,
 * traps and deaths sit exactly where the log puts them. `?view=formation|replay` picks one.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RING_SEGMENTS } from "@caravan/circle";
import { IsoCanvas, cellToWorld, EMPTY_SCENE, type IsoSceneState } from "../iso/index.ts";
import { CIRCLE_CAMP, CIRCLE_GEOMETRY } from "../screens/trail/FormationScreen.tsx";
import { REPLAY_CAMP, REPLAY_GEOMETRY, openReplay } from "../screens/replay/replayModel.ts";
import type { ReplayView } from "../api/replayTypes.ts";
import replayJson from "../test/contract/replay.json";
import "../theme.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "both";

/** Two open ring positions (the approved look test's gaps), every other non-wagon position fenced. */
const GAP_INDICES = new Set([3, 12]);
const formation: IsoSceneState = {
  ...EMPTY_SCENE,
  showRadii: false,
  fences: RING_SEGMENTS.filter((_, i) => !GAP_INDICES.has(i)).map((s, i) => ({ id: `f${i}`, cell: s.cell, tierId: i % 5 === 4 ? "fence.barbed_wire" : "fence.split_rail", hp: 400, maxHp: 400 })),
  posts: [
    { id: "p1", pos: cellToWorld({ x: 13, y: 16 }), typeId: "desert.sand_sharpshooter", mergeLevel: 1, stance: "hold", hpFraction: 1, aggroRadius: 4, leashDistance: 5, attackRange: 4 },
    { id: "p2", pos: cellToWorld({ x: 19, y: 15 }), typeId: "desert.sand_sharpshooter", mergeLevel: 2, stance: "guard", hpFraction: 1, aggroRadius: 4, leashDistance: 5, attackRange: 4 },
    { id: "p3", pos: cellToWorld({ x: 17, y: 19 }), typeId: "desert.well_digger", mergeLevel: 1, stance: "guard", hpFraction: 1, aggroRadius: 3, leashDistance: 4, attackRange: 1 },
  ],
  traps: [{ id: "t1", pos: cellToWorld({ x: 22, y: 19 }), typeId: "trap.jaw_trap" }],
};

function ReplayFrame(): JSX.Element {
  const open = openReplay(replayJson.body as unknown as ReplayView);
  if (!open.ok) return <p>replay fixture not renderable: {open.reason}</p>;
  const m = open.model;
  let firstBreak = 0;
  while (firstBreak < 20000 && (m.scene(firstBreak).brokenFences ?? []).length === 0) firstBreak += 5;
  const tick = Number(params.get("tick") ?? firstBreak + 2);
  return <IsoCanvas geometry={REPLAY_GEOMETRY} state={m.scene(tick)} label="Replay frame" openCamp={REPLAY_CAMP} />;
}

function Harness(): JSX.Element {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 16, padding: 0, background: "#1b1a17" }}>
      {view !== "replay" && (
        <section data-testid="harness-formation" style={{ width: 393, height: 700, position: "relative", ["--iso-h" as string]: "700px" }}>
          <IsoCanvas geometry={CIRCLE_GEOMETRY} state={formation} label="Formation" openCamp={CIRCLE_CAMP} />
        </section>
      )}
      {view !== "formation" && (
        <section data-testid="harness-replay" style={{ width: 393, height: 700, position: "relative", ["--iso-h" as string]: "700px" }}>
          <ReplayFrame />
        </section>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Harness />
  </StrictMode>,
);
