/**
 * Draws one painted sprite plus the code readability layer (docs/art/STYLE-GUIDE.md §3, §5):
 * a flat cool contact shadow under the ground-contact point, the sprite itself at native
 * device size (its texture carries the atlas DPR as its resolution, so 1 texel = 1 device px at
 * camera zoom 1), and for units the side mark (round turquoise badge for settlers, triangular
 * brick-red tag for raiders) with a brass star from merge level 2. Code motion (bob, lunge,
 * hit flash, topple) belongs to the renderer and goes on top of this node later.
 */
import { Container, Graphics, Sprite } from "pixi.js";
import type { SpriteSkin } from "./skins.ts";

export const SIDE_MARK = { defender: 0x4fb8b0, attacker: 0xec5231, outline: 0x2a1a14, star: 0xfcc83a, shadow: 0x1c2733, selected: 0xf1e9d6 } as const;

export function drawSprite(skin: SpriteSkin, selected: boolean): Container {
  const node = new Container();
  const { w, h } = skin.size;
  const shadow = new Graphics();
  shadow.label = "shadow";
  shadow.ellipse(0, 0, Math.max(4, w * 0.36), Math.max(2, w * 0.13)).fill({ color: SIDE_MARK.shadow, alpha: 0.28 });
  if (selected) shadow.ellipse(0, 0, Math.max(5, w * 0.42), Math.max(3, w * 0.17)).stroke({ width: 2, color: SIDE_MARK.selected });
  node.addChild(shadow);

  const sprite = new Sprite(skin.texture);
  sprite.label = "sprite";
  sprite.anchor.set(skin.anchor.x / w, skin.anchor.y / h);
  sprite.width = w;
  sprite.height = h;
  if (skin.flipX) sprite.scale.x = -Math.abs(sprite.scale.x);
  node.addChild(sprite);

  const top = -skin.anchor.y - 5;
  if (skin.mark) {
    const badge = new Graphics();
    badge.label = "badge";
    if (skin.mark === "defender") badge.circle(0, top, 3.5).fill(SIDE_MARK.defender).stroke({ width: 1, color: SIDE_MARK.outline });
    else badge.poly([0, top + 3.5, -4, top - 3, 4, top - 3]).fill(SIDE_MARK.attacker).stroke({ width: 1, color: SIDE_MARK.outline });
    node.addChild(badge);
  }
  if (skin.level >= 2) {
    const star = new Graphics();
    star.label = "star";
    const cx = skin.mark ? 7 : 0, pts: number[] = [];
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? 3.5 : 1.5;
      const [ux, uy] = STAR[i]!;
      pts.push(cx + ux * r, top + uy * r);
    }
    star.poly(pts).fill(SIDE_MARK.star).stroke({ width: 1, color: SIDE_MARK.outline });
    node.addChild(star);
  }
  return node;
}

const STAR: readonly (readonly [number, number])[] = Array.from({ length: 10 }, (_, i) => {
  const a = -Math.PI / 2 + (i * Math.PI) / 5;
  return [Math.cos(a), Math.sin(a)] as const;
});
