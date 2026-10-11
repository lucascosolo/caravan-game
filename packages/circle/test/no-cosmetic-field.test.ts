/**
 * PHASE-2 §28 / chunk 20, GUARDRAILS §2: no formation, manifest, party or resolver input
 * type can carry a cosmetic field — at the TYPE level (every `@ts-expect-error` below is
 * checked by `pnpm typecheck`: if any of these interfaces ever gains a `cosmetic`, `skin`
 * or `banner` field, the directive becomes unused and the build fails) and at RUNTIME
 * (every parser and shape guard is closed-keyed and refuses the extra field). A cosmetic
 * therefore has no path into a resolution: the resolver cannot read one (boundary check),
 * and the structures that reach it cannot hold one.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertResolveInput, type ResolveInput } from "@caravan/resolver";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FORMATION,
  EMPTY_PARTY_CONFIG,
  FORMATION_VERSION,
  MANIFEST_VERSION,
  PARTY_CONFIG_VERSION,
  assertBattlefield,
  formationFromJson,
  manifestFromJson,
  partyConfigFromJson,
  partyFromJson,
  resolverTunables,
  toBattlefield,
  type Battlefield,
  type Formation,
  type Manifest,
  type PackInput,
  type PartyConfig,
  type PostPlacement,
} from "../src/index.js";
import { arrange, fullPack } from "./fixtures.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("no resolver-bound type can carry a cosmetic field (type level)", () => {
  it("compiles only because every extra field below is a type error", () => {
    // @ts-expect-error Formation has no cosmetic field
    const f: Formation = { v: FORMATION_VERSION, fences: [], traps: [], posts: [], cosmetic: "x" };
    // @ts-expect-error a post carries no skin
    const p: PostPlacement = { ref: "u", cell: { x: 1, y: 1 }, stance: "guard", skin: "x" };
    // @ts-expect-error Manifest has no cosmetic field
    const m: Manifest = { v: MANIFEST_VERSION, units: [], traps: [], fences: [], wagonSkin: "x" };
    // @ts-expect-error PackInput has no cosmetic field
    const pi: PackInput = { units: [], traps: [], fence: null, fenceStyle: "x" };
    // @ts-expect-error PartyConfig has no banner field
    const pc: PartyConfig = { v: PARTY_CONFIG_VERSION, units: [], siege: [], banner: "x" };
    // @ts-expect-error Battlefield has no cosmetic field
    const b: Partial<Battlefield> = { cosmetic: "x" };
    // @ts-expect-error ResolveInput has no cosmetic field
    const ri: Partial<ResolveInput> = { cosmetics: [] };
    expect([f, p, m, pi, pc, b, ri].length).toBe(7);
  });
});

describe("no resolver-bound structure can carry a cosmetic field (runtime)", () => {
  const manifest = fullPack();
  const formation = arrange(manifest, 2);
  const battlefield = toBattlefield(manifest, formation);

  it("formationFromJson / manifestFromJson / partyConfigFromJson / partyFromJson refuse an extra cosmetic key at every level", () => {
    const withKey = (o: unknown, k: string): unknown => ({ ...(o as object), [k]: "x" });
    expect(() => formationFromJson(withKey(formation, "cosmetic"))).toThrow(/unknown key 'cosmetic'/);
    expect(() => formationFromJson({ ...formation, posts: formation.posts.map((p) => withKey(p, "skin")) })).toThrow(/unknown key 'skin'/);
    expect(() => formationFromJson({ ...formation, fences: formation.fences.map((f) => withKey(f, "style")) })).toThrow(/unknown key 'style'/);
    expect(() => manifestFromJson(withKey(manifest, "wagonSkin"))).toThrow(/unknown key 'wagonSkin'/);
    expect(() => manifestFromJson({ ...manifest, units: manifest.units.map((u) => withKey(u, "skin")) })).toThrow(/unknown key 'skin'/);
    expect(() => partyConfigFromJson(withKey(EMPTY_PARTY_CONFIG, "banner"))).toThrow(/unknown key 'banner'/);
    expect(() => partyFromJson({ v: 1, units: [], siege: [], banner: "x" })).toThrow(/unknown key 'banner'/);
    // The unmodified structures parse, so the refusals above are about the key alone.
    expect(() => formationFromJson(formation)).not.toThrow();
    expect(() => manifestFromJson(manifest)).not.toThrow();
    expect(formationFromJson(EMPTY_FORMATION)).toEqual(EMPTY_FORMATION);
  });

  it("assertBattlefield and assertResolveInput refuse a cosmetic key anywhere in the input", () => {
    expect(() => assertBattlefield(battlefield)).not.toThrow();
    expect(() => assertBattlefield({ ...battlefield, cosmetic: "x" })).toThrow(/cosmetic/);
    expect(() => assertBattlefield({ ...battlefield, posts: battlefield.posts.map((p) => ({ ...p, skin: "x" })) })).toThrow(/skin/);
    expect(() => assertBattlefield({ ...battlefield, fences: battlefield.fences.map((f) => ({ ...f, style: "x" })) })).toThrow(/style/);
    // Key checks run before content checks: the same input minus the extra key gets past
    // the shape guard and fails only on its (deliberately) empty party.
    const input = { battlefield, party: { v: 1, units: [], siege: [] }, tunables: resolverTunables() };
    expect(() => assertResolveInput(input)).toThrow(/party\.units must not be empty/);
    expect(() => assertResolveInput({ ...input, cosmetics: [] })).toThrow(/cosmetics/);
    expect(() => assertResolveInput({ ...input, party: { ...input.party, banner: "x" } })).toThrow(/banner/);
  });
});

describe("the resolver and the circle model have no cosmetic vocabulary at all", () => {
  it("packages/resolver/src and packages/circle/src never mention cosmetics, skins, banners, purchases or entitlements", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e) => {
        const full = join(dir, e);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
      });
    // "stored" / "storage" are ordinary words; only the noun "store" (the shop) is banned.
    const banned = /cosmetic|\bskins?\b|banner|decoration|purchas|entitle|billing|\bstore\b/i;
    const offenders: string[] = [];
    for (const dir of [join(HERE, "..", "src"), join(HERE, "..", "..", "resolver", "src")]) {
      for (const f of walk(dir)) {
        readFileSync(f, "utf8")
          .split("\n")
          .forEach((line, i) => {
            // Comment lines may state the negation ("no purchase or entitlement state"); code may not.
            if (/^\s*(\*|\/\/|\/\*)/.test(line)) return;
            if (banned.test(line)) offenders.push(`${f.slice(f.indexOf("packages"))}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
