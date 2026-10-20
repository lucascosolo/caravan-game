# Studio-feel review: what separates Caravan Vaults from a studio-made game

**Reviewer role:** UX and game-feel lead, top-grossing mobile studio. **Build:** `roadmap/phase-2-spec` @ `0058f0d`.
**Date:** 2026-10-20. **Scope:** presentation, feel, flow, onboarding, accessibility, performance feel, copy. No code was changed.

## Headline verdict

Caravan Vaults is a rigorous, honest rules prototype wearing a settings-app costume. The systems underneath are
studio-grade or better: deterministic fights, every stake itemized, no dark patterns, 44 px targets, focus-trapped
modals, rem type, and text alternatives for the canvas. But nothing a player *feels* exists yet. There is no art
direction (the units are blue and orange lozenges labelled "WD" and "DR"), no sound, no haptics and no motion system.
The whole stylesheet has one 160 ms animation and no `:active` state. Every screen is a scrolling form: the town is 5.3
phone screens long and the wagon circle 6.2. The one payoff the game has, watching your circle hold, is a static
diagram whose camera can leave the whole fight out of frame. It ends in a bordered text box that reads "Your caravan
held." A bank or an overrun lands below the fold, under a "Save your progress" card. The copy says "server" 55 times
and never sounds like the frontier. The good news is that almost all of the gap is presentation. The log-driven replay
architecture is the ideal base for juice, because every effect can be keyed to a log record without touching the
resolver. A focused polish pass of about 8–12 weeks, art included, would make this read as a real game. The first two
weeks need no artist at all.

### Top 10

| # | Finding | Pri | Size |
|---|---|---|---|
| 1 | [No art direction: placeholder shapes everywhere](#f9) | P0 | L |
| 2 | [Silent: no audio, no haptics](#f15) | P0 | M |
| 3 | [The replay camera is static and misses the action](#f3) | P0 | M |
| 4 | [Hits, deaths, traps and the core reached are diagrams, not impacts; no win or loss stinger](#f4) | P0 | M |
| 5 | [Reward moments are flat text, buried under other prompts](#f6) | P0 | M |
| 6 | [No touch feedback and no motion system](#f1) | P0 | M |
| 7 | [Primary actions sit at the bottom of 4–6-screen pages; a trip is 13 taps over about 17 screen-heights](#f16) | P0 | M |
| 8 | [The first session tells instead of shows; the outfit step dead-ends](#f26) | P0 | M |
| 9 | [Canvas actors are illegible on the sand: contrast 1.1–1.5:1, and raiders vanish under deuteranopia](#f11) | P0 | S |
| 10 | [The voice is system-speak, not Old West](#f33) | P0 | S |

## How this was played

- **Hosting:** single-process production mode per `docs/PLAYTEST-HOSTING.md`: `NODE_ENV=production`, `SERVE_WEB=1`,
  `STORE_MODE=off`, real resolver, port 3933, database `caravan_studio_feel`. It used the shared-instance login roles
  `caravan_sf_owner` (member of `caravan`, `SET role = caravan`) and `caravan_sf_app` (member of `caravan_app`), with
  strong passwords. The database was migrated and seeded with the 96 authored parties, and no login accounts. There was
  no Caddy in front, so `localhost` stood in for HTTPS. Note: the Node server sends no `Content-Encoding`; the runbook
  relies on Caddy for compression.
- **Device:** Playwright Chromium (`/opt/pw-browsers`) with `isMobile`, `hasTouch`, DPR 2–3 and an Android UA, at
  390×844, 360×740 and 320×568, in both light and dark color schemes. Also tested: landscape 844×390, 150% root text,
  reduced motion, offline, a 1.5 s RTT link, and CPU 4× with Fast 3G (562.5 ms RTT, 180 KB/s down).
- **Walks:** the guided first session (guest → welcome → refugee → outfit → ride out → scout → guided circle → commit →
  replay → results → push → encounter 2 → bank → raise the party → finish), an unguided Badlands caravan pushed
  unfenced to an overrun at encounter 5, a merge by canvas drag, and the Party, Webs, Inbox, Account, Packs and
  Cosmetics screens, plus error, loading and empty states.
- **Evidence.** In this document, `$SHOTS` means
  `/tmp/claude-0/-home-user-caravan-game/edcaf182-6a4d-5af1-b736-5ca8113d60f8/scratchpad/sf-review/shots`. The
  Playwright scripts that produced it are in the sibling `pw/` folder. Screen videos are in `$SHOTS/video/<step>/`: the
  first fight is `10-commit`, a 1× replay is `15-e2`, the overrun walk is `21-overrun`, and the merge is `19-merge`.
  Contact sheets cut from the videos are in `$SHOTS/frames10`, `frames15` and `frames21`. The evidence is not committed.
- **Not observed live:** a strike by my own standing party. My first caravan went on to bank a second trip, but its
  next three searches (one search and two free rerolls) still drew only authored outfits, so my second account's party was
  never served. The passive-side payoff below is judged from the inbox and feed screens and their copy.
- **Caveat:** this host renders WebGL in software (SwiftShader; 99.5% of profiled time is native GPU emulation). Canvas
  frame rates measured here are therefore not representative. JavaScript cost, payload, request counts and heap are.

**Priority:**
- **P0:** this is what makes it read as a prototype; fix it before outside players see it.
- **P1:** needed before a soft launch.
- **P2:** polish.

**Size** follows PHASE-2: S is one session, M is two to four sessions, L is a week or more.

---

## Findings

### 1. Game feel and juice

<a id="f1"></a>**1. No touch feedback and no motion system.** P0 · M
- **Evidence:**
  - `$SHOTS/04-refugee-tap-50ms.png` and `$SHOTS/04-refugee-taken.png`: tapping "Take" makes the offers vanish, the
    guide card swaps and the page jumps.
  - `$SHOTS/06-ride-confirm.png` → `$SHOTS/07-trail-p0.png`: riding out is a hard cut to a text page.
  - `apps/web/src/theme.css` has no `:active`, `:hover`, `:focus-visible` for `.btn`, and no `transition`. Its single
    animation is the 160 ms `sheet-in`.
- **What is wrong:**
  - Nothing responds to a finger. Buttons don't depress, tabs don't animate, and dialogs pop in and out.
  - Screens replace each other without a transition, and lists re-render in place. The only state change you can see
    is `opacity: .55` on disabled buttons.
  - On a phone, a game that does not answer the thumb within 100 ms feels broken, even when it is correct.
- **What a studio would do:**
  - Add motion tokens to `theme.css`: durations 80 / 160 / 240 / 400 ms and two easings (`cubic-bezier(.2,.8,.2,1)`
    for UI and a spring-like overshoot for rewards).
  - Press state on every button: scale to 0.96 and darken by 8% in 80 ms, with a spring back on release.
  - On tab change, the icon bounces and the screen cross-slides about 12 px over 200 ms.
  - Dialogs become bottom sheets that slide up 240 ms with a backdrop fade.
  - List items enter in a 30 ms stagger.
  - `prefers-reduced-motion` gets crossfades only.

<a id="f2"></a>**2. A fight has no anticipation beat, and the first frame is black.** P0 · M
- **Evidence:**
  - `$SHOTS/11-post-commit-00.png`: a fully blank screen, captured 250 ms after the "Commit" tap.
  - `$SHOTS/frames10/sheet-09.png`: "Committing…", then a black canvas, then the fight already running at 0:00 under
    "Nothing yet."
  - `$SHOTS/frames21/sheet-01.png`: "Loading the fight…", then three frames of black canvas.
  - `$SHOTS/frames15/sheet-03.png`: the opening shows the whole island, then hard-cuts to the close framing.
- **What is wrong:**
  - The most important tap in the game (commit) leads into a void. The circle the player spent minutes on disappears
    the instant they commit.
  - The fight then starts cold at 0:00 with no build-up, and the first 9 s of it is raiders walking in.
- **What a studio would do:**
  - Keep the committed circle on screen and play a 1.5–2 s **pre-roll** keyed to the log's spawn rows: a dust cloud on
    each approach edge, a "Riders on the horizon!" banner, the camera dollying from the main approach edge to the
    ring, a drum hit and a light haptic.
  - Mount the Pixi scene behind the transition and reveal it only after it has drawn its first frame. Paint the canvas
    host in `--bg-sunken` with the island silhouette, never `#000`.
  - Start the replay at the first contact (the first hit row), with a "skip intro" tap.
  - The quiet fast-forward already exists. Give it a visible speed-lines treatment instead of the text "fast-forwarding
    to the next key moment".

<a id="f3"></a>**3. The replay camera is static and frames the ring, not the action.** P0 · M
- **Evidence:**
  - `$SHOTS/15-e2-replay-end.png`: the ring is cut off on the right.
  - `$SHOTS/frames21/sheet-01.png` (overrun at encounter 5): every posted defender and every death happen outside the
    frame. The player watches four empty wagons until raiders walk into view and touch the core.
  - `$SHOTS/frames10/sheet-10.png`: the action is a few pixels in a corner.
- **What is wrong:**
  - The player is asked to watch the result of their decisions, and is not shown them.
  - Pinch and pan are the only camera, which is wrong for a replay that autoplays at 2×.
- **What a studio would do:** a log-driven **camera director**. It is presentation only, reading the same `frame(t)`
  positions the renderer already gets.
  - Frame the bounding box of the living units with a critically damped follow (about 0.4 s), never a cut.
  - On key rows (trap fired, fence broken, ability, the last defender down, core reached), punch in by 1.3× for
    0.6–1.0 s, then ease back.
  - A user pinch overrides the director for 3 s, then it eases back. A "free camera" toggle stays available.
  - Under reduced motion: no punch-ins, and slower follow.

<a id="f4"></a>**4. Impacts are diagrams. There is no hit weight, death, trap payoff, slow-motion or stinger.** P0 · M
- **Evidence:**
  - `$SHOTS/frames10/hit-02.png` and `$SHOTS/12-replay-005.png` show a hit as a 2.5 px cream line ending in a 3–6 px
    dot. A death is a grey X, and the unit simply vanishes.
  - In `apps/web/src/iso/scene.ts` `drawMark`:
    - a trap is an orange ellipse outline;
    - a fence break is a green rectangle outline;
    - the core reached is a yellow diamond outline.
  - HP bars are 3 px tall and quantized to 5%.
  - `$SHOTS/12-replay-end.png` and `$SHOTS/21-replay-end-5.png`: the win and loss end cards are the same bordered box,
    with one word different, and the button still says "Skip to result" after the fight has ended.
- **What is wrong:** the information is all there, which is good legibility, but there is no feel. Nothing tells the
  body that something hit hard, that a plan worked, or that it all fell apart.
- **What a studio would do:** an effect per log-row kind (table below). Every effect reads only the row's own fields,
  so audio and visuals stay a view of the log (PHASE-2 §27). The decisive moment is known in advance from the log (the
  core-reached row, or the last raider's death row). Slow-motion around it is presentation-only time warping; the fight
  is never re-simulated.

| Moment (log row) | Visual | Camera and time | Haptic | Sound |
|---|---|---|---|---|
| Raiders spawn | Dust plume per edge, banner "Riders from the east!" | Dolly from the main edge to the ring | Light | Hooves, whoop |
| Hit | Target white-flash 60 ms, 2 px knockback, damage number pops (amount from the row, rises 18 px, fades 500 ms); crits and abilities in gold | None | None | Gunshot, melee thunk, or beast snarl, by attacker type |
| Ability fires | 200 ms wind-up glow in the archetype colour, icon pops over the head, then the effect (dash trail, heal sparkle, buff ring) | Punch-in 1.2× for the first one per fight | Light | One cue per archetype (6) |
| Trap fired | Ground bursts (spikes, smoke), 8–12 debris particles, trap sprite swaps to sprung | 4 px shake for 150 ms, punch-in | Medium | Snap + spike / powder boom |
| Trap nullified by siege | Trap greys out, "Bridged" tag | None | None | Dull thud |
| Fence hit / broken | Splinters; segment swaps to broken sprite; the gap glows briefly | 3 px shake on break | Light on break | Wood thunk / crash |
| Unit dies | Falls and fades 300 ms, dust puff, hat or grave decal for 2 s; HP bar drains with a trailing "ghost" bar | None | Light (own unit) | Grunt + body fall |
| Last raider down (held) | Remaining raiders' banners drop | Ease out to the full circle, 0.5× for 0.6 s | Success pattern | Victory stinger |
| Core reached (overrun) | Red vignette, canvas tears on the core wagon, scene desaturates | 0.3× for 0.8 s, punch-in on the core | Heavy double | Bell alarm + defeat stinger |
| End card | Full-bleed banner "THE CIRCLE HELD!" (brass) or "OVERRUN" (torn red), Coin counter rolls up | None | None | Fanfare / dirge |

<a id="f5"></a>**5. The end of a fight has no stinger, and its controls are mislabeled.** P0 · S
- **Evidence:**
  - `$SHOTS/12-replay-end.png`: "Skip to result" is the dialog action even after the end card shows.
  - `$SHOTS/12-replay-below.png`: the "As it happened" heading overlaps the strip under the pinned stage.
- **What is wrong:** win and loss carry the same weight. The exit is labeled as if the fight were still running, and
  the end card buries the outcome under depth percentages and an authored-outfit footnote.
- **What a studio would do:**
  - A 1.5 s outcome stinger (see the table in finding 4), then a single "Continue" CTA.
  - Depth and the footnote move into the results card.
  - Keep "Watch again" as a secondary action.

<a id="f6"></a>**6. Reward and loss moments are flat text, buried under other prompts.** P0 · M
- **Evidence:**
  - **Bank:** `$SHOTS/16-summary-p0.png` and `$SHOTS/16-summary-p1.png`. "1658 Coin banked." is the fourth item,
    below the fold, under a guide card with four buttons and a "Save your progress" card with two.
  - **Overrun:** `$SHOTS/21-overrun-summary-p0.png`. "3969 unbanked Coin was lost" sits under the same save prompt.
  - **Merge:** `$SHOTS/19-town-canvas-after.png` and `$SHOTS/19-after-merge.png`. The badge changes from "1" to "2",
    the marker is identical, and a green notice reads "Merged: 1 × Well Digger level 2. 1454 Coin left."
  - **Encounter win:** `$SHOTS/13-results-p0.png`, "+600 Coin this encounter, carried unbanked."
  - **Passive side** (not observed live; from `InboxScreen.tsx` and `STRINGS.inbox`): a strike is a text card, "Your
    party struck a caravan", with a "Watch the fight" button, behind a header button that is polled every 60 s and
    has no device push yet (§29). It is the hook the whole asynchronous loop depends on.
- **What is wrong:**
  - These are the dopamine and the sting of the loop: banking is the whole point of pushing your luck. Each arrives as
    a line of body text, with no count-up and no fly-to-HUD.
  - There is no persistent Coin HUD to fly to. The balance only appears as a sentence in the town page.
- **What a studio would do:**
  - **Bank:** a full-screen "Delivered!" moment. A coin count-up (encounters, delivery bonus, total) with ticks, coins
    fly into a persistent Coin chip in the header, then the itemized summary.
  - **Overrun:** a desaturated "Overrun" card with the lost Coin draining out, followed by a "What to try next" tip.
  - **Merge:** the two units slide together, flash white, and the result pops 1 → 1.25 → 1 with a brass rank badge flip
    and a small star burst. The copy says what was *freed* ("frees 1 slot"), never "stronger", per guardrail 2.
  - **Refugee taken:** the card flies into the roster with a "Joined" stamp.
  - **Unlock:** the node lights up and a line draws along its prerequisite edges.
  - **Your party struck:** on the next app open, a "Word from the trail" card with your party's banner, the outcome and
    the Coin it earned counting up. "Watch" opens the owner-view replay framed on your raiders.
  - The guest-save prompt never shares a screen with a reward or a loss (finding 19).

<a id="f7"></a>**7. Progress is invisible when it is earned.** P1 · S
- **Evidence:**
  - The ledger for my first trip records `reputation_changed` +5 and +8, and `ladder_progress_gained` +25 living and
    +25 trap per encounter (DB query on `caravan_studio_feel`).
  - Neither the results card nor the trip summary mentions Reputation or the ladder: `13-results.json` and
    `16-summary.json` contain neither word.
  - Webs then reads "Ladder rung 0 of 20. 50 ladder points to the next rung" (`$SHOTS/18-webs-p0.png`).
- **What is wrong:** the long-term hook (ladders, then the webs) never gets a beat. PHASE-2 §22 asks for "Reputation
  change, ladder progress" in the results summary.
- **What a studio would do:**
  - Two animated progress bars on the result card ("Living ladder 25 → 50 / 100", "Reputation 405 → 413").
  - A "Rung reached! 1 unlock point" toast that deep-links to the node it can buy.

<a id="f8"></a>**8. The replay layout shifts while it plays.** P1 · S
- **Evidence:** `$SHOTS/frames10/sheet-10.png`. The event strip grows from 0 to 3 lines and pushes the transport
  controls down, and the end card inserts between the stage and the controls.
- **What a studio would do:** a fixed-height 3-line ticker overlaid on the bottom of the stage (gradient scrim), with
  the controls pinned. The end card overlays the stage after the stinger, and "Look at the field" dismisses it.

### 2. Visual identity

<a id="f9"></a>**9. There is no art direction: every visual is a placeholder.** P0 · L
- **Evidence:**
  - Units, wagons and fences: `$SHOTS/10-circle-arranged.png` and `$SHOTS/frames10/hit-02.png`. Units are blue or
    orange rectangles, ellipses and triangles with initials; wagons are cream ellipses on brown boxes; fences are brown
    diamonds with a stick.
  - Town: `$SHOTS/03-town-canvas.png` is a tan field with flat polygons cut off at its edges.
  - Party: `$SHOTS/17-party-raised-p2.png` shows the island with raiders as specks.
  - UI: system font, flat cards, unicode tab glyphs ⌂ ⛰ ⚑ ✦ ✉.
  - The app icon is a placeholder wheel (`apps/web/public/icon.svg`).
- **What is wrong:**
  - Nothing says "Old West", "caravan" or "vault".
  - Today the skin seam (`iso/skins.ts`) can only draw placeholders, because the scene throws on `kind: "sprite"`.
    PHASE-2 §26 is not started.
- **Minimum art pass that makes it read as a real Old West game** (roughly a 4–6-week, two-artist scope):
  - **Art bible first (1 week):** a warm, sun-bleached painterly-flat style with a 2-px ink outline, a dusk palette and
    one key-art piece. It must keep the colour-plus-shape rules of guardrail 4 and §35.
  - **Units:** 6 archetype bodies (matching §26's six ability cues). Each has idle, walk in 8 directions, attack and
    death, at 6–8 frames and about 64 px at 2×.
    - The 32 types are made of overlays on those bodies: hat, weapon and mount, which carry the role (rifle = ranged,
      pick or shovel = grit melee, horse or animal = beast).
    - Sides: settlers wear blue-cream with a round shield badge; raiders wear red-black with a bandana triangle. That
      keeps shape plus colour.
    - Level shows as a brass star badge (1–5).
    - Under §26, v1 stays within settler, outlaw, frontier-industry and animal archetypes.
  - **Wagons:**
    - The core is a Conestoga with a flag and a strongbox, the "vault".
    - The 4 parked wagons are drawn the same way.
    - Every wagon has a damaged state.
  - **Fences and traps:** 4 tiers (brush pile, split rail, wire, stone), each intact and broken, plus the 6 traps,
    each hidden-laid and sprung.
  - **Terrain:** one Desert tile set first (sand, wheel ruts, cacti, bleached skull, rock edges, a sky band and a
    horizon), then High Plains, Mountain and Badlands.
  - **Town:** one painted false-front main street (saloon, general store, bank, outfitter, livery, mine head-frame)
    with hit zones (see finding 12). Nothing in it may look damaged or attackable (guardrail 0).
  - **UI chrome:**
    - Parchment cards for reports.
    - A "wanted poster" frame for candidate parties.
    - Ledger paper for results.
    - Brass-plate primary buttons and leather-tab bottom navigation.
  - **Iconography:** a 24 px icon set to replace the unicode glyphs:
    - wagon wheel (Town), trail sign (Trail), banner (Party), star chart (Webs);
    - letter with a wax seal (Inbox), Coin, trip-cap hourglass;
    - stance icons (guard, hold, reserve; nearest, traps, core), affinity icons (Grit, Powder, Beast), siege icons.
  - **Typography:** a western woodtype or slab display face for headings and numbers, and a humanist sans for body
    text. Both self-hosted, because the CSP is `font-src 'self'`.
  - **Logo and splash:** a wordmark with a wagon-wheel or vault-door motif, an inline SVG splash in `index.html` shown
    before JS boots, and a full app icon set (§34).

<a id="f10"></a>**10. Unit roles cannot be recognized at a glance.** P0 · M
- **Evidence:**
  - `$SHOTS/10-circle-arranged.png`: posts are about 18×9 CSS px markers with 11 px initials, and five of them overlap
    on top of each other.
  - `$SHOTS/09-formation-first.png`: raiders are about 12 px ellipses at the edges, and one of the four is off-screen.
  - `$SHOTS/29-party-after-save.png`: in the party editor, the raiders are 6×4 px specks.
- **What is wrong:**
  - Reading the incoming party is the skill of the game (guardrail 4), yet "BH" vs "GU" and square vs triangle is a
    memory test.
  - Ranged vs melee, the property the scouting summary and the guide single out (the "Shoot from range" line), has
    no visual at all on the canvas.
- **What a studio would do:**
  - Silhouette-first readability: every type must be identifiable by silhouette alone at the scouting zoom in a
    0.5-second glance test.
  - Minimum marker height 28 CSS px. Ranged units show a long-gun silhouette and their attack-reach ring on long-press.
  - Overlapping posts fan out a few pixels (presentation only).
  - Tapping a raider opens a portrait card (the DOM card already exists).
  - Ship with the §28 review note for each skin.

<a id="f11"></a>**11. The canvas palette fails on the ground it sits on, and raiders vanish under deuteranopia.** P0 · S
- **Evidence:** contrast computed with `pw/contrast.cjs` against the ground `#b9a06b`:

  | Element | Contrast on ground |
  |---|---|
  | Defender blue `#56b4e9` | 1.10:1 |
  | Trap orange | 1.12:1 |
  | Fence-break green | 1.35:1 |
  | Attacker vermillion | 1.53:1 |
  | Core yellow | 1.91:1 |
  | Hit and death marks | 2.09:1 |

  `$SHOTS/22-deuteranopia-sim.png` (Machado deuteranopia matrix): the raiders turn khaki and merge with the sand, and
  the orange threat bands disappear.
- **What is wrong:** Okabe–Ito was chosen against the dark DOM, not against the mid-tone terrain. Only the 1.5 px dark
  outline separates the actors from the ground.
- **What a studio would do:**
  - Every actor gets a 2 px dark outline, a light inner rim and a contact shadow.
  - Lower the ground's value and saturation by about 20% so actors pop.
  - Raiders keep the vermillion and also get a dark bandana and skull badge; defenders get a shield badge.
  - Threat bands become hatched, not tinted.
  - Re-test under deuteranopia, protanopia and tritanopia as part of §35's definition of done.
  - This is S because it is palette and outline work in `skins.ts` / `scene.ts` that can ship before the art.

<a id="f12"></a>**12. The town is a form with a map in the middle, not a place.** P1 · L
- **Evidence:**
  - `$SHOTS/03-town-first-full.png`: 4,498 px tall (5.3 screens), 30 buttons.
  - `$SHOTS/03-town-canvas.png`: the canvas opens zoomed on the merge board, so the six structures are cut off at the
    frame edges.
  - `$SHOTS/03-town-p5.png`: "Elsewhere in town" is a list of eight buttons.
  - `$SHOTS/03-town-p1.png`: Coin appears only as the sentence "Banked: 0 of 50000 Coin…".
- **What is wrong:** the hub has no sense of place, no HUD and no reason to linger. The buildings are labels, not
  destinations.
- **What a studio would do:**
  - Make the town a full-screen diorama of the main street, with HUD chips on top: Coin with its cap meter, trips left
    with a refill timer, and a ladder pip.
  - Each building is the navigation, and each opens a bottom sheet over the scene:
    - Saloon → refugees
    - Outfitter → outfit and ride out
    - Bank → Coin
    - Mine → trickle
    - Livery → standing party
    - General store → packs and cosmetics
  - The merge board is the yard in front, and a "Ride out" CTA is always visible.
  - The mine wheel already turns. Add one or two ambient loops (a tumbleweed, the saloon door) that respect reduced
    motion.

<a id="f13"></a>**13. There is no light theme, and native controls are unthemed.** P1 · S
- **Evidence:**
  - `$SHOTS/01-launch-390-dark.png` and `$SHOTS/01-launch-390-light.png` are byte-identical (same md5); `theme.css`
    has no `prefers-color-scheme` rule.
  - `$SHOTS/20-formation-360.png`: checkboxes render in Chromium blue, not the theme accent.
- **What a studio would do:**
  - Decide explicitly. Dark-only is a fine choice for a game: declare `color-scheme: dark`, set `accent-color`, and
    style the selects.
  - Or ship a parchment light theme. Don't leave it accidental.

<a id="f14"></a>**14. There is no logo, no splash, and the first screen is a sign-in form.** P1 · S
- **Evidence:**
  - `$SHOTS/01-launch-390-dark.png`: system-bold "Caravan Vaults", a region `<select>`, then a full username/password
    form on the same screen.
  - Under 4× CPU and Fast 3G (finding 31), first paint is blank for 2.1 s (FP 1.47 s, FCP 3.62 s).
- **What a studio would do:**
  - An inline splash (logo and a spinning wagon wheel) in `index.html`, so first paint is the brand.
  - A title screen with key art and one "Start" CTA. "I have an account" becomes a text link.
  - Region choice becomes four illustrated cards that show the starter units and the terrain, with "Permanent" as a
    badge rather than a paragraph.

### 3. Audio

<a id="f15"></a>**15. The game is silent: no audio and no haptics.** P0 · M
- **Evidence:** `grep -r "AudioContext\|new Audio\|vibrate" apps/web/src` finds nothing (PHASE-2 §27 is not started).
- **What is wrong:** a silent mobile game feels broken (§27's own words). Every reward and impact in findings 4–6 is
  missing half its weight.
- **Minimum sound set:** about 40 effects plus 3 music loops and 4 stingers. That is roughly 0.8 MB of effects (Opus,
  mono, short) and 1.5–2 MB of music, within §27's 3 MB, streamed after first paint.
- **Firing rules:**
  - Every combat cue is keyed to a log-row kind, so a replay watched with or without sound conveys the same sequence
    (§27's definition of done).
  - Pitch and sample variation, if any, are seeded per row so a replay always sounds the same.
  - At most 3 concurrent hit sounds; music ducks under stingers.
  - Audio unlocks on the first user gesture (iOS).
  - Mute plus separate music and effects sliders, persisted on the account (§27).

| Group | Cue | Fires on |
|---|---|---|
| UI | tap (soft wood tick) | every button press (`pointerdown`) |
| UI | toggle / select | checkbox, stance, speed, tab change |
| UI | sheet open / close | dialog and sheet open and dismiss |
| UI | confirm (heavier) | commit, ride out, bank, push confirmed |
| UI | error (dull clunk) | a server refusal or error box |
| UI | coin tick / coin collect | count-up ticks; coins landing in the HUD |
| UI | refugee joins | refugee claim answered |
| UI | merge (whoosh + anvil clank) | merge answered |
| UI | unlock (chime) | unlock node bought |
| UI | rung reached (short horn) | ladder rung gained (result card) |
| UI | inbox (letter) | an unread item appears |
| Combat | raiders arrive (hooves, whoop) | spawn rows at replay start |
| Combat | gunshot ×2, rifle crack | hit rows from ranged attackers |
| Combat | melee thunk, pick swing | hit rows from melee attackers |
| Combat | beast snarl / bite | hit rows from beast attackers |
| Combat | death grunt + body fall | death rows (own units louder) |
| Combat | trap snap / spikes, powder boom | trap-fired rows by trap category |
| Combat | trap nullified (dull thud) | trap-nullified rows |
| Combat | fence thunk / splinter crash | fence-hit / fence-broken rows |
| Combat | 6 ability cues (one per archetype) | ability rows |
| Combat | core alarm (wagon bell) | core-reached row |
| Ambience | town loop: wind, muffled saloon piano, distant anvil | Town tab |
| Ambience | trail loop per region: wind and crickets (Desert), grass (Plains), pines (Mountain), canyon echo (Badlands) | Trail, Outfit |
| Ambience | battle bed: wind and a low drum pulse | replay playing |
| Music | title / town theme (60–90 s loop) | launch, town |
| Music | trail tension loop | formation screen |
| Stinger | victory (3 s), defeat (3 s), delivered (2 s, brass), first-party-strike (2 s) | end card held / overrun; bank summary; the inbox strike card |

- **Haptics** (§27; web Vibration API on Android, native bridge on iOS under chunk 34):
  - place snap: tick
  - merge: success
  - commit: medium
  - trap spring in your own fight: rigid
  - held: success
  - overrun: heavy double
  - Never on a timer, and never on spend prompts.

### 4. Information design and flow

<a id="f16"></a>**16. Primary actions sit at the bottom of very long pages.** P0 · M
- **Evidence:** page heights at 390×844, from the dumps in `$SHOTS/*.json` (`pw/heights.cjs`):

  | Screen | Height | Screens | Buttons | Where the primary action is |
  |---|---|---|---|---|
  | Town | 4,498 px | 5.3 | 30 | "Outfit the caravan" at y = 3,639 |
  | Outfit | 2,028 px | 2.4 | 11 | "Pack and ride out" at the end |
  | Candidates | 2,511 px | 3.0 | 11 | per card |
  | **Formation** | 5,269 px | **6.2** | 27 | "Commit this arrangement" at y = 5,137 (`$SHOTS/10-commit-button.png`) |
  | Bank or push | 3,192 px | 3.8 | 9 | "Bank and go home" after the stake prose (`$SHOTS/14-decide-p4.png`) |
  | Trip summary | 3,316 px | 3.9 | 16 | n/a |
  | Party | 4,497 px | 5.3 | 44 | "Save party" at y = 4,120 |

- **What is wrong:** the player scrolls past walls of explanation to reach the one button that moves the game forward.
  On the formation screen, the sticky map then covers 38 vh of every scroll position.
- **What a studio would do:**
  - One sticky action bar per screen, sitting above the tab bar in the thumb zone:
    - Outfit: "Ride out"
    - Formation: "Circle the wagons" with the budget meter
    - Decision: "Deliver the haul" | "Ride on"
  - Hide the tab bar on the formation screen and the replay (full-screen tasks).
  - Everything else goes into collapsible sheets: the scouting report as a swipe-up sheet over the map, the tray as a
    horizontal card rail under the map.

<a id="f17"></a>**17. First-session dead end: the guide says "Open Outfit" and gives no button.** P0 · S
- **Evidence:** `$SHOTS/04-guide-outfit.png`, plus `04-guide-outfit.json`. Every other guide step carries its action
  inline; this one doesn't, and the only Outfit button is at y = 3,639 of 4,511.
- **What a studio would do:**
  - An inline "Open the outfitter" button on the card.
  - Better: a coach mark that pulses on the real control and scrolls to it.

<a id="f18"></a>**18. The core loop takes too many taps and screens.** P1 · M
- **Evidence:**
  - Counted on the walks: a returning player's one-encounter trip from the Town tab takes 13 taps over 9 screens, with
    about 17 screen-heights of scrolling.
  - The taps: scroll to Outfit → Same as last → Pack and ride out → confirm → Search → scroll → Face → "Arrange
    for me" (first two trips only) or the quick-arrange side buttons (1–5 taps; "Start from my last arrangement"
    exists only from encounter 2) → scroll 6 screens → Commit → confirm → Skip to result → Bank or push… → scroll 4
    screens → Bank → confirm.
  - That includes three confirmation dialogs (ride out, commit, bank or push).
  - The guided first session reached the first fight's end card at tap 18 (`pw/34-ftue-words.cjs` log).
- **What a studio would do:** target 6 taps for a returning trip:
  1. "Ride out" on the town HUD (last loadout, with the stakes shown on the button sheet).
  2. Swipe the three wanted posters and pick one.
  3. The last trip's circle (or the suggested one) is applied automatically, with a clear "reset" option.
  4. Hold-to-commit (800 ms fill) replaces the commit dialog. Its stake summary moves onto the sheet itself, so
     guardrail 4's preview is kept.
  5. The fight plays.
  6. "Deliver" or "Ride on" sit on the result card. One sheet with both columns of stakes replaces the separate
     results → decision → confirm chain.

<a id="f19"></a>**19. Modal, card and prompt fatigue.** P1 · M
- **Evidence:**
  - **Dialogs:** `$SHOTS/06-ride-confirm.png`, `$SHOTS/10-commit-dialog.png` and `$SHOTS/16-bank-confirm.png` are
    centered dialogs over a dimmed long page.
  - **Save prompt:** "Save your progress" appears in four places (`$SHOTS/16-summary-p0.png`,
    `$SHOTS/21-overrun-summary-p0.png`, `$SHOTS/23-landscape-town.png`, `$SHOTS/23-text150-320-town.png`). It shows on
    the trip summary, on the town after a trip, on the overrun, and it fills the whole first screen in landscape and at
    150% text.
  - **"Skip the guide":** on every guide card.
- **What a studio would do:**
  - One prompt per session at most, never on a reward or loss screen, never above the screen's own content.
  - The guest-save prompt becomes a single toast after the first bank ("Brand your caravan so it's never lost") with
    "Later".
  - Dialogs become bottom sheets with a drag handle.
  - "Skip the guide" moves into a ⋯ menu on the guide.

<a id="f20"></a>**20. Walls of text and weak hierarchy on the results and stakes screens.** P1 · M
- **Evidence:**
  - `$SHOTS/13-results-p1.png`: six h3 headings, several followed only by "None".
  - `$SHOTS/14-decide-p0.png` through `p4`: 3.8 screens of stake prose.
  - `$SHOTS/16-bank-confirm.png`: "Dust Rider · stays L1 (level 1 is the floor)" listed under the heading "loses a
    merge level".
  - `$SHOTS/21-overrun-summary-p1.png`: that line repeated six times.
- **What is wrong:** the itemization guardrail 4 requires is there, but it is presented as a legal disclosure, not a
  game screen. The single most important legibility screen (§23) is the hardest to read.
- **What a studio would do:**
  - A two-column stake card: "Deliver now: +1,658 Coin, safe" vs "Ride on: +808 if you hold, but risk 1,658 Coin and
    these 4 units".
  - The units at risk shown as portraits with HP bars, the ones that would be lost outlined red.
  - Empty sections hidden.
  - Floor-level repeats collapsed to "5 units can't drop below rank 1".
  - The full itemization one tap away under "Every item" (this keeps guardrail 4).

<a id="f21"></a>**21. Debug-speak on the candidate cards.** P1 · S
- **Evidence:**
  - `$SHOTS/08-candidates-p0.png` and `$SHOTS/08-candidates-p1.png`: "Search #1 · centred on 250 · band width 600",
    "The band was widened to find enough parties.", "Coin earn ×100%".
  - `$SHOTS/14-decide-p4.png`: "0 Reputation beyond the band searched · Earn multiplier 100%".
- **What a studio would do:**
  - Each candidate becomes a wanted poster: the outfit's name, the flavour line (already excellent), a strip of raider
    portraits, a threat rating, the bounty (Coin) and a compass of approach edges.
  - Matchmaking internals move to an (i) sheet for the curious.

<a id="f22"></a>**22. Navigation and back behaviour.** P1 · M
- **Evidence:**
  - `pw/32-back.cjs` log and `$SHOTS/32-back-from-outfit.png`: the system back gesture from Outfit goes to the
    previous *tab* (Webs), not to Town. Back with a merge dialog open navigates away to Webs.
  - `$SHOTS/18-inbox-p0.png`: Inbox and Account light no tab and have no back control.
  - `$SHOTS/18-packs-p0.png`: Packs and Cosmetics live under the Town tab with an in-page "Back to town".
- **What a studio would do:**
  - A per-tab route stack (town/outfit, town/packs), with a history entry per sheet so back closes the top sheet
    first.
  - Header: an avatar for the account, and a bell for the inbox with a badge on the tab bar.
  - A consistent top-left back chevron on every pushed screen.

<a id="f23"></a>**23. Loading, skeletons, optimistic UI and duplicate fetches.** P1 · S
- **Evidence:**
  - `$SHOTS/27-slow-trail-loading.png` and `$SHOTS/27-slow-town-loading.png`: at 1.5 s RTT every tab is the word
    "Loading…" on an empty page.
  - The canvas host mounts black (`$SHOTS/frames21/sheet-01.png`).
  - Merges, refugee claims and party saves wait for the server, then re-render the page.
  - Entering the town fetches `/api/me` four times (`pw/24-perf.cjs` request log).
- **What a studio would do:**
  - A content-shaped skeleton per screen.
  - The canvas host painted in `--bg-sunken` with the island silhouette.
  - Optimistic animations for merge, claim and save, reconciled with the server's answer. The server stays the
    authority, and a refusal plays a snap-back.
  - Dedupe `/me` behind one in-memory cache with a short time-to-live.

<a id="f24"></a>**24. Error copy and resilience.** P1 · S
- **Evidence:**
  - `$SHOTS/27-offline-town.png`: switching tabs offline replaces the *entire shell, tab bar included* with
    "render_error · TypeError: Failed to fetch dynamically imported module: http://localhost:3933/assets/TownScreen-BqZAeaIu.js".
  - `$SHOTS/27-offline-commit.png`: committing offline shows "Could not reach the server. network", six screens down.
  - `$SHOTS/27-admin-as-player.png`: a bare "Not found."
- **What a studio would do:**
  - Keep the shell alive and show a top banner: "No word from the trail. Check your signal; we'll keep trying." It
    retries automatically with backoff.
  - Never show error codes, URLs or stack text; log them instead.
  - Prefetch the four tab chunks after first paint, so switching tabs never needs the network.
  - Put errors next to the control that failed.

<a id="f25"></a>**25. Empty states are text only.** P2 · S
- **Evidence:** `$SHOTS/18-inbox-p0.png` ("Nothing here yet…"); the party feed reads "Not served yet…"
  (`STRINGS.party.feedEmpty`).
- **What a studio would do:** an illustrated empty state plus the one action that fills it: "Raise your party" or
  "Ride out". The inbox empty state should sell the passive side ("Your raiders are out there; word comes back here").

### 5. Onboarding (FTUE)

<a id="f26"></a>**26. The first session tells instead of shows, and the first "aha" comes late.** P0 · M
- **Evidence** (`pw/34-ftue-words.cjs`, a fresh guided session at robot speed):

  | Step | Guide words | Words on screen |
  |---|---|---|
  | Welcome | 240 | 243 (`$SHOTS/02-welcome-full.png`) |
  | Town (take a refugee) | 59 | 667 |
  | Pack and ride out | 74 | 697 |
  | Outfit | 74 | 330 |
  | Search | 56 | 96 |
  | Candidates | 84 | 448 |
  | Arrange | 74–155 | 680–757 |

  - In total, about 740 words of guide copy and about 2,500 words on screen before the first fight.
  - The end card arrives at tap 18.
  - The guided arrangement is four "do it for me" buttons (`guide-do-fence`, `-post`, `-trap`, `-rest`), so the
    player never drags a fence or a unit in the first session, and that is the game's core skill.
  - The whole `STRINGS.guide` block is 2,081 words.
- **What is wrong:** the inverted loop needs teaching (§24), but this teaches it as reading. Players skim; the first
  thing they *do* themselves is tap "Commit".
- **What a studio would do:**
  - Replace the welcome with three illustrated swipe panels of at most 15 words each ("You defend. Live." / "Your
    raiders ride while you're away." / "Your town is never raided."), or with none.
  - Open on the trail with the dust of the raiders on the horizon.
  - A coach mark drags one fence segment and one unit by hand. Show the gap with an arrow, and let the "do the rest"
    button finish the ring.
  - Commit, a 20 s fight, and "HELD!" within about 60–90 s of launch.
  - Teach the passive side after the first bank with a 10 s animation of *your* party riding into someone else's
    circle, ending on your banner. That makes "while you were out" visible instead of explained.
  - Keep §24's rules: a real trip, no grants, account-level progress.

<a id="f27"></a>**27. First-session drop-off risks.** P1 · S
- **Evidence:**
  - `$SHOTS/05-outfit-p1.png` and `$SHOTS/05-outfit-p2.png`: the fence tier defaults to "No fence" and traps to 0,
    even on the guided first trip whose next step is "fence the side". The fence count is a numeric keyboard field.
  - The overrun path offers no consolation beat (`$SHOTS/21-overrun-summary-p0.png`).
  - The save prompt competes with the first bank (`$SHOTS/16-summary-p0.png`).
  - "Skip the guide" is a full-width button on every card (`$SHOTS/07-trail-p0.png`).
- **What a studio would do:**
  - Preselect the first fence tier at the full budget, and one trap, on the guided trip.
  - Fence count becomes a stepper or slider.
  - After an overrun: "Close call. Next time: fence the side they came from" with a one-tap "Ride out again".
  - Move the skip affordance into a menu.

### 6. Accessibility and comfort

<a id="f28"></a>**28. Contrast of non-text UI is too low.** P1 · S
- **Evidence:** `pw/contrast.cjs`.
  - DOM *text* passes comfortably: fg 14.4:1, muted 6.8–7.7:1, accent 7.7:1, the GUIDE label 6.6:1.
  - Secondary button borders (`--line #3f3b32`) are 1.56:1 on the background and 1.37:1 on raised cards, below the
    3:1 needed for UI components. Secondary buttons read as plain text boxes (for example "Skip the guide" in
    `$SHOTS/03-town-first.png`).
  - The canvas palette is covered in finding 11.
- **What a studio would do:** raise `--line` to about `#6b6455` (3:1), give secondary buttons a raised fill and an
  inner highlight, and give disabled controls a pattern or an icon, not only opacity.

<a id="f29"></a>**29. Text scaling and one-handed reach.** P1 · S
- **Evidence:**
  - `$SHOTS/23-text150-320-town.png`: at 150% text and 320 px, the "Guest" chip slides under the Inbox button, and the
    town grows to 8,447 px (15 screens).
  - Inbox and Account sit top-right, the hardest one-handed zone. Primary actions are at the far end of long pages
    (finding 16).
  - Positive: the pinned "Skip to result" in the replay is in the right place.
- **What a studio would do:** the header collapses to icon buttons below 360 px or at large text; primary actions move
  to the sticky bottom bar; test at 200% with a reflow pass.
- **What is already right:** 44 px DOM targets everywhere (only label-wrapped checkboxes are under 44 px themselves),
  no sideways scroll at 320 px, rem-based type, a real modal focus trap with `inert`, text-list alternatives for the
  canvas, and shape plus word alongside every colour.

<a id="f30"></a>**30. Reduced motion and landscape.** P1 · M
- **Evidence:**
  - Reduced motion currently only affects the lattice fade and the mine wheel (`iso/scene.ts`, `IsoCanvas.tsx`). The
    replay autoplays at 2× regardless. That is acceptable today, because nothing else moves.
  - `$SHOTS/23-landscape-town.png`: at 844×390, a centered 720 px column, the 56 px tab bar takes a seventh of the
    height, and the save prompt fills the screen. The manifest locks portrait only when installed.
- **What a studio would do:**
  - Every effect in findings 1–6 ships with a reduced-motion variant: no shake, no slow-motion or punch-in, crossfades
    instead of slides, count-ups that jump to the final value.
  - Landscape for the formation and replay (canvas left, panel right), or a polite "rotate your phone" card on the
    web build.

### 7. Performance feel

<a id="f31"></a>**31. First load on a mid-range phone.** P1 · M
- **Evidence** (`pw/24-perf.cjs`, 4× CPU and Fast 3G, cold cache, uncompressed as Node serves it):

  | Measure | Value |
  |---|---|
  | First paint | 1.47 s (blank) |
  | First contentful paint | 3.62 s |
  | "Start playing" usable | 3.81 s |
  | Bytes before the first screen | 406 KB |
  | Bytes to the town | 760 KB |
  | Start → welcome | 2.0 s |
  | Begin → town | 3.2 s, with only "Loading…" |

  - Raw / gzip sizes from the build: `index` 386 KB / 124 KB, `IsoCanvas` 284 KB / 87 KB, plus Pixi renderer chunks of
    about 200 KB raw.
  - Behind Caddy's `encode zstd gzip`, the first screen would be about 130 KB.
- **What a studio would do:**
  - The inline splash (finding 14) so the blank 2 s becomes the brand.
  - Preload the canvas chunks while the welcome is on screen.
  - Compress at the origin as well (brotli), so a misconfigured proxy can't ship 760 KB raw.
  - Split `index` (content tables and strings for screens not yet visited).
  - Budget enforcement, like §26's 8 MB / 4 MB.

<a id="f32"></a>**32. Canvas cost and jank.** P1 · S
- **Evidence:**
  - `iso/scene.ts`: only the replay opts into `sleepWhenIdle`. The town and formation tickers redraw a static scene
    continuously, while the player reads five screens of text.
  - Town under 4× CPU: rAF median 16.7 ms, but p95 450 ms and max 2.2 s during entry (four `/api/me` fetches, plus
    the guide's 3 s poll).
  - The heap is healthy: 8.4–8.6 MB across five replay open/close cycles, with no canvases left behind.
  - Absolute frame rates are not measurable on this host (software WebGL; see the caveat at the top).
- **What a studio would do:**
  - Sleep the ticker when idle everywhere. That means fixing the formation e2e scroll interaction noted in `scene.ts`
    rather than keeping the ticker always on.
  - Cap DPR at 2 (already done) and drop to 1.5 on low-end devices.
  - Measure on a real Moto G-class Android and an iPhone SE before any outside play test, with a frame-time overlay in
    dev builds.

### 8. Copy and tone

<a id="f33"></a>**33. The voice is system and legal-speak, not Old West.** P0 · S
- **Evidence:**
  - "server" appears 55 times in `apps/web/src/strings.ts` player copy.
  - No frontier vernacular appears anywhere except the authored outfits' one-line flavour, which is genuinely good and
    shows the tone the rest should have: "Teamsters who stopped hauling freight and started taking it."
    (`$SHOTS/08-candidates-p1.png`).
  - Numbers have no separators ("50000", "3969"), although §35 requires locale formatting.
- **What a studio would do:** a voice guide (laconic trail boss: short, dry, second person), applied in one pass. It
  keeps every guardrail: no "base" or "camp", merges never "stronger", the town never attacked, every stake still
  stated. Examples:

| Today | Rewrite |
|---|---|
| "That fight resolved exactly as the server recorded it. What it cost is itemized here: damage carries forward, and nothing is repaired until the trip ends." | "The dust settles. Here's what it cost you. Nothing gets mended till you're home." |
| "Plays back the server's record of this fight. Nothing is fought again." | "Watch how it went down." |
| "Your circle is committed and the party is attacking it. The fight resolves on the server without you; this screen checks back on its own." | "Riders on the horizon… hold tight." |
| "Could not reach the server." / "network" | "No word from the trail. Check your signal; we'll keep trying." |
| "The server refused this merge:" | "The blacksmith won't do that:" (keep the reason) |
| "Banked: 0 of 50000 Coin. Safe here — the town is never attacked." | "Vault: 0 / 50,000 Coin. Safe in town; no one raids it." |
| "Searched near 250 Reputation: encounter 1 is searched 150 below your caravan's 400." | "Scouts spotted three outfits on the trail ahead." (numbers behind ⓘ) |
| "The budget is below a full ring on purpose: at least 8 positions stay open. Where they go is your call." | "Rails for 20 of 28 spots. Leave your gaps where you want 'em." |
| "Commit this arrangement" / "Commit" | "Circle the wagons!" |
| "Bank or push…" | "Head home or ride on?" |
| "Bank and go home" / "Push on to encounter 2" | "Deliver the haul" / "Ride on to encounter 2" |
| "Your caravan held." / "The caravan was overrun." | "The circle held!" / "Overrun! They broke the circle." |
| "Dust Rider · stays L1 (level 1 is the floor)" | "Dust Rider: wounded, keeps rank 1" |
| "Merge 2 → 1 for 250 Coin" | "Combine 2 into 1, freeing a slot: 250 Coin" |
| "Skip the guide" | "I know the trail" |
| "Search again in 179s (free, time-gated)" | "Fresh scouting report in 2:59 (free)" |

---

## Minimum polish pass: ordered plan to feel studio-made

Every step is presentation-only. Nothing touches `packages/resolver`, matchmaking or the ledger. Effects read log rows,
and the server stays the authority.

**Phase A: no artist needed, about 2 weeks**

1. **Voice pass and number formatting (S).** Rewrite `strings.ts` against a one-page voice guide, remove every
   "server" and every raw code, and format numbers with `Intl.NumberFormat`. Fixes 33, part of 24, and 21.
2. **Sticky action bars, and fix the first-session dead ends (M).** A bottom bar per screen, the tab bar hidden on the
   formation and replay, an inline Outfit button on the guide card, the fence and trap preselected on the guided trip,
   a fence stepper. Fixes 16, 17, 27.
3. **Touch feedback and motion tokens (M).** Press states, sheet transitions, tab animation, reduced-motion variants.
   Fixes 1 and 30 (motion).
4. **Replay bookends (S/M).** No blank or black frame (pre-drawn scene, `--bg-sunken` host), a pre-roll from the spawn
   rows, a fixed ticker overlay, an outcome stinger card, a "Continue" CTA. Fixes 2, 5, 8.
5. **Get prompts off the reward screens (S).** Guest-save becomes a toast after the first bank; one prompt per session;
   dialogs become sheets. Fixes 19.
6. **Show progress (S).** Reputation and ladder bars on the result card, and a rung-reached toast. Fixes 7.
7. **Canvas legibility patch (S).** Outlines, contact shadows, side badges, a desaturated ground, a deuteranopia
   retest. Fixes 11, and buys time for 10.
8. **Resilience and loading (S).** Keep the shell when offline, add a retry banner, prefetch the tab chunks,
   skeletons, dedupe `/me`, idle the ticker everywhere. Fixes 23, 24, 32.

**Phase B: feel, about 2–3 weeks, can start alongside the art bible**

9. **Camera director (M).** A follow camera, punch-ins on key rows, decisive-moment slow-motion, a user override.
   Fixes 3.
10. **Impact effects from log rows (M).** Hit flash and damage numbers, death fall, trap bursts and shake, fence
    splinters, ability wind-ups (the table in finding 4). Fixes 4.
11. **Reward sequences (M).** A persistent Coin HUD; count-up and fly-to-HUD on bank; the merge fusion pop; the refugee
    "Joined" stamp; the unlock line-draw; the overrun drain. Fixes 6.
12. **Minimum audio set and haptics (M).** The cue table in finding 15, account-persisted mute and sliders, and the
    haptic map. Fixes 15.
13. **Stakes card and results redesign (M).** The two-column deliver vs ride-on card with portraits, and "Every item"
    disclosure. Fixes 20 and 18 (taps).

**Phase C: art, about 4–6 weeks with two artists**

14. **Art bible, logo, splash, typography, UI chrome, icon set (M).** Fixes 9 (identity), 13, 14.
15. **Unit archetype sprites with type overlays, wagons, fences, traps (L), through the §26 pipeline and skin seam.**
    Fixes 9 and 10. Every skin gets the §28 scouting-zoom note.
16. **Desert terrain, then the other three regions (M each).** Fixes 9.
17. **The town as a diorama, used for navigation (L).** Fixes 12.

**Phase D: onboarding and comfort, about 1–2 weeks after B and C land**

18. **Show-don't-tell first session (M).** Swipe intro or none, a hand-dragged first fence and unit, a fight within
    90 s, and the passive side shown as an animation after the first bank. Fixes 26.
19. **Navigation stack and back behaviour (M).** Fixes 22.
20. **Accessibility sweep (S).** Non-text contrast, a 200% text reflow, a landscape layout or rotate card, and an
    explicit dark-only decision (or a light theme). Fixes 28, 29, 30, 13.
21. **On-device performance pass (S).** A real mid-range Android and an iPhone SE: frame times in the replay, first
    load behind Caddy, battery while idle. Fixes 31, 32.

If only a week is available: steps 1, 2, 4, 5 and 7. None of them needs art, and together they remove most of the
"prototype" read in the first five minutes.
