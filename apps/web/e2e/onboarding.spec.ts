/**
 * The first session (chunk 24, PHASE-2 §24), on a 360×640 portrait screen against the built
 * server (scripts/e2e.mjs runs chunk 15's test double as the resolver: every fenced encounter-1
 * circle is held, 150 HP off each post, encounter 2 kills the lowest-ref post; and, chunk 24 QA
 * S5, an encounter-1 circle with NO fence is overrun — DOUBLE_SCRIPT — so the path most real
 * first trips take is walked end to end too):
 *
 *   register a fresh account (region explained as permanent; the caravan starts with its
 *   starting roster, chunk 24 QA D1) → the first screen (defense live, the raid party passive;
 *   not skippable; no tab bar) → the town: take a refugee (the ordinary free menu) → pack and
 *   ride out → encounter 1: search, the scout card names the smallest party, choose it, the
 *   guided arrangement (fence, gap, post, trap, rest — each step next to the circle; "now scout
 *   why"), commit → the real (double-resolved) result, honestly → the bank-or-push card reads
 *   the stakes and recommends, never insists → push → encounter 2: a free arrangement → bank →
 *   the trip summary → "while you were out, someone else's party met a caravan": raise the
 *   standing party from the roster → finish. The server then agrees: guide done, the trip
 *   banked after two encounters, and nothing granted beyond the starting roster and the trip.
 *
 *   The overrun branches: encounter 1 left unfenced → overrun → the summary → the party card
 *   leads with the overrun and says what was lost (as the ended trip records it) → raise from
 *   what is left (a de-merged survivor, or nothing) → finish.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { TUNABLES, unlockWebFor } from "@caravan/content";

/** The starting roster every new caravan is granted (chunk 24 QA D1), read from content: its region's tier-0 living types × STARTING_ROSTER copies. */
function startingRosterSize(region: "desert" | "high_plains" | "mountain" | "badlands" = "desert"): number {
  return unlockWebFor("living", region).nodes.filter((n) => n.tier === 0).length * TUNABLES.STARTING_ROSTER.copiesPerStarterType;
}
/** The whole roster the guide packs: the starting roster and the one refugee it claims. */
const PACKED = startingRosterSize() + 1;
/** What "raise my party" fills: every roster unit up to the party cap. */
const RAISED = Math.min(PACKED, TUNABLES.PARTY_SLOT_CAP);

/** Every control at least a touch target tall, and no sideways scroll (chunk 17's check). */
async function fitsPortrait(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    const controls = [...document.querySelectorAll<HTMLElement>("button, select, summary, a[href], input[type=checkbox], input[type=radio]")];
    const small = controls
      .filter((b) => !(b.title ?? "").startsWith("select to enable accessibility"))
      .filter((b) => {
        const own = b.getBoundingClientRect();
        if (own.width === 0 || own.height === 0) return false;
        const target = b.tagName === "INPUT" ? (b.closest("label") ?? b).getBoundingClientRect() : own;
        return target.height < 43.5;
      })
      .map((b) => `${b.tagName}:${(b.textContent ?? "").trim().slice(0, 40)}`);
    return { scroll: doc.scrollWidth, width: window.innerWidth, small };
  });
  expect(r.scroll).toBeLessThanOrEqual(r.width);
  expect(r.small).toEqual([]);
}

async function atWidths(page: Page): Promise<void> {
  await fitsPortrait(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await fitsPortrait(page);
  await page.setViewportSize({ width: 360, height: 640 });
}

/**
 * Guardrail 0 copy over the whole screen (chunk 24 QA S5: `main`, not just the guide's cards —
 * the commit dialog's "every living unit is at the camp" once slipped past a `.guide`-only scan).
 */
async function copyIsTheRightWayRound(page: Page): Promise<void> {
  for (const text of await page.locator("main, [role=dialog]").allTextContents()) {
    expect(text).not.toMatch(/\b(base|camp)\b/i);
    expect(text).not.toMatch(/\byou (attack|raid)\b/i);
    expect(text).not.toMatch(/pushes once/i);
  }
}

/** Chunk 24 QA S1: the guide's own rules apply (a dashed border: the marker that is not colour alone). */
async function guideStyled(page: Page): Promise<void> {
  const style = await page.locator(".guide").first().evaluate((el) => getComputedStyle(el).borderTopStyle);
  expect(style).toBe("dashed");
}

/** Chunk 24 QA S4: when a guided step is tapped, the circle it changes is on screen. */
async function tapWithCircleInView(page: Page, testId: string): Promise<void> {
  const button = page.getByTestId(testId);
  await button.scrollIntoViewIfNeeded();
  const seen = await page.evaluate(() => {
    const r = document.querySelector("[data-testid=formation-screen] [data-testid=iso-host]")!.getBoundingClientRect();
    const visible = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    return { visible, height: r.height };
  });
  // At least a third of the circle shares the screen with the step being taken.
  expect(seen.visible, `${testId}: circle ${seen.visible}px of ${seen.height}px in view`).toBeGreaterThanOrEqual(seen.height / 3);
  await button.click();
  // …and after the edit the circle is brought into view, so the change is seen.
  const after = await page.evaluate(() => {
    const r = document.querySelector("[data-testid=formation-screen] [data-testid=iso-host]")!.getBoundingClientRect();
    return Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0) >= r.height / 2;
  });
  expect(after, `${testId}: circle in view after the edit`).toBe(true);
}

/**
 * Final play-test review S4: a just-committed fight opens its replay at once, playing, with
 * "Skip to result" as the dialog's action. Prove it opened, then skip to the itemized result.
 */
async function skipAutoplay(page: Page): Promise<void> {
  const dialog = page.getByTestId("replay-dialog");
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  const skip = dialog.getByTestId("replay-close");
  await expect(skip).toHaveText("Skip to result");
  await skip.click();
  await expect(dialog).toHaveCount(0);
}

async function commit(page: Page): Promise<void> {
  await page.getByTestId("commit-open").click();
  await expect(page.getByTestId("commit-confirm")).toBeEnabled({ timeout: 15_000 });
  await copyIsTheRightWayRound(page);
  await page.getByRole("dialog").getByTestId("commit-confirm").click();
  await skipAutoplay(page);
}

const fresh = (tag: string): string => `e2e_${tag}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
const PASSWORD = "e2e-password-1";

/** Register (region permanent), read the first screen (no skip, no tabs), begin. */
async function registerAndBegin(page: Page, username: string): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "New here? Start a caravan" }).click();
  await expect(page.getByText("Permanent: chosen once for this caravan and never swapped.")).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Region").selectOption("desert");
  await page.getByRole("button", { name: "Create account" }).click();
  const welcome = page.getByTestId("onboarding-welcome");
  await expect(welcome).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0); // QA N7
  await welcome.page().getByTestId("welcome-begin").click();
  await expect(page.getByTestId("guide-roster")).toBeVisible();
}

/** The roster step: take a refugee from the ordinary free menu; the guide moves on from the server's claim. */
async function takeRefugee(page: Page): Promise<string> {
  const firstOffer = page.getByTestId("refugee-offers").getByRole("button", { name: /^Take / }).first();
  const typeName = (await firstOffer.textContent())!.trim().replace(/^Take /, "");
  await firstOffer.click();
  await expect(page.getByTestId("refugee-panel").getByRole("status")).toHaveText(`Taken: ${typeName} joined the roster at level 1.`);
  await expect(page.getByTestId("guide-outfit")).toBeVisible({ timeout: 10_000 });
  return typeName;
}

/** Pack every unit in the roster (the starting roster and the refugee), optionally a trap, a fence; ride out. */
async function packAndRide(page: Page, units: number, trap: boolean): Promise<void> {
  await page.getByTestId("nav-outfit").click();
  const boxes = page.getByTestId("outfit-units").getByRole("checkbox");
  await expect(boxes).toHaveCount(units);
  for (let i = 0; i < units; i++) await boxes.nth(i).check();
  if (trap) await page.getByTestId("outfit-traps").getByRole("button", { name: "Add Spike Pit" }).click();
  await page.getByTestId("outfit-fence-tier").selectOption("fence.brush_pile");
  await page.getByTestId("outfit-ride-out").click();
  const ride = page.getByRole("dialog", { name: "Pack the caravan and ride out?" });
  await expect(ride).toContainText(`${units} living unit${units === 1 ? "" : "s"}`);
  await ride.getByTestId("outfit-confirm").click();
}

/** Encounter 1: search, the scout's smallest party, choose it. */
async function searchAndChoose(page: Page): Promise<void> {
  await expect(page.getByTestId("trail-unsearched")).toHaveAttribute("data-encounter", "1");
  await expect(page.getByTestId("guide-search")).toBeVisible();
  await page.getByTestId("search").click();
  await expect(page.getByTestId("candidate-list")).toBeVisible();
  await expect(page.getByTestId("guide-scout-pick")).toContainText("That is a reading of the scout, not a promise.");
  const pick = await page.getByTestId("guide-scout-pick").getAttribute("data-index");
  await page.getByTestId(`choose-${pick}`).click();
  await expect(page.getByTestId("formation-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("guide-arrange")).toBeVisible();
}

async function login(request: APIRequestContext, username: string): Promise<Record<string, string>> {
  const res = await request.post("/api/auth/login", { data: { username, password: PASSWORD } });
  const { token } = (await res.json()) as { token: string };
  return { Authorization: `Bearer ${token}` };
}

test("a fresh account: register, the first screen, a refugee, the first trip guided to a bank after two encounters, then the standing party", async ({ page, request }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 360, height: 640 });
  const username = fresh("new");

  await page.goto("/");
  await page.getByRole("button", { name: "New here? Start a caravan" }).click();
  await expect(page.getByText("Permanent: chosen once for this caravan and never swapped.")).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Region").selectOption("desert");
  await page.getByRole("button", { name: "Create account" }).click();

  // ── the first screen: before any tab, not skippable ──
  const welcome = page.getByTestId("onboarding-welcome");
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText("You play defense, live");
  await expect(welcome).toContainText("Your raid party works while you are away");
  await expect(welcome).toContainText("Your town is never raided");
  await expect(welcome).toContainText("then bank if you are still standing"); // QA N9: a plan, not a promise
  await expect(page.getByTestId("welcome-region")).toContainText("Your caravan rides the Desert.");
  await expect(page.getByTestId("welcome-region")).toContainText("permanent for this caravan");
  await expect(page.getByTestId("guide-skip")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0); // QA N7
  await copyIsTheRightWayRound(page);
  await atWidths(page);
  await page.getByTestId("welcome-begin").click();

  // ── town: the starting roster is there; take a refugee (the ordinary free menu) ──
  await expect(page.getByTestId("guide-roster")).toBeVisible();
  await expect(page.getByTestId("guide-roster")).toContainText("starting roster");
  await guideStyled(page);
  await expect(page.getByTestId("town-screen")).toBeVisible();
  await expect(page.getByTestId("board-count")).toContainText(`${startingRosterSize()} of ${TUNABLES.BOARD_SLOTS} board slots used`);
  await copyIsTheRightWayRound(page);
  await atWidths(page);
  await takeRefugee(page);

  // ── outfit and ride out: the whole roster ──
  await packAndRide(page, PACKED, true);

  // ── encounter 1: search, scout, choose the smallest party ──
  await searchAndChoose(page);
  await copyIsTheRightWayRound(page);

  // ── the guided arrangement: each step next to the circle ──
  const arrange = page.getByTestId("guide-arrange");
  await expect(page.getByTestId("guide-next-step")).toContainText("Step 1 of 5");
  await page.screenshot({ path: "test-results/onboarding-arrange-step1.png" });
  await tapWithCircleInView(page, "guide-do-fence");
  await expect(page.getByTestId("guide-step-fence")).toHaveAttribute("data-done", "true");
  await expect(page.getByTestId("guide-step-gap")).toHaveAttribute("data-done", "true");
  await tapWithCircleInView(page, "guide-do-post");
  await expect(page.getByTestId("guide-step-post")).toHaveAttribute("data-done", "true");
  await tapWithCircleInView(page, "guide-do-trap");
  await expect(page.getByTestId("guide-step-trap")).toHaveAttribute("data-done", "true");
  await tapWithCircleInView(page, "guide-do-rest");
  await expect(page.getByTestId("budget-meter")).toContainText("20 of 20 segments placed");
  await expect(page.getByTestId("guide-steps-done")).toBeVisible();
  await expect(page.getByTestId("guide-why")).toContainText("one way through");
  await expect(arrange).toContainText("does not guarantee a hold");
  await copyIsTheRightWayRound(page);
  await atWidths(page);
  await commit(page);
  await expect(page.getByTestId("encounter-results")).toBeVisible({ timeout: 20_000 });

  // ── the result, as the server recorded it (the double holds); the advice reads the stakes ──
  const r1 = page.getByTestId("encounter-result-1");
  await expect(r1.getByTestId("result-outcome")).toHaveText("The caravan held.");
  await expect(page.getByTestId("guide-result")).toContainText("Your caravan held");
  await page.getByTestId("to-decision").click();
  await expect(page.getByTestId("bank-or-push")).toBeVisible();
  await expect(page.getByTestId("guide-result")).toContainText("Bank or push");
  // QA D2: a recommendation from the server's preview, never "this first trip pushes once".
  const advice = page.getByTestId("guide-advice");
  await expect(advice).toBeVisible();
  console.log(`onboarding e2e: encounter-1 advice: ${await advice.getAttribute("data-advice")}`);
  await expect(page.getByTestId("bank-or-push").getByTestId("stake-unbanked")).toBeVisible();
  await copyIsTheRightWayRound(page);
  await atWidths(page);
  await page.getByTestId("push-open").click();
  await page.getByRole("dialog", { name: "Push on to encounter 2?" }).getByTestId("push-confirm").click();

  // ── encounter 2: a free arrangement; post every living unit by hand ──
  await expect(page.getByTestId("trail-unsearched")).toHaveAttribute("data-encounter", "2");
  await expect(page.getByTestId("guide-free")).toBeVisible();
  await page.getByTestId("search").click();
  await page.getByTestId("choose-0").click();
  await expect(page.getByTestId("formation-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("guide-free")).toBeVisible();
  await expect(page.getByTestId("guide-arrange")).toHaveCount(0);
  const trayUnits = page.locator('[data-testid^="tray-unit-"]');
  const n = await trayUnits.count();
  for (let i = 0; i < n; i++) {
    const unit = trayUnits.nth(i);
    await unit.getByRole("button").click();
    const picker = page.getByTestId("placement-picker");
    await picker.getByRole("combobox").selectOption({ index: 1 });
    await picker.getByRole("button", { name: "Place here" }).click();
    await expect(unit).toContainText("Posted at");
    // Final play-test review S3: placing the last unit clears the selection (nothing left to advance to).
    const done = page.getByRole("region", { name: "Selected" }).getByRole("button", { name: "Done" });
    if (await done.count()) await done.click();
  }
  await commit(page);
  await expect(page.getByTestId("encounter-results")).toBeVisible({ timeout: 20_000 });

  // ── bank ──
  await expect(page.getByTestId("encounter-result-2").getByTestId("result-outcome")).toHaveText("The caravan held.");
  await page.getByTestId("to-decision").click();
  await expect(page.getByTestId("guide-result")).toContainText("that ends the first trip");
  await page.getByTestId("bank-open").click();
  await page.getByRole("dialog", { name: "Bank the trip?" }).getByTestId("bank-confirm").click();
  const summary = page.getByTestId("trip-summary");
  await expect(summary).toBeVisible();
  await expect(summary.getByTestId("summary-banked")).toContainText("Banked after 2 encounters. The caravan is home.");
  const bankedText = (await summary.getByTestId("summary-credited").textContent()) ?? "";
  const banked = Number(/(\d+) Coin banked/.exec(bankedText)?.[1] ?? "NaN");
  expect(Number.isInteger(banked)).toBe(true);
  const balanceText = (await summary.getByTestId("summary-balance").textContent()) ?? "";
  const balance = Number(/now (\d+)\./.exec(balanceText)?.[1] ?? "NaN");
  // Banked Coin is the trip's earnings plus the mine's ordinary trickle (chunk 16); no guide grant.
  expect(balance).toBeGreaterThanOrEqual(banked);

  // ── the passive side: someone else's party met a caravan; raise yours ──
  const party = page.getByTestId("guide-party");
  await expect(party).toBeVisible();
  await expect(party).toContainText("While you were out, someone else's party met a caravan");
  await copyIsTheRightWayRound(page);
  await atWidths(page);
  await party.getByTestId("guide-raise-party").click();
  await expect(page).toHaveURL(/#\/party$/);
  await expect(page.getByTestId("guide-party-raised")).toContainText(`Your standing party is up: ${RAISED} units from your roster`);
  await expect(page.getByTestId("guide-party")).toContainText("This is your passive side.");
  // QA N8: the Party screen opens at its top, the guide's status and Finish in view.
  await expect(page.getByTestId("guide-finish")).toBeInViewport();
  await atWidths(page);
  await page.getByTestId("guide-finish").click();
  await expect(page.locator(".guide")).toHaveCount(0);

  // ── the server agrees, and nothing was granted beyond the starting roster and the trip's own earnings ──
  const auth = await login(request, username);
  const ob = (await (await request.get("/api/me/onboarding", { headers: auth })).json()) as { onboarding: { step: string; skipped: boolean } };
  expect(ob.onboarding).toMatchObject({ step: "done", skipped: false });
  const me = (await (await request.get("/api/me", { headers: auth })).json()) as { account: { coinBalance: number }; caravans: { id: string; units: unknown[] }[] };
  expect(me.caravans[0]!.units).toHaveLength(PACKED);
  // The account's own ledger: the starting roster, the trip's events and the refugee claim, and no purchase of any kind.
  const ledger = (await (await request.get("/api/me/ledger?limit=200", { headers: auth })).json()) as { events: { type: string; causationId: string; payload: { source?: string } }[] };
  const types = ledger.events.map((e) => e.type);
  console.log(`onboarding e2e: ledger event types: ${[...new Set(types)].join(", ")}`);
  expect(types).not.toContain("coin_purchased");
  const acquired = ledger.events.filter((e) => e.type === "unit_acquired").map((e) => e.payload.source);
  expect(acquired.sort()).toEqual(["refugee", ...Array<string>(startingRosterSize()).fill("starting_roster")]);
  const status = (await (await request.get(`/api/me/caravans/${me.caravans[0]!.id}/trip`, { headers: auth })).json()) as { trip: { endReason: string; encounters: { decision: string | null }[] } };
  expect(status.trip.endReason).toBe("banked");
  expect(status.trip.encounters.map((e) => e.decision)).toEqual(["pushed", "banked"]);
  const saved = (await (await request.get("/api/me/party", { headers: auth })).json()) as { party: { valid: boolean; config: { units: unknown[] } } };
  expect(saved.party.config.units).toHaveLength(RAISED);
  expect(saved.party.valid).toBe(true);
  // A reload reads the same server row: the guide stays finished (no browser storage involved).
  // Chunk 30: a reload stays signed in (the server's HttpOnly device cookie); no second sign-in.
  await page.reload();
  await expect(page.getByTestId("party-screen").or(page.getByTestId("town-screen"))).toBeVisible();
  await expect(page.locator(".guide, [data-testid=onboarding-welcome]")).toHaveCount(0);
});

for (const branch of [
  { name: "with a survivor", trap: true },
  { name: "with no one left", trap: false },
] as const) {
  test(`the common path: encounter 1 is overrun (${branch.name}) → the summary → the party card says what was lost → raise from what is left → finish`, async ({ page, request }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 360, height: 640 });
    const username = fresh(branch.trap ? "ovr_s" : "ovr_n");
    await registerAndBegin(page, username);
    await takeRefugee(page);
    await packAndRide(page, PACKED, branch.trap);
    await searchAndChoose(page);

    // Post every unit (and lay the trap) through the guide, but leave the circle unfenced: the
    // double overruns an unfenced encounter 1 (DOUBLE_SCRIPT), as the real resolver mostly does.
    await page.getByTestId("guide-all-steps").locator("summary").click();
    await page.getByTestId("guide-do-post").click();
    await expect(page.getByTestId("guide-step-post")).toHaveAttribute("data-done", "true");
    if (branch.trap) {
      await page.getByTestId("guide-do-trap").click();
      await expect(page.getByTestId("guide-step-trap")).toHaveAttribute("data-done", "true");
    }
    await expect(page.getByTestId("budget-meter")).toContainText("0 of 20 segments placed");
    await commit(page);

    // ── the summary: the trip ended in an overrun ──
    const summary = page.getByTestId("trip-summary");
    await expect(summary).toBeVisible({ timeout: 20_000 });
    await expect(summary.getByTestId("summary-overrun")).toBeVisible();

    // ── the party card: the overrun first, under its own heading; what was lost, as recorded ──
    const card = page.getByTestId("guide-party");
    await expect(card).toBeVisible();
    await expect(card.getByRole("heading").first()).toHaveText("Your caravan was overrun");
    await expect(card.getByRole("heading").nth(1)).toHaveText("Meanwhile, your own party meets other players' caravans");
    await expect(card).not.toContainText("While you were out, someone else's party met a caravan");
    await expect(card).not.toContainText("what you packed is lost");
    await expect(card).not.toContainText("itemized before"); // no stake choice was made at encounter 1
    const losses = card.getByTestId("guide-overrun-losses");
    if (branch.trap) {
      await expect(losses).toContainText("Lost outright (still standing when the caravan fell):");
      await expect(losses).toContainText("Fell in the fighting and come home a level lower (never below level 1):");
    } else {
      await expect(losses).toContainText("Lost outright (still standing when the caravan fell):");
      await expect(losses).not.toContainText("Fell in the fighting");
    }
    await guideStyled(page);
    await copyIsTheRightWayRound(page);
    await atWidths(page);
    await page.screenshot({ path: `test-results/onboarding-overrun-${branch.trap ? "survivor" : "none"}.png`, fullPage: true });

    // ── raise the party from what is left ──
    await card.getByTestId("guide-raise-party").click();
    if (branch.trap) {
      await expect(page).toHaveURL(/#\/party$/);
      await expect(page.getByTestId("guide-party-raised")).toContainText("Your standing party is up: 1 unit from your roster");
    } else {
      await expect(page.getByTestId("guide-party-empty")).toBeVisible();
    }
    await page.getByTestId("guide-finish").click();
    await expect(page.locator(".guide")).toHaveCount(0);

    // ── the server agrees ──
    const auth = await login(request, username);
    const me = (await (await request.get("/api/me", { headers: auth })).json()) as { caravans: { id: string; units: { merge_level: number }[] }[] };
    expect(me.caravans[0]!.units).toHaveLength(branch.trap ? 1 : 0);
    const status = (await (await request.get(`/api/me/caravans/${me.caravans[0]!.id}/trip`, { headers: auth })).json()) as { trip: { endReason: string } };
    expect(status.trip.endReason).toBe("overrun");
    const ob = (await (await request.get("/api/me/onboarding", { headers: auth })).json()) as { onboarding: { step: string; skipped: boolean } };
    expect(ob.onboarding).toMatchObject({ step: "done", skipped: false });
  });
}
