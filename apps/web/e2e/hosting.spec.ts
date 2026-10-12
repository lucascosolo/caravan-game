/**
 * Final review S2: the built server hosts the play test as ONE process (SERVE_WEB=1). Runs only
 * under `pnpm e2e:hosting` (E2E_HOSTING=1), where the browser talks to the server directly:
 *
 *   - `/` is the client, with the security headers (CSP, nosniff, frame denial) and no-cache;
 *     its bundles are immutable-cached; the page boots under that CSP with no CSP violation
 *     (PixiJS included: the rest of the suite drives the canvas in this mode);
 *   - every API route answers under /api (health at /health too), API answers are no-store, an
 *     unknown /api path is a JSON 404, and a root path that used to be API is now the client;
 *   - the device cookie set through /api is HttpOnly, SameSite=Strict, Path=/ (Secure only under
 *     NODE_ENV=production, which apps/server/test/final-review.test.ts covers with the map rule).
 */
import { expect, test } from "@playwright/test";

test.skip(!process.env["E2E_HOSTING"], "single-process hosting only (pnpm e2e:hosting)");

test("the client is served at / with its security headers, and boots under the CSP", async ({ page, request }) => {
  const violations: string[] = [];
  page.on("console", (msg) => {
    if (/Content Security Policy|Refused to/i.test(msg.text())) violations.push(msg.text());
  });
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toMatch(/^text\/html/);
  expect(res.headers()["cache-control"]).toBe("no-cache");
  expect(res.headers()["content-security-policy"]).toContain("default-src 'self'");
  expect(res.headers()["content-security-policy"]).toContain("script-src 'self'");
  expect(res.headers()["x-content-type-options"]).toBe("nosniff");
  expect(res.headers()["x-frame-options"]).toBe("DENY");

  const html = await res.text();
  const script = /<script[^>]+src="([^"]+\.js)"/.exec(html)?.[1];
  expect(script, "the entry bundle").toBeTruthy();
  const js = await request.get(script!);
  expect(js.status()).toBe(200);
  expect(js.headers()["content-type"]).toMatch(/javascript/);
  expect(js.headers()["cache-control"]).toBe("public, max-age=31536000, immutable");
  expect((await request.get("/assets/does-not-exist.js")).status()).toBe(404);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Caravan Vaults" })).toBeVisible();
  // A deep path is the same client (the router is hash-based; the server falls back to index.html).
  await page.goto("/some/deep/link");
  await expect(page.getByRole("heading", { name: "Caravan Vaults" })).toBeVisible();
  expect(violations).toEqual([]);
});

test("the API lives under /api on the same origin; API answers are never cached", async ({ request }) => {
  expect(await (await request.get("/health")).json()).toEqual({ ok: true });
  expect(await (await request.get("/api/health")).json()).toEqual({ ok: true });
  const guest = await request.post("/api/auth/guest", { data: { region: "desert" } });
  expect(guest.status()).toBe(201);
  const cookie = guest.headers()["set-cookie"] ?? "";
  expect(cookie).toMatch(/caravan_device=/);
  expect(cookie).toMatch(/HttpOnly/);
  expect(cookie).toMatch(/SameSite=Strict/);
  expect(cookie).toMatch(/Path=\//);
  const { token } = (await guest.json()) as { token: string };
  const me = await request.get("/api/me", { headers: { Authorization: `Bearer ${token}` } });
  expect(me.status()).toBe(200);
  expect(me.headers()["cache-control"]).toBe("no-store");
  expect((await request.get("/api/me")).status()).toBe(401);
  const unknown = await request.get("/api/not-a-route");
  expect(unknown.status()).toBe(404);
  expect(await unknown.json()).toMatchObject({ statusCode: 404 });
  // /me at the root is the client, never the API.
  const rootMe = await request.get("/me", { headers: { Authorization: `Bearer ${token}` } });
  expect(rootMe.headers()["content-type"]).toMatch(/^text\/html/);
  // Clean up the guest (a guest's sign-out erases it).
  expect((await request.post("/api/auth/logout", { headers: { Authorization: `Bearer ${token}` }, data: { abandon: true } })).status()).toBe(204);
});
