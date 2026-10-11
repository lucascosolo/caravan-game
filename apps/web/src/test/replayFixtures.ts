/**
 * Replay fixtures for component tests (chunk 22):
 *   - the REAL server bodies the contract test recorded (src/test/contract/replay*.json):
 *     a fight the real resolver fought, for the caravan's player and for the party's owner,
 *     and a fight the test double resolved (no log) — run through the client's guard;
 *   - golden logs from the resolver's own corpus (packages/resolver/golden), wrapped in a
 *     replay body exactly as the server's route builds one (labels from content), so the
 *     player is tested on fights with traps, fence breaks, abilities and every ending.
 */
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getFenceTier, getTrapType, getUnitType } from "@caravan/content";
import type { ReplayLog } from "@caravan/resolver/replay";
import { expectShape } from "../api/shape.ts";
import { replayShape } from "../api/replayShapes.ts";
import type { ReplayView, ReplayViewer } from "../api/replayTypes.ts";
import replayJson from "./contract/replay.json";
import replayOwnerJson from "./contract/replay-owner.json";
import replayNoLogJson from "./contract/replay-no-log.json";

export const replayCaravan = (): ReplayView => expectShape(replayShape, replayJson.body);
export const replayOwner = (): ReplayView => expectShape(replayShape, replayOwnerJson.body);
export const replayNoLog = (): ReplayView => expectShape(replayShape, replayNoLogJson.body);

const GOLDEN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../packages/resolver/golden");

export function goldenNames(): string[] {
  return readdirSync(GOLDEN_DIR)
    .filter((f) => f.endsWith(".golden.json"))
    .map((f) => f.replace(/\.golden\.json$/, ""))
    .sort();
}

export function goldenLog(name: string): ReplayLog {
  return (JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.golden.json`), "utf8")) as { replay: ReplayLog }).replay;
}

/** A replay body around a golden log, as GET /me/encounters/:jobId/replay builds it (routes/replay.ts). */
export function goldenView(name: string, viewer: ReplayViewer = "caravan", loot = 250): ReplayView {
  const log = goldenLog(name);
  const body = {
    jobId: `encounter:00000000-0000-4000-8000-000000000001:1`,
    viewer,
    tripId: "00000000-0000-4000-8000-000000000001",
    encounterIndex: 1,
    resolverVersion: log.resolverVersion,
    currentResolverVersion: log.resolverVersion,
    logFormat: log.v,
    renderable: true,
    reason: null,
    outcome: { kind: log.outcome.kind, depth: log.outcome.depth, endTick: log.outcome.endTick, loot: log.outcome.kind === "stalemate" ? 0 : loot },
    party: { partyId: "p", partyHash: "h", partySavedAt: "2026-10-11T12:00:00.000Z" },
    labels: {
      units: log.units.map((u) => ({ ...u, displayName: getUnitType(u.typeId)?.displayName ?? u.typeId, ability: getUnitType(u.typeId)?.ability.displayName ?? null })),
      fences: log.fences.map((f) => ({ ...f, displayName: getFenceTier(f.tierId)?.displayName ?? f.tierId })),
      traps: log.traps.map((t) => ({ ...t, displayName: getTrapType(t.typeId)?.displayName ?? t.typeId })),
    },
    log,
  };
  return expectShape(replayShape, body);
}
