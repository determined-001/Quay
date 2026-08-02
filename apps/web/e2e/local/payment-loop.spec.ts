import { test, expect } from "@playwright/test";

/**
 * Full payment loop against the locally-composed stack (issue 5.7, point 1):
 * create link -> open checkout -> simulate payment -> assert paid -> cash out
 * (mock adapter) -> assert offramp_settled.
 *
 * "Simulate payment" calls the API's test-only route
 * (apps/api/src/routes/test-only.ts, mounted only under E2E_TEST_MODE=1)
 * rather than waiting for a real on-chain payment - this suite runs with no
 * network access, so there is no live Stellar ledger to pay against. See
 * that route's own doc comment for exactly what it does and doesn't verify.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8887";

test("create link, pay it, and cash out", async ({ page, request }) => {
  await page.goto("/");

  const title = `E2E payment loop ${Date.now()}`;

  await page.locator("#title").fill(title);
  await page.locator("#amount").fill("5");
  // Leave #asset at its default (USDC).

  const [createResponse] = await Promise.all([
    page.waitForResponse((res) => res.url().endsWith("/links") && res.request().method() === "POST"),
    page.getByRole("button", { name: "Create link" }).click(),
  ]);
  expect(createResponse.ok()).toBeTruthy();
  const created = (await createResponse.json()) as { link: { id: string; title: string } };
  expect(created.link.title).toBe(title);
  const linkId = created.link.id;

  const row = page.getByRole("row", { name: new RegExp(title) });
  await expect(row).toBeVisible();

  // ── Checkout page (the buyer's view) ─────────────────────────────────────
  await page.goto(`/pay/${linkId}`);
  await expect(page.getByText("Waiting for payment")).toBeVisible();
  // The SEP-7 QR code itself - a real rendered <svg>, not a placeholder image.
  await expect(page.locator(".qr-wrap svg")).toBeVisible();
  // The memo the buyer's wallet must send - present and non-empty.
  await expect(page.locator(".memo-note .v").first()).not.toHaveText("");

  // ── Simulate the on-chain payment landing ────────────────────────────────
  const simResponse = await request.post(`${API_URL}/__test__/simulate-payment`, {
    data: { linkId },
  });
  expect(simResponse.ok()).toBeTruthy();
  const simBody = (await simResponse.json()) as { becamePaid: boolean };
  expect(simBody.becamePaid).toBe(true);

  // Checkout page polls every ~4s (CheckoutClient.tsx) and should flip to paid.
  await expect(page.getByText("Payment received")).toBeVisible({ timeout: 10_000 });

  // ── Cash out from the dashboard ──────────────────────────────────────────
  await page.goto("/");
  const paidRow = page.getByRole("row", { name: new RegExp(title) });
  await expect(paidRow.getByText(/^paid$/)).toBeVisible();

  await paidRow.getByRole("button", { name: /Cash out/ }).click();

  // MockAnchorOffRamp settles after OFFRAMP_MOCK_SETTLE_MS (500ms in this
  // config, vs. its 8s production default) via the cash-out poller, which
  // keeps running even in E2E_TEST_MODE (see container.ts) since it's local,
  // in-memory timer-driven - no network involved.
  await expect(paidRow.getByText(/off-ramp settled/)).toBeVisible({ timeout: 10_000 });
});
