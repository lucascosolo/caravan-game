/**
 * One tick of the simulation (chunk 10).
 *
 * TICK_PHASE_ORDER — fixed here, in this order, forever (changing it changes every replay):
 *   1. retarget                 — an attacker re-evaluates its stance target ONLY when the
 *                                 current one is invalid (dead / spent / unreachable / none).
 *   2. path recompute (if due)  — every PATH_RECOMPUTE_INTERVAL ticks (tick % interval === 0,
 *                                 the same tick for every unit), plus immediately for a unit
 *                                 whose target changed, plus for every unit on the tick after
 *                                 a fence segment broke. Never at a data-dependent cadence.
 *   3. movement                 — continuous, fixed-point, sub-cell steps along the smoothed
 *                                 route; no unit–unit collision; fences and bounds only.
 *   4. trap triggers            — chunk 11 (traps.ts): swept-path intersection against each
 *                                 attacker's sweep polyline, fire once, spend, siege nullify.
 *   5. posted-unit aggro/leash  — chunk 11 (posted.ts): the three defensive stances, aggro
 *                                 acquisition, leash pursuit, disengage-and-return, and the
 *                                 posted units' own movement.
 *   6. attack cooldowns, damage — every living unit, in id order: its cooldown counts down;
 *                                 when ready it hits the nearest enemy unit within reach
 *                                 (combat.ts ATTACK_TARGET_SELECTION, every stance) or, failing
 *                                 that, the fence it is breaching. ATTACK_PRIORITY (QA-11 D2):
 *                                 a breacher switches from the fence only to a unit that has
 *                                 the breacher in ITS reach — it fights back against what can
 *                                 hurt it; a post that cannot touch it does not shield the fence.
 *                                 SIMULTANEOUS_DAMAGE: every hit this tick resolves against
 *                                 start-of-tick life — a unit whose HP hit 0 earlier in this
 *                                 phase still fires, so mutual kills happen; HP floors at 0.
 *   7. abilities                — chunk 12 (abilities.ts): every living unit whose ability is
 *                                 ready AND satisfiable fires, decided in ascending id against
 *                                 the state at the start of phase 7, applied damage-first
 *                                 (every non-heal in id order, then every heal in id order).
 *                                 An attacker's dash is tested against the traps right there,
 *                                 with phase 4's rules (DASH_SPRINGS_TRAPS, QA-12 B1).
 *   8. death resolution         — fence destruction (hp ≤ 0 → broken; the grid is rebuilt
 *                                 and every path is recomputed next tick), then unit death
 *                                 (hp ≤ 0 → dead: `unit_died`, out of targeting; an attacker
 *                                 holding on it retargets in phase 1, a guard pursuing it
 *                                 disengages in phase 5, both next tick).
 *   then a keyframe every keyframeInterval ticks and on the last tick.
 *
 * Within every phase, units are visited in ASCENDING UNIT ID and nothing else; every "the
 * nearest X" picks the LOWEST ID (or lowest trap index) on an exact tie. Those two rules
 * are the only tie-breaks the tick loop has, and tests pin both.
 *
 * REACH (chunk 11): every "within range/radius" test between units, and between a unit
 * and a trap, compares squared centre distance against (radius + unitRadius)²; the leash
 * and the hysteresis radius are measured on the unit's own centre against its post. An
 * attacker whose unit target is within its reach holds (MOVEMENT_HOLD) and phase 6 makes
 * it hit.
 *
 * RETARGET_RULE fallback chain (documented so chunk 11 keeps it):
 *   nearest : nearest living posted unit → the core
 *   traps   : nearest unspent trap → nearest living posted unit → the core
 *   core    : the core
 * A candidate that proved unreachable (no route even by breaching — only an anchor or a
 * sealed pocket can cause it) is skipped for the rest of the fight.
 *
 * MOVEMENT_HOLD: an attacker whose target is a unit within its attack range does not move
 * (it is engaged; chunk 11 makes it attack). One whose route is blocked by an intact
 * segment stands in the adjacent cell and breaches. One with no route left has arrived.
 *
 * MOVEMENT_LEG (QA-10 S2): a unit advances along its current waypoint leg PARAMETRICALLY —
 * position = leg anchor + sign(d) × floor(|d| × progress / len) per axis (`legOffset`),
 * where the anchor is where it stood when the leg began and len = isqrt(|d|²) is fixed for
 * the leg — never by re-aiming from its last rounded position. Rounding is therefore < 1 unit off the exact line for
 * the whole leg, and the leg itself was accepted by smoothing with LOS_LEG_MARGIN, so no
 * step can clip an intact cell's corner. When the leg's remaining length fits the tick's
 * budget the unit lands exactly on the waypoint and spends the surplus on the next leg
 * (QA-10 N1: arrival is `len − progress ≤ remaining`, so a step that would land exactly on
 * the waypoint consumes it in the same tick).
 *
 * FENCE_BLOCKS_PATHING price (QA-10 S1): a breach edge costs the distance the unit could
 * have walked in the ticks it will stand still — hits land on arrival and then every
 * cooldownTicks, the segment breaks on the last hit and the unit moves again on the NEXT
 * tick (phase 2 recompute precedes phase 3 movement, so that tick is not lost):
 *   stationary ticks = (hits − 1) × cooldownTicks + max(0, cooldownRemaining − 1)
 * (a cooldown of 1 fires on the arrival tick because phase 6 decrements before it checks).
 * The cooldownRemaining term is the unit's value when the path is planned — an
 * over-estimate of at most the ticks it walks before arriving; exact when it plans on
 * arrival, which is what the determinism probe measures.
 *
 * ROUTE_CHOICE (QA-10 S1, second half): the lattice prices a detour in Manhattan steps,
 * but the unit walks the string-pulled route, which can be far shorter (a two-cell
 * sidestep through a gap is 4 lattice steps ≈ 54 ticks on the lattice and ≈ 5 ticks on
 * foot). So when the best lattice route breaches, the best breach-free lattice route is
 * found too, both are smoothed, and the one with the lower MEASURED cost — smoothed
 * length plus the breach price above — is taken; an exact tie walks around (the gap is
 * what the defender built). Which segment to breach, when breaching wins, is still the
 * lattice's single-edge comparison. Two A* runs at most, only on a recompute whose
 * lattice route breaches.
 */
import { CORE_CENTER_CELL, cellCenter, cellKey, cellOf, isCoreCell, type Cell, type FixedPoint } from "./battlefield.js";
import { breachableFence, engaged, hitDamage, landFenceHit, nearestEnemyInReach, threatInReach } from "./combat.js";
import { COST_INFINITE, ceilDiv, isqrt } from "./fixed.js";
import { abilityPhase, fenceHitDamage, postedUnitPhase, trapTriggerPhase } from "./hooks.js";
import { logTarget, type LogEvent } from "./log.js";
import { advance, effectiveSpeed, tickEffects } from "./move.js";
import { sampleUnitDepth } from "./outcome.js";
import { BREACH_COST_MAX, CELL_FREE, findPath, smoothPath, type Waypoint } from "./path.js";
import { sameTarget, type SimState, type Target, type UnitState } from "./state.js";

export { legOffset } from "./move.js";

function distSqUnits(a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function targetValid(state: SimState, t: Target): boolean {
  if (t.kind === "core") return true;
  if (t.kind === "unit") return state.units[t.id]!.alive;
  return !state.traps[t.index]!.spent;
}

function isUnreachable(u: UnitState, t: Target): boolean {
  return u.unreachable.some((x) => sameTarget(x, t));
}

/** Nearest living posted unit by squared distance; exact tie → lowest id. */
function nearestDefender(state: SimState, u: UnitState): Target | null {
  let best: UnitState | null = null;
  let bestD = 0;
  for (let id = state.attackerCount; id < state.units.length; id++) {
    const d = state.units[id]!;
    if (!d.alive) continue;
    const t: Target = { kind: "unit", id };
    if (isUnreachable(u, t)) continue;
    const dd = distSqUnits(u, d);
    if (best === null || dd < bestD) {
      best = d;
      bestD = dd;
    }
  }
  return best === null ? null : { kind: "unit", id: best.id };
}

/** Nearest unspent trap by squared distance; exact tie → lowest trap index. */
function nearestTrap(state: SimState, u: UnitState): Target | null {
  let best = -1;
  let bestD = 0;
  for (const t of state.traps) {
    if (t.spent) continue;
    const target: Target = { kind: "trap", index: t.index };
    if (isUnreachable(u, target)) continue;
    const dd = distSqUnits(u, t.pos);
    if (best < 0 || dd < bestD) {
      best = t.index;
      bestD = dd;
    }
  }
  return best < 0 ? null : { kind: "trap", index: best };
}

function chooseTarget(state: SimState, u: UnitState): Target | null {
  const core: Target = { kind: "core" };
  const coreOrNull = isUnreachable(u, core) ? null : core;
  switch (u.stance) {
    case "nearest":
      return nearestDefender(state, u) ?? coreOrNull;
    case "traps":
      return nearestTrap(state, u) ?? nearestDefender(state, u) ?? coreOrNull;
    case "core":
      return coreOrNull;
    default:
      return null;
  }
}

function targetCell(state: SimState, t: Target): Cell {
  if (t.kind === "core") return CORE_CENTER_CELL;
  if (t.kind === "unit") {
    const d = state.units[t.id]!;
    return cellOf({ x: d.x, y: d.y });
  }
  return state.traps[t.index]!.cell;
}


// ─── Phase 1 ────────────────────────────────────────────────────────────────────────

export function retargetPhase(state: SimState, log: LogEvent[]): void {
  for (let id = 0; id < state.attackerCount; id++) {
    const u = state.units[id]!;
    if (!u.alive) continue;
    if (u.target !== null && targetValid(state, u.target)) continue;
    const next = chooseTarget(state, u);
    if (sameTarget(next, u.target)) continue;
    u.target = next;
    u.pathDirty = true;
    u.waypoints = [];
    u.legLen = -1;
    u.breaching = -1;
    log.push({ t: state.tick, k: "target", u: id, target: logTarget(next) });
  }
}

// ─── Phase 2 ────────────────────────────────────────────────────────────────────────

function sameRoute(a: readonly Waypoint[], b: readonly Waypoint[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const p = a[i]!;
    const q = b[i]!;
    if (p.x !== q.x || p.y !== q.y || p.breach !== q.breach) return false;
  }
  return true;
}

/**
 * FENCE_BLOCKS_PATHING cost (see header): the distance (fixed cells) the unit could have
 * walked in the ticks it will stand still to destroy the segment,
 *   ((hits − 1) × cooldownTicks + max(0, cooldownRemaining − 1)) × speedPerTick,
 * hits = ⌈hp / damage per hit⌉. Clamped to BREACH_COST_MAX: a breakable segment is never
 * priced as a wall, however sturdy (QA-10 S3). The factors are bounded by input validation
 * (INPUT_BOUNDS), so the product is a safe integer before the clamp.
 */
export function breachCostFor(state: SimState, u: UnitState): (fenceIndex: number) => number {
  return (fenceIndex: number): number => {
    const fence = state.fences[fenceIndex]!;
    const hits = ceilDiv(fence.hp, fenceHitDamage(state, u, fence));
    const waitTicks = (hits > 1 ? hits - 1 : 0) * u.cooldownTicks + (u.cooldownRemaining > 1 ? u.cooldownRemaining - 1 : 0);
    const cost = waitTicks * u.speedPerTick;
    return cost > BREACH_COST_MAX ? BREACH_COST_MAX : cost;
  };
}

/**
 * ROUTE_CHOICE measure of a smoothed route from `from`: the walked length (sum of integer
 * leg lengths, the same isqrt movement uses) plus the breach price of every segment on it.
 */
export function routeCost(from: FixedPoint, route: readonly Waypoint[], breachCost: (fenceIndex: number) => number): number {
  let total = 0;
  let prev: FixedPoint = from;
  for (const wp of route) {
    const dx = wp.x - prev.x;
    const dy = wp.y - prev.y;
    total += isqrt(dx * dx + dy * dy);
    if (wp.breach >= 0) total += breachCost(wp.breach);
    prev = wp;
  }
  return total;
}

const noBreach = (): number => COST_INFINITE;

/**
 * Plan a unit's route (see ROUTE_CHOICE): null when the goal is unreachable even by
 * breaching. Exported for tests.
 */
export function planRoute(state: SimState, u: UnitState, from: FixedPoint, goal: Cell): Waypoint[] | null {
  const breachCost = breachCostFor(state, u);
  const steps = findPath(state.grid, cellOf(from), goal, breachCost, state.work);
  if (steps === null) return null;
  let route = smoothPath(state.grid, from, steps);
  if (steps.some((s) => s.breach >= 0)) {
    const around = findPath(state.grid, cellOf(from), goal, noBreach, state.work);
    if (around !== null) {
      const routeAround = smoothPath(state.grid, from, around);
      if (routeCost(from, routeAround, breachCost) <= routeCost(from, route, breachCost)) route = routeAround;
    }
  }
  // Already inside the goal cell: finish at its centre (the route would otherwise be empty
  // and the unit would stop wherever it entered the cell).
  if (steps.length === 0) {
    const c = cellCenter(goal);
    if (c.x !== from.x || c.y !== from.y) route.push({ x: c.x, y: c.y, breach: -1 });
  }
  return route;
}

export function pathPhase(state: SimState, log: LogEvent[]): void {
  const intervalDue = state.tick % state.pathRecomputeInterval === 0;
  for (let id = 0; id < state.attackerCount; id++) {
    const u = state.units[id]!;
    if (!u.alive) continue;
    const due = intervalDue || u.pathDirty || state.fenceBrokeSinceRecompute;
    if (!due) continue;
    u.pathDirty = false;
    if (u.target === null) {
      if (u.waypoints.length > 0) {
        u.waypoints = [];
        u.legLen = -1;
        log.push({ t: state.tick, k: "path", u: id, speed: u.speedInForce, wp: [] });
      }
      continue;
    }
    if (engaged(state, u)) {
      // In range of its unit target: no route needed. Dropped silently; `hold` logs the stop.
      u.waypoints = [];
      u.legLen = -1;
      u.breaching = -1;
      continue;
    }
    const from: FixedPoint = { x: u.x, y: u.y };
    const route = planRoute(state, u, from, targetCell(state, u.target));
    if (route === null) {
      u.unreachable.push(u.target);
      u.target = null;
      u.waypoints = [];
      u.legLen = -1;
      u.breaching = -1;
      log.push({ t: state.tick, k: "target", u: id, target: null });
      continue;
    }
    if (!sameRoute(route, u.waypoints)) {
      // A new route starts a new leg from where the unit stands now; an unchanged route
      // keeps the leg in progress (and logs nothing — see log.ts INTERPOLATION CONTRACT).
      u.waypoints = route;
      u.legLen = -1;
      log.push({ t: state.tick, k: "path", u: id, speed: u.speedInForce, wp: route.map((w) => [w.x, w.y, w.breach] as const) });
    }
  }
  state.fenceBrokeSinceRecompute = false;
}

// ─── Phase 3 ────────────────────────────────────────────────────────────────────────

/**
 * Attacker movement (the stepping itself is move.ts `advance`, shared with posted units).
 * A rooted unit's budget is 0 and a slowed unit's is reduced (move.ts EFFECTS); the sweep
 * polyline recorded here is what phase 4 tests against the traps.
 */
export function movementPhase(state: SimState, log: LogEvent[]): void {
  for (let id = 0; id < state.attackerCount; id++) {
    const u = state.units[id]!;
    if (!u.alive) continue;
    let moved = false;
    u.breaching = -1;
    u.sweep = [{ x: u.x, y: u.y }];
    if (!engaged(state, u)) moved = advance(state, u, effectiveSpeed(u));
    tickEffects(state, u, log);
    const holding = !moved;
    if (holding !== u.holding) {
      u.holding = holding;
      log.push({ t: state.tick, k: "hold", u: id, holding });
    }
    if (u.reachedCoreTick < 0 && isCoreCell(cellOf({ x: u.x, y: u.y }))) {
      u.reachedCoreTick = state.tick;
      log.push({ t: state.tick, k: "core_reached", u: id });
    }
    sampleUnitDepth(u, u.x, u.y); // DEPTH_SAMPLE (outcome.ts): where it stood alive after moving
  }
}

// ─── Phase 6 ────────────────────────────────────────────────────────────────────────

/**
 * ATTACK_COOLDOWN: the counter decrements first, then a ready unit (0) fires if it has
 * something in reach, and the counter resets to cooldownTicks — so the first hit lands
 * on contact and the next every cooldownTicks (a cooldown of 1 fires every tick). A ready
 * unit with nothing in reach stays ready. One hit per unit per tick, at most.
 */
export function attackPhase(state: SimState, log: LogEvent[]): void {
  for (const u of state.units) {
    if (!u.alive) continue;
    if (u.cooldownRemaining > 0) u.cooldownRemaining--;
    if (u.cooldownRemaining > 0) continue;
    const fence = breachableFence(state, u);
    // ATTACK_PRIORITY (combat.ts, QA-11 D2): a breacher answers only a unit that can reach it.
    const v = fence === null ? nearestEnemyInReach(state, u) : threatInReach(state, u);
    if (v !== null) {
      const damage = hitDamage(state, u, v);
      v.hp = v.hp - damage < 0 ? 0 : v.hp - damage;
      u.cooldownRemaining = u.cooldownTicks;
      log.push({ t: state.tick, k: "hit", u: u.id, v: v.id, damage, hp: v.hp });
      continue;
    }
    if (fence === null) continue;
    const damage = fenceHitDamage(state, u, fence); // capped: combat.ts FENCE_HIT_SEGMENT_CAP
    landFenceHit(state, u, fence, damage);
    u.cooldownRemaining = u.cooldownTicks;
    log.push({ t: state.tick, k: "fence_hit", u: u.id, f: fence.index, damage, hp: fence.hp });
  }
}

// ─── Phase 8 ────────────────────────────────────────────────────────────────────────

export function deathPhase(state: SimState, log: LogEvent[]): void {
  for (const fence of state.fences) {
    if (!fence.intact || fence.hp > 0) continue;
    fence.intact = false;
    fence.brokenTick = state.tick;
    state.grid[cellKey(fence.cell)] = CELL_FREE;
    state.fenceBrokeSinceRecompute = true;
    log.push({ t: state.tick, k: "fence_broken", f: fence.index });
    for (const u of state.units) {
      if (u.breaching === fence.index) {
        u.breaching = -1;
        u.pathDirty = true;
      }
      // Attackers are re-planned by `fenceBrokeSinceRecompute` (phase 2); posted units read `pathDirty` (phase 5).
      if (u.side === "defender") u.pathDirty = true;
    }
  }
  // UNIT_DEATH: every unit at 0 HP dies now, in id order, after all of this tick's hits
  // landed (SIMULTANEOUS_DAMAGE). It leaves targeting (alive = false is what every target
  // and reach test reads) and drops its own target, route and breach.
  for (const u of state.units) {
    if (!u.alive || u.hp > 0) continue;
    u.alive = false;
    u.diedTick = state.tick;
    u.target = null;
    u.waypoints = [];
    u.legLen = -1;
    u.breaching = -1;
    u.postMode = "idle";
    log.push({ t: state.tick, k: "unit_died", u: u.id });
  }
}

// ─── The tick ───────────────────────────────────────────────────────────────────────

export function keyframe(state: SimState, log: LogEvent[]): void {
  log.push({
    t: state.tick,
    k: "keyframe",
    // `ab` (chunk 12): ticks from the next tick until the ability may fire (0 = ready).
    units: state.units.map((u) => ({ u: u.id, x: u.x, y: u.y, hp: u.hp, alive: u.alive, cd: u.cooldownRemaining, slow: u.slowRemaining, root: u.rootRemaining, ab: u.abilityReadyTick > state.tick + 1 ? u.abilityReadyTick - state.tick - 1 : 0 })),
    fences: state.fences.map((f) => ({ f: f.index, hp: f.hp })),
    traps: state.traps.map((t) => ({ i: t.index, spent: t.spent })),
  });
}

/** Run every phase for `state.tick`, in TICK_PHASE_ORDER, then the keyframe if due. */
export function runTick(state: SimState, log: LogEvent[]): void {
  for (const u of state.units) if (u.alive) state.work.unitTicks++; // §36 work counter (never read by the sim)
  retargetPhase(state, log); // 1
  pathPhase(state, log); // 2
  movementPhase(state, log); // 3
  trapTriggerPhase(state, log); // 4
  postedUnitPhase(state, log); // 5
  attackPhase(state, log); // 6
  abilityPhase(state, log); // 7
  deathPhase(state, log); // 8
  const done = state.tick + 1;
  if (done % state.keyframeInterval === 0 || done === state.tickCap) keyframe(state, log);
}
