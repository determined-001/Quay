import { test, expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { LOCAL_API_URL } from "../urls";

/**
 * The whole payment loop against the locally-composed stack (issue 5.7):
 * API + web + in-memory DB, watcher disabled, mock off-ramp.
 *
 *   create link → open checkout → simulate payment → assert paid
 *   → cash out (mock adapter) → assert offramp_settled → receipt renders
 *
 * The buyer-facing surfaces (checkout page, receipt page) are driven in a
 * real browser — they are public and need no session. The seller actions
 * (create, cash out) go through the API with a session minted by
 * /__test__/session, because the dashboard's SessionGate is a live SEP-10
 * wallet flow: there is no wallet extension in a headless browser, and
 * unlocking the routes for tests would be worse than being honest that this
 * suite authenticates out-of-band. The payment itself is injected by
 * /__test__/pay at the watcher's applyMatch boundary — see the disclosure in
 * apps/api/src/routes/test-only.ts for exactly what that does and does not
 * verify.
 */

let api: APIRequestContext;
let seller: APIRequestContext;

test.beforeAll(async () => {
  api = await playwrightRequest.newContext({ baseURL: LOCAL_API_URL });
  const minted = await api.post("/__test__/session", { data: {} });
  expect(minted.ok(), "e2e session minting must succeed (is E2E_TEST_MODE=1 set?)").toBeTruthy();
  const { token } = (await minted.json()) as { token: string };
  seller = await playwrightRequest.newContext({
    baseURL: LOCAL_API_URL,
    extraHTTPHeaders: { authorization: `Bearer ${token}` },
  });
});

test.afterAll(async () => {
  await api?.dispose();
  await seller?.dispose();
});

test("create link → pay → paid → cash out → offramp_settled → receipt", async ({ page }) => {
  // 1. Create a link as the authenticated seller.
  const created = await seller.post("/links", {
    data: { title: "E2E test order", amount: "12.75", assetCode: "USDC" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { link } = (await created.json()) as {
    link: { id: string; reference: string; status: string };
  };
  expect(link.status).toBe("active");

  // 2. The buyer's checkout page renders a payable QR for the right amount.
  await page.goto(`/pay/${link.id}`);
  await expect(page.locator(".qr-wrap svg")).toBeVisible();
  await expect(page.getByText("12.75", { exact: false }).first()).toBeVisible();

  // 3. Simulate the on-chain payment (the watcher's applyMatch boundary).
  const paid = await api.post("/__test__/pay", { data: { linkId: link.id } });
  expect(paid.ok(), await paid.text()).toBeTruthy();
  const payResult = (await paid.json()) as { outcome: string; becamePaid: boolean };
  expect(payResult.outcome).toBe("paid");
  expect(payResult.becamePaid).toBe(true);

  // 4. The checkout page the buyer is still looking at flips to settled on
  //    its own poll — no reload. This is the buyer's whole experience of
  //    "it worked", so it is asserted in the browser, not against the API.
  await expect(page.getByText(/settled to the merchant/i)).toBeVisible({ timeout: 20_000 });

  // 5. Seller-initiated cash-out through the mock adapter.
  const cashOut = await seller.post(`/links/${link.id}/cash-out`, {
    data: { targetCurrency: "NGN", payoutFields: {} },
  });
  expect(cashOut.ok(), await cashOut.text()).toBeTruthy();

  // 6. The mock anchor settles ~8s after initiation and the poller advances
  //    the link — offramp_settled is the loop's terminal state.
  await expect
    .poll(
      async () => {
        const res = await api.get(`/links/${link.id}`);
        const body = (await res.json()) as { link: { status: string } };
        return body.link.status;
      },
      { timeout: 30_000, message: "link should reach offramp_settled via the cash-out poller" },
    )
    .toBe("offramp_settled");

  // 7. The public receipt — the buyer's proof, no auth — renders the payment.
  await page.goto(`/r/${link.reference}`);
  await expect(page.getByText("12.75", { exact: false }).first()).toBeVisible();
});

test("underpayment is not marked paid", async ({ page }) => {
  const created = await seller.post("/links", {
    data: { title: "E2E underpay", amount: "25", assetCode: "USDC" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { link } = (await created.json()) as { link: { id: string } };

  const paid = await api.post("/__test__/pay", { data: { linkId: link.id, amount: "10" } });
  const payResult = (await paid.json()) as { outcome: string; becamePaid: boolean };
  expect(payResult.outcome).toBe("underpaid");
  expect(payResult.becamePaid).toBe(false);

  // The buyer sees the underpaid state, not a false success.
  await page.goto(`/pay/${link.id}`);
  await expect(page.getByText(/settled to the merchant/i)).not.toBeVisible();
});
