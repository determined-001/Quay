import { test, expect } from "@playwright/test";

/**
 * Against the real deployed URLs (issue 5.7, point 2) - the exact "stranger"
 * path `MAINTAINER.md` says a manual pre-entry sweep exists to catch: can
 * someone who is not us actually use this? Run nightly/on-demand
 * (.github/workflows/e2e-live.yml) and via `pnpm sweep` - never on every PR,
 * since it depends on and mutates the live deployment.
 *
 * Like the existing scripts/uptime-check.mjs synthetic check, this leaves a
 * tiny throwaway link behind on every successful run - proving the public
 * write path works, not cleanliness. Same known trade-off, same reason
 * (pruning a demo-scale DB isn't worth the complexity here).
 */

const LIVE_API_URL = process.env.LIVE_API_URL ?? "https://quay-api.onrender.com";

test("/ready is green", async ({ request }) => {
  const res = await request.get(`${LIVE_API_URL}/ready`);
  expect(res.ok()).toBeTruthy();
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
});

test("a stranger can create a link and see a checkout page with a QR code", async ({ page }) => {
  await page.goto("/");

  const title = `live e2e ${Date.now()}`;
  await page.locator("#title").fill(title);
  await page.locator("#amount").fill("0.0000001");
  await page.locator("#asset").selectOption("XLM"); // no issuer config needed, smallest possible footprint

  const [createResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().endsWith("/links") && res.request().method() === "POST"),
    page.getByRole("button", { name: "Create link" }).click(),
  ]);
  expect(createResponse.ok()).toBeTruthy();
  const created = (await createResponse.json()) as { link: { id: string } };

  await page.goto(`/pay/${created.link.id}`);
  await expect(page.getByText("Waiting for payment")).toBeVisible();
  await expect(page.locator(".qr-wrap svg")).toBeVisible();
});
