/**
 * The whole trip (chunk 23), on a 360×640 portrait screen, against the built server running
 * chunk 15's test double as the resolver (scripts/e2e.mjs sets CARAVAN_TEST_RESOLVER=double):
 *
 *   town → outfit → pack and ride out → search → choose → arrange (tap-to-place on the real
 *   canvas) → commit → resolving → results → bank-or-push (every stake on screen) → push →
 *   encounter 2 (attrition carried: the trap is spent, the fence broken, the riders hurt) →
 *   commit → results → bank → trip summary → town shows the trip-cap use spent.
 *
 * The account is run-unique and starts in town (scripts/e2e.mjs seeds it): trips are history
 * and never reset, so a reused account could not start from town.
 */
import { expect, test, type Page } from "@playwright/test";

const USERNAME = process.env["E2E_TRIP_USERNAME"] ?? "dev";
const PASSWORD = process.env["E2E_TRIP_PASSWORD"] ?? "devpassword";

type IsoDebug = { cellToClient(c: { x: number; y: number }): { x: number; y: number } | null };

async function tapCell(page: Page, cell: { x: number; y: number }): Promise<void> {
  const p = await page.evaluate((c) => (window as unknown as { __isoDebug?: IsoDebug }).__isoDebug?.cellToClient(c), cell);
  if (!p) throw new Error("iso debug hook missing");
  await page.mouse.click(p.x, p.y);
}

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

async function chooseFirstCandidate(page: Page, n: number): Promise<void> {
  await expect(page.getByTestId("trail-unsearched")).toHaveAttribute("data-encounter", String(n));
  await page.getByTestId("search").click();
  await expect(page.getByTestId("candidate-list")).toBeVisible();
  await page.getByTestId("choose-0").click();
  await expect(page.getByTestId("formation-screen")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: `Encounter ${n}` })).toBeVisible();
  await page.waitForFunction(() => !!(window as unknown as { __isoDebug?: IsoDebug }).__isoDebug?.cellToClient({ x: 13, y: 13 }));
}

async function postRiders(page: Page): Promise<void> {
  const riders = page.locator('[data-testid^="tray-unit-"]');
  await expect(riders).toHaveCount(2);
  const cells = [
    { x: 13, y: 13 },
    { x: 18, y: 18 },
  ];
  for (const [i, cell] of cells.entries()) {
    await riders.nth(i).getByRole("button").click();
    // Posted through the DOM placement picker (chunk 08 QA D3): the same drop the canvas makes.
    const picker = page.getByTestId("placement-picker");
    await picker.getByRole("combobox").selectOption({ label: `(${cell.x}, ${cell.y})` });
    await picker.getByRole("button", { name: "Place here" }).click();
    await expect(riders.nth(i)).toContainText(`Posted at (${cell.x}, ${cell.y})`);
    await page.getByRole("region", { name: "Selected" }).getByRole("button", { name: "Done" }).click();
  }
}

async function commit(page: Page): Promise<void> {
  await page.getByTestId("commit-open").click();
  const dialog = page.getByRole("dialog");
  await expect(page.getByTestId("commit-confirm")).toBeEnabled({ timeout: 15_000 });
  await dialog.getByTestId("commit-confirm").click();
  // The fight resolves on the server; the screen waits on it, then shows the result.
  await expect(page.getByTestId("encounter-results")).toBeVisible({ timeout: 20_000 });
}

test("a full trip: outfit, ride out, two encounters with a push between, bank, summary, and the trip cap spent in town", async ({ page, request }) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.goto("/");
  await page.getByLabel("Username").fill(USERNAME);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("town-screen")).toBeVisible();
  await expect(page.getByTestId("caravan-state")).toHaveAttribute("data-state", "in_town");
  await expect(page.getByTestId("trip-cap")).toContainText("Trips available: 3 of 3.");

  // ── outfit and ride out ──
  await page.getByTestId("nav-outfit").click();
  await expect(page.getByTestId("outfit-screen")).toBeVisible();
  const riders = page.getByTestId("outfit-units").getByRole("checkbox", { name: /Dust Rider/ });
  await riders.nth(0).check();
  await riders.nth(1).check();
  await page.getByTestId("outfit-traps").getByRole("button", { name: "Add Spike Pit" }).click();
  await page.getByTestId("outfit-fence-tier").selectOption("fence.brush_pile");
  await expect(page.getByTestId("trip-cap")).toContainText("Trips available: 3 of 3.");
  await fitsPortrait(page);
  await page.getByTestId("outfit-ride-out").click();
  const ride = page.getByRole("dialog", { name: "Pack the caravan and ride out?" });
  await expect(ride).toContainText("2 living units");
  await expect(ride).toContainText("Riding out uses 1 of your 3 available trips (of 3).");
  await ride.getByTestId("outfit-confirm").click();

  // ── encounter 1: search, choose, arrange (fence, trap, two posts), commit ──
  await chooseFirstCandidate(page, 1);
  await page.getByTestId("tray-fence-next").getByRole("button").click();
  await tapCell(page, { x: 12, y: 11 });
  await expect(page.getByTestId("budget-meter")).toContainText("1 of 20 segments placed");
  // The placed segment stays selected (to move it); "Done" lets go before the next item.
  await page.getByRole("region", { name: "Selected" }).getByRole("button", { name: "Done" }).click();
  await postRiders(page);
  await page.getByTestId("tray-trap-t0").getByRole("button").click();
  // The trap goes down through the picker too: the first legal cell it lists.
  const picker = page.getByTestId("placement-picker");
  await picker.getByRole("combobox").selectOption({ index: 1 });
  await picker.getByRole("button", { name: "Place here" }).click();
  await expect(page.getByTestId("tray-trap-t0")).toContainText(/Laid at \(\d+, \d+\)/);
  await page.getByRole("region", { name: "Selected" }).getByRole("button", { name: "Done" }).click();
  await commit(page);

  // ── results: what the fight cost, from the server ──
  const r1 = page.getByTestId("encounter-result-1");
  await expect(r1.getByTestId("result-outcome")).toHaveText("The caravan held.");
  await expect(r1.getByTestId("result-coin")).toContainText(/^\+\d+ Coin this encounter, carried unbanked\.$/);
  await expect(r1.getByTestId("result-damaged")).toContainText("Dust Rider · Level 1 · HP 620 → 470 of 620");
  await expect(r1.getByTestId("result-traps")).toContainText("Spike Pit");
  await expect(r1.getByTestId("result-fences")).toContainText("Brush Pile #1");
  await expect(r1.getByTestId("watch-fight")).toBeDisabled();
  await expect(r1.getByTestId("watch-fight")).toContainText("replay coming");
  await fitsPortrait(page);

  // ── bank or push: every stake on screen, then push ──
  await page.getByTestId("to-decision").click();
  const decide = page.getByTestId("bank-or-push");
  await expect(decide).toBeVisible();
  await expect(decide.getByTestId("stake-unbanked")).toContainText(/\d+ Coin carried on the trail, not yet banked\./);
  await expect(decide.getByTestId("stake-bank")).toContainText(/Coin for the delivery = \d+ Coin\./);
  await expect(decide.getByTestId("stake-bank-forecast")).toBeVisible();
  await expect(decide.getByTestId("stake-units")).toContainText("Alive · HP 470 of 620 (150 damage carried, not repaired)");
  await expect(decide.getByTestId("stake-units")).toContainText("If it dies: stays at level 1 (level 1 is the floor)");
  await expect(decide.getByTestId("stake-overrun")).toContainText(/Lose all \d+ unbanked Coin\./);
  await expect(decide.getByTestId("stake-traps")).toContainText("0 still armed");
  await expect(decide.getByTestId("stake-traps")).toContainText("1 spent, not re-armed: Spike Pit");
  await expect(decide.getByTestId("stake-fences")).toContainText("1 destroyed, not rebuilt");
  await expect(decide.getByTestId("stake-next")).toContainText("Encounter 2 if you push");
  await expect(decide.getByTestId("stake-next-difficulty")).toContainText("Harder:");
  expect(await page.locator("body").textContent()).not.toMatch(/\b(buy|purchase|pay)\b/i);
  await fitsPortrait(page);
  await page.getByTestId("push-open").click();
  const push = page.getByRole("dialog", { name: "Push on to encounter 2?" });
  await expect(push.getByTestId("push-quote")).toContainText("2 living units stay at risk");
  await push.getByTestId("push-confirm").click();

  // ── encounter 2: attrition carried forward ──
  await chooseFirstCandidate(page, 2);
  await expect(page.getByTestId("tray-trap-t0")).toContainText(/[Ss]pent/);
  await expect(page.getByTestId("fence-tray-line")).toContainText("1 destroyed");
  await postRiders(page);
  await commit(page);
  await expect(page.getByTestId("encounter-result-2").getByTestId("result-damaged")).toContainText("HP 470 → 320 of 620");

  // ── bank → summary → town ──
  await page.getByTestId("to-decision").click();
  await expect(page.getByTestId("bank-or-push")).toHaveAttribute("data-encounter", "2");
  await page.getByTestId("bank-open").click();
  const bank = page.getByRole("dialog", { name: "Bank the trip?" });
  await expect(bank.getByTestId("bank-quote")).toContainText(/The trip ends\. \d+ Coin is banked in the town, safe for good\./);
  await bank.getByTestId("bank-confirm").click();
  const summary = page.getByTestId("trip-summary");
  await expect(summary).toBeVisible();
  await expect(summary.getByTestId("summary-banked")).toContainText("Banked after 2 encounters. The caravan is home.");
  await expect(summary.getByTestId("summary-credited")).toContainText(/\d+ Coin banked/);
  await expect(summary.getByTestId("summary-balance")).toContainText(/Banked Coin in town is now \d+\./);
  await expect(summary.getByTestId("encounter-result-1")).toBeVisible();
  await expect(summary.getByTestId("encounter-result-2")).toBeVisible();
  await fitsPortrait(page);
  await summary.getByTestId("summary-to-town").click();

  await expect(page.getByTestId("town-screen")).toBeVisible();
  await expect(page.getByTestId("caravan-state")).toHaveAttribute("data-state", "in_town");
  await expect(page.getByTestId("trip-cap")).toContainText("Trips available: 2 of 3. The next trip returns in");

  // The server agrees: one trip-cap use for the whole two-encounter trip, banked once.
  const login = await request.post("/api/auth/login", { data: { username: USERNAME, password: PASSWORD } });
  const { token } = (await login.json()) as { token: string };
  const auth = { Authorization: `Bearer ${token}` };
  const me = (await (await request.get("/api/me", { headers: auth })).json()) as { caravans: { id: string }[] };
  const status = (await (await request.get(`/api/me/caravans/${me.caravans[0]!.id}/trip`, { headers: auth })).json()) as {
    cap: { available: number };
    trip: { phase: string; endReason: string; encounters: { decision: string | null }[] };
  };
  expect(status.cap.available).toBe(2);
  expect(status.trip.phase).toBe("ended");
  expect(status.trip.endReason).toBe("banked");
  expect(status.trip.encounters.map((e) => e.decision)).toEqual(["pushed", "banked"]);
});
