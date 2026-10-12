/**
 * `resolve(input) → output`: the pure entry point (chunk 10).
 *
 * One synchronous pass: validate, normalize, build tick-zero state, run ticks in
 * TICK_PHASE_ORDER until an end condition fires (chunk 13, outcome.ts END_CONDITIONS: an
 * attacker reached the core, the party is wiped, or TICK_CAP = battleLengthCapSeconds ×
 * tickRate ticks ran — a stalemate), then return the outcome, the final state and the log. Nothing is written anywhere; nothing is read
 * from anywhere but `input`. Calling it twice with the same input returns structurally
 * identical outputs — a test byte-compares the serialization across 100 runs and across
 * processes.
 */
import type { AbilityArchetype } from "./battlefield.js";
import { RESOLVER_VERSION } from "./version.js";
import { endOfTick } from "./hooks.js";
import { assertResolveInput, normalizeInput, type ResolveInput } from "./input.js";
import type { LogEvent } from "./log.js";
import { fightDepth, outcomeKindOf, type EndReason, type ResolveOutcome } from "./outcome.js";
import { initialState } from "./state.js";
import { keyframe, runTick } from "./tick.js";

export type { EndReason, ResolveOutcome } from "./outcome.js";

export interface UnitSummary {
  readonly id: number;
  readonly side: "attacker" | "defender";
  readonly ref: string;
  readonly typeId: string;
  readonly mergeLevel: number;
  /** Chunk 13 (v8, QA-13 S3): its ability's archetype — the replay labels carry it so an `ab` row can be checked against its caster. */
  readonly ability: AbilityArchetype;
  readonly x: number;
  readonly y: number;
  /** HP it brought into the fight (chunk 13: the replay's tick-zero HP). */
  readonly startHp: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly alive: boolean;
  /** Attackers: the tick they first stood on a core cell, or −1. */
  readonly reachedCoreTick: number;
  /** The tick the unit died on (phase 8), or −1. */
  readonly diedTick: number;
}

export interface FenceSummary {
  readonly f: number;
  readonly ref: string;
  readonly segment: number;
  readonly tierId: string;
  readonly category: string;
  readonly startHp: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly intact: boolean;
  readonly brokenTick: number;
}

export interface TrapSummary {
  readonly i: number;
  readonly ref: string;
  readonly typeId: string;
  /** Where it lies (fixed-point centre of its cell). */
  readonly x: number;
  readonly y: number;
  readonly spent: boolean;
  /** The tick it fired or was nullified on, or −1. */
  readonly spentTick: number;
}

export interface ResolveOutput {
  readonly resolverVersion: number;
  readonly tickRate: number;
  readonly tickCap: number;
  /** Keyframe cadence in ticks (LOG_KEYFRAME_INTERVAL converted). */
  readonly keyframeInterval: number;
  /** Ticks simulated (= tickCap unless an end condition fired earlier). */
  readonly ticks: number;
  readonly end: EndReason;
  /** Chunk 13: which end condition, on which tick, and how deep the party got. */
  readonly outcome: ResolveOutcome;
  readonly units: readonly UnitSummary[];
  readonly fences: readonly FenceSummary[];
  readonly traps: readonly TrapSummary[];
  readonly log: readonly LogEvent[];
  /** PHASE-2 §36 (QA S3): the fight's integer work counts (ticks included). Not part of the log or the golden text. */
  readonly work: { readonly ticks: number; readonly unitTicks: number; readonly pathSearches: number; readonly pathExpansions: number };
}

export function resolve(rawInput: unknown): ResolveOutput {
  assertResolveInput(rawInput);
  const input: ResolveInput = normalizeInput(rawInput);
  const state = initialState(input);
  const fenceStartHp = state.fences.map((f) => f.hp);
  const log: LogEvent[] = [];
  for (const u of state.units) log.push({ t: 0, k: "spawn", u: u.id, x: u.x, y: u.y });

  let end: EndReason = "tick_cap";
  let ticks = 0;
  while (state.tick < state.tickCap) {
    runTick(state, log);
    ticks = state.tick + 1;
    const reason = endOfTick(state);
    if (reason !== null) {
      end = reason;
      if (ticks % state.keyframeInterval !== 0 && ticks !== state.tickCap) keyframe(state, log);
      state.tick++;
      break;
    }
    state.tick++;
  }
  const { depth, deepestUnit } = fightDepth(state, end);

  return {
    resolverVersion: RESOLVER_VERSION,
    tickRate: state.tickRate,
    tickCap: state.tickCap,
    keyframeInterval: state.keyframeInterval,
    ticks,
    end,
    outcome: { kind: outcomeKindOf(end), end, endTick: ticks - 1, depth, deepestUnit },
    units: state.units.map((u) => ({
      id: u.id,
      side: u.side,
      ref: u.ref,
      typeId: u.typeId,
      mergeLevel: u.mergeLevel,
      ability: u.ability.archetype,
      x: u.x,
      y: u.y,
      startHp: u.startHp,
      hp: u.hp,
      maxHp: u.maxHp,
      alive: u.alive,
      reachedCoreTick: u.reachedCoreTick,
      diedTick: u.diedTick,
    })),
    fences: state.fences.map((f) => ({ f: f.index, ref: f.ref, segment: f.segment, tierId: f.tierId, category: f.category, startHp: fenceStartHp[f.index]!, hp: f.hp, maxHp: f.maxHp, intact: f.intact, brokenTick: f.brokenTick })),
    traps: state.traps.map((t) => ({ i: t.index, ref: t.ref, typeId: t.typeId, x: t.pos.x, y: t.pos.y, spent: t.spent, spentTick: t.spentTick })),
    log,
    work: { ticks, ...state.work },
  };
}
