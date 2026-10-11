/**
 * Replay fixtures for component tests (chunk 22):
 *   - the REAL server bodies the contract test recorded (src/test/contract/replay*.json):
 *     a fight the real resolver fought, for the caravan's player and for the party's owner,
 *     and a fight the test double resolved (no log) — run through the client's guard;
 *   - golden logs from the resolver's own corpus (packages/resolver/golden), wrapped in a
 *     replay body exactly as the server's route builds one (labels from content), so the
 *     player is tested on fights with traps, fence breaks, abilities and every ending.
 *
 * QA-22 S9: a golden body's `outcome` is the RESOLVER'S OUTPUT recorded beside the log in the
 * golden file (`golden.outcome`, what the server stores as the job result), never the log's own
 * copy — so "the end shows the recorded outcome" compares two records, not the log with itself.
 * The server suite (test/replay-ledger.test.ts) does the same against the ledger for 100+ fights.
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

interface GoldenFile {
  readonly replay: ReplayLog;
  /** The resolver's own outcome for the fight (its output, recorded beside the log). */
  readonly outcome: { readonly kind: "caravan_held" | "caravan_overrun" | "stalemate"; readonly depth: number; readonly endTick: number };
}

function golden(name: string): GoldenFile {
  return JSON.parse(readFileSync(path.join(GOLDEN_DIR, `${name}.golden.json`), "utf8")) as GoldenFile;
}

export function goldenLog(name: string): ReplayLog {
  return golden(name).replay;
}

/** What a body's `settled` says before the trip loop has folded a fight in (golden bodies have no ledger). */
export const NOT_APPLIED = { source: "ledger", applied: false, coin: [], coinLost: null, reputation: [], ladder: [], unlockPoints: [], deMerged: [], destroyed: [], trip: null } as const;

/** A replay body around a golden log, as GET /me/encounters/:jobId/replay builds it (routes/replay.ts). */
export function goldenView(name: string, viewer: ReplayViewer = "caravan", loot = 250): ReplayView {
  const g = golden(name);
  const log = g.replay;
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
    outcome: { kind: g.outcome.kind, depth: g.outcome.depth, endTick: g.outcome.endTick, loot: g.outcome.kind === "stalemate" ? 0 : loot },
    party: { partyId: "p", partyHash: "h", partySavedAt: "2026-10-11T12:00:00.000Z" },
    labels: {
      // The golden corpus records no stances or siege (the server's labels come from the job's snapshots).
      units: log.units.map((u) => ({ ...u, displayName: getUnitType(u.typeId)?.displayName ?? u.typeId, ability: getUnitType(u.typeId)?.ability.displayName ?? null, stance: null })),
      fences: log.fences.map((f) => ({ ...f, displayName: getFenceTier(f.tierId)?.displayName ?? f.tierId })),
      traps: log.traps.map((t) => ({ ...t, displayName: getTrapType(t.typeId)?.displayName ?? t.typeId, category: getTrapType(t.typeId)?.category ?? null })),
      siege: [],
    },
    settled: NOT_APPLIED,
    log,
  };
  return expectShape(replayShape, body);
}
