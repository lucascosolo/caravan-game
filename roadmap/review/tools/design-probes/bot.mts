/**
 * Studio design review: an API-level player for the hosted production server (port 3935).
 * Plays real trips through the real routes (the server's real resolver decides every fight).
 * The bot only chooses what a player chooses: what to pack, which candidate, the circle, bank/push,
 * refugees, unlocks, mercenaries, merges, and the standing party.
 *
 *   tsx bot.mts --user NAME --region desert --persona guide|solver|naive|designer --trips N [--register]
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { TUNABLES, getUnitType, CONTENT } from "../../../../packages/content/src/index.js";
import { guidePick, guideStakesOf, pushAdvice, raiseCell, raiseUnits, starterEdges, isUnitAlive, type Formation, type Manifest, type Party } from "../../../../packages/circle/src/index.js";
import { GUIDED, NAIVE, SKILLED, fight, better, scoutOf, type FightResult, type ServedParty } from "../../../../scripts/balance/sweep.js";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1]! : d; };
const USER = arg("user")!;
const REGION = arg("region", "desert")!;
const PERSONA = arg("persona", "guide")! as "guide" | "solver" | "naive" | "designer";
const TRIPS = Number(arg("trips", "3"));
const SMART = arg("smart", "0") === "1";
const DAY = arg("day", "0");
const BASE = arg("base", "http://127.0.0.1:3935/api")!;
const DIR = process.env.STUDIO_DIR ?? "./studio-out";
const LOG = `${DIR}/logs/bot-${USER}.log`;
const JSONL = `${DIR}/logs/bot-${USER}.jsonl`;
const PW = "studio-design-pw-" + USER;
const log = (...a: unknown[]) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); appendFileSync(LOG, s + "\n"); console.log(s); };
const rec = (o: Record<string, unknown>) => appendFileSync(JSONL, JSON.stringify({ t: new Date().toISOString(), day: DAY, user: USER, persona: PERSONA, ...o }) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let token = "";
async function api(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; body: any }> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? (method === "GET" ? undefined : "{}") : JSON.stringify(body) });
    const text = await res.text();
    let b: any = null;
    try { b = text ? JSON.parse(text) : null; } catch { b = text; }
    if (res.status === 429) { await sleep(3000); continue; }
    if (res.status >= 400 && !okStatuses.includes(res.status)) log(`  ! ${res.status} ${method} ${path} ${JSON.stringify(b).slice(0, 300)}`);
    return { status: res.status, body: b };
  }
  throw new Error("rate limited");
}

async function login(): Promise<void> {
  let r = await api("POST", "/auth/login", { username: USER, password: PW }, [401]);
  if (r.status !== 200) {
    r = await api("POST", "/auth/register", { username: USER, password: PW, region: REGION });
    if (r.status >= 300) throw new Error("register failed");
    token = r.body.token;
    await api("POST", "/me/onboarding/advance", { step: "roster" }, [400, 409]);
    await api("POST", "/me/onboarding/skip", undefined, [409]);
    log(`registered ${USER} (${REGION}, ${PERSONA})`);
  } else token = r.body.token;
}

const defensiveValue = (typeId: string) => { const t = getUnitType(typeId)!; return t.defense * t.defense * t.hp; };

async function me() { return (await api("GET", "/me")).body; }

async function townVisit(): Promise<{ caravanId: string; coin: number; units: any[] }> {
  let m = await me();
  const caravan = m.caravans[0];
  const cid = caravan.id as string;
  // refugees
  for (let k = 0; k < 4; k++) {
  let ref = (await api("GET", `/me/caravans/${cid}/refugees`)).body;
  if (ref?.menu?.claimed && (ref.timer?.freeRefreshDue || ref.relief?.active)) {
    const rr = await api("POST", `/me/caravans/${cid}/refugees/refresh`, { fromSequence: ref.menu.sequence }, [409]);
    if (rr.status < 300) ref = (await api("GET", `/me/caravans/${cid}/refugees`)).body;
  }
  if (!(ref?.menu && !ref.menu.claimed && ref.menu.offers?.length)) break;
  {
    const counts = new Map<string, number>();
    for (const u of caravan.units) counts.set(u.unit_type_id, (counts.get(u.unit_type_id) ?? 0) + 1);
    // prefer a type we have fewest of, then the sturdier one
    const offers = [...ref.menu.offers].sort((a: any, b: any) => (counts.get(a.unitTypeId) ?? 0) - (counts.get(b.unitTypeId) ?? 0) || defensiveValue(b.unitTypeId) - defensiveValue(a.unitTypeId));
    const pick = offers[0];
    const c = await api("POST", `/me/caravans/${cid}/refugees/claim`, { unitTypeId: pick.unitTypeId, sequence: ref.menu.sequence }, [409]);
    if (c.status < 300) { log(`  refugee: took ${pick.unitTypeId} of [${ref.menu.offers.map((o: any) => o.unitTypeId.split(".")[1]).join(", ")}]${ref.relief?.active ? " (relief)" : ""}`); rec({ ev: "refugee", type: pick.unitTypeId, relief: !!ref.relief?.active }); }
    else break;
  }
  }
  // unlocks: spend available points, cheapest affordable first (living: prefer sturdier types)
  for (let k = 0; k < 6; k++) {
    const u = (await api("GET", "/me/unlocks")).body;
    let spent = false;
    for (const web of u.webs) {
      const aff = web.nodes.filter((n: any) => n.affordable && !n.reached).sort((a: any, b: any) => a.cost - b.cost || (web.pool === "living" ? defensiveValue(b.id) - defensiveValue(a.id) : 0));
      if (!aff.length) continue;
      const n = aff[0];
      const s = await api("POST", "/me/unlocks/spend", { pool: web.pool, nodeId: n.id, ...(web.pool === "living" ? { caravanId: cid } : {}) }, [409]);
      if (s.status < 300) { log(`  unlocked ${n.id} (${web.pool}, cost ${n.cost})`); rec({ ev: "unlock", node: n.id, pool: web.pool, cost: n.cost }); spent = true; break; }
    }
    if (!spent) break;
  }
  m = await me();
  let coin = m.account.coinBalance as number;
  let units = m.caravans[0].units as any[];
  // mercenaries: fill to the slot cap with the sturdiest unlocked type, keep a reserve
  const reserve = PERSONA === "solver" ? 1500 : 2500;
  const rv = (await api("GET", `/me/caravans/${cid}/recruit`)).body;
  const recruitable = (rv?.recruitable ?? []).map((r: any) => r.unitTypeId).sort((a: string, b: string) => defensiveValue(b) - defensiveValue(a));
  const target = PERSONA === "naive" ? 6 : TUNABLES.DEPLOYMENT_SLOT_CAP + (PERSONA === "solver" ? 4 : 2);
  while (units.length < target && coin - 600 >= (units.length < 5 ? 0 : reserve) && recruitable.length) {
    // rotate through the two sturdiest types to keep merge pairs available
    const t = recruitable[units.length % Math.min(2, recruitable.length)];
    const r = await api("POST", `/me/caravans/${cid}/recruit`, { unitTypeId: t, requestId: randomUUID() }, [409]);
    if (r.status >= 300) break;
    log(`  recruited ${t}`); rec({ ev: "recruit", type: t });
    m = await me(); coin = m.account.coinBalance; units = m.caravans[0].units;
  }
  // merges: when the roster is past the slot cap, merge the lowest level pair of a type
  if (PERSONA !== "naive") {
    for (let k = 0; k < 4; k++) {
      if (units.length <= TUNABLES.DEPLOYMENT_SLOT_CAP) break;
      const groups = new Map<string, any[]>();
      for (const u of units) { const key = `${u.unit_type_id}|${u.merge_level}`; groups.set(key, [...(groups.get(key) ?? []), u]); }
      const cands = [...groups.entries()].filter(([, g]) => g.length >= 2 && g[0].merge_level < 5).sort((a, b) => a[1][0].merge_level - b[1][0].merge_level || b[1].length - a[1].length);
      if (!cands.length) break;
      const [, g] = cands[0]!;
      const ids = g.length >= 5 ? g.slice(0, 5).map((x: any) => x.id) : g.slice(0, 2).map((x: any) => x.id);
      const pv = await api("POST", `/me/caravans/${cid}/merge/preview`, { instanceIds: ids }, [409]);
      if (pv.status >= 300 || !pv.body.affordable || coin - pv.body.totalCost < 600) break;
      const mr = await api("POST", `/me/caravans/${cid}/merge`, { instanceIds: ids, confirmInParty: true }, [409]);
      if (mr.status >= 300) break;
      log(`  merged ${ids.length}× ${g[0].unit_type_id} L${g[0].merge_level} → L${g[0].merge_level + 1} for ${pv.body.totalCost}`);
      rec({ ev: "merge", type: g[0].unit_type_id, from: g[0].merge_level, n: ids.length, cost: pv.body.totalCost });
      m = await me(); coin = m.account.coinBalance; units = m.caravans[0].units;
    }
  }
  await maintainParty(cid, units);
  m = await me();
  return { caravanId: cid, coin: m.account.coinBalance, units: m.caravans[0].units };
}

async function maintainParty(cid: string, units: any[]): Promise<void> {
  const p = (await api("GET", "/me/party")).body;
  const have = p?.party?.config?.units?.length ?? 0;
  const roster = units.map((u) => ({ instanceId: u.id, caravanId: cid, typeId: u.unit_type_id, unlocked: true, mergeLevel: u.merge_level }));
  let config: any;
  if (PERSONA === "designer") {
    // a real party design: the strongest 8 by level, fast units on core from two edges, breakers on traps, the rest nearest from a third edge
    const best = [...roster].sort((a, b) => b.mergeLevel - a.mergeLevel || getUnitType(b.typeId)!.offense - getUnitType(a.typeId)!.offense).slice(0, TUNABLES.PARTY_SLOT_CAP);
    const edges = ["east", "south", "west"] as const;
    config = { v: 1, siege: ["siege.battering_wagon"], units: best.map((u, i) => {
      const t = getUnitType(u.typeId)!;
      const stance = USER.includes("core") ? "core" : t.moveSpeed >= 1400 || t.ability.archetype === "dash" ? "core" : t.ability.archetype === "structure_breaker" || t.ability.archetype === "burst_radius" ? "traps" : "nearest";
      const edge = USER.includes("core") ? (["north", "east", "south", "west"] as const)[i % 4]! : edges[i % 2]!;
      return { ref: u.instanceId, stance, edge, cell: raiseCell(edge, i) };
    }) };
  } else {
    if (have >= Math.min(3, units.length) && (p?.valid ?? p?.party?.valid)) return;
    const raised = raiseUnits({ v: 1, units: [], siege: [] }, roster, PERSONA === "solver" ? TUNABLES.PARTY_SLOT_CAP : TUNABLES.SUGGESTED_PARTY_MAX);
    config = { v: 1, units: raised, siege: ["siege.battering_wagon"] };
  }
  const r = await api("PUT", "/me/party", config, [400, 409, 422]);
  if (r.status < 300) log(`  party saved: ${config.units.length} units (${config.units.map((u: any) => u.stance + "@" + u.edge).join(", ")}) valid=${r.body.valid}`);
}

function partyOf(c: any): ServedParty {
  const units = (c.snapshot?.composition?.units ?? c.scout.units).map((u: any) => ({ ref: u.ref, typeId: u.typeId, mergeLevel: u.mergeLevel, stance: u.stance, edge: u.edge, cell: u.cell }));
  const siege = (c.snapshot?.composition?.siege ?? c.scout.siege).map((s: any) => ({ typeId: s.typeId }));
  const party: Party = { v: 1, units, siege };
  return { spec: { username: c.owner.displayName, rating: c.reputation.rating, outfit: { name: c.owner.displayName } } as any, party, scout: scoutOf(party), pool: { partyId: c.partyId, ownerAccountId: "?", rating: c.reputation.rating, authored: c.owner.authored } };
}

function solve(m: Manifest, sp: ServedParty): { f: Formation; r: FightResult; layout: string } | null {
  let best: { f: Formation; r: FightResult; layout: string } | null = null;
  for (const l of SKILLED) {
    const f = l.build(m, sp.scout);
    if (!f) continue;
    const r = fight(m, f, sp, l);
    if (!best || better(r, best.r)) best = { f, r, layout: l.name };
  }
  return best;
}

async function oneTrip(cid: string, units: any[]): Promise<boolean> {
  const status0 = (await api("GET", `/me/caravans/${cid}/trip`)).body;
  if (status0.trip && !status0.trip.endedAt) { log("  trip already open; resuming"); }
  else {
    if ((status0.cap?.available ?? 0) < 1) { log("  no trip available (cap)"); return false; }
    // pack: the best units up to the slot cap (guide persona leaves 2 at home while roster is small)
    const sorted = [...units].sort((a, b) => b.merge_level - a.merge_level || defensiveValue(b.unit_type_id) - defensiveValue(a.unit_type_id));
    let n = Math.min(TUNABLES.DEPLOYMENT_SLOT_CAP, sorted.length);
    if (PERSONA === "guide" && sorted.length <= TUNABLES.DEPLOYMENT_SLOT_CAP) n = Math.max(1, sorted.length - TUNABLES.GUIDE_RESERVE);
    const ul = (await api("GET", "/me/unlocks")).body;
    const trapWeb = ul.webs.find((w: any) => w.pool === "trap");
    const trapTypes = trapWeb.nodes.filter((x: any) => x.reached && x.id.startsWith("trap.")).map((x: any) => x.id);
    const fences = trapWeb.nodes.filter((x: any) => x.reached && x.id.startsWith("fence.")).map((x: any) => CONTENT.fences.find((f) => f.id === x.id)!).sort((a, b) => b.segmentHp - a.segmentHp);
    const traps = Array.from({ length: PERSONA === "naive" ? 2 : TUNABLES.TRAP_SLOT_CAP }, (_, i) => trapTypes[i % trapTypes.length]);
    const existing = await api("GET", `/caravans/${cid}/manifest`, undefined, [404]);
    if (existing.status === 200 && existing.body?.manifest && !existing.body.manifest.closedAt) await api("DELETE", `/caravans/${cid}/manifest`, undefined, [404, 409]);
    const pk = await api("POST", `/caravans/${cid}/manifest`, { units: sorted.slice(0, n).map((u) => u.id), traps, fence: { tierId: fences[0]!.id, count: TUNABLES.FENCE_MATERIAL_BUDGET } }, []);
    if (pk.status >= 300) return false;
    const st = await api("POST", `/me/caravans/${cid}/trip/start`, undefined, [409]);
    if (st.status >= 300) return false;
    log(`  rode out with ${n} units [${sorted.slice(0, n).map((u) => u.unit_type_id.split(".")[1] + "L" + u.merge_level).join(",")}], ${traps.length} traps, 20 × ${fences[0]!.id}`);
  }
  const encs: any[] = [];
  let lastPreds: string[] = [];
  for (let guard = 0; guard < 12; guard++) {
    const s = (await api("GET", `/me/caravans/${cid}/trip`)).body;
    const t = s.trip;
    if (!t || t.endedAt) break;
    if (t.phase === "decide") {
      const n = t.decisionFor;
      const man = (await api("GET", `/caravans/${cid}/manifest`)).body;
      const surv: Manifest = man.manifest?.survivors ?? man.survivors;
      const menuJust = encs.length ? encs[encs.length - 1].menuScouts : [];
      let push: boolean;
      const alive = surv.units.filter(isUnitAlive);
      const hpShare = alive.reduce((a, u) => a + u.hp, 0) / Math.max(1, surv.units.reduce((a, u) => a + u.maxHp, 0));
      if (PERSONA === "guide") push = pushAdvice(guideStakesOf(surv), menuJust, n).kind === "push";
      else if (PERSONA === "naive") push = false;
      else if (PERSONA === "solver") {
        const preds: string[] = encs.length ? encs[encs.length - 1].preds ?? [] : [];
        const comfortable = SMART ? preds.length > 0 && preds.every((k) => k === "caravan_held") : true;
        push = n < 5 && hpShare >= (SMART ? 0.6 : 0.55) && alive.length >= Math.min(4, surv.units.length) && comfortable;
      }
      else push = n < 3 && hpShare >= 0.6;
      const pv = (await api("GET", `/me/caravans/${cid}/trip/preview`)).body;
      if (push) { await api("POST", `/me/caravans/${cid}/trip/push`, { tripId: t.id, encounterIndex: n }); log(`  e${n}: push (hp ${(hpShare * 100).toFixed(0)}%, ${alive.length} alive, unbanked ${t.unbankedCoin})`); }
      else {
        const b = await api("POST", `/me/caravans/${cid}/trip/bank`, { tripId: t.id, encounterIndex: n });
        log(`  e${n}: BANK ${b.body?.credited} (discarded ${b.body?.discarded}); demerged ${JSON.stringify((b.body?.restored?.deMerged ?? []).map((d: any) => `${d.typeId.split(".")[1]} ${d.fromLevel}->${d.toLevel}`))}`);
        rec({ ev: "trip", result: "banked", encounters: n, credited: b.body?.credited, demerged: b.body?.restored?.deMerged?.length ?? 0, encs: encs.map((e) => e.summary) });
        void pv;
        return true;
      }
      continue;
    }
    if (t.phase === "resolving") { await sleep(700); continue; }
    if (t.phase === "arranging" || t.phase === "choosing" || t.phase === "searching" || t.currentEncounter) {
      const n = t.currentEncounter;
      let cands = (await api("GET", `/me/caravans/${cid}/encounters/${n}/candidates`, undefined, [404])).body;
      let menu = cands?.menu;
      if (!menu || !menu.candidates?.length) {
        const sr = await api("POST", `/me/caravans/${cid}/encounters/${n}/search`, undefined, [409]);
        if (sr.status === 409 && sr.body?.error === "pool_empty") { await api("POST", `/me/caravans/${cid}/trip/return`, { tripId: t.id, encounterIndex: n }); return true; }
        menu = sr.body.menu;
      }
      const man = (await api("GET", `/caravans/${cid}/manifest`)).body;
      const surv: Manifest = man.manifest?.survivors ?? man.survivors;
      const served = menu.candidates.map(partyOf);
      let idx: number;
      let plan: { f: Formation; r?: FightResult; layout: string } | null = null;
      if (menu.chosen?.candidateId || menu.choice) {
        const chosenId = menu.chosen?.candidateId ?? menu.choice?.candidateId;
        idx = Math.max(0, menu.candidates.findIndex((c: any) => c.candidateId === chosenId));
      } else if (PERSONA === "solver") {
        let bi = 0; let br: { f: Formation; r: FightResult; layout: string } | null = null;
        let preds: string[] = [];
        const evalMenu = (srv: ServedParty[]) => { bi = 0; br = null; preds = []; srv.forEach((sp: ServedParty, i: number) => { const s2 = solve(surv, sp); preds.push(s2?.r.kind ?? "none"); if (s2 && (!br || better(s2.r, br.r))) { br = s2; bi = i; } }); };
        evalMenu(served);
        if (SMART && preds.every((k) => k !== "caravan_held") && (menu.searchSeq ?? 1) < 3) {
          log(`  all ${preds.length} candidates predicted lost; waiting out the free reroll`);
          await sleep(182_000);
          const sr = await api("POST", `/me/caravans/${cid}/encounters/${n}/search`, undefined, [409]);
          if (sr.status < 300) { menu = sr.body.menu; served.splice(0, served.length, ...menu.candidates.map(partyOf)); evalMenu(served); rec({ ev: "reroll", n }); }
        }
        lastPreds = preds;
        idx = bi; plan = br;
      } else if (PERSONA === "naive") idx = 0;
      else idx = guidePick(menu.candidates.map((c: any) => c.scout))?.index ?? 0;
      const c = menu.candidates[idx];
      const ch = await api("POST", `/me/caravans/${cid}/encounters/${n}/choose`, { candidateId: c.candidateId }, [409]);
      void ch;
      const sp = served[idx]!;
      if (!plan) {
        if (PERSONA === "solver") plan = solve(surv, sp);
        else if (PERSONA === "naive") { const l = NAIVE[0]!; const f = l.build(surv, sp.scout); plan = f ? { f, layout: l.name } : null; }
        else { const f = GUIDED.build(surv, sp.scout); plan = f ? { f, layout: "guided" } : null; }
      }
      if (!plan) { log("  no layout builds"); return false; }
      const put = await api("PUT", `/caravans/${cid}/encounters/${n}/formation`, plan.f, [400, 409, 422]);
      if (put.status >= 300) { log("  formation refused"); return false; }
      const cm = await api("POST", `/me/caravans/${cid}/trip/encounters/${n}/commit`, undefined, [409]);
      const jobId = cm.body?.jobId;
      // wait
      let after: any = null;
      for (let w = 0; w < 120; w++) {
        await sleep(500);
        after = (await api("GET", `/me/caravans/${cid}/trip`)).body;
        if (!after.trip || after.trip.endedAt || after.trip.phase === "decide" || (after.trip.currentEncounter && after.trip.currentEncounter !== n)) break;
      }
      const tripNow = after.trip ?? (await api("GET", `/me/caravans/${cid}/trip`)).body.trip;
      const lastTrip = tripNow ?? after.lastTrip;
      const encRow = (lastTrip?.encounters ?? []).find((e: any) => e.index === n);
      const outcome = encRow?.outcome ?? (after.trip?.endReason ?? "?");
      const raiders = sp.party.units.length;
      const stances = sp.party.units.map((u) => u.stance);
      const summary = { n, party: c.owner.displayName, authored: c.owner.authored, raiders, core: stances.filter((s) => s === "core").length, edges: sp.scout.edges.length, menuRaiders: served.map((x: ServedParty) => x.party.units.length), outcome, predicted: plan.r?.kind, layout: plan.layout, deaths: encRow?.deaths?.length ?? null, coin: encRow?.coinAccrued, rating: menu.caravan?.rating, jobId };
      log(`  e${n}: vs ${c.owner.displayName}${c.owner.authored ? " (authored)" : " (LIVE)"} ${raiders}r [${stances.join(",")}] edges ${sp.scout.edges.join("/")} menu ${summary.menuRaiders.join("/")} → ${outcome}${plan.r ? ` (solver predicted ${plan.r.kind})` : ""} layout ${plan.layout}; rating ${menu.caravan?.rating}`);
      encs.push({ summary: { ...summary, preds: lastPreds }, preds: lastPreds, menuScouts: menu.candidates.map((x: any) => x.scout) });
      if (outcome === "caravan_overrun" || (after.trip && after.trip.endedAt) || !after.trip) {
        const st2 = (await api("GET", `/me/caravans/${cid}/trip`)).body;
        log(`  OVERRUN at e${n}: ${JSON.stringify(st2.lastTrip?.ending ?? st2.trip?.ending ?? {}).slice(0, 400)}`);
        rec({ ev: "trip", result: "overrun", encounters: n, encs: encs.map((e) => e.summary) });
        return true;
      }
      continue;
    }
    log("  unknown phase", t.phase); await sleep(1000);
  }
  return true;
}

async function main() {
  await login();
  log(`=== ${USER} day ${DAY} session: persona ${PERSONA}, ${TRIPS} trips`);
  for (let i = 0; i < TRIPS; i++) {
    const tv = await townVisit();
    const prog = (await api("GET", "/me/progression")).body;
    const lv = prog.pools.map((p: any) => `${p.pool} rung ${p.ladder.level} rep ${p.reputation} pts ${p.unlockPoints.available}`).join("; ");
    log(` town: coin ${tv.coin}, roster ${tv.units.length} [${tv.units.map((u: any) => u.unit_type_id.split(".")[1] + "L" + u.merge_level).join(",")}]; ${lv}`);
    rec({ ev: "town", coin: tv.coin, roster: tv.units.map((u: any) => [u.unit_type_id, u.merge_level]), pools: prog.pools.map((p: any) => ({ pool: p.pool, rung: p.ladder.level, rep: p.reputation, avail: p.unlockPoints.available, pts: p.ladder.points })) });
    const ok = await oneTrip(tv.caravanId, tv.units);
    if (!ok) break;
  }
  // party feed summary
  const feed = (await api("GET", "/me/party/feed")).body;
  rec({ ev: "feed", n: feed?.entries?.length ?? 0, entries: (feed?.entries ?? []).slice(0, 20).map((e: any) => ({ outcome: e.outcome, coin: e.coin ?? e.credited, at: e.settledAt ?? e.at })) });
}
main().catch((e) => { log("FATAL", String(e?.stack ?? e)); process.exit(1); });
