import { test, expect, request as playwrightRequest, type APIRequestContext } from "@playwright/test";
import { LOCAL_API_URL } from "../urls";

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

test("create draft with 2 line items → edit → issue (INV-0001) → pay → paid → receipt", async ({ page }) => {
  // 1. Create a draft with two line items
  const created = await seller.post("/invoices", {
    data: {
      clientName: "Acme Client",
      clientEmail: "client@example.com",
      lineItems: [
        { description: "Item 1", quantity: 2, unitPrice: "25.00" },
        { description: "Item 2", quantity: 1, unitPrice: "50.00" },
      ],
      assetCode: "USDC",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { invoice: draft } = (await created.json()) as { invoice: any };
  expect(draft.status).toBe("draft");
  expect(draft.total).toBe("100.00");
  expect(draft.number).toBeNull();

  // 2. Edit draft (update line items to new quantity)
  const edited = await seller.patch(`/invoices/${draft.id}`, {
    data: {
      lineItems: [
        { description: "Item 1", quantity: 3, unitPrice: "25.00" },
        { description: "Item 2", quantity: 1, unitPrice: "50.00" },
      ],
    },
  });
  expect(edited.ok(), await edited.text()).toBeTruthy();
  const { invoice: patched } = (await edited.json()) as { invoice: any };
  expect(patched.total).toBe("125.00");

  // 3. Issue the invoice -> allocated number is INV-0001
  const issued = await seller.post(`/invoices/${draft.id}/issue`);
  expect(issued.ok(), await issued.text()).toBeTruthy();
  const { invoice: openInvoice } = (await issued.json()) as { invoice: any };
  expect(openInvoice.number).toBe("INV-0001");
  expect(openInvoice.status).toBe("open");
  expect(openInvoice.linkId).toBeTruthy();

  // 4. Public /invoice/<id> page shows the invoice and payable checkout
  await page.goto(`/invoice/${openInvoice.id}`);
  await expect(page.locator("h1.invoice-number")).toHaveText("INV-0001");
  await expect(page.getByText("125.00 USDC", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("Acme Client")).toBeVisible();
  await expect(page.locator(".qr-wrap svg")).toBeVisible();

  // 5. Pay it using synthetic payment against underlying linkId
  const paid = await api.post("/__test__/pay", { data: { linkId: openInvoice.linkId } });
  expect(paid.ok(), await paid.text()).toBeTruthy();

  // 6. Flips to Paid on checkout/invoice page and links to receipt
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/View receipt/i)).toBeVisible();

  // Clicking receipt takes buyer to /r/<reference>
  await page.getByRole("link", { name: /View receipt/i }).click();
  await expect(page.getByText("125.00", { exact: false }).first()).toBeVisible();
});

test("invoice with due date in the past shows Overdue", async ({ page }) => {
  const pastDue = Date.now() - 3 * 86_400_000; // 3 days ago
  const created = await seller.post("/invoices", {
    data: {
      clientName: "Overdue Debtor",
      lineItems: [{ description: "Services", quantity: 1, unitPrice: "200.00" }],
      assetCode: "USDC",
      dueAt: pastDue,
    },
  });
  const { invoice: draft } = (await created.json()) as { invoice: any };
  const issued = await seller.post(`/invoices/${draft.id}/issue`);
  const { invoice: overdueInv } = (await issued.json()) as { invoice: any };

  // Public page shows Overdue
  await page.goto(`/invoice/${overdueInv.id}`);
  await expect(page.locator(".pill--overdue, .pill--bad, .badge--overdue").first()).toBeVisible();
  await expect(page.getByText("Overdue", { exact: true }).first()).toBeVisible();

  // Dashboard list shows Overdue
  const listRes = await seller.get("/invoices");
  const { invoices } = (await listRes.json()) as { invoices: any[] };
  const found = invoices.find((inv: any) => inv.id === overdueInv.id);
  expect(found.status).toBe("overdue");
});

test("voiding an open invoice hides pay controls on public page", async ({ page }) => {
  const created = await seller.post("/invoices", {
    data: {
      clientName: "Cancelled Project",
      lineItems: [{ description: "Discovery", quantity: 1, unitPrice: "50.00" }],
      assetCode: "USDC",
    },
  });
  const { invoice: draft } = (await created.json()) as { invoice: any };
  const issued = await seller.post(`/invoices/${draft.id}/issue`);
  const { invoice: openInv } = (await issued.json()) as { invoice: any };

  // First verify pay controls are visible on public page
  await page.goto(`/invoice/${openInv.id}`);
  await expect(page.locator(".qr-wrap svg")).toBeVisible();

  // Void the invoice
  const voided = await seller.post(`/invoices/${openInv.id}/void`);
  expect(voided.ok()).toBeTruthy();

  // Reload public page -> pay controls hidden, displays cancellation notice
  await page.reload();
  await expect(page.locator(".qr-wrap svg")).not.toBeVisible();
  await expect(page.getByText(/This invoice was cancelled/i)).toBeVisible();
});
