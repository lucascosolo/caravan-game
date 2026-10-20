# Studio review: live-ops, economy and retention

Reviewer: live-ops and economy design lead (studio review, long-lived free-to-play). Build:
`roadmap/phase-2-spec` at 0058f0d (RESOLVER_VERSION 9, authored set v7, balance pass 8). Date:
2026-10-20. No code changed. This document is the only file this review adds.

## Headline verdict

Caravan Vaults has the cleanest foundations I have reviewed at this stage. Every outcome is
deterministic and on a ledger, every price is previewed, the combined pay ceiling is enforced in
code, the inbox never pushes the store, and a balance dashboard already reads straight off the
ledger. As a game a studio could run for years, though, it is **not yet operable, and its economy
breaks in week 1**.
- **Coin floods.** A player who just plays reaches the 50,000 storage cap on day 7 (casual) or
  day 3 (hardcore). From then on the cap destroys about 80 % of everything they earn.
- **The sinks that should hold Coin don't hold value.** Merges and mercenaries are the only real
  sinks, and they work as a loss-replacement treadmill. A player who spends every coin still
  fields a circle averaging level 1–2 at day 90. Fewer than 6 % ever field 8 × L3, and a player
  who stops at L3 on purpose builds 8 × L3 by day 5 and loses it by week 4.
- **The paid product sells the currency players throw away.** The cosmetics that should carry
  monetization have no art and no render path.
- **There is no reason to come back on a given day or week:** no push notification, no daily or
  weekly goals, no season, no event, no collection. A hardcore player runs out of permanent
  progression between day 40 and day 57.
- **There are no live-ops tools.** Every tunable is a compiled, deep-frozen constant. The cosmetic
  rotation is a hash nobody can schedule. There is no config service, no feature flags, no A/B
  testing and no event system. The dashboard answers balance questions, not the daily ones a
  live-ops team asks.

None of this touches a guardrail, and every fix proposed below keeps the guardrails intact.
**Verdict: ready for the closed balance alpha it was built for; not ready for a soft launch.** The
soft-launch bar is the P0 items: F1, F2, F5, F7, F10, F11, F14, F15, F19, F22 and F24, plus F18
before any paid launch. I estimate 6–8 weeks of work, then the 12-week roadmap at the end.

## How I tested

- **Hosting.** I followed `docs/PLAYTEST-HOSTING.md` in production mode with the shared-instance
  option:
  - roles `caravan_lo_owner` (`IN ROLE caravan`, `SET role = caravan`) and `caravan_lo_app`
    (`IN ROLE caravan_app`), with random passwords;
  - database `caravan_studio_liveops`;
  - env `NODE_ENV=production`, `SERVE_WEB=1`, `STORE_MODE=off`, port 3931;
  - `migrate.js up` (30 migrations) and `seed.js` (authored set v7, 96 parties, no login
    accounts).

  The boot lines matched the runbook: real resolver, "store: off", the client served, source maps
  not served.
- **Play.** Four guest accounts, one per region (a1 Desert, a2 High Plains, a3 Mountain, a4
  Badlands), driven by Playwright as a 390×844 touch phone (Pixel 5 profile). Each played its
  guided first trip, then a second trip and a third (after 2 banks, live parties are served).
  - **First trips:** all four held encounter 1. a1 and a2 banked 725; a3 and a4 pushed, held
    again and banked 1,658.
  - **Second trips:** the outfit starts empty after the guide, and the script packed all 7 units.
    a1 followed the push advice and was overrun at encounter 2, losing 600 Coin and all 7 units.
  - **Third trips:** a2, a3 and a4 each held twice and banked.
  - **Operator:** a1 was linked as `lo_operator`, granted admin with
    `node apps/server/dist/admin.js grant`, and used to read `#/admin` and
    `GET /api/admin/dashboard`. I also dumped every economy route per account (`/me/economy`,
    `/me/store`, `/me/cosmetics`, `/me/inbox`, recruit, refugees).
- **Tools.** I ran `trip-ev.ts` and `unlock-pace.ts` at HEAD. The model reads the pass-8 full sweep
  (the `--json` matrix and pushed-trip curves the balance agent wrote at 15:16, after the last
  content-changing commit at 14:18). Its equilibrium bands (fresh / L1 / L2 / L3 / L4 = 3 / 3 /
  4 / 4 / 7) and the 8 × L1 best bank point (+5,960 at k = 4) match BALANCE-LOG pass 8's published
  rows. I ran `measured-ev.ts` on it. I stopped my own `--quick` re-sweep after 25 minutes: at load
  average 14–26 (other reviewers were running), it was taking the CPU they needed.
- **90-day model.** I wrote an offline Monte Carlo, 200 players per persona, seeded. It is not
  committed, because this review adds one file; it is `liveops/ninety.ts` in the reviewer's
  scratchpad. It imports the repo's real `coinForEncounter`, `coinForDelivery`, `bandOf`,
  `TUNABLES`, ladder tables and web shapes, plus the sweep's measured hold curves and deaths per
  held encounter.
  - **Its assumptions.**
    - A typical player's hold rate is the sweep's per-party skilled rate, plus 0.08 for picking
      the easiest of three, minus a skill gap that grows 25 % per encounter index: 0.12 for
      casual and 0.06 for hardcore, a quarter of that in bands 0–1.
    - A pack of fewer than 8 holds a little less.
    - Strikes pay the sweep's measured owner income.
    - Reputation moves +8 / −20 with no gap scaling.
  - **Personas.** *Casual*: 1–2 sessions a day, 16 trips a week, 1.5 refugee claims a day, banks
    after 2 holds or at the first death, 1 passive strike a day. *Hardcore*: 35 trips a week, 4
    claims a day, 3 strikes a day, pushes to 3 holds (and a "careful" variant that banks the
    guide's way).
  - **Spending styles.** *Natural* merges refugee copies and buys mercenaries only to keep 8 units
    to pack. *Spender* sinks every coin into mercenaries and merges.
  - **Calibration.** Week 1 for a casual banks 85 % of trips, against 79 % in round 4's simulated
    week (11 of 14) and 94 % for trip 2 in pass 8. Read the steady-state rows as directional; the
    play test must measure them.
- **Code read.** `PROJECT.md` and `GUARDRAILS.md` in full; PHASE-2 §§28, 29, 32, 33, 37, 39–49;
  chunks 16, 18, 19 and 20; BALANCE-LOG passes 1–8; the final play-test reviews; and
  `apps/server/src/analytics`, `economy`, `trip/loot.ts`, `progression`, `inbox`,
  `packages/content` (tunables, cosmetics, packs, unlock webs) and `apps/web/src/iso/skins.ts`.

### The 90-day model in one table

Coin per player per day. Sources, sinks and losses are means over the players; balances, levels
and days are medians.

| | casual natural | casual spender | hardcore spender | hardcore careful | careful, stops at L3 |
|---|---|---|---|---|---|
| Sources, week 1 (trickle + trips + passive) | 4,480 + 2,514 + 766 | 4,800 + 2,785 + 871 | 4,800 + 10,578 + 2,635 | 4,800 + 6,448 + 2,528 | 4,789 + 6,946 + 2,580 |
| Sources, week 13 (credited) | 240 + 954 + 0 | 4,800 + 2,720 + 859 | 4,800 + 7,952 + 2,672 | 4,800 + 5,979 + 2,544 | 4,800 + 6,124 + 2,686 |
| Sinks, week 13 (merge + mercenary) | 144 + 1,059 | 3,632 + 4,726 | 7,204 + 8,150 | 6,402 + 7,000 | 5,889 + 7,745 |
| Destroyed by the cap, week 13 (idle trickle + credits) | **4,560 + 2,286** | 0 | 0 | 0 | 0 |
| Day the cap is first reached (p25–p75) | **7 (6–8)** | never | never | never | 1 % of players, day 6 |
| Balance at day 90, p50 | 50,000 | 4,820 | 10,117 | 7,802 | 8,754 |
| Trips banked, week 1 → week 13 | 85 % → 58 % | 85 % → 62 % | 73 % → 46 % | 86 % → 59 % | 90 % → 60 % |
| Units destroyed / merge levels lost per day, week 13 | 3.2 / 0.3 | 2.9 / 2.6 | 6.3 / 4.6 | 5.3 / 4.0 | 5.5 / 4.5 |
| Mean merge level of the best 8 at day 90 | 1.0 | 1.4 | 1.0 | 1.0 | 1.0 (8 × L3 at day 5, ground down by week 4) |
| 90-day totals: credited / destroyed by the cap | 145k / 598k | 766k / 0 | 1.42M / 0 | 1.24M / 0 | 1.26M / 0 |

## Findings

Priority: **P0** blocks a soft launch; **P1** is needed within the first 12 weeks of soft launch;
**P2** is valuable later. Size: **S** is one session, **M** two to four, **L** a week or more,
counted as PHASE-2 counts them.

### Economy health

#### F1. Coin floods in week 1, and the storage cap becomes the main sink — **P0, M**

**Evidence.**
- **The faucets.**
  - The trickle is 200/h, which is 4,800 a day and 33,600 a week. It fills the 50,000 cap from
    zero in 10.4 days without a single trip.
  - `FREE_WEEKLY_EARN_ESTIMATE` (55,000) is itself above the cap.
  - The repo's own `measured-ev.ts`, run on the pass-8 sweep, says the estimate "would be
    220000 (now 55000)": 30 trips a week at the skilled 8 × L1 curve bank at k = 4 for 6,227
    Coin a trip. Without picking the easiest party of three ("no choice", 73 % holds), the same 30
    trips gross about 820 a trip banking at 1, or 1,770 banking at 3: 58–87k a week. The shipped
    55,000 is still chunk 19's pre-resolver guess.
  - For a 30-trip week, then, free earn is 58–220k depending on skill and bank point. Every shape
    is above the 50k cap.
  - Passive strikes pay on top of that and are not counted in the estimate (F4).
- **What the model shows.**
  - A casual player who just plays is at the cap on day 7 (p25–p75: days 6–8). A hardcore player
    who doesn't use Coin is at the cap on day 3.
  - From week 2, the casual natural player is credited about 1,200 Coin a day. The cap destroys
    about 6,850 a day: 4,560 of trickle that is never written, plus 2,286 of trip Coin discarded at
    the cap.
  - Over 90 days that is 145k credited and 598k destroyed: **80 % of all Coin earned never
    reaches the player.**
- **The play tests agree.**
  - Round 4's simulated week (g9) ended at 18,169 Coin with the mine *not aged*. A real week adds
    33,600 more, which is past the cap by about day 7.
  - Round 2's week had 14,353 Coin and "no merge ever".
  - BALANCE-LOG passes 4 and 8 list "Coin with nothing to buy" as open.
- **What there is to buy.** Merges, mercenaries and refugee rerolls. Unlock nodes cost ladder
  points, not Coin, and the trip cap and matchmaking can't be bought, rightly.

**Proposal.**
1. **Brake the faucet without cutting active earn.** Give the mine its own buffer of 12 hours'
   output (2,400 Coin) that the player collects into the vault.
   - Rate unchanged: a twice-daily player earns the same 4,800 a day.
   - The weekly estimate and the 1.09× pay ratio are unchanged.
   - Absence stops paying: a lapsed player returns to 2,400, not 50,000.
   - It is also the daily appointment hook the game lacks (F11).
2. **Add value sinks** (F6) sized to absorb 35–50k a week from an engaged player.
3. **Make the loss visible.**
   - Default the "mine near cap" inbox item on (it ships off).
   - Have the outfit and summary screens say "N Coin of this trip was discarded at the cap"
     (already computed as `wouldDiscard`).
   - Record idle-at-cap time (F24).

**Guardrail fit.** Clean. The trickle stays a flat rate. A buffer changes *when* Coin is credited,
not what anyone can buy. Chunk 17's rule ("the mine must never be upgradeable") is respected: the
buffer is fixed, never bought or levelled. It is a PROJECT.md §14 amendment, because "a slow
passive trickle up to a storage cap" becomes "up to the mine's buffer, collected into the vault".

#### F2. The merge sink cannot hold value: merges don't stick, and L4+ circles destroy Coin faster than they earn — **P0, M** (decision S, tuning M)

**Evidence.**
- **The price curve.**
  - Merge Coin per resulting unit: 250 / 900 / 3,000 / 9,500.
  - Amortised rebuild value V(L) from `trip-ev.ts` at HEAD: L1 600, L2 1,250, L3 2,983, L4 7,972,
    L5 22,787.
  - One death costs V(L) − V(L−1): 650 / 1,733 / 4,989 / **14,815**.
  - The stat gain is ×1.25 per level, so an L5 is 2.44× an L1 in one slot. Coin per unit of slot
    power doubles at every level (about 1,000 → 1,900 → 4,100 → 9,300).
- **Losses at high bands.**
  - The sweep's deaths per *held* encounter rise with band: band 1 0.24, band 3 0.71, band 5 0.97,
    band 6 1.71, band 7 1.22.
  - An L5 circle at its band-7 equilibrium loses about 1.2 × 14,815 ≈ 17,800 Coin of merge levels
    per *held* fight. Encounter 1 there pays 1,800.
  - BALANCE-LOG records 8 × L4 trip EV as negative at every bank point, unsolved since pass 1.
    `measured-ev.ts` on the pass-8 sweep agrees.
    - 8 × L4 and 8 × L5 are negative at every bank point even with skilled play (−4,163 and
      −16,154 at k = 1).
    - Without picking the easiest party of three ("no choice"), 8 × L2 and 8 × L3 are negative at
      every bank point too (−1,135 to −4,752).
- **Reputation guarantees losses at equilibrium.** Reputation pins every circle at the 71 % hold
  break-even (+8 / −20). So about 1 encounter in 3–4 is an overrun, and it destroys every unit
  still standing.
- **What the model shows.**
  - The "careful, stops at L3" hardcore player has 8 × L3 on day 5 (98 % of players). It is ground
    back to a mean of L1 by week 4, while its rating, which lags, reaches band 5 around day 31.
  - At that point it spends 13,600 Coin a day just replacing destroyed units and lost levels.
  - Every spender persona ends day 90 at a mean merge level of 1.0–1.4. Apart from the player who
    stops at L3 on purpose, fewer than 6 % ever field 8 × L3, and none field 8 × L4.
  - Round 4 saw the same in play: "four merges for 1,000 Coin netted one L2".

So Coin's only use, merging, is either a furnace (high levels) or a treadmill (low levels). The §1
merge/loadout hook ("collection growth over time") barely appears in 90 days.

**Proposal.** This is a design decision, and the game's identity is in it. Pick one:
- **(a) A convalescence re-merge.** A unit de-merged on a death can be restored within 24 h for
  60 % of that level's merge cost. This is round 4's D5 option. It turns the treadmill into a
  visible, chosen Coin sink.
- **(b) A death-cost brake at high levels.** Raise `COIN_ENCOUNTER_BAND_SCALE_BP` for bands ≥ 5,
  or lower deaths per held fight there (content), until the measured 8 × L3 and 8 × L4 EV is
  positive. The §37 target already asks for this.
- **(c) Pace the climb.** Equilibrium sits where 29 % of encounters are total-loss events. Test a
  Reputation split nearer +10 / −20 for bands ≥ 4, so high-value circles settle a band lower.

I'd ship (b) and (c) as tuning before soft launch. Then I'd roll (a) out to everyone by date once
F19's config exists, measured as a before/after cohort (F20), not as a split test.

**Guardrail fit.**
- (a) is Coin buying back slot efficiency the player already paid for. It is pace, the merge cap
  stays L5, and a merged unit is still weaker than its components. But it softens §13's "loses one
  merge level", so it needs a PROJECT.md §13 amendment and a QA probe that a restored unit never
  exceeds what it was.
- (b) and (c) are numbers.

#### F3. Mercenaries are the real sink; refugees and rerolls stop mattering after week 1 — **P2, S**

**Evidence.**
- **Mercenaries carry the spending.**
  - A mercenary costs 600, three hours of trickle.
  - In every spender persona they are 49–55 % of all Coin spent (casual spender 399k of 761k;
    hardcore 738k of 1.41M), almost all of it replacing units destroyed by overruns.
- **Rerolls are dominated** at a 7-type pool. P(the wanted type is on a menu) = 3/7, so the
  150 / 300 / 600 rerolls cost about 350 / 700 / 1,400 per wanted unit, and a 600 mercenary beats
  the second and third.
- **The refugee drip favours whoever is online most.** It gives up to 16 menus a day to an
  always-online player and 1–2 to a casual one (one menu per take, no stockpile). Coin erases the
  difference by week 1.
- **What this means.** The acquisition economy is healthy, and the safety valve works as chunk 18
  intends. But its sink is driven by losses, so it scales with frustration, not with ambition.

**Proposal.**
- No price change: chunk 18 rightly forbids making the valve dearer.
- Track the mercenary share of spend by cause (rebuild vs growth), and the post-wipe rebuild time
  (BALANCE-LOG open item 8).
- If F2(a) ships, convalescence takes some of this load.

**Guardrail fit.** Clean.

#### F4. Passive income is a second, uncounted, minted faucet — **P1, S**

**Evidence.**
- **The pay rule.** A held strike pays the owner `full × depth^1.5`, which is minted. An overrun
  pays the transfer, which is zero-sum, plus `COIN_PER_PARTY_WIN` 300, which is minted.
- **What a strike is worth.** The sweep measured 505 per held strike and 1,777 per overrun (28 %
  overrun share), so a strike averages about 860. Our two live strikes, both held in band 1, paid
  232 and 299.
- **Scale.** In a mature pool a party is served about as often as its owner's peers fight. At 3
  strikes a day that is about 2,600 a day, or 18k a week. It is not in `FREE_WEEKLY_EARN_ESTIMATE`
  ("depends on other players").
- **More faucets are queued.** PHASE-2 §48 (duplicate recycling as "a fixed Coin refund per
  instance level") and §40 (contracts paying Coin) would each add another.

**Proposal.**
- Count passive income in the free-week estimate as soon as telemetry has it.
- Pay part of held-strike loot as **season renown** (cosmetic-track progress, F12) instead of Coin.
  The King of Thieves payoff becomes status, which is what that hook is about anyway.
- Build §48 as a cosmetic or renown refund, not Coin.
- Contracts pay cosmetics and renown, with Coin only as a small, stated fraction (§40 already asks
  for that number).

**Guardrail fit.** Clean. Renown buys only cosmetics, never access or power.

#### F5. The trickle's design reason no longer exists — **P0, S** (documentation, but it drives F1)

**Evidence.**
- PROJECT.md §14 and chunk 16 justify the trickle as "keeps something always at risk even for
  players who aren't actively pushing trips".
- After the polarity correction, the town is never attacked and banked Coin is never at risk
  (GUARDRAILS §0, PROJECT.md §12a). So the faucet that is 56 % of a casual spender's income, and
  61 % of the "active" weekly estimate, has no design job left except paying absence.
- An account that never starts a trip earns 33,600 Coin a week.

**Proposal.**
- Amend §14 to give the trickle the job it should have: a **return hook** (F1's buffer, F11).
- Re-derive `FREE_WEEKLY_EARN_ESTIMATE` from measured, *credited* Coin, not accrued Coin.

**Guardrail fit.** Clean.

#### F6. Sinks that are fun and not pay-to-win — **P1, M–L**

**Sizing.** From week 2 the casual natural player has about 7,000 Coin a day with nowhere to go.
Sinks should absorb 35–50k a week per engaged player and must never touch stats, slots, access or
the trip cap.

| sink | what it is | absorbs | guardrail notes | size |
|---|---|---|---|---|
| **Outfitter** (Coin cosmetics) | A Coin shop of cosmetics at 10–30k each. Two new items a week, plus pack items from 8+ weeks ago as Coin variants. Pack-exclusive variants stay paid-only, which protects pack value. | 20–60k/week | Cosmetic only. Needs a §16 / §28 amendment: today `cosmetic_ownership.purchase_id NOT NULL` means "a cosmetic comes from a pack and nothing else". | M |
| **Town building (decorative)** | Saloon, chapel, newspaper, rail depot and more, each in 5 stages (for example 5k / 10k / 20k / 40k / 80k). Staged so the 50k cap never blocks. Shown on the public party record (§42). | about 1.2M lifetime (8 × 155k), about 25 weeks of casual surplus | The town never feeds combat. The **mine is excluded** (chunk 17: never upgradeable, never a Coin sink). Needs art (chunk 26). | M (L with art) |
| **Party notoriety** | Wanted posters, painted banners and named raiders for the standing party, bought with Coin and shown to defenders on the scouting card. | 10–30k/week | Each item needs chunk 28's readability review: nothing may hide type, stance, ability or siege. | M |
| **Convalescence** (F2a) | Restore a de-merged level within 24 h at 60 % of its merge cost. | 3–8k/day for active players | Pace, cap unchanged. Needs a §13 amendment. | S–M |
| **Bounty board** (later) | Post Coin on a party that overran you; whoever holds against it collects, with a 50 % burn fee. | variable | It is a Coin-transfer path, so chunk 31's integrity work comes first (alt-feeding). P2. | M |

Do **not** build:
- a trap-restock Coin cost: Coin would decide the trap loadout, which is outcome-adjacent;
- an upgradeable storage cap or mine;
- any Coin-priced scouting or matchmaking advantage.

### Progression pacing

#### F7. Milestones: the merge milestones come early and don't last; the unlock web walls in the middle — **P0, S** (tuning)

Median day reached, from the 90-day model and `unlock-pace.ts` at HEAD, with the share of players
who reach it within 90 days in brackets:

| milestone | casual natural | casual spender | hardcore spender | careful, stops at L3 |
|---|---|---|---|---|
| first tier-2 living unlock (tier 1 bought first) | day 7 | 7 | 3 | 4 |
| first L3 unit | 11 (41 %) | 2 | 1 | 1 |
| first L4 unit | never | 5 | 3 | — (capped at L3) |
| first L5 unit | never | 18 (43 %) | 34 (61 %) | — |
| 8 × L3 circle | never | 11 (5 %) | never | 5 (98 %), lost by week 4 |
| living rung 10 / rung 20 | 37 / >90 (rung 16 at day 90) | 37 / >90 | 12 / 40 | 17 / 57 |
| living web can't take another node | >90 | >90 | 38 | 53 |
| a full web | **never, by construction** (F8) | | | |
| band 5 / band 7 (top) | never / never | 83 (2 %) / never | 57 (43 %) / never | 31 (100 %) / never |

**Where the curve walls.**
- **The first tier-3 living node.**
  - The web's order is t1 (1 point), t2 (2), t2 (2), then t3 at 8. Buying in order, the fifth node
    arrives at rung 5 and the sixth at rung 12, with 13 points granted.
  - At the casual 83 ladder points a day that is day 13.5 → day 50: **about 36 days with no new
    unit type**. A hardcore player waits day 5 → day 19.
  - Trap web: the second tier-2 node at rung 8, then the first tier-3 node at rung 13.
- **The cap.** Once Coin is capped (day 3–7) Coin rewards mean nothing (F1). Round 4's g9 already
  had "on days 3–5 a lone living point waited for a node that costs 2".
- **The ladder cap.** Day 40–57 for hardcore players, after which nothing permanent remains (F8).

**Proposal.**
- Flatten the middle of the living and trap curves. For example living `[0, 1, 2, 5, 12]` (paid
  total 27, so a capped ladder's 30 points complete the web), or front-load
  `UNLOCK_POINTS_BY_RUNG` (2 per rung for rungs 6–10).
- Put a small cosmetic or renown reward on every rung that grants no node.
- Show "next unlock in about N held encounters" on the Webs tab.
- Re-run `unlock-pace.ts` with the target "no gap between living nodes longer than 10 days for
  the casual model".

**Guardrail fit.** Numbers only. The web stays the only gate. Rung rewards must be cosmetic or
renown (§39's rule: "every reward in this group is Coin within the storage cap, or a cosmetic").

#### F8. No web can ever be completed, and post-cap there is nothing permanent to earn — **P1, M**

**Evidence.**
- **The webs outspend the ladder.**
  - Paid totals: living 35, trap 39, siege 38. A capped ladder grants 30.
  - The best living path reaches 7 of 8 nodes (capstone at rung 19, rejoin node unreachable). The
    trap web reaches 9 of 10.
  - The "most but not all, a choice" design is coherent, but nothing in the UI says the web can't
    be completed, and completionists churn on invisible walls.
- **Then nothing.** After rung 20 (hardcore day 40–57) the only moving number is Reputation, a
  rating that by design returns to equilibrium.
- **No answer is built.** PHASE-2 group B names this as the replayability gap (condition 3); none
  of group B is built.

**Proposal.**
- Say it on the Webs tab: "A capped ladder reaches 30 of the 35 points: you will choose 7 of 8".
- Ship §41's ladder extension with the first content drop (rungs 21–25 for new nodes).
- Seasons (F12) and collections (F13) give the post-cap goal.

**Guardrail fit.** Clean. §41 already requires that growth is never retroactive on earned points.

#### F9. The passive side's own progression is starved — **P1, S**

**Evidence.**
- **How the siege ladder moves.** Only through strikes: +30 for an overrun, +10 for a held or
  stalemate fight, and only when the party fields a siege piece.
- **What it costs.** The first siege tier-2 node costs 8, so it needs rung 9 (2,700 points), which
  is 90–270 strikes.
- **What the model shows.** At day 90 the siege ladder stands at rung 5 (casual, 1 strike a day)
  or rung 12 (hardcore, 3 a day).
- **What makes it worse.**
  - Round 4 D3: strong parties are passed over in a pick-from-three menu.
  - The first 2 banks of every caravan meet authored outfits only.
  - On day 1 of our server, pool health showed 8 band alarms: bands 0 and 2–7 authored only,
    band 1 over the authored share.
  - In our third trips (after 2 banks), 9 of the 18 candidates on 6 menus were live parties. The
    script picked by HP, core runners and shooters, and chose a live party 2 times. Both picks were
    the same owner's party, which was held both times and paid 232 and 299 Coin of loot. The other
    three live parties were never chosen.
- **The hook.** The King of Thieves hook ("designing a hard-to-beat raiding party") has the
  slowest progression in the game.

**Proposal.**
- Siege ladder credit for being **scouted** (shown on a menu), at about 2 points, as round 4's
  D3(a) suggests.
- A weekly "party contract" track (F11).
- A "most-feared" party record (§42).

**Guardrail fit.** Ladder points from being served are still "through use" of the party. Use
chunk 31's sandbag rules so alts can't farm scouting.

#### F10. At equilibrium 1 trip in 3 or more ends in an overrun: a churn risk the balance pass hasn't measured — **P0, S** (instrument now, decide after data)

**Evidence.**
- **The model.**
  - Casual bank rates fall from 85 % (week 1, bands 0–1) to 58–62 % (week 13, band 3). Hardcore
    falls to 46–60 %.
  - An overrun destroys every unit still standing: 2.9–6.3 units a day at steady state.
- **The play tests.**
  - Round 4's first trips: 6 of 14 were overrun, losing every unit still standing. Our own a1 lost
    its whole 7-unit roster on trip 2. After the guide the outfit starts empty, and "pack
    everything" is one tap, with a warning.
  - BALANCE-LOG pass 4's top telemetry question ("whether those players come back the next day")
    has no panel.

**Proposal.**
- Add retention split by "had a total-loss overrun on day N", and next-day return after an
  overrun (F24).
- Then decide between F2(c), a larger `GUIDE_RESERVE` default beyond the first trip, or keeping
  the harshness.

**Guardrail fit.** Measurement only.

### Retention hooks

#### F11. There is no daily or weekly reason to return, and nothing reaches a player outside the app — **P0, M**

**Evidence.**
- **The timers aren't daily.** The trip cap refills in 60 minutes, the refugee grid is 90 minutes
  with one menu per take, and the mine fills the cap in 10.4 days. So every hook is either always
  ready (sub-2 hours) or ten days away. Nothing resets daily or weekly except the pack rotation,
  which is off during the play test and has nothing to show (F14).
- **Nothing is pushed.** §29 built the in-app inbox only ("device push deferred"). The DoD,
  "learns within a minute", holds only with the app open. The asynchronous loop's payoff, "your
  party struck", is invisible until the player comes back by themselves.
- **No goals.** §40 contracts, §39 seasons and §42 social are not built.

**Proposal**, ranked in the table below:
1. Web push now, through a service worker and VAPID, for strike batches (hourly), the mine buffer
   full (F1) and the trip cap refilled (opt-in). Native push with §34. Frequency caps, quiet
   hours, and never a spend nag (§29's rule stays).
2. **Weekly contracts (§40)**, plus three *daily bounties* paying renown only. §40 rejects daily
   *Coin* goals, rightly; a renown-only daily slate is lighter and keeps the trip cap the real
   pacer.
3. A **welcome-back** summary for a player away 3+ days: strikes, Coin the party earned, what is
   new.

**Guardrail fit.** Clean. Contracts never require a purchase or a locked type (§40). Rewards are
cosmetic or renown, plus Coin within the cap at a stated fraction.

**Retention features, ranked.** The lift figures are my genre judgement for a mid-core async
strategy game with this loop. They are targets to A/B, not measurements.

| rank | feature | expected D7 lift | expected D30 lift | cost | guardrail fit | spec |
|---|---|---|---|---|---|---|
| 1 | Push (web now, native with §34) for strikes and the mine buffer | +2–4 pts | +1–2 pts | S–M | clean (no spend nags) | §29, §34 |
| 2 | Mine buffer + collect (F1) | +1–2 | +0–1 | S | §14 amendment; never upgradeable | new |
| 3 | Weekly contracts + daily renown bounties | +2–4 | +2–3 | M | §40 amendment; no purchase or locked type required | §40 |
| 4 | Seasons, leaderboards, free cosmetic season track | +1 | +3–5 | M–L | §39 amendment; never touches ladders | §39 |
| 5 | Events and limited-time modifiers (published, identical for all) | +0–1 | +2–4 (and reactivation) | M–L (needs F19, F20) | modifiers are resolver tunables staged by §33; previewable | §33 |
| 6 | Collections and achievements (Wanted board of outfits beaten, unit codex, titles) | +1–2 | +1–3 | S–M | cosmetic and titles only | new |
| 7 | Party records and shareable replays, friends | +0–1 | +1–2 (and K-factor) | S–M | §42 (public by default, opt-out) | §42 |
| 8 | Welcome-back summary | reactivation +5–10 % of lapsed | — | S | clean | new |
| 9 | Streak or login calendar | +1–2 | 0–1 | S | cosmetic only; §40's caution about logging in for its own sake applies | new |
| — | Clans and chat | +3–6 in genre | | L plus moderation | §42 explicitly excludes them; revisit as "posses" (shared records, no chat) after soft-launch data | — |

#### F12. Seasons (§39): the post-cap goal layer and the home for cosmetics — **P1, L**

**Evidence.**
- Reputation has no decay and no reset, and by F7 it equilibrates at bands 2–4 for most players,
  so a Reputation leaderboard would show the same few names forever.
- §39's proposal (6-week season, soft reset toward start, deliveries and strikes boards,
  cosmetic-only rewards) is right but unbuilt.
- §31 (integrity) is also unbuilt, and leaderboards attract alt-farming first.

**Proposal.**
- Build §39 with a free **season track** of 30 tiers of cosmetics, titles and banners, fed by
  renown from contracts, holds, deliveries and strikes.
- Use bracketed leaderboards (cohorts of about 100 by season start and band), so a casual player
  has a reachable rank.
- Gate leaderboard rewards on §31's sandbag and alt checks.
- Align season boundaries with the pack week (Monday 00:00 UTC).

**Guardrail fit.**
- The reset touches Reputation only, and Reputation is a rating, not progress.
- Leaderboards rank play only; Coin can't buy rank (no paid trips, no paid rerolls).
- Cutoffs are previewable from day 1 (guardrail 4).

#### F13. No collection or achievement layer, though the content would support one — **P2, S–M**

**Evidence.**
- There are 96 authored outfits with names, 32 living types, 6 traps, 5 siege pieces and 4 fence
  tiers. The replay log already knows every fight.
- None of it is collected or celebrated. The only record is the results feed.

**Proposal.**
- A "Wanted board": every authored outfit beaten, per band.
- A unit codex.
- "First hold against a 3-siege party"-style achievements paying titles and banners.
- Pinned best replays (§42).

**Guardrail fit.** Clean, cosmetic only.

### Monetization

#### F14. The cosmetics, the paid product, have no art, no render path and no audience — **P0, L**

**Evidence.**
- **Nothing is drawn.**
  - `apps/web/src/iso/skins.ts` ships only `PLACEHOLDER_SKINS` (geometric markers). `SpriteSkin` is
    "reserved for chunk 26: … the scene refuses it until then".
  - No renderer reads `cosmetic_equip`: a grep for cosmetic and equip in `iso/` and the town,
    trail and party screens finds only comments and the nav button.
  - Every catalog entry carries "pending art review (chunk 26)". Chunk 26 (art pipeline) is not
    built.
- **Nobody else sees them either.** §28 says party banners show on the scouting screen and in the
  results feed. The candidate views and the feed carry no banner, so no cosmetic is visible to
  the owner *or to anyone else*.
- **Most unit skins can never be used.**
  - 6 of the 8 unit skins are for other regions' starter types. With one caravan and a fixed
    region they can never be used by the buyer.
  - Example: our Desert player's next-week Pack 3 contains "Beaver-Hat Trapper", a Mountain unit.

**Proposal.**
- Before any paid launch:
  - chunk 26 sprites, with a cosmetic layer in the one iso renderer;
  - cosmetics visible where others see them: the scouting card, the replay, the owner-view
    replay, the party record;
  - unit skins offered only for the buyer's region, or sold as cross-region "families" (one
    purchase skins the equivalent type in every region).
- Keep chunk 28's readability review per item.

**Guardrail fit.** Clean. Cosmetics stay out of every resolver input (the type test exists).

#### F15. The store sells the currency players are throwing away — **P0, M** (product decision)

**Evidence.**
- **The value is gone for engaged players.**
  - The packs are 6,000 / 14,000 / 40,000 Coin for $5 / $10 / $25 ($0.83 / $0.71 / $0.63 per
    thousand).
  - A casual natural player is at the cap from day 7 (F1), so any pack is 100 % discarded. The
    store honestly says "Over the cap".
  - The $25 pack fits only a balance under 10,000.
  - A spender's Coin goes to replacing losses (F2), which feels like paying a repair bill, not
    progress.
- **The guardrails close the usual levers.** "Coin amounts fixed and consistent week to week" means
  no first-purchase bonus, no sales and no value packs. That is correct for fairness, but it leaves
  cosmetics as the only lever.
- **Spending is capped low, and Coin is worth nothing to the best players.**
  - The combined ceiling is $40 a week (60k Coin), so ARPPU is hard-capped at about $170 a month.
  - That ceiling is 1.09× the shipped free-week estimate, but only 0.27–1.03× a measured 30-trip
    week (F1). The guardrail holds with room to spare, which is one more sign that Coin is
    oversupplied.
  - The marginal value of Coin to the players with the highest lifetime value is zero.
  - The grind-wall probe is designed to show that paying is optional. Today it is optional
    because Coin is worthless, which is a monetization failure, not a fairness success.

**Proposal.** Re-anchor monetization on cosmetics and status, and keep Coin packs as the
"pace" option for the few who want it.
1. A **premium season track** ("Trail Pass", $4.99–7.99 per 6-week season). Cosmetic-only tiers
   earned by play-only renown. No Coin in the premium track, so `WEEKLY_PAY_CEILING` keeps its
   meaning. No tier skips at launch.
2. **Direct cosmetic purchase and themed cosmetic bundles** ($1.99–9.99, no Coin).
3. **A supporter or founder pack**: one-time, cosmetic-only (wagon, banner, title). If it carries
   Coin, that Coin counts toward the week's ceiling.
4. **Replay and caravan customization**: replay title cards, a victory flourish in the owner-view
   replay, wagon trails, party nameplates. Each passes the scouting-readability review.

**Guardrail fit.**
- All four are cosmetics, which guardrail 2 permits.
- Each is a new product type, so it needs a PROJECT.md §16 amendment (today §16 lists only weekly
  packs).
- None may contain Coin above the combined weekly ceiling, unlock points, slots, trip-cap uses or
  rerolls (chunk 20's list).

#### F16. Pricing ladder and the first-purchase moment — **P1, S**

**Evidence.**
- The entry price is $5. There is no $0.99–2.99 entry, no starter offer and no moment that frames
  a purchase.
- The inbox is forbidden from linking the store (good). The Packs screen is reached only from a
  Town button.
- Cosmetics sell when players see their own caravan wearing one, and today nothing renders
  (F14).

**Proposal.**
- **The ladder:** $1.99 single cosmetics; a $4.99 one-time starter (cosmetic plus the tier-1 pack's
  Coin, counted in the week); the $4.99–7.99 pass; $9.99 and $19.99 bundles; the three Coin
  packs unchanged.
- **The moment:** the second bank's summary shows the caravan rolling into town, and the
  "Your caravan" card in Town shows the equipped look with a "Try on" preview of this week's
  items. Never on a loss screen, never in the inbox, never in a push.

**Guardrail fit.**
- Previews stay exact (guardrail 4).
- A starter whose Coin equals tier 1's is not a per-player Coin variance, since every player gets
  the same offer once. Confirm in the §16 amendment.

#### F17. "Limited-release" isn't limited, and a full payer exhausts the catalog in 11 weeks — **P1, S**

**Evidence** (probe over 52 weeks with the shipped `cosmeticRotationForWeek`):
- 24 cosmetics, 6 a week.
- **Each cosmetic is on offer 9–19 weeks a year** (median 13). The median gap between returns is 3
  weeks, and 73 of 288 returns are back-to-back weeks.
- **A player buying all three packs weekly owns the whole catalog in 11 weeks** ($440). After that
  every pack grants nothing new ("not granted twice"), so the spending ceiling falls to Coin the
  player doesn't need.
- A tier-3-only buyer completes it in 21 weeks, a tier-1-only buyer in 92.
- The rotation can't be scheduled: rank = FNV-1a(week, id), and a catalog addition can only push
  out a week's sixth item. So there are no themed weeks, holiday items or launch exclusives.

**Proposal.**
- An **editorial schedule** table: overrides per week, still identical for every player and
  previewable at least one week ahead. Chunk 28's determinism holds, because a published schedule
  is as reproducible as a hash.
- Catalog growth of at least 4–6 items a week while full payers exist.
- Season-exclusive items that are vaulted, with the vaulting stated up front.

**Guardrail fit.** Legibility holds: what's on offer and what returns are both published.

#### F18. Real payments (§34) aren't built, and the weekly-limit rule collides with store billing — **P0 for a paid launch, L**

**Evidence.**
- `PURCHASE_BACKEND` is `sandbox_stub`. `STORE_MODE=off` is the production default, and the
  sandbox is refused in production unless overridden.
- There is no StoreKit 2, Play Billing or web PSP. There is no receipt verification, refund,
  chargeback or clawback.
- **The collision with platform consumables.**
  - Apple consumables can't be refunded by the developer.
  - The per-(account, week, tier) UNIQUE limit is therefore only safe if it is checked *before* the
    purchase sheet opens. A duplicate receipt that arrives anyway (a second device, a race, a
    restore) needs a policy that keeps the weekly ceiling.
- **Clawback.** Coin can't go negative, so a refunded pack whose Coin is already spent needs a
  rule too.

**Proposal.**
- §34 as specced, plus:
  - a server-issued, short-lived purchase intent before the sheet opens;
  - a written policy for late duplicates: grant the cosmetics and park the Coin as a pending
    credit released in the next week where that tier is unbought, so the ceiling holds;
  - a refund policy (debit the remaining Coin, revoke the cosmetic, flag the account);
  - store-console price tiers per country (Coin stays per tier, which the guardrail allows).
- Choose the web PSP now: the game is web-first, and the PWA is the soft-launch vehicle.

**Guardrail fit.** Repeat chunk 20's whole QA list with real billing, as §34 says.

### Live-ops readiness

#### F19. Nothing can change without a deploy — **P0, M**

**Evidence.**
- **The registry is a compiled constant.** `TUNABLES` (196 keys) is `deepFreeze`d at import
  in `packages/content/src/tunables.ts`. The authored set and cosmetics are code.
- **§33 (live-ops tooling) is not built.**
- **Resolver-visible changes are deploys with a drain.**
  - Any change to a resolver tunable changes `RESOLUTION_CONTENT_HASH`. Menus drawn under the old
    hash answer 409 `menu_stale`, and queued jobs park.
  - PLAYTEST-HOSTING step 12 is a stop, drain, migrate, seed and restart procedure, and testers
    must reload.
- **The client has its own copy.** It compiles tunables in, including `DEPLOYMENT_SLOT_CAP`,
  `TRAP_SLOT_CAP`, `FENCE_MATERIAL_BUDGET`, `AUTHORED_ONLY_UNTIL_BANKS`, `SUGGESTED_PARTY_MAX`,
  `GUIDE_RESERVE` and `MERGE_LEVEL_MAX`. A server-side config change would desync the client, and
  after §34 it would wait on a store review.
- **The only runtime switches** are environment variables (`STORE_MODE`, rate limits).

**Proposal.** A minimal §33 before soft launch:
1. **Server-driven config, versioned and audited**, for non-resolver numbers first: trickle and
   buffer, cap, merge, mercenary and reroll costs, reward schedules, inbox defaults, guide knobs.
   Read per request, cached, every change an audit row.
2. **Resolver tunables as scheduled versions.** Published at a stated time, identical for everyone.
   The version id is stamped on the job and the replay; the old menus' `menu_stale` path already
   handles the switch.
3. **A `/api/config` endpoint the client reads at boot**, replacing the compiled copies.
4. **Feature flags and kill switches**: store, contracts, events, push.

**Guardrail fit.**
- Determinism holds if every resolution records the tunables version (§33 already requires it).
- Scheduled for everyone keeps "identical for paying and non-paying".

#### F20. No event scheduling, no A/B testing and no merchandising control — **P1, M**

**Evidence.**
- There is no event model: no start or end, no themed authored set, no modifier.
- There is no experiment assignment or exposure logging.
- The pack rotation is a hash (F17).

**Proposal.**
- **An event object**: schedule, a themed authored-outfit set (seeded like chunk 25), an optional
  published modifier (a resolver tunable version from F19), a contract set and a cosmetic set.
- **An experiment framework limited to what the guardrails allow to differ between players**:
  onboarding, copy, notification timing and frequency, store presentation and ordering, guide
  advice.
  - Never resolution, matchmaking, pack contents or Coin amounts.
  - Economy changes (F1's buffer, F2's tuning) roll out by date to everyone, measured as
    before/after cohorts, not split.

**Guardrail fit.** Excluding outcome-relevant systems from A/B is what keeps guardrails 1 and 2.

#### F21. The content pipeline is code-only, with no authored editor and no fast balance gate — **P1, M**

**Evidence.**
- **Each content type means a code edit.**
  - A unit is about 22 lines of TypeScript in `units.ts`.
  - The validator pins `LIVING_WEB_NODES` = `LIVING_UNITS_PER_REGION` = 8, so new units mean
    changing web shape, ladder table (20 rungs) and validation together.
  - Authored outfits are generated by `authoredPartySpecs()` with hand overrides
    (`AUTHORED_REAUTHORED`, set v7), seeded by `seed.js`.
  - Cosmetics are code plus art that doesn't exist.
- **There is no authored-party editor** (§33 asks for one, reusing the player party builder).
- **The balance gate is slow.** Every drop needs the 75-minute full sweep at 2 jobs. The `--quick`
  loop is about 17 minutes on an idle host; ours had not finished after 25 minutes on a loaded
  one.

**Proposal.**
- Content as data: JSON with a schema, still hashed into `RESOLUTION_CONTENT_HASH`.
- An authored-outfit editor in the admin app that writes a new set version.
- Run the sweep as a sharded CI job on content PRs (the CI slice exists; make it the gate).
- A per-drop checklist: sweep, BALANCE-LOG entry, outfit refresh, cosmetic review note.

**Guardrail fit.** Clean.

#### F22. The admin surface is one read-only dashboard; operations and support have no tools — **P0, M**

**Evidence.**
- `admin.js` has `grant`, `revoke` and `list`. `/admin/dashboard` is the only admin route and only
  reads.
- §33's account tools are not built: view, suspend, restore, refund, inspect any replay, trace
  Coin.
- There is no audit log beyond `account_admin.granted_by`.
- A support ticket ("where did my 7 units go?") needs SQL against the ledger.

**Proposal.**
- An account inspector (ledger timeline in plain words, roster history, trips, replays).
- Suspend and restore, and refund (with F18's policy).
- A Coin trace between accounts (§31).
- An audit log for every admin action.
- Role-based access: support, live-ops, admin.

**Guardrail fit.** No admin tool may grant access or power. Refunds only remove.

#### F23. There is no season or reset model at all — **P1, S** (design)

**Evidence.** Reputation is volatile but permanent. There is no season boundary, nothing weekly
resets except the pack week, and inbox horizons are 14 days.

**Proposal.**
- Decide the calendar now:
  - week = the pack week (Monday 00:00 UTC);
  - season = 6 weeks, starting on a pack-week boundary;
  - events = 7–10 days inside a season;
  - content drop = every second season.
- Write it into PROJECT.md with §39's amendment.

**Guardrail fit.** Clean.

### Telemetry

#### F24. Chunk 32 is a balance dashboard; the studio KPI set is mostly missing — **P0, M**

What a studio watches daily, and what `/admin/dashboard` produces today:

| KPI | soft-launch target (my genre benchmark, mid-core async strategy) | chunk 32 today | gap |
|---|---|---|---|
| D1 / D7 / D30 | 35–45 % / 12–18 % / 4–8 % | one number each for days 1, 7 and 30, over everyone created in the last 90 days (`RETENTION_SQL`) | per install-day cohorts, the D2–D14 curve, splits by region and by first-trip outcome |
| DAU / WAU / MAU, stickiness | DAU/MAU ≥ 20 % | missing | add (screen events and own-action ledger rows already exist) |
| New players per day | — | missing | add (`account.created_at`) |
| Session length | median 8–15 min | yes (client screen flow, 30-min gap) | add by cohort and by day of life |
| Sessions per DAU | 2–4 | missing | add |
| FTUE funnel: welcome → refugee → ride out → enc 1 → bank → party raised → trip 2 → 2nd bank | — | missing (`account_onboarding` stores the steps) | add |
| Trip funnel: start → search → choose → commit → bank / overrun / void | — | partial (`tripLength`, `bankVsPush`) | add search, choose, void and abandon |
| Churn points (last action before 7 days idle) | — | missing | add |
| Return after a total-loss overrun (BALANCE-LOG's top question) | — | missing | add (F10) |
| Economy: sources, sinks and net per DAU per day; median balance by day of life; idle-at-cap | — | `earnBySource` and `spendByReason` as window totals; `nearCap` counts now | daily series, per capita, net. **Idle trickle at the cap is unrecorded: the server writes nothing at the cap, so the biggest leak (F1) is invisible.** |
| Balance distribution | — | ≥ 90 % and at-cap counts only | percentiles |
| Payer funnel: conversion, ARPDAU, ARPPU, first-purchase day, repeat | 2–4 % conversion | `packFunnel` (store view → purchase); "not counted" in production | add with F18 |
| Push opt-in and open rate | — | no push | add with F11 |
| Content: share and hold rate per authored outfit; cosmetic equip rate | — | per-unit, trap and siege panels; no outfit or equip panel | add |
| Crash-free sessions | ≥ 99.5 % | crash reports (class plus hash) | needs the session denominator |
| Pool health | — | yes, with alarms | alarms are noise on day 1 (8 of 8 bands): add a soft-launch baseline |

**Also.**
- **Pull-only and fragile.** The dashboard is pull-only, its widest window is 120 days, it runs
  with a 5-second statement timeout on the game's own database, and it has no export and no
  alerting. A band-emptiness alarm reaches nobody.
- **Totals hide trends.** Panels are tables of window totals, so trends are invisible.

**Proposal.**
- A nightly export of the ledger and client events to an analytics store.
- Cohort tables and the KPIs above.
- A daily digest to a channel with alert thresholds (pool empty, crash spike, D1 drop).
- Keep the one-way rule (play never reads analytics) and the opt-out.

**Guardrail fit.** Clean. Payloads stay keyed by the opaque id (§32's privacy rule).

### Content cadence

#### F25. Players will exhaust the content fast, and a new region doesn't reach existing players — **P1, L**

**Evidence.**
- **Permanent progression ends early.** Hardcore players stop at living rung 20 by day 40–57;
  casual players reach it after day 90 (rung 16 at day 90).
- **The authored set repeats.**
  - 12 authored outfits per band. A band-2–3 player at 5–9 encounters a day has met all 12 of
    their band within 2–3 days, with `RECENT_OPPONENT_EXCLUSION` 5.
  - Until the live pool fills, and in a small soft-launch market, the authored set *is* the
    content. Our server's day 1: 0 live parties in 7 of 8 bands.
- **Cosmetics run out:** in 11 weeks for a full payer (F17).
- **A new region doesn't reach the installed base.**
  - §41 proposes that "a new region is a content drop of 8 living-unit types and a palette".
  - But region is chosen once and `MAX_CARAVANS_PER_ACCOUNT` is 1. Multi-caravan is §46,
    post-v1.
  - So a region drop gives existing players only new *raiders* to fight. It can't be their next
    collection.
- **The cadence is too slow.** §41's default cadence is 8 weeks. Hardcore players hit the ladder
  cap at week 6–8.

**Proposal.** A cadence the team can sustain:

| cadence | content | needs |
|---|---|---|
| weekly | 4–6 cosmetics (the editorial schedule, F17); contract slate | F17, F11 |
| fortnightly | a themed authored-outfit set of 6–12 (an event), cosmetic rewards | F20, F21 editor |
| 6-weekly | a season: reset, leaderboards, pass (F12, F15) | F12 |
| 12-weekly | a web extension: 1 living type per region, 1 trap or 1 siege piece, ladder rungs 21–25 (§41), outfits re-authored | F21 gate, F19 scheduled resolver version |
| when ready | multi-caravan (§46) as the first "new region" for existing players | group C |

**Authored-outfit tooling, as it is today**: code generation plus hand overrides and a version
bump, no editor, a 75-minute sweep. That is fine for a balance pass, and too slow for a
fortnightly event. F21's editor is the prerequisite.

**Guardrail fit.**
- New nodes are never Coin-purchasable (§41).
- Growth is never retroactive.
- Every drop runs the sweep before release.

## Soft-launch live-ops roadmap: the first 12 weeks

**Before week 1** (the P0 gate, about 6–8 weeks, much of it in parallel):
- F1: the mine buffer, with the "near cap" item on by default;
- F2: (b) and (c) tuned so 8 × L3 is stable;
- F5: amend §14;
- F7: the living and trap curves flattened;
- F10 and F24: the KPI export, cohorts and the return-after-overrun panel;
- F11: web push;
- F14: art for the soft-launch catalog and cosmetics rendered where others see them;
- F19: server-driven config and flags, with the client reading `/api/config`;
- F22: the account inspector, suspend and refund;
- F15 / F18: decide the product (cosmetic-first) and the web PSP.

If F14 can't make it, launch with the store off and cosmetics withheld rather than sell labels.

| week | systems | content | what the team reads that week |
|---|---|---|---|
| 1 | Soft launch in 1–2 test markets (PWA). Daily KPI digest; hotfixes through config only. | Authored set v7; catalog of 24 plus the editorial schedule | D1, FTUE funnel, first-trip delivery, crash-free rate, pool health by band |
| 2 | Push frequency tuning (F11). The welcome-back summary. | First editorial week (themed) | D1/D3, push opt-in and open rate, overruns per player per day |
| 3 | **Weekly contracts and daily renown bounties** (F11, §40) | Contract slate 1 | D7 of the week-1 cohort, contract completion, idle-at-cap share |
| 4 | The Outfitter Coin shop (F6) | 4 Coin cosmetics | Coin net per DAU, balance percentiles, share at the cap |
| 5 | Event framework (F20); scouting credit for parties (F9) | **Event 1**: "Railroad Strike" outfit set, 8 outfits plus 3 cosmetics | strikes per party by strength, siege ladder pace |
| 6 | **Season 0** (F12): soft reset, bracketed boards, the free track; §31 integrity checks first | Season 0 cosmetics | D14/D30 of early cohorts, season-track engagement |
| 7 | Billing live on the web PSP (F18); premium track and starter (F15, F16) | Pass cosmetics (art) | conversion, first-purchase day, ARPDAU |
| 8 | Collections and the Wanted board (F13); party records and replay share (§42) | Codex art | D30, share and K-factor, collection progress |
| 9 | The first scheduled resolver-tunables version (F19), if F2 needs it | **Event 2** plus a published modifier ("Dust Storm": all ranges −1 cell, swept first and announced a week ahead) | hold rate by band before and after; overruns |
| 10 | Town building, stages 1–2 (F6) | 4 buildings | Coin net, sink share by type |
| 11 | Convalescence (F2a) as a dated rollout; the authored-outfit editor (F21) | Outfit refresh for bands 2–4 | merge levels kept per week, mercenary share of spend |
| 12 | **Content drop 1** (F25): 1 living type per region, 1 trap, ladder rungs 21–25; Season 1 | Season 1 pass | go / no-go for wider launch: D1 ≥ 35 %, D7 ≥ 12 %, D30 ≥ 5 %, conversion ≥ 2 %, no band empty, < 30 % of DAU at the cap |

**What not to do in the window:**
- clans or chat (§42);
- Coin login rewards;
- an upgradeable mine or cap;
- anything sold that touches the trip cap, rerolls, slots or the unlock web;
- multi-caravan before group A is done.
