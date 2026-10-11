import { TUNABLES, REGION_IDS } from "../../packages/content/src/index.js";
import { authoredParties, freshRoster, manifestOf, servedMenu, guidePick, oneFight, bestFight, GUIDED, SKILLED, NAIVE, starterTypes, share } from "./sweep.js";
const t0 = performance.now();
let n = 0, held = 0, heldBest = 0, fights = 0;
const start = TUNABLES.REPUTATION_START;
for (const region of REGION_IDS) for (const refugee of starterTypes(region)) for (const traps of [1]) for (let s = 0; s < 6; s++) {
  const roster = freshRoster(region, refugee, traps);
  const m = manifestOf(roster);
  const { centre, menu } = servedMenu(`c-${region}-${s}`, `t-${s}`, start, 1);
  const p = guidePick(menu);
  const r = oneFight(m, p, GUIDED)!;
  const b = bestFight(m, p, SKILLED)!;
  n++; fights += 1 + SKILLED.length;
  if (r.kind !== "caravan_overrun") held++;
  if (b.kind !== "caravan_overrun") heldBest++;
  if (s === 0) console.log(region, refugee, centre, p.spec.username, r.kind, r.depth, r.endTick, "best:", b.layout, b.kind, b.endTick);
}
console.log({ n, held, heldBest, ms: (performance.now() - t0) / fights });
