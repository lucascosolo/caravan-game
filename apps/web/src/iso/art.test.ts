import { Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import { atlasDpr, atlasUrls, loadAtlasImage, recolourSide, type ArtManifest } from "./art.ts";
import { createSpriteSkins, PLACEHOLDER_SKINS, type SpriteFrame, type SpriteSkin } from "./skins.ts";

const manifest: ArtManifest = {
  version: 1,
  assets: {},
  scenes: {
    town: { width: 64, height: 64, files: { "1": { webp: "t1.webp", png: "t1.png", bytes: { webp: 1, png: 2 } } }, frames: {} },
  },
};

describe("atlasDpr", () => {
  it("rounds and clamps to 1..3", () => {
    expect([0.5, 1.5, 2.6, 4].map(atlasDpr)).toEqual([1, 2, 3, 3]);
  });
});

describe("atlasUrls", () => {
  it("returns the urls for a present scene and dpr", () => {
    expect(atlasUrls(manifest, "town", 1)).toEqual({ webp: "t1.webp", png: "t1.png" });
  });
  it("is null for a null manifest, a missing scene or a missing dpr", () => {
    expect(atlasUrls(null, "town", 1)).toBeNull();
    expect(atlasUrls(manifest, "battle", 1)).toBeNull();
    expect(atlasUrls(manifest, "town", 2)).toBeNull();
  });
});

describe("loadAtlasImage", () => {
  const urls = { webp: "a.webp", png: "a.png" };
  it("prefers webp", async () => {
    const calls: string[] = [];
    const r = await loadAtlasImage(urls, async (u: string) => (calls.push(u), u));
    expect(r).toEqual({ image: "a.webp", format: "webp" });
    expect(calls).toEqual(["a.webp"]);
  });
  it("falls back to png when webp rejects", async () => {
    const r = await loadAtlasImage(urls, async (u: string) => {
      if (u.endsWith("webp")) throw new Error("no webp");
      return u;
    });
    expect(r).toEqual({ image: "a.png", format: "png" });
  });
  it("is null when both reject", async () => {
    expect(await loadAtlasImage(urls, () => Promise.reject(new Error("nope")))).toBeNull();
  });
});

describe("recolourSide", () => {
  const px = (data: Uint8ClampedArray, i: number) => Array.from(data.slice(i * 4, i * 4 + 4));
  const rect = { x: 0, y: 0, w: 4, h: 1 };
  // pixels: lit turquoise, shadow turquoise, outline, denim | row 2 mirrors them outside rect
  const row = [0x4f, 0xb8, 0xb0, 255, 0x24, 0x77, 0x78, 255, 0x2a, 0x1a, 0x14, 255, 0x60, 0x86, 0xc2, 255];
  const make = () => new Uint8ClampedArray([...row, ...row, 0xf2, 0xc9, 0x70, 255, 0x82, 0xb1, 0x4e, 255, 0, 0, 0, 0, 0x4f, 0xb8, 0xb0, 0]);

  it("turns only turquoise pixels in the rect reddish and reports the count", () => {
    const d = make();
    expect(recolourSide(d, 4, rect)).toBe(2);
    for (const i of [0, 1]) {
      const [r, g, b, a] = px(d, i) as [number, number, number, number];
      expect(r).toBeGreaterThan(g);
      expect(r).toBeGreaterThan(b);
      expect(a).toBe(255);
    }
    const lit = px(d, 0), shadow = px(d, 1);
    expect(Math.abs(lit[0]! - 0xec)).toBeLessThan(40);
    expect(Math.abs(shadow[0]! - 0xa5)).toBeLessThan(40);
  });
  it("leaves outline, denim, sand, plant, transparent and out-of-rect pixels untouched", () => {
    const before = make();
    const d = make();
    recolourSide(d, 4, rect);
    for (const i of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) expect(px(d, i)).toEqual(px(before, i));
  });
});

describe("createSpriteSkins", () => {
  const tex = (): Texture => new Texture({ source: Texture.WHITE.source });
  const unitTex = tex(), raiderTex = tex();
  const frame = (texture: Texture, raiderTexture: Texture | null = null): SpriteFrame => ({ texture, raiderTexture, anchor: { x: 9, y: 26 }, size: { w: 20, h: 27 } });
  const frames = new Map<string, SpriteFrame>([
    ["units/desert.sand_sharpshooter", frame(unitTex, raiderTex)],
    ["traps/desert.tripwire", frame(tex())],
    ["wagons/core", frame(tex())],
    ["wagons/covered_front", frame(tex())],
    ["wagons/supply_rear", frame(tex())],
  ]);
  const skins = createSpriteSkins(frames);

  it("returns a sprite skin for a unit with a frame, with side texture, mark and level", () => {
    const d = skins.unit("desert.sand_sharpshooter", "defender", 2) as SpriteSkin;
    expect(d).toMatchObject({ kind: "sprite", textureId: "units/desert.sand_sharpshooter", flipX: false, mark: "defender", level: 2 });
    expect(d.texture).toBe(unitTex);
    expect(d.anchor).toEqual({ x: 9, y: 26 });
    expect(d.size).toEqual({ w: 20, h: 27 });
    const a = skins.unit("desert.sand_sharpshooter", "attacker") as SpriteSkin;
    expect(a.texture).toBe(raiderTex);
    expect(a.mark).toBe("attacker");
    expect(a.level).toBe(1);
  });
  it("falls back to the placeholder registry when a frame is absent", () => {
    expect(skins.unit("desert.well_digger", "defender")).toEqual(PLACEHOLDER_SKINS.unit("desert.well_digger", "defender"));
    expect(skins.fence("nope")).toEqual(PLACEHOLDER_SKINS.fence("nope"));
    expect(skins.siege("nope")).toEqual(PLACEHOLDER_SKINS.siege("nope"));
  });
  it("uses an explicit fallback registry", () => {
    const sentinel = PLACEHOLDER_SKINS.core();
    const s = createSpriteSkins(new Map(), { ...PLACEHOLDER_SKINS, unit: () => sentinel });
    expect(s.unit("x", "defender")).toBe(sentinel);
  });
  it("draws traps and the core as unmarked level-0 sprites", () => {
    expect(skins.trap("desert.tripwire")).toMatchObject({ kind: "sprite", textureId: "traps/desert.tripwire", mark: null, level: 0 });
    expect(skins.core()).toMatchObject({ kind: "sprite", textureId: "wagons/core" });
  });
  it("picks the wagon frame by index parity and facing, flipping sw and ne", () => {
    expect(skins.wagonAnchor(0, "se")).toMatchObject({ textureId: "wagons/covered_front", flipX: false });
    expect(skins.wagonAnchor(2)).toMatchObject({ textureId: "wagons/covered_front", flipX: false });
    expect(skins.wagonAnchor(1, "ne")).toMatchObject({ textureId: "wagons/supply_rear", flipX: true });
    expect(skins.wagonAnchor(1, "nw")).toMatchObject({ textureId: "wagons/supply_rear", flipX: false });
    expect(skins.wagonAnchor(0, "sw")).toMatchObject({ textureId: "wagons/covered_front", flipX: true });
  });
  it("falls back for a missing wagon frame", () => {
    expect(skins.wagonAnchor(1, "se")).toEqual(PLACEHOLDER_SKINS.wagonAnchor());
  });
});
