/**
 * The SKIN SEAM (chunk 08; PHASE-2 §26 "the pipeline must support a skin layer from the
 * start, keyed by unit type, that the resolver never sees").
 *
 * The scene asks a `SkinRegistry` what a type looks like and draws that. Chunk 08 ships
 * exactly one registry, `PLACEHOLDER_SKINS`: clean geometric placeholders built from the
 * same colourblind-safe rules the DOM uses (affinity = shape, never colour alone; Okabe–Ito
 * palette). Chunk 26 adds a sprite registry with the same interface and chunk 28 layers
 * cosmetics on top by swapping the registry per player — no scene code changes.
 *
 * Nothing in here reads game state or balance numbers; it is keyed by type id only.
 */
import { getFenceTier, getSiegeType, getTrapType, getUnitType, type AffinityCategory } from "@caravan/content";

export type PlaceholderShape = "circle" | "square" | "triangle" | "diamond" | "bar" | "wagon";

export interface PlaceholderSkin {
  readonly kind: "placeholder";
  readonly shape: PlaceholderShape;
  readonly fill: number;
  readonly outline: number;
  /** One or two characters drawn on the marker (a unit's initials, a trap's symbol). */
  readonly glyph: string;
  /** Size relative to a tile (1 = fills the diamond). */
  readonly scale: number;
}

/** Reserved for chunk 26: a texture from the atlas. The scene refuses it until then. */
export interface SpriteSkin {
  readonly kind: "sprite";
  readonly textureId: string;
}

export type Skin = PlaceholderSkin | SpriteSkin;

export type Side = "defender" | "attacker";

export interface SkinRegistry {
  unit(typeId: string, side: Side): Skin;
  trap(typeId: string): Skin;
  fence(tierId: string): Skin;
  siege(typeId: string): Skin;
  /** The four parked wagons at the ring corners (chunk 07 QA D2). */
  wagonAnchor(): Skin;
  core(): Skin;
}

// Okabe–Ito, matching theme.css. Defender/attacker are told apart by outline colour AND
// by a marker: defenders get a solid outline, attackers a dashed ring drawn by the scene.
export const PALETTE = {
  defender: 0x56b4e9, // sky blue
  attacker: 0xd55e00, // vermillion
  trap: 0xe69f00, // orange
  trapSpent: 0x7a7468,
  timber: 0x8b5a2b,
  wire: 0x9aa0a6,
  stone: 0x6f7b8a,
  siege: 0xcc79a7, // reddish purple
  wagon: 0x5c4a32,
  core: 0xf0e442, // yellow
  outlineDark: 0x1b1a17,
  ground: 0xb9a06b,
  groundLine: 0x8f7b4f,
  tier1: 0x8c7a4b,
  tier2: 0x6f6240,
  tier3: 0x54492f,
  cliff: 0x3b3322,
  water: 0x2b4a5e,
  lattice: 0xf1e9d6,
  gap: 0xf1e9d6,
  /** Chunk 22 QA S5: a fence BREAKING in a replay has a colour of its own (Okabe–Ito bluish green), never the raiders' vermillion. */
  fenceBreak: 0x009e73,
  /** Chunk 22 QA S4: the line of a hit in a replay (cream, over the field). */
  hit: 0xf1e9d6,
} as const;

const AFFINITY_SHAPE: Record<AffinityCategory, PlaceholderShape> = {
  grit: "square",
  powder: "triangle",
  beast: "circle",
};

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return words.length >= 2 ? `${words[0]![0]}${words[1]![0]}`.toUpperCase() : name.slice(0, 2).toUpperCase();
}

export const PLACEHOLDER_SKINS: SkinRegistry = {
  unit(typeId, side) {
    const t = getUnitType(typeId);
    return {
      kind: "placeholder",
      shape: t ? AFFINITY_SHAPE[t.affinity] : "circle",
      fill: side === "defender" ? PALETTE.defender : PALETTE.attacker,
      outline: PALETTE.outlineDark,
      glyph: t ? initials(t.displayName) : "?",
      scale: 0.62,
    };
  },
  trap(typeId) {
    const t = getTrapType(typeId);
    return { kind: "placeholder", shape: "diamond", fill: PALETTE.trap, outline: PALETTE.outlineDark, glyph: t?.category === "powder" ? "✸" : "▽", scale: 0.5 };
  },
  fence(tierId) {
    const f = getFenceTier(tierId);
    const fill = f?.category === "wire" ? PALETTE.wire : f?.category === "stone" ? PALETTE.stone : PALETTE.timber;
    return { kind: "placeholder", shape: "bar", fill, outline: PALETTE.outlineDark, glyph: f ? String(f.tier) : "", scale: 0.9 };
  },
  siege(typeId) {
    const s = getSiegeType(typeId);
    return { kind: "placeholder", shape: "square", fill: PALETTE.siege, outline: PALETTE.outlineDark, glyph: s ? initials(s.displayName) : "S", scale: 0.7 };
  },
  wagonAnchor() {
    return { kind: "placeholder", shape: "wagon", fill: PALETTE.wagon, outline: PALETTE.outlineDark, glyph: "", scale: 1 };
  },
  core() {
    return { kind: "placeholder", shape: "wagon", fill: PALETTE.core, outline: PALETTE.outlineDark, glyph: "", scale: 1 };
  },
};
