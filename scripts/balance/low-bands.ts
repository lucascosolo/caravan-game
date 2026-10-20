/**
 * The bands 0–1 gate (balance pass 8; the authored-only phase): every band-0 and band-1 authored
 * outfit against the caravan that meets it — a fresh roster (STARTING_ROSTER + each refugee type)
 * packing the guide's default (roster − GUIDE_RESERVE, every rotation of which units stay home),
 * one trap, a full fence — arranged by the GUIDED layout (@caravan/circle `guidedFormation`, the
 * client's "Arrange for me"). Gates: each outfit held ≥ LOW_BAND_GUIDED_MIN (60 %); at most
 * CORE_HEAVY_MAX_SHARE of each band's outfits core-stance-heavy (half or more raiders on `core`).
 *
 *   pnpm --filter @caravan/server exec tsx ../../scripts/balance/low-bands.ts [--jobs 2] [--variants]
 *
 * `--variants` also fights variants of every outfit (each stance pattern, one raider fewer / more)
 * so a re-author can be chosen from measurements. Floats only in the report.
 */
import { REGION_IDS, TUNABLES } from "../../packages/content/src/index.js";
import type { AuthoredPartySpec } from "../../apps/server/src/matchmaking/authored.js";
import { runParallel, serveIfChild } from "./parallel.js";
import { GUIDED, authoredParties, freshRoster, manifestOf, oneFight, servedParty, starterTypes, type RosterSpec, type ServedParty } from "./sweep.js";

/** Tunable (pass 8): the guided hold every band 0–1 outfit must reach against the fresh guided pack. */
export const LOW_BAND_GUIDED_MIN = 0.6;
/** Tunable (pass 8): the most of a band's outfits that may be core-stance-heavy. */
export const CORE_HEAVY_MAX_SHARE = 1 / 3;

/** Half or more of the party's raiders on the `core` stance. */
export function isCoreHeavy(sp: ServedParty): boolean {
  const core = sp.party.units.filter((u) => u.stance === "core").length;
  return sp.party.units.length > 0 && core * 2 >= sp.party.units.length;
}

/** Every fresh guided pack: each region × each refugee type × each rotation of who stays home. */
export function freshPacks(): RosterSpec[] {
  const out: RosterSpec[] = [];
  for (const r of REGION_IDS) for (const refugee of starterTypes(r)) {
    const full = freshRoster(r, refugee, 1);
    const keep = Math.max(1, full.units.length - TUNABLES.GUIDE_RESERVE);
    for (let rot = 0; rot < full.units.length; rot++) {
      const units = [...full.units.slice(rot), ...full.units.slice(0, rot)].slice(0, keep);
      out.push({ ...full, label: `${full.label} rot ${rot}`, units });
    }
  }
  return out;
}

export interface Variant {
  readonly name: string;
  readonly stancePattern?: AuthoredPartySpec["stancePattern"];
  readonly delta?: number;
}
export const VARIANTS: readonly Variant[] = [
  { name: "as-is" },
  { name: "nearest", stancePattern: "nearest" },
  { name: "traps", stancePattern: "traps" },
  { name: "core", stancePattern: "core" },
  { name: "mixed", stancePattern: "mixed" },
  { name: "drop1", delta: -1 },
  { name: "add1", delta: 1 },
  { name: "add1+nearest", delta: 1, stancePattern: "nearest" },
  { name: "add1+traps", delta: 1, stancePattern: "traps" },
  { name: "add1+mixed", delta: 1, stancePattern: "mixed" },
];

/** A variant of an authored spec, built the generator's way (types cycle, all band 0–1 units are L1). */
export function variantOf(spec: AuthoredPartySpec, v: Variant): AuthoredPartySpec {
  const n = Math.max(1, Math.min(TUNABLES.PARTY_SLOT_CAP, spec.units.length + (v.delta ?? 0)));
  const types = [...new Set(spec.units.map((u) => u.typeId))];
  const units = Array.from({ length: n }, (_, u) => spec.units[u] ?? { typeId: types[u % types.length]!, mergeLevel: spec.units[spec.units.length - 1]!.mergeLevel });
  return { ...spec, units, stancePattern: v.stancePattern ?? spec.stancePattern };
}

export interface LowBandTask {
  readonly party: number;
  readonly variant: number;
  readonly pack: number;
}
let packs: RosterSpec[] | undefined;
export function lowBandFight(t: LowBandTask): boolean {
  packs ??= freshPacks();
  const base = authoredParties()[t.party]!;
  const sp = t.variant === 0 ? base : servedParty(variantOf(base.spec, VARIANTS[t.variant]!));
  const r = oneFight(manifestOf(packs[t.pack]!), sp, GUIDED);
  return r !== null && r.kind !== "caravan_overrun";
}

const isMain = process.argv[1]?.endsWith("low-bands.ts") ?? false;
if (isMain && !serveIfChild(lowBandFight)) {
  const ji = process.argv.indexOf("--jobs");
  const jobs = ji >= 0 ? Number(process.argv[ji + 1]) : 2;
  const explore = process.argv.includes("--variants");
  const parties = authoredParties();
  const nPacks = freshPacks().length;
  const tasks: LowBandTask[] = [];
  parties.forEach((sp, party) => {
    if (sp.spec.band > 1) return;
    const vs = explore ? VARIANTS.map((_, i) => i) : [0];
    for (const variant of vs) for (let pack = 0; pack < nPacks; pack++) tasks.push({ party, variant, pack });
  });
  const rs = await runParallel(process.argv[1]!, tasks, lowBandFight, jobs);
  const held = new Map<string, number>();
  tasks.forEach((t, i) => {
    if (rs[i]) held.set(`${t.party}|${t.variant}`, (held.get(`${t.party}|${t.variant}`) ?? 0) + 1);
  });
  console.log(`Bands 0–1 gate — guided layout (guidedFormation) vs ${nPacks} fresh guided packs (roster − GUIDE_RESERVE ${TUNABLES.GUIDE_RESERVE}, every rotation, 1 trap); bar ${LOW_BAND_GUIDED_MIN * 100} % each, core-heavy ≤ ${Math.round(CORE_HEAVY_MAX_SHARE * 100)} % of a band`);
  for (const band of [0, 1]) {
    const inBand = parties.map((sp, i) => ({ sp, i })).filter((x) => x.sp.spec.band === band);
    const coreHeavy = inBand.filter((x) => isCoreHeavy(x.sp)).length;
    const total = inBand.reduce((n, x) => n + (held.get(`${x.i}|0`) ?? 0), 0);
    const under = inBand.filter((x) => (held.get(`${x.i}|0`) ?? 0) < LOW_BAND_GUIDED_MIN * nPacks).length;
    console.log(`band ${band}: guided held ${total}/${inBand.length * nPacks} = ${Math.round((100 * total) / (inBand.length * nPacks))}%; under the bar ${under}; core-heavy ${coreHeavy}/${inBand.length}; raiders ${inBand.reduce((n, x) => n + x.sp.party.units.length, 0)}`);
    for (const { sp, i } of inBand) {
      const h = held.get(`${i}|0`) ?? 0;
      const stances = sp.party.units.map((u) => u.stance[0]).join("");
      const types = [...new Set(sp.party.units.map((u) => u.typeId.split(".")[1]))].join("+");
      const extra = explore ? "  " + VARIANTS.slice(1).map((v, k) => `${v.name} ${held.get(`${i}|${k + 1}`) ?? 0}`).join(" · ") : "";
      console.log(`  ${sp.spec.outfit.name.padEnd(26)} ${sp.spec.regionId.padEnd(11)} ${String(sp.party.units.length)} [${stances}] ${types.padEnd(28)} siege ${sp.party.siege.length} edges ${sp.spec.edgeCount}  held ${String(h).padStart(2)}/${nPacks}${h < LOW_BAND_GUIDED_MIN * nPacks ? " <<" : ""}${isCoreHeavy(sp) ? " core-heavy" : ""}${extra}`);
    }
  }
}
