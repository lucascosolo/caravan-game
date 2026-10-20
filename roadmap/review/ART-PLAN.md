# Art and audio plan

Status: plan only, nothing built. Written 2026-10-20 for the next session, which runs on the
owner's PC with access to the Kenney library and to Wiro API credits. It turns the studio feel
review (`studio-feel.md`, findings 9–15 and the "Minimum polish pass") into a production plan,
and records which tool makes which asset.

## The decision: three sources, one art direction

The owner finds Kenney assets generic, and they are: they are designed to be neutral. Identity
in this game must come from the pieces players read every fight and the pieces that sell the
fantasy. So each asset gets the cheapest source that does not cost the game its personality.

| Source | Use it for | Why |
|---|---|---|
| **Code-built SVG** (written in this repo) | Everything read mid-fight: the 6 unit archetype bodies and their type overlays (hat, weapon, mount), the side badges, level stars, wagons and the core "vault" wagon, fence tiers (intact and broken), traps (laid and sprung), effect sprites (hit flash, dust, splinters), the 24 px icon set, stance and affinity icons, UI chrome (parchment card, wanted-poster frame, brass buttons, leather tabs), the logo wordmark and the inline splash | Must stay consistent across angles and frames and readable at scouting zoom (guardrail 4: shape plus colour, never colour alone). Generated images drift between frames; code does not. Zero cost. Animatable directly in the iso renderer. |
| **Wiro (painted, generated)** | Key art and the store/app-icon source, a painted backdrop behind the logo, one banner per region (Desert, High Plains, Mountain, Badlands), the town main-street backdrop, unit portraits for the scout and party cards (one per unit type, 32), loading-screen paintings, cosmetic and pack art | These carry the "made for this game" feel and are seen still, one at a time, so frame-to-frame consistency does not matter. Credits are spent only here. |
| **Kenney library (owner's copy)** | Ground tiles, rocks, cacti, barrels, crates, dead trees, generic props and particles, and placeholder UI sounds while the real set is made | Scenery nobody reads closely. Every Kenney sprite is re-coloured into the palette below by a script, so it stops looking like Kenney. |

Every source goes through the same final treatment, so they read as one game:
- **Palette remap.** Sun-bleached ochre, rust, sage and dusk blue for the world. The two sides keep their Okabe–Ito-safe hues, but darkened and outlined so they clear 3:1 against the ground (feel review finding 11: today defenders are 1.10:1 on sand).
- **Line and light.** A 2 px ink outline, a contact shadow under everything that stands, and one light direction (late afternoon, from the west).
- **Texture.** A light paper-grain overlay on painted pieces and UI chrome.
- **Type.** A western woodtype or slab display face for headings and numbers, and a humanist sans for body text. Both are self-hosted, since the CSP is `font-src 'self'`. Use an OFL-licensed pair.

## Order of work (follows the feel review's phases)

1. **Art bible, one page:** the palette swatches with contrast checks, the outline and shadow rules, the silhouette rule (every unit type identifiable by silhouette alone at scouting zoom in a half-second glance), and three reference pieces. Done before anything else.
2. **Canvas legibility patch, code only:** outlines, contact shadows, side badges and a desaturated ground. Then a deuteranopia retest. This is feel review step 7 and needs no art.
3. **Splash key art via Wiro:** about 6 explorations, then pick one and lock it as the style reference for every later Wiro piece. Use it as an image-to-image or style reference where the model allows, and keep the prompt and seed in `assets/painted/PROMPTS.md`.
4. **Code-built unit archetypes and overlays.** Start with the 6 bodies and the 8 directions, then the overlays for the 32 types, wagons, fences and traps, all through the `iso/skins.ts` seam. Today it throws on `kind: "sprite"`, so PHASE-2 §26 has to make it draw sprites first.
5. **Kenney scenery pass:** a script that palette-remaps and outlines the chosen Kenney tiles into the Desert set first, then High Plains, Mountain and Badlands.
6. **The rest of the Wiro pieces,** batched against the locked style reference: region banners, the town backdrop, the 32 portraits, loading screens, then cosmetic art. The cosmetics currently have no art and are never drawn (live-ops review F14), so the render path is built first.
7. **Icon set and UI chrome,** in code.

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

- **No art in fights may depend on a paid service.** The game must build and play with code-built and Kenney art alone.
- **Wiro pieces are optional enhancements.** If one is missing, the code-built fallback shows.
- **Stay inside the size budget.** Keep the initial download small: painted pieces are lazy-loaded per screen, and audio streams after first interaction.
