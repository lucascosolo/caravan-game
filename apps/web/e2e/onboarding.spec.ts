/**
 * The first session (chunk 24, PHASE-2 §24), on a 360×640 portrait screen against the built
 * server (scripts/e2e.mjs runs chunk 15's test double as the resolver, so the outcome is the
 * double's: every encounter held, 150 HP off each post, encounter 2 kills the lowest-ref post):
 *
 *   register a fresh account (region explained as permanent) → the first screen (defense
 *   live, the raid party passive; not skippable) → the town: take a refugee (the ordinary free
 *   menu) → pack and ride out → encounter 1: search, the scout card names the smallest party,
 *   choose it, the guided arrangement (fence, gap, post, trap, rest; "now scout why"), commit
 *   → the real (double-resolved) result, honestly → push → encounter 2: a free arrangement →
 *   bank → the trip summary → "while you were out, someone else's party met a caravan": raise
 *   the standing party from the roster → finish. The server then agrees: guide done, the trip
 *   banked after two encounters, and nothing granted beyond what the trip earned.
 */
import { expect, test, type Page } from "@playwright/test";

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

/** Guardrail 0 copy, on whatever guide card is showing. */
async function guideCopyIsTheRightWayRound(page: Page): Promise<void> {
  for (const text of await page.locator(".guide, [data-testid=onboarding-welcome]").allTextContents()) {
    expect(text).not.toMatch(/\b(base|camp)\b/i);
    expect(text).not.toMatch(/\byou (attack|raid)\b/i);
  }
}

async function commit(page: Page): Promise<void> {
  await page.getByTestId("commit-open").click();
  await expect(page.getByTestId("commit-confirm")).toBeEnabled({ timeout: 15_000 });
  await page.getByRole("dialog").getByTestId("commit-confirm").click();
  await expect(page.getByTestId("encounter-results")).toBeVisible({ timeout: 20_000 });
}

test("a fresh account: register, the first screen, a refugee, the first trip guided to a bank after two encounters, then the standing party", async ({ page, request }) => {
  test.setTimeout(200_000);
  await page.setViewportSize({ width: 360, height: 640 });
  const username = `e2e_new_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const password = "e2e-password-1";

  // ── register: the region is explained as permanent before the account exists ──
  await page.goto("/");
  await page.getByRole("button", { name: "New here? Start a caravan" }).click();
  await expect(page.getByText("Permanent: chosen once for this caravan and never swapped.")).toBeVisible();
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByLabel("Region").selectOption("desert");
  await page.getByRole("button", { name: "Create account" }).click();

  // ── the first screen: before any tab, not skippable ──
  const welcome = page.getByTestId("onboarding-welcome");
  await expect(welcome).toBeVisible();
  await expect(welcome).toContainText("You play defense, live");
  await expect(welcome).toContainText("Your raid party works while you are away");
  await expect(welcome).toContainText("Your town is never raided");
  await expect(page.getByTestId("welcome-region")).toContainText("Your caravan rides the Desert.");
  await expect(page.getByTestId("welcome-region")).toContainText("permanent for this caravan");
  await expect(page.getByTestId("guide-skip")).toHaveCount(0);
  await guideCopyIsTheRightWayRound(page);
  await atWidths(page);
  await page.getByTestId("welcome-begin").click();

  // ── town: take a refugee (the ordinary free menu; nothing is granted) ──
  await expect(page.getByTestId("guide-roster")).toBeVisible();
  await expect(page.getByTestId("town-screen")).toBeVisible();
  await expect(page.getByTestId("board-count")).toContainText("0 of 36 board slots used");
  await guideCopyIsTheRightWayRound(page);
  await atWidths(page);
  const firstOffer = page.getByTestId("refugee-offers").getByRole("button", { name: /^Take / }).first();
  const typeName = (await firstOffer.textContent())!.trim().replace(/^Take /, "");
  await firstOffer.click();
  await expect(page.getByTestId("refugee-panel").getByRole("status")).toHaveText(`Taken: ${typeName} joined the roster at level 1.`);
  // The guide re-reads the server and moves on once the roster has the unit.
  await expect(page.getByTestId("guide-outfit")).toBeVisible({ timeout: 10_000 });

  // ── outfit and ride out ──
  await page.getByTestId("nav-outfit").click();
  await page.getByTestId("outfit-units").getByRole("checkbox", { name: new RegExp(typeName) }).check();
  await page.getByTestId("outfit-traps").getByRole("button", { name: "Add Spike Pit" }).click();
  await page.getByTestId("outfit-fence-tier").selectOption("fence.brush_pile");
  await page.getByTestId("outfit-ride-out").click();
  const ride = page.getByRole("dialog", { name: "Pack the caravan and ride out?" });
  await expect(ride).toContainText("1 living unit");
  await ride.getByTestId("outfit-confirm").click();

  // ── encounter 1: search, scout, choose the smallest party ──
  await expect(page.getByTestId("trail-unsearched")).toHaveAttribute("data-encounter", "1");
  await expect(page.getByTestId("guide-search")).toBeVisible();
  await page.getByTestId("search").click();
  await expect(page.getByTestId("candidate-list")).toBeVisible();
  const scoutCard = page.getByTestId("guide-scout");
  await expect(scoutCard).toContainText("Scout before you choose");
  await expect(page.getByTestId("guide-scout-pick")).toContainText("That is a reading of the scout, not a promise.");
  const pick = await page.getByTestId("guide-scout-pick").getAttribute("data-index");
  await guideCopyIsTheRightWayRound(page);
  await atWidths(page);
  await page.getByTestId(`choose-${pick}`).click();

  // ── the guided arrangement ──
  await expect(page.getByTestId("formation-screen")).toBeVisible({ timeout: 15_000 });
  const arrange = page.getByTestId("guide-arrange");
  await expect(arrange).toBeVisible();
  await page.getByTestId("guide-do-fence").click();
  await expect(page.getByTestId("guide-step-fence")).toHaveAttribute("data-done", "true");
  await expect(page.getByTestId("guide-step-gap")).toHaveAttribute("data-done", "true");
  await page.getByTestId("guide-do-post").click();
  await expect(page.getByTestId("guide-step-post")).toHaveAttribute("data-done", "true");
  await page.getByTestId("guide-do-trap").click();
  await expect(page.getByTestId("guide-step-trap")).toHaveAttribute("data-done", "true");
  await page.getByTestId("guide-do-rest").click();
  await expect(page.getByTestId("budget-meter")).toContainText("20 of 20 segments placed");
  await expect(page.getByTestId("guide-why")).toContainText("one way through");
  await expect(arrange).toContainText("does not guarantee a hold");
  await guideCopyIsTheRightWayRound(page);
  await atWidths(page);
  await commit(page);

  // ── the result, as the server recorded it (the double holds), then push ──
  const r1 = page.getByTestId("encounter-result-1");
  await expect(r1.getByTestId("result-outcome")).toHaveText("The caravan held.");
  await expect(page.getByTestId("guide-result")).toContainText("Your caravan held");
  await expect(page.getByTestId("guide-result")).toContainText("This first trip pushes once, then banks");
  await page.getByTestId("to-decision").click();
  await expect(page.getByTestId("bank-or-push")).toBeVisible();
  await expect(page.getByTestId("guide-result")).toContainText("Bank or push");
  await expect(page.getByTestId("bank-or-push").getByTestId("stake-unbanked")).toBeVisible();
  await atWidths(page);
  await page.getByTestId("push-open").click();
  await page.getByRole("dialog", { name: "Push on to encounter 2?" }).getByTestId("push-confirm").click();

  // ── encounter 2: a free arrangement ──
  await expect(page.getByTestId("trail-unsearched")).toHaveAttribute("data-encounter", "2");
  await expect(page.getByTestId("guide-free")).toBeVisible();
  await page.getByTestId("search").click();
  await page.getByTestId("choose-0").click();
  await expect(page.getByTestId("formation-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("guide-free")).toBeVisible();
  await expect(page.getByTestId("guide-arrange")).toHaveCount(0);
  // Post the unit by hand, through the DOM placement picker.
  const unit = page.locator('[data-testid^="tray-unit-"]').first();
  await unit.getByRole("button").click();
  const picker = page.getByTestId("placement-picker");
  await picker.getByRole("combobox").selectOption({ label: "(15, 13)" });
  await picker.getByRole("button", { name: "Place here" }).click();
  await expect(unit).toContainText("Posted at (15, 13)");
  await page.getByRole("region", { name: "Selected" }).getByRole("button", { name: "Done" }).click();
  await commit(page);

  // ── bank ──
  await expect(page.getByTestId("encounter-result-2").getByTestId("result-outcome")).toHaveText("The caravan held.");
  await expect(page.getByTestId("guide-result")).toContainText("That ends the first trip.");
  await page.getByTestId("to-decision").click();
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
  await guideCopyIsTheRightWayRound(page);
  await atWidths(page);
  await party.getByTestId("guide-raise-party").click();
  await expect(page).toHaveURL(/#\/party$/);
  await expect(page.getByTestId("guide-party-raised")).toContainText("Your standing party is up: 1 unit from your roster");
  await expect(page.getByTestId("guide-party")).toContainText("This is your passive side.");
  await atWidths(page);
  await page.getByTestId("guide-finish").click();
  await expect(page.locator(".guide")).toHaveCount(0);

  // ── the server agrees, and nothing was granted beyond the trip's own earnings ──
  const login = await request.post("/api/auth/login", { data: { username, password } });
  const { token } = (await login.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };
  const ob = (await (await request.get("/api/me/onboarding", { headers: auth })).json()) as { onboarding: { step: string; skipped: boolean } };
  expect(ob.onboarding).toMatchObject({ step: "done", skipped: false });
  const me = (await (await request.get("/api/me", { headers: auth })).json()) as { account: { coinBalance: number }; caravans: { id: string; units: unknown[] }[] };
  expect(me.caravans[0]!.units).toHaveLength(1);
  // The account's own ledger: the trip's events and the refugee claim, and no purchase of any kind.
  const ledger = (await (await request.get("/api/me/ledger?limit=200", { headers: auth })).json()) as { events: { type: string }[] };
  const types = ledger.events.map((e) => e.type);
  console.log(`onboarding e2e: ledger event types: ${[...new Set(types)].join(", ")}`);
  expect(types.length).toBeGreaterThan(0);
  expect(types).not.toContain("coin_purchased");
  const status = (await (await request.get(`/api/me/caravans/${me.caravans[0]!.id}/trip`, { headers: auth })).json()) as { trip: { endReason: string; encounters: { decision: string | null }[] } };
  expect(status.trip.endReason).toBe("banked");
  expect(status.trip.encounters.map((e) => e.decision)).toEqual(["pushed", "banked"]);
  const saved = (await (await request.get("/api/me/party", { headers: auth })).json()) as { party: { valid: boolean; config: { units: unknown[] } } };
  expect(saved.party.config.units).toHaveLength(1);
  expect(saved.party.valid).toBe(true);
  // A reload reads the same server row: the guide stays finished (no browser storage involved).
  // Chunk 30: a reload stays signed in (the server's HttpOnly device cookie); no second sign-in.
  await page.reload();
  await expect(page.getByTestId("party-screen").or(page.getByTestId("town-screen"))).toBeVisible();
  await expect(page.locator(".guide, [data-testid=onboarding-welcome]")).toHaveCount(0);
});
