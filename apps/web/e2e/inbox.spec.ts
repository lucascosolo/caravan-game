/**
 * Chunk 29 e2e: the inbox against the real built server. A fresh account's standing party is
 * recorded as having struck two caravans (fixture: two `party_served_as_encounter` ledger
 * events in the shape chunk 13's handler writes, inserted as the server's own DB role, exactly
 * as smoke.spec grants unlock points), and the owner learns it from the shell's badge:
 *
 *   two strikes in one hour are ONE batch, so the badge reads 1 → the Inbox says what happened,
 *   where and what it earned, never an account id → "Watch the fight" opens the replay player over the
 *   inbox (the fixture's job has no stored fight, so the player says so) → the batch is read
 *   on the server and the badge is gone → the screen fits 320 px with 44 px targets, even with a
 *   40-character caravan name that has no space to break at (QA S3) → opting
 *   out of strikes empties the list and opting in brings it back.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import pg from "pg";

const DATABASE_URL = process.env["E2E_DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];

interface Fresh {
  username: string;
  password: string;
  accountId: string;
  caravanId: string;
  token: string;
}

async function register(request: APIRequestContext, caravanName: string): Promise<Fresh> {
  const username = `e2e_ib_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const password = "e2e-password-1";
  const res = await request.post("/api/auth/register", { data: { username, password, region: "desert", caravanName } });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { token: string; account: { id: string }; caravan: { id: string } };
  // A fresh account opens on the first-session guide (chunk 24); skip it through the real routes
  // as the other specs do (onboarding.spec walks it).
  const auth = { Authorization: `Bearer ${body.token}` };
  expect((await request.post("/api/me/onboarding/advance", { headers: auth, data: { step: "roster" } })).status()).toBe(200);
  expect((await request.post("/api/me/onboarding/skip", { headers: auth })).status()).toBe(200);
  return { username, password, accountId: body.account.id, caravanId: body.caravan.id, token: body.token };
}

async function recordStrikes(owner: Fresh, defender: Fresh): Promise<void> {
  if (!DATABASE_URL) throw new Error("the inbox e2e needs E2E_DATABASE_URL (or TEST_DATABASE_URL / DATABASE_URL)");
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    for (const [i, kind] of (["caravan_held", "caravan_overrun"] as const).entries()) {
      await client.query(
        `INSERT INTO ledger_event (event_type, account_id, caravan_id, causation_id, causation_seq, resolver_version, payload)
         VALUES ('party_served_as_encounter', $1, NULL, $2, 0, 1, $3::jsonb)`,
        [
          owner.accountId,
          `e2e:inbox:${owner.accountId}:${i}`,
          JSON.stringify({ jobId: `e2e-inbox-${owner.accountId}-${i}`, tripId: null, encounterIndex: i + 1, defenderAccountId: defender.accountId, defenderCaravanId: defender.caravanId, outcome: { kind } }),
        ],
      );
    }
  } finally {
    await client.end();
  }
}

async function signIn(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
}

async function fitsPortrait(page: Page): Promise<void> {
  const r = await page.evaluate(() => {
    const doc = document.scrollingElement ?? document.documentElement;
    const controls = [...document.querySelectorAll<HTMLElement>("button, select, summary, a[href], input[type=checkbox]")];
    const small = controls
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

/** Chunk 29 QA S3: the longest valid caravan name (CARAVAN_NAME_MAX = 40) with no space to break at. */
const LONG_NAME = "W".repeat(40);

test("a party owner learns of their strikes from the badge, reads them, and watches one", async ({ page, request }) => {
  const owner = await register(request, "Owner Wagons");
  const defender = await register(request, LONG_NAME);
  await recordStrikes(owner, defender);

  await page.setViewportSize({ width: 360, height: 640 });
  await signIn(page, owner.username, owner.password);
  const button = page.getByTestId("inbox-button");
  await expect(page.getByTestId("inbox-badge")).toHaveText("1");
  await expect(button).toHaveAccessibleName("Inbox, 1 unread");

  await button.click();
  const card = page.getByTestId("inbox-item-party_strike");
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute("data-unread", "true");
  await expect(card).toContainText("Your party struck 2 caravans");
  await expect(card).toContainText("1 overrun by your party · 1 held out");
  await expect(card).toContainText(`vs ${defender.username} (${LONG_NAME}), encounter 2 of their trip`);
  await expect(card).toContainText("Your party overran the caravan.");
  await expect(card).toContainText("The caravan held; your party was driven off.");
  const text = (await page.getByTestId("inbox-screen").textContent()) ?? "";
  expect(text).not.toContain(defender.accountId);

  await fitsPortrait(page);
  await page.setViewportSize({ width: 320, height: 640 });
  await fitsPortrait(page);

  // One tap: the replay player opens over the inbox, and the batch is read on the server.
  await card.getByRole("button", { name: "Watch the fight" }).first().click();
  const dialog = page.getByTestId("replay-dialog");
  await expect(dialog).toBeVisible();
  await page.getByTestId("replay-close").click();
  await expect(dialog).toHaveCount(0);
  await expect(card).toHaveAttribute("data-unread", "false");
  await expect(page.getByTestId("inbox-badge")).toHaveCount(0);
  const unread = await request.get("/api/me/inbox/unread", { headers: { Authorization: `Bearer ${owner.token}` } });
  expect(await unread.json()).toEqual({ unreadCount: 0 });

  // Per-category opt-out, on the server.
  await page.getByText("What to show here").click();
  await page.getByTestId("inbox-pref-party_strike").click();
  await expect(page.getByTestId("inbox-pref-party_strike")).not.toBeChecked();
  await expect(page.getByTestId("inbox-empty")).toBeVisible();
  await page.getByTestId("inbox-pref-party_strike").click();
  await expect(page.getByTestId("inbox-pref-party_strike")).toBeChecked();
  await expect(page.getByTestId("inbox-item-party_strike")).toBeVisible();
  await fitsPortrait(page);
});
