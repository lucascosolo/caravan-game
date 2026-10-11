/**
 * The whole trip (chunk 23), on a 360×640 portrait screen, against the built server running
 * chunk 15's test double as the resolver (scripts/e2e.mjs sets CARAVAN_TEST_RESOLVER=double):
 *
 *   town → outfit → pack and ride out → search → choose → arrange (tap-to-place on the real
 *   canvas) → commit → resolving → results → bank-or-push (every stake on screen) → push →
 *   encounter 2 (attrition carried: the trap is spent, the fence broken, the riders hurt; the
 *   double's script kills one rider and the caravan holds) → bank-or-push shows the death's
 *   de-merge on the bank card, the overrun card and the push confirm → push → encounter 3
 *   (one rider left to post) → bank (the confirm restates the de-merge) → trip summary →
 *   town shows the trip-cap use spent. A banked three-encounter trip (PHASE-2 §23 DoD).
 *   Chunk 22: at the first results, "Watch the fight" opens the replay player (the double
 *   records no log: the not-renderable state), then once more with a recorded real-resolver
 *   body played on the canvas.
 *
 * The account is run-unique and starts in town (scripts/e2e.mjs seeds it): trips are history
 * and never reset, so a reused account could not start from town.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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

async function postRiders(page: Page, alive = 2): Promise<void> {
  const riders = page.locator('[data-testid^="tray-unit-"]');
  await expect(riders).toHaveCount(2);
  // A dead rider is listed but cannot be posted (its button is disabled): post the living.
  const living: number[] = [];
  for (let i = 0; i < 2; i++) if (await riders.nth(i).getByRole("button").isEnabled()) living.push(i);
  expect(living).toHaveLength(alive);
  const cells = [
    { x: 13, y: 13 },
    { x: 18, y: 18 },
  ].slice(0, alive);
  for (const [k, cell] of cells.entries()) {
    const i = living[k]!;
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

test("a full trip: outfit, ride out, three encounters (a rider dies at the second), bank, summary, and the trip cap spent in town", async ({ page, request }) => {
  test.setTimeout(200_000);
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
  await fitsPortrait(page);

  // ── chunk 22: Watch the fight. The e2e server resolves with chunk 15's test double, which
  // records no log: the player says so plainly (never "expired", never a blank canvas), shows
  // the server's recorded outcome, fits 360 and 320 px, and Close lands back on the results. ──
  await r1.getByTestId("watch-fight").click();
  const replay = page.getByRole("dialog", { name: "Encounter 1: the fight" });
  const noLog = replay.getByTestId("replay-not-renderable");
  await expect(noLog).toHaveAttribute("data-no-log", "true");
  await expect(noLog).toContainText("No replay was recorded for this fight");
  // QA N6: the raw reason sits under a plain sentence, inside "Technical detail".
  await replay.getByText("Technical detail").click();
  await expect(replay.getByTestId("replay-reason")).toHaveText("Reason: no replay log was recorded for this fight");
  await expect(replay.getByTestId("replay-outcome")).toHaveText("Your caravan held.");
  await expect(replay.getByTestId("replay-depth-explained")).toContainText("from the ring to the core");
  await expect(replay.getByTestId("replay-loot")).toContainText(/Loot reported for the raiding party's owner: \d+ Coin\./);
  await expect(replay.getByTestId("iso-canvas")).toHaveCount(0);
  await fitsPortrait(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await fitsPortrait(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await replay.getByTestId("replay-close").click();
  await expect(replay).toHaveCount(0);
  await expect(r1.getByTestId("result-outcome")).toHaveText("The caravan held.");

  // The same button with a REAL log: the e2e server's double has none, so the replay body the
  // server suite recorded from a real-resolver fight (src/test/contract/replay.json) is served
  // for this one request. The built client reads it with the resolver's replay reader and
  // draws it through the iso renderer on a real canvas; play at 4×, skip to the end.
  const recorded = JSON.parse(readFileSync(fileURLToPath(new URL("../src/test/contract/replay.json", import.meta.url)), "utf8")) as { body: { outcome: { kind: string } } };
  // QA N7: the player refuses a body for another fight, so the served body names the job that was asked for.
  await page.route("**/api/me/encounters/*/replay", (route) => {
    const jobId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...recorded.body, jobId, encounterIndex: 1 }) });
  });
  await r1.getByTestId("watch-fight").click();
  const real = page.getByRole("dialog", { name: "Encounter 1: the fight" });
  const player = real.getByTestId("replay-player");
  await expect(player).toBeVisible();
  await expect(real.getByTestId("iso-canvas")).toBeVisible();
  await expect(real.getByTestId("replay-summary-toggle")).toContainText("How it ended: Your caravan held.");
  // QA S2: the camera opens on the action, a lattice cell at least 32 px wide at 360 px.
  const isoZoom = () => page.evaluate(() => (window as unknown as { __isoDebug?: { zoom(): number } }).__isoDebug?.zoom() ?? 0);
  await expect.poll(isoZoom).toBeGreaterThanOrEqual(32 / 48 - 1e-6);
  // QA S9: the canvas keeps updating while the fight plays — its pixels change and the renderer's frame count rises.
  const frames = () => page.evaluate(() => (window as unknown as { __isoDebug?: { framesDrawn(): number } }).__isoDebug?.framesDrawn() ?? 0);
  const field = real.locator(".replay__field canvas");
  const shotDir = process.env["E2E_SHOT_DIR"];
  const before = await field.screenshot(shotDir ? { path: `${shotDir}/replay-360-start.png` } : {});
  const framesBefore = await frames();
  await real.getByTestId("replay-speed-4").click();
  await real.getByTestId("replay-play").click();
  await expect.poll(async () => Number(await real.getByTestId("replay-scrub").inputValue()), { timeout: 8_000 }).toBeGreaterThan(130);
  await real.getByTestId("replay-play").click();
  const after = await field.screenshot(shotDir ? { path: `${shotDir}/replay-360-mid.png` } : {});
  expect(Buffer.compare(before, after), "the canvas changed between two ticks").not.toBe(0);
  expect(await frames()).toBeGreaterThan(framesBefore + 10);
  if (shotDir) await page.screenshot({ path: `${shotDir}/replay-360-dialog.png` });
  await real.getByTestId("replay-feed-all").click();
  await expect(real.getByTestId("replay-feed")).toContainText("hit");
  const scrubBox = await real.getByTestId("replay-scrub").boundingBox();
  expect(scrubBox!.height).toBeGreaterThanOrEqual(43.5);
  await real.getByTestId("replay-to-end").click();
  // QA S1: the last frame is held about a second before the end card shows.
  await expect(real.getByTestId("replay-end-card")).toHaveAttribute("data-outcome", recorded.body.outcome.kind);
  await expect(real.getByTestId("replay-end-card")).toContainText("Your caravan held.");
  if (shotDir) await field.screenshot({ path: `${shotDir}/replay-360-end.png` });
  await real.getByTestId("replay-end-dismiss").click();
  await expect(real.getByTestId("replay-end-card")).toHaveCount(0);
  await page.setViewportSize({ width: 320, height: 640 });
  await fitsPortrait(page);
  if (shotDir) await page.screenshot({ path: `${shotDir}/replay-320-dialog.png` });
  await page.setViewportSize({ width: 360, height: 640 });
  await real.getByTestId("replay-close").click();
  await page.unroute("**/api/me/encounters/*/replay");

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
  // The double's encounter-2 script: the lowest-ref rider dies, the other takes 150; the caravan holds.
  const r2 = page.getByTestId("encounter-result-2");
  await expect(r2.getByTestId("result-outcome")).toHaveText("The caravan held.");
  await expect(r2.getByTestId("result-killed")).toContainText("Dust Rider · Level 1");
  await expect(r2.getByTestId("result-damaged")).toContainText("HP 470 → 320 of 620");

  // ── bank or push after a death the caravan survived: the de-merge on both cards ──
  await page.getByTestId("to-decision").click();
  const decide2 = page.getByTestId("bank-or-push");
  await expect(decide2).toHaveAttribute("data-encounter", "2");
  await expect(decide2.getByTestId("stake-units")).toContainText("Dead since encounter 2");
  await expect(decide2.getByTestId("stake-bank")).toContainText("Units that died lose a merge level when you bank:");
  await expect(decide2.getByTestId("stake-bank")).toContainText("Dust Rider · stays L1 (level 1 is the floor)");
  await expect(decide2.getByTestId("stake-overrun-demerged")).toContainText("Dust Rider · stays L1 (level 1 is the floor)");
  await expect(decide2.getByTestId("stake-overrun-coin-goes")).toContainText("It goes to the raiders' owner");
  await expect(decide2.getByTestId("stake-overrun-final-fight")).toBeVisible();
  await fitsPortrait(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await fitsPortrait(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await page.getByTestId("push-open").click();
  const push2 = page.getByRole("dialog", { name: "Push on to encounter 3?" });
  await expect(push2.getByTestId("push-quote")).toContainText("1 living unit stay at risk, and 1 dead unit loses a level");
  await push2.getByTestId("push-confirm").click();

  // ── encounter 3: one rider left ──
  await chooseFirstCandidate(page, 3);
  await postRiders(page, 1);
  await commit(page);
  await expect(page.getByTestId("encounter-result-3").getByTestId("result-damaged")).toContainText("HP 320 → 170 of 620");

  // ── bank → summary → town ──
  await page.getByTestId("to-decision").click();
  await expect(page.getByTestId("bank-or-push")).toHaveAttribute("data-encounter", "3");
  await page.getByTestId("bank-open").click();
  const bank = page.getByRole("dialog", { name: "Bank the trip?" });
  await expect(bank.getByTestId("bank-quote")).toContainText(/The trip ends\. \d+ Coin is banked in the town, safe for good\./);
  await expect(bank.getByTestId("bank-quote-refit")).toContainText("but 1 unit that died loses a merge level:");
  await expect(bank).not.toContainText("fully refitted");
  await expect(bank.getByTestId("bank-quote-demerged")).toContainText("Dust Rider · stays L1 (level 1 is the floor)");
  await fitsPortrait(page);
  await page.setViewportSize({ width: 320, height: 568 });
  await fitsPortrait(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await bank.getByTestId("bank-confirm").click();
  const summary = page.getByTestId("trip-summary");
  await expect(summary).toBeVisible();
  await expect(summary.getByTestId("summary-banked")).toContainText("Banked after 3 encounters. The caravan is home.");
  await expect(summary.getByTestId("summary-credited")).toContainText(/\d+ Coin banked/);
  await expect(summary.getByTestId("summary-balance")).toContainText(/Banked Coin in town is now \d+\./);
  await expect(summary.getByTestId("summary-bank-demerged")).toContainText("Dust Rider · stays L1 (level 1 is the floor)");
  for (const n of [1, 2, 3]) await expect(summary.getByTestId(`encounter-result-${n}`)).toBeVisible();
  await fitsPortrait(page);
  // The same screens at the narrowest phone width this client supports.
  await page.setViewportSize({ width: 320, height: 568 });
  await fitsPortrait(page);
  await page.setViewportSize({ width: 360, height: 640 });
  await summary.getByTestId("summary-to-town").click();

  await expect(page.getByTestId("town-screen")).toBeVisible();
  await expect(page.getByTestId("caravan-state")).toHaveAttribute("data-state", "in_town");
  await expect(page.getByTestId("trip-cap")).toContainText("Trips available: 2 of 3. The next trip returns in");

  // The server agrees: one trip-cap use for the whole three-encounter trip, banked once.
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
  expect(status.trip.encounters.map((e) => e.decision)).toEqual(["pushed", "pushed", "banked"]);
});
