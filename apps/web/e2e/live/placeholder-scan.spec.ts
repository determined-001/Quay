import { test, expect } from "@playwright/test";

/**
 * Fails on placeholder strings in the *rendered* production HTML (issue 5.7,
 * point 3) - a real browser render, not a raw HTTP fetch, since the point is
 * catching what a stranger's browser would actually show, including
 * anything client-rendered after hydration.
 *
 * The exact strings named in the issue: "Demo Seller", "example.com",
 * "localhost:8787", "TODO", "lorem". Case-insensitive - a stray "Lorem
 * ipsum" or "todo:" is just as much a regression as an exact-case match.
 */

const FORBIDDEN = ["Demo Seller", "example.com", "localhost:8787", "TODO", "lorem"];

async function assertNoPlaceholders(html: string, pageLabel: string): Promise<void> {
  for (const needle of FORBIDDEN) {
    const found = html.toLowerCase().includes(needle.toLowerCase());
    expect(found, `${pageLabel} rendered HTML contains placeholder string "${needle}"`).toBe(false);
  }
}

test("dashboard has no placeholder strings in its rendered HTML", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await assertNoPlaceholders(await page.content(), "dashboard (/)");
});

test("a checkout 'not found' page has no placeholder strings in its rendered HTML", async ({ page }) => {
  await page.goto("/pay/e2e-placeholder-scan-nonexistent-id");
  await page.waitForLoadState("networkidle");
  await expect(page.getByText("Payment link not found")).toBeVisible();
  await assertNoPlaceholders(await page.content(), "checkout not-found (/pay/:id)");
});
