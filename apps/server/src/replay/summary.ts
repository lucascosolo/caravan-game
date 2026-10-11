/**
 * PHASE-2 §36 — the end-card tally of a stored replay, recorded beside it at completion so the
 * fight keeps its results summary after its tick log is compacted away (migration 022).
 *
 * `replayTally(log)` is ONE pass over the stored LOG_FORMAT rows (no interpolation, no reader):
 * who fell (`d` rows), which segments broke (`fb`), which traps fired (`tf`) and which the
 * party's siege made harmless without firing (`tn`), whether a raider reached the core (`c`), and the deepest raider the
 * outcome names. It is the same tally the web client's replay player derives from the reader's
 * events (apps/web/src/screens/replay/replayModel.ts `tally`); a server test pins the two equal
 * over real fights. The worker stores it in the job's immutable result (`result.replay.tally`);
 * the compaction copies it from there into encounter_log_summary — never from a caller.
 */
import type { ReplayLog } from "@caravan/resolver";

export interface ReplayTallyRecord {
  readonly raiders: number;
  readonly raidersFallen: number;
  readonly defenders: number;
  readonly defendersFallen: number;
  readonly fences: number;
  readonly fencesBroken: number;
  readonly traps: number;
  /** Traps that fired (a siege-nullified trap is not counted here, as in the web player). */
  readonly trapsSprung: number;
  /** Traps the party's siege made harmless (and that never fired). */
  readonly trapsNullified: number;
  readonly coreReached: boolean;
  /** The deepest raider (outcome.deepestUnit), by its label: null when the log names none. */
  readonly deepest: { readonly u: number; readonly side: "attacker" | "defender"; readonly typeId: string } | null;
}

export function replayTally(log: Pick<ReplayLog, "units" | "fences" | "traps" | "events" | "outcome">): ReplayTallyRecord {
  const died = new Set<number>();
  const broke = new Set<number>();
  const fired = new Set<number>();
  const nullified = new Set<number>();
  let core = false;
  for (const row of log.events) {
    const code = row[1];
    if (code === "d") died.add(row[2] as number);
    else if (code === "fb") broke.add(row[2] as number);
    else if (code === "tf") fired.add(row[2] as number);
    else if (code === "tn") nullified.add(row[2] as number);
    else if (code === "c") core = true;
  }
  const isRaider = (u: number): boolean => log.units[u]?.side === "attacker";
  const raiders = log.units.filter((u) => u.side === "attacker").length;
  const fallen = [...died];
  const d = log.outcome.deepestUnit;
  const deepestLabel = d >= 0 ? log.units[d] : undefined;
  return {
    raiders,
    raidersFallen: fallen.filter(isRaider).length,
    defenders: log.units.length - raiders,
    defendersFallen: fallen.filter((u) => !isRaider(u)).length,
    fences: log.fences.length,
    fencesBroken: broke.size,
    traps: log.traps.length,
    trapsSprung: fired.size,
    trapsNullified: [...nullified].filter((i) => !fired.has(i)).length,
    coreReached: core,
    deepest: deepestLabel ? { u: d, side: deepestLabel.side, typeId: deepestLabel.typeId } : null,
  };
}
