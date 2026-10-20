# Caravan Vaults: style guide and anti-style guide

This is the art bible from `roadmap/review/ART-PLAN.md`, step 1. It turns the owner's reference
board (`assets/reference/style-board-v1.png`) and the owner's ten art principles (2026-10-20) into
rules an artist, or a generation prompt, can follow. When in doubt, this file wins over adjectives.

## 1. The tradition

**Mid-century storybook gouache, with a brush-ink contour, built as a tabletop diorama.**
Picture an illustrated Western adventure book from the 1950s. It is painted in opaque gouache on
cold-press paper and outlined with a loaded brush in dark walnut ink. Someone has cut it out and
set it on a table as a tiny, slightly wonky model town.

Two supporting traditions, each used only where named:
- **Wood-type broadside printing:** wanted posters, playbills and freight notices from 19th-century letterpress. This is for UI: headings, numbers, notices, the wanted-poster frame and the trip-result "notice". It uses flat ink colours, slight misregistration and worn type edges.
- **Pulp dime-novel cover painting.** For key art and region banners only. Even there it stays flat and storybook: the energy comes from the pose and the shape, not from movie lighting.

Not the tradition: 3D-render "stylized", glossy mobile-ad art, concept-art matte painting,
anime, pixel art, vector flat design.

## 2. How it is constructed

### Line
- **Contour:** a walnut-ink brush line (`#49372E`). It is never pure black.
- **Weight:** on screen at 1× it is about 3 px for units and wagons and 2 px for buildings and props. Terrain has no contour.
- **Variation:** the line is thicker on the shadow side and at overlaps, thins to nothing at highlights, and has small gaps where light hits. It is never a uniform vector stroke.
- **Interior lines:** few. Only plank seams, the fold of a coat and the brim of a hat. Detail is suggested, not drawn.

### Brushwork
- **Coverage:** opaque gouache. Flat fills with dry-brush edges, and visible brush direction that follows the form: along the planks, around a barrel, down a canvas sag.
- **Paper:** paper tooth shows through in the lightest areas only.
- **No blending:** no airbrush gradients and no soft glazing. Value changes come in steps, not blends.

### Shape
- **Characters:** chunky, about 3–3.5 heads tall. Hats, hands, boots and tools are oversized. Each type gets one exaggerated feature that reads at 64 px: a huge hat brim, a pickaxe longer than the body, a bandana that covers half the face.
- **Buildings:** top-heavy false fronts. Roofs sag. Porches lean 2–4°. No wall is perfectly plumb.
- **Silhouettes:** mostly broad simple masses, with one spike of interest each, such as a chimney, a sign or a water-tower leg.

### Colour
- **Palette:** the board's nine colours and nothing else, except darker or lighter mixes of them:

  | Group | Colours |
  |---|---|
  | Earth | Trail Dust `#D8B477`, Weathered Cedar `#A96E48`, Sunbleached Canvas `#EBD4A6` |
  | Cool | Sagebrush `#718365`, Faded Turquoise `#4D8584`, Storm Blue `#6D7180` |
  | Accent | Brick Red `#C75E43`, Brass Gold `#E5B84F`, Dark Walnut `#49372E` |

- **Per asset:** at most 5 colours plus the walnut ink.
- **Warm against cool:** every scene pairs sun-baked earth with at least one cool area (sage, turquoise paint or sky) so it never reads uniformly orange.
- **Side identity:**
  - Settlers lean Faded Turquoise and Sunbleached Canvas.
  - Raiders lean Brick Red and Dark Walnut.
  - Code always adds a side badge shape: a round settler badge or a triangular raider tag.
  - The pair must pass deuteranopia and protanopia simulation on Trail Dust ground (guardrail 4).

### Shading and light
- **One light:** late afternoon from the west (upper left on screen). It is the same light on every asset.
- **Two values per material:** a lit value and a shadow value, with at most one narrow mid-tone where they meet.
- **Shadow colour:** shadows are cool (Storm Blue mixed in), never just a darker brown.
- **Cast shadows:** flat Storm Blue shapes at about 35 % opacity, as a hard-edged blob under everything that stands.
- **Highlights:** Sunbleached Canvas, never white. At most one highlight dab per object.

### Materials
| Material | Treatment |
|---|---|
| Timber | Planks of uneven widths with a knot or two, split ends, gaps between boards and one or two nails picked out in brass |
| Canvas | Sagging between hoops, with one patch, a stitched seam and slightly darker stains at the bottom |
| Metal | Flat brass or iron with a single highlight dab. Rust is a few Brick Red dry-brush flecks. |
| Stone | Rounded lumps in two values, never brick-perfect |
| Dirt and sand | A flat Trail Dust field, wheel ruts in two brush strokes, a few pebbles and sparse scrub tufts. Quiet. |
| Cloth | Big folds only. Bandanas and sashes give the colour accents. |

## 3. Deliberate imperfection

Every asset should have at least one of these, chosen on purpose:
- crooked architecture (leaning posts, a sagging ridge line, a shutter hanging off one hinge);
- asymmetry (two different windows, a lopsided chimney, a patched-on lean-to);
- uneven paint (a dry-brush edge, a slightly missed fill, visible strokes);
- worn materials (a cracked plank, a frayed rope, chipped paint on a sign);
- quirky proportions (an oversized sign, a tiny door, a hat too big for its owner).

Two limits keep it intentional rather than sloppy:
- **Gameplay shapes stay crisp.** The side badge, fence segments and the core wagon's silhouette are never so crooked that they mislead.
- **The town is never damaged in a way that reads as attacked** (guardrail 0). It is lived-in, not raided.

## 4. Simplify

- **Detail budget:** detail goes where the eye should land, which is the silhouette and the functional bit (a weapon, a trap mechanism, a sign). Everywhere else is a broad flat shape.
- **Visual quiet:** about a third of any scene is calm area, such as open sand, sky or a plain wall. Busy patterns are not allowed to fill a frame.
- **The 64 px test:** a unit must still read at 64 px tall, in silhouette only, within half a second. If it doesn't, simplify the shape before adding anything.

## 5. Reference set

Feed a few chosen references alongside every prompt, one per job, rather than text alone. Keep them in `assets/reference/` with the source and licence recorded in `assets/reference/SOURCES.md`.

| Job | Reference |
|---|---|
| Colour and overall feel | `style-board-v1.png` (owner's board) |
| Linework | a public-domain mid-century storybook page with a brush-ink contour, to collect |
| Texture | a scan of real gouache on cold-press paper, flat swatches with dry-brush edges, to collect or paint |
| Composition (key art and banners) | a public-domain dime-novel or pulp Western cover, to collect |
| Typography and UI | public-domain 19th-century wood-type broadsides and wanted posters, to collect |

Only use references that are public domain or that the owner holds rights to. A reference teaches the style; nothing from it is traced or copied.

## 6. Composition

- **In-game assets** use the fixed isometric camera. Composition there means a clear silhouette on a plain backdrop, the object resting on its ground line, and nothing cropped.
- **Key art, banners and loading screens:**
  - **Subject placement:** put the subject off-centre on a third. Let the horizon sit high (looking down on the trail) or low (a big sky), not dead centre.
  - **Light:** even storybook light, not spotlit drama. Mood comes from the palette and the pose.
  - **Tell a moment, not a pose:** a wagon wheel stuck in a rut, a raider's hat blown off, a mule that refuses to move.
  - **Leave room for type:** a calm area holds the lettering, as on a printed book cover.
  - **Vary the framing across the set:** some wide and empty, some close and cluttered, some seen from the side.

## 7. Anti-style guide: what it must NOT look like

If an image has any of these, it is rejected or regenerated with a correction.

**Rendering clichés**
- glossy 3D-render or "stylized 3D" look, plastic sheen, subsurface skin;
- rim lighting, god rays, lens flare, bokeh, volumetric fog, bloom;
- glowing particles, magic sparkles, energy trails;
- airbrushed gradients, soft painterly blur everywhere, smudge-tool blending;
- photo textures, photobashed elements, realistic skin pores, hyper-detail;
- the orange-and-teal colour grade, oversaturation, neon accents outside the palette.

**Composition clichés**
- a centred hero shot with the subject staring at the camera;
- movie-poster layouts, dramatic low angles on everything, a dark vignette;
- symmetry for its own sake; every building perfectly front-on.

**Content clichés**
- generic fantasy (castles, armour, dragons) or sci-fi bleed-through;
- anime eyes, chibi cuteness with no grit, mascot-style smiles on everyone;
- gritty realism, gore, sepia "old photo" filters;
- AI tells: melted hands, extra fingers, unreadable pseudo-letters on signs, merging limbs, wood grain that turns into faces.

**Game-specific rules**
- No colour-only side identity: the badge shape is always there.
- Nothing in the town looks damaged by attack, burned or besieged.
- Signs either carry real readable words from a short list (SALOON, GENERAL STORE, BANK, LIVERY, ASSAY OFFICE, TRADING POST) or carry no lettering, with text added in code. No AI gibberish lettering ships.

**Banned prompt words.** Don't use these at all, or at most once and on purpose: *epic, hyper-detailed, ultra-detailed, ultra-realistic, photorealistic, cinematic, cinematic lighting, dramatic lighting, octane, unreal engine, 8k, 4k, masterpiece, trending, award-winning, stunning, glowing, volumetric, intricate.* A prompt lint script (`scripts/art/prompt-lint`) rejects them.

## 8. Prompt template

Build every prompt from these parts, in this order, and keep each part to concrete construction words:

1. **Tradition:** "Mid-century storybook gouache illustration, opaque flat paint with dry-brush edges, brush-ink contour in dark walnut, on cold-press paper."
2. **Construction:** line weight, two-value shading with cool shadows, west light, palette names, and the material treatments from §2 for this asset.
3. **Subject:** one sentence of what it is, plus its one exaggerated feature and its function. For example, the core wagon is "a Conestoga carrying a padlocked iron strongbox".
4. **Imperfection:** one or two specific items from §3.
5. **Framing:** for in-game assets, "isometric three-quarter view, whole object visible, plain flat backdrop, resting on a ground line". For key art, the composition choice from §6.
6. **Exclusions:** if the model takes a negative prompt, use §7's rendering and content clichés, kept short.
7. **References:** attach `style-board-v1.png` and the locked key art. Add the linework or texture reference when it helps.

Record each accepted image's prompt, model, seed, references and date in `assets/painted/PROMPTS.md`.

## 9. Personality check before accepting an image

Answer each question yes or no. Accept the image only if all five are yes.
1. Could this only belong to Caravan Vaults, or could it be any Western mobile game? It must be distinctive.
2. Can you name its one deliberate imperfection and its one exaggerated feature?
3. Does it read in silhouette at game size, with at least a third of it quiet?
4. Is the light the west-light storybook light, and are the shadows cool?
5. Is it free of everything in §7?

Polish matters less than these answers. A slightly rough image that passes all five beats a beautiful one that fails the first.

## 10. Iterating: remove the biggest cliché, don't add adjectives

When an image feels generic:
1. Name its single biggest offender, for example "the lighting is spotlit and dramatic" or "the wagon is perfectly symmetric".
2. Make one targeted correction, either by removing the cause or by stating the construction rule that replaces it ("even storybook light from the west, flat cool shadow"). Don't add more adjectives.
3. Regenerate with the same seed and references where the model allows, so only that one thing changes.
4. Log the offender and the correction in `PROMPTS.md`. Recurring offenders become new §7 lines.

At most three correction rounds per asset. If it still fails, rewrite the subject sentence rather than stacking fixes.
