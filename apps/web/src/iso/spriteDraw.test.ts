import { Container, Sprite, Texture } from "pixi.js";
import { describe, expect, it } from "vitest";
import { drawSprite } from "./spriteDraw.ts";
import { IsoScene } from "./scene.ts";
import { createSpriteSkins, type SpriteFrame, type SpriteSkin } from "./skins.ts";

const skin = (o: Partial<SpriteSkin> = {}): SpriteSkin => ({
  kind: "sprite",
  textureId: "units/x",
  texture: Texture.WHITE,
  anchor: { x: 8, y: 15 },
  size: { w: 16, h: 16 },
  flipX: false,
  mark: null,
  level: 1,
  ...o,
});
const child = (c: Container, label: string) => c.getChildByLabel(label);

describe("drawSprite", () => {
  it("draws a shadow and a sprite of the skin's size, with no badge or star by default", () => {
    const c = drawSprite(skin(), false);
    expect(child(c, "shadow")).not.toBeNull();
    const s = child(c, "sprite") as Sprite;
    expect(s).toBeInstanceOf(Sprite);
    expect(Math.abs(s.width)).toBeCloseTo(16);
    expect(s.scale.x).toBeGreaterThan(0);
    expect(child(c, "badge")).toBeNull();
    expect(child(c, "star")).toBeNull();
  });
  it("mirrors the sprite when flipX is set, keeping its width", () => {
    const s = child(drawSprite(skin({ flipX: true }), false), "sprite") as Sprite;
    expect(s.scale.x).toBeLessThan(0);
    expect(Math.abs(s.width)).toBeCloseTo(16);
  });
  it("adds a badge iff the skin has a mark", () => {
    expect(child(drawSprite(skin({ mark: "attacker" }), false), "badge")).not.toBeNull();
    expect(child(drawSprite(skin({ mark: "defender" }), false), "badge")).not.toBeNull();
  });
  it("adds a star iff the level is 2 or more", () => {
    expect(child(drawSprite(skin({ level: 1 }), false), "star")).toBeNull();
    expect(child(drawSprite(skin({ level: 2 }), false), "star")).not.toBeNull();
    expect(child(drawSprite(skin({ level: 3 }), true), "star")).not.toBeNull();
  });
});

describe("IsoScene with a sprite skin", () => {
  const frames = new Map<string, SpriteFrame>([
    ["units/desert.well_digger", { texture: Texture.WHITE, raiderTexture: null, anchor: { x: 8, y: 15 }, size: { w: 16, h: 16 } }],
  ]);
  const geometry = { width: 8, height: 8, coreCells: [], ringCells: [], wagons: [], entryBandDepth: 1 };

  it("constructs and draws a sprite marker without throwing", () => {
    const skins = createSpriteSkins(frames);
    const scene = new IsoScene({ geometry, reducedMotion: false, background: 0, skins });
    const marker = (scene as unknown as { marker: (s: unknown, p: { x: number; y: number }, m: number, l: number, sel: boolean) => Container }).marker.bind(scene);
    const node = marker(skins.unit("desert.well_digger", "defender"), { x: 0, y: 0 }, 1, 2, false);
    expect(node).toBeInstanceOf(Container);
    expect(node.getChildByLabel("sprite", true)).not.toBeNull();
  });
});
