import { test, expect, request as playwrightRequest } from "@playwright/test";
import { liveApiUrl, liveWebUrl } from "../urls";

/**
 * The stranger path against the DEPLOYED demo (issue 5.7): what a first-time
 * visitor with no session, no wallet and no context actually gets. Read-only —
 * this suite creates nothing and signs nothing. Link creation is exercised in
 * the local suite, where a session can be minted honestly; the seller surface
 * on the deployment requires a SEP-10 wallet login by design.
 *
 * Runs nightly and on demand (.github/workflows/e2e-live.yml) and as part of
 * `pnpm sweep`, the pre-entry ritual.
 */

test("@live /ready is green", async () => {
  const api = await playwrightRequest.newContext({ baseURL: liveApiUrl() });
  const res = await api.get("/ready");
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { ok: boolean };
  expect(body.ok).toBe(true);
  await api.dispose();
});

test("@live the landing page renders for a clean browser context", async ({ page }) => {
  const response = await page.goto(liveWebUrl());
  expect(response?.status()).toBe(200);
  // The page rendered as a page, not as Next's error boundary.
  await expect(page.locator("body")).not.toContainText(/application error|internal server error/i);
});

test("@live the demo checkout page renders — the exact stranger path", async ({ page }) => {
  const api = await playwrightRequest.newContext({ baseURL: liveApiUrl() });
  const demoRes = await api.get("/demo/link");
  expect(demoRes.ok(), await demoRes.text()).toBeTruthy();
  const demo = (await demoRes.json()) as { id: string | null };
  test.skip(!demo.id, "no seeded demo link on this deployment (run pnpm demo:seed)");

  const linkRes = await api.get(`/links/${demo.id}`);
  expect(linkRes.ok(), await linkRes.text()).toBeTruthy();
  const { link } = (await linkRes.json()) as {
    link: { status: string; reference: string; amount: string };
  };

  await page.goto(`${liveWebUrl()}/pay/${demo.id}`);
  // A stranger must land on a real checkout state: a payable QR while the
  // link is open, or the settled panel once a demo payment has landed —
  // never "not found" and never an error boundary.
  if (link.status === "active") {
    await expect(page.locator(".qr-wrap svg")).toBeVisible();
  } else {
    await expect(page.getByText(/settled to the merchant|payment received|expired|cancelled/i).first()).toBeVisible();
  }
  await expect(page.locator("body")).not.toContainText(/link not found|application error/i);

  // The public receipt — a settled demo link must produce a shareable proof.
  const settled = new Set(["paid", "offramp_pending", "offramp_settled", "offramp_failed"]);
  if (settled.has(link.status)) {
    const receipt = await page.goto(`${liveWebUrl()}/r/${link.reference}`);
    expect(receipt?.status()).toBe(200);
    await expect(page.getByText(link.amount, { exact: false }).first()).toBeVisible();
  }
  await api.dispose();
});
