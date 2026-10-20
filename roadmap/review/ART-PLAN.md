# Art and audio plan

Status: plan only, nothing built. Written 2026-10-20 for the next session, which runs on the
owner's PC with access to the Kenney library and to Wiro API credits. It turns the studio feel
review (`studio-feel.md`, findings 9–15 and the "Minimum polish pass") into a production plan,
and records which tool makes which asset. Revised the same day after the owner's style board: the
world and units are now painted, and code owns readability, motion and the fallback set.

## The target (owner's direction, 2026-10-20)

The reference board is `assets/reference/style-board-v1.png`. It sets the feeling to aim for; none of it is an asset to copy. The ideal screenshot reads like **a page from an illustrated Western adventure book that someone has carefully built into a playable miniature world.** Five qualities define it:

1. **Illustrated, not photorealistic.** Surfaces have brushwork, simplified material detail and deliberate shapes.
2. **Exaggerated, not distorted beyond readability.** Roofs, porches, signs, chimneys and water towers have appealing silhouettes.
3. **Lived-in, not cluttered.** Everyday life shows, but buildings and gameplay elements stay easy to identify.
4. **Playful, not childish.** Expressive characters and visual jokes sit beside convincing timber, canvas, metal, dirt and stone.
5. **Warm, not uniformly orange.** Sun-baked earth is the base, balanced by cool shadows, blue-green paint, sagebrush and turquoise skies.

**Palette (from the board).** These are the starting tokens. Each must be contrast-checked against the ground before use (feel review finding 11):

| Role | Name | Hex |
|---|---|---|
| Base | Trail Dust | `#D8B477` |
| Base | Weathered Cedar | `#A96E48` |
| Base | Sunbleached Canvas | `#EBD4A6` |
| Cool | Sagebrush | `#718365` |
| Cool | Faded Turquoise | `#4D8584` |
| Cool | Storm Blue | `#6D7180` |
| Accent | Brick Red | `#C75E43` |
| Accent | Brass Gold | `#E5B84F` |
| Accent | Dark Walnut | `#49372E` |

**Side identity.** Settlers and raiders must be told apart by shape first, colour second (guardrail 4). Faded Turquoise against Brick Red is the natural pair from this palette, but it must pass a deuteranopia and protanopia simulation on Trail Dust ground. Every unit also carries a side badge shape: a round settler badge or a triangular raider bandana tag, drawn by code over the painted sprite.

**What the board shows that the design does not have.** These do not become mechanics without a PROJECT.md change:
- The board's "Building upgrade" strip (Scrappy → Landmark) and "Build your town" tagline. The town is never attacked and has no building upgrades in PROJECT.md. A purely visual town that grows with the account's progression (ladder rungs, banked trips) fits, if it grants nothing.
- The board's cast (Cowboy, Prospector, Sheriff, Blacksmith, Scout, Saloon Girl). This is a style target. The game's real roster (Dust Rider, Well Digger and the rest, 32 types in four regions) gets designed in this style.
- The title "CARAVAN". The game is "Caravan Vaults"; the vault, the strongbox on the core wagon, should appear in the logo.

## The decision: painted art for the world, code for readability and motion

The board's hand-painted look cannot come from code-built flat vector art, so the earlier plan (code-built SVG for everything read mid-fight) is replaced. **Painted, generated art (Wiro) is now the primary source for the world and its units. Code owns readability, motion and every fallback.**

| Source | Use it for | Why |
|---|---|---|
| **Wiro, painted** | Buildings and the town diorama; wagons, including the core "vault" wagon and damaged states; unit sprites (32 types, one painted 3/4-iso pose each, mirrored for the opposite facing); fence tiers (intact and broken) and traps (laid and sprung); terrain tiles and props for each region; painted UI chrome (parchment cards, wanted-poster frame, wooden and brass buttons, the round resource badges); icon art; key art, the logo backdrop, region banners, unit portraits, loading screens and cosmetic art | This is the look on the board, and only a painting model gets there. |
| **Code** | The readability layer on top of every painted sprite: the side badge shape, a level star, an ink outline, a contact shadow, HP bars and the selection ring. Motion: bob, walk lean, attack recoil, hit flash, death topple, wagon sway and dust, done as procedural tweens on single painted poses instead of frame-by-frame animation. Effects: dust, splinters, sparks and number pops from the fight-log rows. The logo wordmark and the inline splash. A complete flat fallback set, so the game builds and plays with no generated art. | Keeps silhouettes, sides and timing consistent and legible whatever the generator does, and costs nothing. |
| **Kenney library** | Greybox and layout stand-ins while the painted set is made, and possibly placeholder UI sounds. Not shipped art: its neutral look is the opposite of this target. | The owner already has it, and it is useful for blocking out scenes. |

**Consistency rules for generated sprites.** A sheet of independently generated images looks like a collage, not a game; these rules prevent that:
- **One camera.** Every world asset is the same isometric angle and the same light direction, late afternoon from the west, with cool shadows. That angle is part of every prompt and of the style reference.
- **One style reference.** The first accepted key art plus this board is passed as the reference image to every later generation, where the model allows image or style reference.
- **One scale.** Each class of asset gets a fixed pixel scale (units, wagons, buildings) and a ground-contact line, checked by a script before an asset is accepted.
- **Clean cut-outs.** Assets are generated on a plain backdrop and masked in code. A shared palette-harmonise pass pulls every accepted asset towards the tokens above.
- **Animation without frames.** Units are single painted poses animated by code tweens. Where a pose change is essential (attack, death), at most two extra painted poses per archetype are generated, not per type.
- **Silhouette test.** Every unit type must be identifiable by silhouette alone at scouting zoom, in a half-second glance, with the code badge on. A failing asset is regenerated, not shipped.

## Order of work (follows the feel review's phases)

1. **Art bible, one page:**
   - this board and the five qualities;
   - the palette with contrast checks against the ground, and the side pair checked under colour-blind simulation;
   - the camera angle and light;
   - per-class scales;
   - the outline, shadow and badge rules;
   - the silhouette rule.
2. **Canvas legibility patch, code only:** outlines, contact shadows, side badges and a desaturated ground, then a colour-blind retest. This is feel review step 7. It ships before any art, because it fixes today's 1.10:1 contrast.
3. **Key art via Wiro:** about 6 explorations in the board's style, showing the core vault wagon in a circle on the trail at golden hour. Pick one and lock it with the board as the style reference. Record the prompt, model and seed in `assets/painted/PROMPTS.md`.
4. **One complete vertical slice:** Desert terrain tiles, the core wagon, two wagons, one fence tier, two traps, and 4 unit types (2 settler, 2 raider). Wire them through the `iso/skins.ts` seam, which today throws on `kind: "sprite"`, so PHASE-2 §26 first has to make it draw sprites. Add code motion and badges, and play a replay with them. This proves the pipeline before credits go on the full set.
5. **The full unit roster (32 types),** then the remaining fence tiers and traps, against the locked reference.
6. **The town diorama:** the main street, the mine head-frame and the merge and outfit locations as tappable places (feel review finding 12). Nothing in it may look damaged or attackable (guardrail 0).
7. **The other three regions:** terrain, props and banners.
8. **UI chrome, icons, portraits, loading screens,** then cosmetic art. The cosmetics currently have no art and are never drawn (live-ops review F14), so their render path is built first.

## Wiro usage

- **API.** Base `https://api.wiro.ai/v1`. Requests are signed with HMAC-SHA256 using an API key and secret (per their SDK README; confirm against their authentication docs before the first call). Models are listed with `POST /Tool/List`, category `image-generation`; FLUX 2 Pro, Imagen 4 and Seedream are among them.
- **Credentials.** Put them in `.env` on the PC as `WIRO_API_KEY` and `WIRO_API_SECRET`. Every script loads `.env`. Never commit them, and never paste them into chat.
- **Spend discipline:**
  - A cheap sketch round comes before every batch.
  - One locked style reference.
  - Every accepted image is saved under `assets/painted/` with its prompt, model, seed and date recorded beside it.
  - Rejected images are not kept.
- **Licence.** Check each model's terms for commercial use before an image ships, and record the model with each asset.
- **Post-processing** is done in code: crop, mask, palette harmonise, the paper grain, and export at 1×, 2× and 3×, as WebP plus PNG fallback.

## Audio (feel review finding 15)

The feel review specifies the minimum set and ties each cue to the log event that fires it. That set is about 40 effects, 3 ambience loops, 3 music tracks and 4 stingers, roughly 2.3–2.8 MB against the spec's 3 MB budget.

- **First pass, code-synthesised, $0.**
  - The effects are generated jsfxr-style and rendered to OGG/WebM by a script.
  - The music is a short procedural Western score: guitar-like plucks, harmonica-like leads, a stomp, and a clip-clop for the trail.
  - It covers every cue in the table, so the game is never silent.
- **Optional upgrade.** Use an effects API (for example ElevenLabs) or Wiro if it offers audio models, for the cues that matter most: hit, trap sprung, core reached, bank, overrun, merge. Licences are recorded the same way as for images.
- **Haptics.** Follow the feel review's map, on supported devices only, and respect reduced-motion and a mute setting stored on the account.

## Budget guardrails

- **No build may depend on a paid service.** The code fallback set keeps the game buildable and playable with no generated art; painted assets are committed files once accepted, never fetched at runtime.
- **Prove the pipeline before spending.** The vertical slice (step 4) is the gate: credits go on the full roster only after the slice reads well in a real replay on a phone.
- **Stay inside the size budget.** Keep the initial download small: painted pieces are lazy-loaded per screen, and audio streams after first interaction.
