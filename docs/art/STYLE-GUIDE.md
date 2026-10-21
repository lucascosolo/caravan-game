# Caravan Vaults: style guide and anti-style guide

This is the art bible. It was rewritten on 2026-10-20, after the owner moved the look away from
painted gouache and toward clean pixel art with a bold storybook outline: "a Stardew Valley
vibe". The earlier painted-storybook guide is in git history (before commit `fb501c7`). The
owner's picks were made on an animated look test
(https://claude.ai/artifact/EGHs2F88GqNcDEN2xh3hgy). Its sprites, palette and screenshots are
the in-house reference, in `assets/reference/look-test-2026-10-20/`. When in doubt, this file
wins over adjectives.

## 1. The look in one paragraph

**Clean, cosy 2D pixel art with a thick dark outline, seen from the game's isometric 3/4
camera.** The feel is a warm frontier version of Stardew Valley: friendly chunky characters,
readable silhouettes, flat colour in two values per material, and everything alive with small
motions. It is drawn on a pixel grid and shown at a small pixel size, so it reads as crisp
pixel art. It does not have to be true pixel art in how it is made: a generated or painted
source is turned into it by the build step (§7).

Not this look: glossy 3D or "stylized 3D" (the Clash of Clans finish), painterly blur, vector
flat design, realistic rendering, or noisy retro pixel art with heavy dithering.

## 2. The owner's picks (2026-10-20)

| Knob | Pick | What it means in practice |
|---|---|---|
| Pixel size | **Small** | The finest of the three sizes tried. |
| Detail | **Fine: 1.5× finer grid, same footprint** (picked later the same day) | Every asset keeps the on-screen footprint in §3 but is drawn on a grid 1.5 times finer, so a 24 × 32 character is drawn at 36 × 48. On a 3× phone screen that is exactly 2 device pixels per art pixel, so the pixels stay crisp. In the look test only the AI-made pieces used it; the finished set uses it for everything, ground and fences included, because mixed pixel sizes are banned (§8). |
| Outline | **Extra bold, never on the ground** | Every object has its own 1 px dark outline in the art, and code adds a second 1 px dark line around the silhouette. Ground tiles get neither, because outlined tiles read as a grid. |
| Colour | **Warm-bright** | The warm palette pushed between warm and bright. The hex values in §4 already include this grade, so nothing is applied by a screen filter. |
| Side marks | **On by default; each player can turn them off** | The round settler badge and triangular raider tag are drawn by code over every unit. They are an account setting, defaulting to on. |

## 3. Construction rules

### Grid and scale

Every asset class has a fixed footprint, measured on the 48 × 24 ground tile the renderer
already uses (`apps/web/src/iso/projection.ts`). The sizes below are footprints. The art itself
is drawn 1.5 times finer (§2, "Detail"), so a 24 × 32 person is a 36 × 48 drawing, a
48 × 24 tile a 72 × 36 drawing and an 84 × 62 wagon a 126 × 93 drawing. The outline grows by
the same factor, so it reads equally bold. The build step checks these sizes.

| Class | Art size (w × h, px) | Ground-contact point | From the look test |
|---|---|---|---|
| Ground tile | 48 × 24, an exact 2:1 diamond | centre | `tile_sand` |
| Person | about 22–24 × 30–32 | between the feet | `sharpshooter`, `welldigger` |
| Animal | sized to the animal: a coyote is 26 × 18, a longhorn or horse larger | between the feet | `coyote` |
| Wagon | about 84 × 62 | centre of the wheel footprint | `wagon_core`, `wagon_plain` (drawn at 64 × 48; the owner asked for bigger wagons on 2026-10-20 because people must look as if they could ride inside) |
| Fence segment | 30 × 24, along a cell edge at the 2:1 slope | centre of the edge | `fence_rail` |
| Trap | about 18 × 10, flat on the ground | centre | `trap_jaw` |
| Small prop | about 14 px wide | base | `rock`, `sagebrush` |
| Tall prop | a saguaro towers over a person: about 20 × 44 | base | `cactus` (drawn at 14 × 24, too small; to redo) |

**Characters stay 24 × 32** (owner's pick, 2026-10-20, over 30 × 40). Props are sized to the
characters, not the other way round: anything people ride, enter or hide behind must look
big enough for them.

The two wagons in the look test had to be rebuilt to the same scale; a class that drifts in
scale reads as a collage. The camera is the game's 2:1 isometric view. Characters face
down-right (towards the viewer, turned slightly right) and are mirrored by code for the
other facing.

### Line

- **Outer line:** a continuous 1 px line in Outline (`#2a1a14`) round the whole silhouette of every object. Code adds the second pixel of thickness, so the art itself carries only one.
- **Interior lines:** few, in Soft line (`#5d3826`), and in Outline only where two shapes must separate (an arm across a body, a hat brim over a face).
- **Ground tiles:** no line at all, inside or out.

### Shading and light

- **One light, from the upper-left** (the west), on every asset. Lit faces point up-left; shadow faces down-right.
- **Two values per material,** a lit one and a shadow one, from the pairs in §4.
- **Highlights:** at most one or two Highlight (`#fff6ce`) pixels per object.
- **Pixels:** no anti-aliasing, no gradients and no noisy dithering. Use clean clusters of flat colour, and never leave a single stray pixel; orphan pixels read as dead pixels at 1×.
- **Shadows:** no ground shadow in the art. Code draws a flat cool contact shadow under everything that stands.

### Shape

- **Characters:** chunky and friendly, with big heads, hands and hats, and **one exaggerated feature each** that reads at game size. The sharpshooter's enormous hat brim and the well digger's pick, longer than his body, are the models.
- **Silhouettes:** readable at a glance. Every unit type must be identifiable by silhouette alone at game size, with the side mark on.
- **Gameplay shapes stay crisp:** fence segments, traps, the core wagon and its strongbox, and the side marks.
- **Charm, not damage:** buildings may lean and sag. The town is never drawn damaged in a way that reads as attacked (guardrail 0).

## 4. Palette

These are the only colours, already graded warm-bright. Each letter is the key the look-test
sprite files use.

| Key | Role | Hex | Key | Role | Hex |
|---|---|---|---|---|---|
| `O` | Outline | `#2a1a14` | `o` | Soft line | `#5d3826` |
| `x` | Highlight | `#fff6ce` | | | |
| `s` | Skin, lit | `#fec486` | `S` | Skin, shadow | `#da8c55` |
| `h` | Leather, hair, hat | `#a2622e` | `H` | Leather, shadow | `#683d16` |
| `c` | Canvas, lit | `#f9e5b0` | `C` | Canvas, shadow | `#deb87b` |
| `w` | Wood, lit | `#ce8445` | `W` | Wood, shadow | `#895225` |
| `g` | Brass, lit | `#fcc83a` | `G` | Brass, shadow | `#c18a19` |
| `i` | Iron, lit | `#626a7c` | `I` | Iron, shadow | `#3a4151` |
| `k` | Stone, lit | `#aaa190` | `K` | Stone, shadow | `#756b5f` |
| `e` | Plant, lit | `#82b14e` | `E` | Plant, shadow | `#4c7f39` |
| `b` | Denim, lit | `#6086c2` | `B` | Denim, shadow | `#3c5c94` |
| `y` | Sand | `#f2c970` | `Y` | Sand, shadow | `#dba654` |
| `z` | Sand, light | `#fddf93` | `d` | Dry earth | `#c28345` |
| `a` | Sage, lit | `#a9b48e` | `A` | Sage, shadow | `#6f7c5e` |
| `r` | Dusty rose, lit | `#d9a196` | `R` | Dusty rose, shadow | `#a46c66` |
| `u` | Plum, lit | `#8f6b93` | `U` | Plum, shadow | `#5a4363` |
| `n` | Charcoal, lit | `#5a5058` | `N` | Charcoal, shadow | `#3a3238` |
| `m` | Moss, lit | `#9a9a4e` | `M` | Moss, shadow | `#686a32` |
| `v` | Cactus green, lit | `#7aa66b` | `V` | Cactus green, shadow | `#52703d` |

The last five pairs were added on 2026-10-20 at the owner's request, to give more variety
without getting louder. Each was measured with CIELAB distance (ΔE76) and admitted only if it
sits at least 25 from every side colour (so sides never blur), at least 15 from every sand
colour (so bodies never melt into the ground), and at least 10 from every existing colour.
Ochre, sky blue and bone were tried and failed: ochre was too close to the sand, sky blue too
close to the settler turquoise, and bone's shadow too close to stone. Sage is for sagebrush and
dry scrub; charcoal is for black hats and horses, distinct from the outline. Cactus green
(added the same day, at the owner's suggestion) exists so desert greens stop falling onto the
settler turquoise: its shadow leans yellow, at least 31 from both side colours. **Scenery never
uses the side colours at all**: the pixel step only lets units snap to `p`/`P`. A new colour must
pass the same three tests.

**Side colour** (keys `p` / `P`, recoloured by code per side):

| Side | Lit (`p`) | Shadow (`P`) |
|---|---|---|
| Settlers | Turquoise `#4fb8b0` | `#247778` |
| Raiders | Brick red `#ec5231` | `#a52d16` |

The ungraded values the look test started from are in
`assets/reference/look-test-2026-10-20/palette.json`. The grade is CSS `saturate(1.15)`
`contrast(1.03)`, computed in sRGB.

**Still to do:** run the contrast and colour-blind checks on the final palette (ART-PLAN
step 1).

## 5. Side identity

Settlers and raiders are told apart by **shape first, colour second** (guardrail 4):

- Every unit type is drawn once. Its bandana, shirt or sash uses the side keys `p` / `P`, so code recolours it turquoise or brick red. That area should be at least 10–15% of the visible body in every frame; the coyote's first draft, at 5%, disappeared against its fur.
- Code draws the side mark above every unit: a **round badge** for settlers and a **triangular tag** for raiders, plus a brass star for merge level and a small health bar once a unit has been hit.
- Side marks are a player setting, on by default. With them off, the side colour still tells the sides apart.
- Body colours must stay off the ground palette. The coyote's fur first used the sand colours and only its outline separated it from the ground.

## 6. Motion: alive and animated

The owner wants the game to feel alive, so everything moves. Two layers make that happen:

| Layer | Who makes it | What |
|---|---|---|
| **Frames** (in the art) | the artist, generator or pixel editor | Per character: **idle 2, walk 4, attack 2–3 frames**, facing down-right. Fences: intact and broken. Traps: laid and sprung. Wagons: one frame. |
| **Code motion** (on top of any art) | the renderer | walk bob, attack lunge, white hit flash, death topple and fade, dust at the feet, sparks and splinters, the contact shadow, an occasional wagon jolt, tumbleweeds rolling through, and one **ability cue per archetype** (six, reused across the roster) that must look different from an ordinary attack (PHASE-2 §26) |

The frame counts are the look test's and are the target. Whether a generator can hold one
character steady across walk frames is still unproven. If it can't, characters keep the code
motion with fewer drawn frames, and the frames that matter most (walk and attack) are
hand-finished in a pixel editor.

## 7. Where art comes from, and the build step that unifies it

Any source is allowed, as long as it ends up looking like one set:

- **Generated** (Wiro, using any image model; nothing that spends credits runs without the owner's yes);
- **Hand-drawn** in a pixel editor such as Aseprite, which is the norm for animation frames;
- **Kenney packs:** the owner bought them on itch.io for production use (CC0). They are a real
  source for props, terrain, fences, rocks and plants, always baked through the steps below and
  never shipped raw. Look in Kenney first for non-character pieces, before generating. **Every
  Kenney asset must earn its place and fit in** (owner, 2026-10-20): Kenney is a starting point,
  not a constraint, and a piece that reads as foreign to the house style, or that a purpose-made
  asset would beat, is replaced with our own (generated and pixelized, or drawn in code). A pale
  render can be warmed with a tint before the palette snap (sandstone for rocks, weathered wood
  for fences). Record the Kenney source file in each asset's provenance. The searchable catalogue
  of every pack is on the storage server, next to the packs (see `roadmap/state.json`,
  `art.kenney_catalog`).
- **Other bought or free packs:** record their licences.

The asset build (PHASE-2 §26) turns every source into the house style the same way:

1. Mask the background and trim to the content. Use the best source available, in this order: a
   real transparent background from the generator (GPT Image 2.5 on Wiro offers
   `background: transparent`); otherwise generate on a solid magenta (`#ff00ff`) backdrop,
   which no palette colour is near, and key it out; otherwise use a matting model once, at
   intake. A white backdrop is the last resort, because the canvas creams sit close to white.
2. Downscale to the class's art size (§3), keeping the ground-contact point fixed.
3. Snap every pixel to the §4 palette.
4. Add the 1 px outer outline where the source lacks one. Ground tiles are exempt.

Code adds the second outline pixel, the contact shadow and the side marks when drawing.
Because the build enforces scale, palette and line, two images from different sources still
match.

**The house generator** (owner's pick after the first Wiro pass, 2026-10-20) is **GPT Image 2
with a reference image**: it read clean while following the theme. Pass the closest
in-house sprite as the reference, so new assets inherit its line, palette and proportions.
Nano Banana 2.1 was a close second; FLUX 2 Pro drifted off-model. In the second pass, **GPT
Image 2.5 (Flare)** matched that look at about a quarter of the price ($0.013 against $0.053
per medium 1k image) and returned a real transparent background, so it is the default for
production runs. GPT Image 2 on a solid magenta backdrop also keys cleanly and is the fallback.

**Before every generation brief, look at the owner's original board**,
`assets/reference/style-board-v1.png` (owner, 2026-10-20: "revisit the original reference photo
before generating buildings and other assets"). Take its traits into the prompt (exaggerated but
readable silhouettes, false fronts, porches, water towers and signs, lived-in detail, warm but not
uniformly orange) and pass it as a reference image where the model accepts more than one.

**Generating sources:** ask for a clean, flat-colour
illustration at large size, not for "pixel art". Generators draw fake pixels that sit off the
grid, and downscaling clean flat art works better. A prompt names the subject and its one
exaggerated feature, then: "isometric three-quarter view facing down-right, whole object
visible, flat colours with two-tone shading, thick dark outline, light from the upper left,
plain flat background". Record every accepted image's prompt, model, seed and date in
`assets/painted/PROMPTS.md`, and check the model's licence before anything ships.

## 8. Anti-style: what it must NOT look like

If an asset has any of these, it is rejected or regenerated with a correction:

- **Wrong rendering:** a glossy 3D or "stylized 3D" finish, plastic sheen, rim lighting, bloom, lens flare, glowing particles or soft painterly blur.
- **Wrong pixels:** gradients, anti-aliased edges, noisy dithering, orphan pixels, mixed pixel sizes in one scene, or a pixel size off the whole-number grid.
- **Wrong colour:** colours outside §4, the orange-and-teal grade, neon, or a body painted in ground colours.
- **Outlines on ground tiles.**
- **Colour-only side identity:** the side colour area and the code side mark are always both present, unless the player has turned the marks off.
- **Wrong content:**
  - generic fantasy or sci-fi bleed-through;
  - gore;
  - anything in the town that looks attacked;
  - AI gibberish lettering: signs carry real words from a short list (SALOON, GENERAL STORE, BANK, LIVERY, ASSAY OFFICE, TRADING POST) or no lettering, with text added in code.
- **Indigenous imagery:** v1 unit art stays within settler, outlaw, frontier-industry and animal archetypes unless deliberate research is done and reviewed (PROJECT.md §20, PHASE-2 §26).

**Banned prompt words**, enforced by `scripts/art/prompt-lint` once it exists: *3D render,
octane, unreal engine, photorealistic, hyper-detailed, ultra-detailed, cinematic, cinematic
lighting, dramatic lighting, volumetric, glossy, 8k, 4k, masterpiece, trending, award-winning,
stunning, glowing, intricate*.

## 9. Accepting an asset

Accept an asset only if all five answers are yes:

1. Does it sit next to the look-test sprites (`assets/reference/look-test-2026-10-20/sheet.png`) as one family: the same line, light, palette and scale?
2. Can you name its one exaggerated feature?
3. Does it read in silhouette at game size, at the small pixel size?
4. For a unit, does its side colour show in every frame, with no body colour on the ground palette?
5. Is it free of everything in §8?

When an asset fails, name its single biggest problem and fix only that. Then regenerate or
redraw with the same seed and references where possible. After three rounds, rewrite the
subject description instead of stacking fixes. Problems that keep coming back become new §8
lines.
