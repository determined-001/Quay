// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../app/components/CheckoutClient", () => ({
  default: ({ initial }: { initial: any }) => (
    <div data-testid="checkout-client" className="checkout">
      CheckoutClient link: {initial.link.id}
    </div>
  ),
}));

import InvoicePage, { generateMetadata } from "../app/invoice/[id]/page";
import { api, CheckoutError, type LinkWithRequest, type PublicInvoice } from "../lib/api";

const MOCK_INVOICE_OPEN: PublicInvoice = {
  id: "inv_123",
  number: "INV-0001",
  sellerName: "Acme Corp",
  clientName: "Alice Smith",
  lineItems: [
    { description: "Development", quantity: 2, unitPrice: "100.00" },
    { description: "Design", quantity: 1, unitPrice: "50.00" },
  ],
  total: "250.00",
  asset: "USDC",
  issuedAt: 1700000000000,
  dueAt: 1700086400000,
  status: "open",
  linkId: "lnk_123",
  notes: "Payment due within 30 days.",
};

const MOCK_LINK_DATA: LinkWithRequest = {
  link: {
    id: "lnk_123",
    reference: "REF_INV_0001",
    sellerId: "sel_1",
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    muxedId: null,
    title: "Invoice INV-0001",
    amount: "250.00",
    asset: { code: "USDC", issuer: null },
    status: "active",
    isDemo: false,
    txHash: null,
    payer: null,
    paidAmount: null,
    overpaidAmount: null,
    offrampJobId: null,
    offrampTargetCurrency: null,
    offrampStatus: null,
    offrampIndicativeRate: null,
    offrampRate: null,
    offrampRateDelta: null,
    offrampFeeAmount: null,
    offrampFeeCurrency: null,
    offrampFeeSource: null,
    offrampNetTargetAmount: null,
    expiresAt: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  },
  request: {
    uri: "web+stellar:pay?destination=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    amount: "250.00",
    asset: { code: "USDC", issuer: null },
    memo: "REF_INV_0001",
  },
};

describe("Public invoice page", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubEnv("NEXT_PUBLIC_INVOICES_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "testnet");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  describe("Feature flag gating and not-found behavior", () => {
    it("renders the same not-found panel as /pay/[id] when the feature flag is off", async () => {
      vi.stubEnv("NEXT_PUBLIC_INVOICES_ENABLED", "false");
      const page = await InvoicePage({ params: Promise.resolve({ id: "inv_123" }) });

      await act(async () => {
        root.render(page);
      });

      expect(container.textContent).toContain("Payment link not found");
      expect(container.textContent).toContain("This link may have been removed, or the id is wrong.");
      expect(container.querySelector('a[href="/"]')).not.toBeNull();
      expect(container.querySelector('a[href="/invoice/inv_123"]')).not.toBeNull();
    });

    it("renders the same not-found panel when the invoice does not exist", async () => {
      vi.spyOn(api, "getPublicInvoice").mockRejectedValue(
        new CheckoutError("not_found", 404, "Invoice not found"),
      );

      const page = await InvoicePage({ params: Promise.resolve({ id: "inv_unknown" }) });

      await act(async () => {
        root.render(page);
      });

      expect(container.textContent).toContain("Payment link not found");
      expect(container.querySelector('a[href="/invoice/inv_unknown"]')).not.toBeNull();
    });

    it("renders the unreachable panel when the API is down", async () => {
      vi.spyOn(api, "getPublicInvoice").mockRejectedValue(
        new CheckoutError("unreachable", 0, "Network error"),
      );

      const page = await InvoicePage({ params: Promise.resolve({ id: "inv_123" }) });

      await act(async () => {
        root.render(page);
      });

      expect(container.textContent).toContain("Unable to load this payment link");
      expect(container.textContent).toContain("We can't reach the payment service right now.");
    });
  });

  describe("Invoice layout and status behaviors", () => {
    it("renders an open invoice with working checkout and testnet notice", async () => {
      vi.spyOn(api, "getPublicInvoice").mockResolvedValue(MOCK_INVOICE_OPEN);
      vi.spyOn(api, "getLink").mockResolvedValue(MOCK_LINK_DATA);

      const page = await InvoicePage({ params: Promise.resolve({ id: "inv_123" }) });

      await act(async () => {
        root.render(page);
      });

      expect(container.textContent).toContain("INV-0001");
      expect(container.textContent).toContain("Acme Corp");
      expect(container.textContent).toContain("Alice Smith");
      expect(container.textContent).toContain("Open");
      expect(container.textContent).toContain("Development");
      expect(container.textContent).toContain("Design");
      expect(container.textContent).toContain("250.00 USDC");
      expect(container.textContent).toContain("Payment due within 30 days.");
      expect(container.textContent).toContain("Testnet — no real money.");

      // Working checkout rendered below invoice
      const checkout = container.querySelector('[data-testid="checkout-client"]');
      expect(checkout).not.toBeNull();
      expect(checkout?.textContent).toContain("lnk_123");
    });

    it("renders an overdue invoice with working checkout", async () => {
      const overdueInvoice: PublicInvoice = {
        ...MOCK_INVOICE_OPEN,
        status: "overdue",
      };
      vi.spyOn(api, "getPublicInvoice").mockResolvedValue(overdueInvoice);
      vi.spyOn(api, "getLink").mockResolvedValue(MOCK_LINK_DATA);

      const page = await InvoicePage({ params: Promise.resolve({ id: "inv_123" }) });

      await act(async () => {
        root.render(page);
      });

      expect(container.textContent).toContain("Overdue");
      const checkout = container.querySelector('[data-testid="checkout-client"]');
      expect(checkout).not.toBeNull();
    });

    it("renders a paid invoice with a receipt link and no pay controls", async () => {
      const paidInvoice: PublicInvoice = {
        ...MOCK_INVOICE_OPEN,
        status: "paid",
        reference: "REF_INV_PAID_999",
      };
      vi.spyOn(api, "getPublicInvoice").mockResolvedValue(paidInvoice);
      vi.spyOn(api, "getLink").mockResolvedValue(MOCK_LINK_DATA);

      const page = await InvoicePage({ params: Promise.resolve({ id: "inv_123" }) });

      await act(async () => {
        root.render(page);
      });

      expect(container.textContent).toContain("Paid");
      expect(container.textContent).toContain("This invoice has been paid.");
      const receiptLink = container.querySelector('a[href="/r/REF_INV_PAID_999"]');
      expect(receiptLink).not.toBeNull();
      expect(receiptLink?.textContent).toContain("View receipt");

      // No pay controls
      expect(container.querySelector('[data-testid="checkout-client"]')).toBeNull();
    });

    it("renders a void invoice with cancellation message and no pay controls", async () => {
      const voidInvoice: PublicInvoice = {
        ...MOCK_INVOICE_OPEN,
        status: "void",
      };
      vi.spyOn(api, "getPublicInvoice").mockResolvedValue(voidInvoice);

      const page = await InvoicePage({ params: Promise.resolve({ id: "inv_123" }) });

      await act(async () => {
        root.render(page);
      });

      expect(container.textContent).toContain("Void");
      expect(container.textContent).toContain("This invoice was cancelled");
      expect(container.querySelector('[data-testid="checkout-client"]')).toBeNull();
      expect(container.querySelector('a[href^="/r/"]')).toBeNull();
    });

    it("hides the testnet notice on public/mainnet", async () => {
      vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "public");
      vi.spyOn(api, "getPublicInvoice").mockResolvedValue(MOCK_INVOICE_OPEN);
      vi.spyOn(api, "getLink").mockResolvedValue(MOCK_LINK_DATA);

      const page = await InvoicePage({ params: Promise.resolve({ id: "inv_123" }) });

      await act(async () => {
        root.render(page);
      });

      expect(container.textContent).not.toContain("Testnet — no real money");
    });
  });

  describe("Metadata privacy", () => {
    it("uses invoice number and seller name only, never the client name", async () => {
      vi.spyOn(api, "getPublicInvoice").mockResolvedValue(MOCK_INVOICE_OPEN);

      const metadata = await generateMetadata({ params: Promise.resolve({ id: "inv_123" }) });

      expect(metadata.title).toBe("Invoice INV-0001 from Acme Corp");
      expect(metadata.openGraph?.title).toBe("Invoice INV-0001 from Acme Corp");
      expect(metadata.openGraph?.description).toBe("Invoice INV-0001 from Acme Corp");

      // Verify client name is NOT leaked
      const metadataStr = JSON.stringify(metadata);
      expect(metadataStr).not.toContain("Alice Smith");
      expect(metadataStr).not.toContain("Alice");
    });

    it("returns default not found title when invoice does not exist or flag is off", async () => {
      vi.spyOn(api, "getPublicInvoice").mockRejectedValue(new Error("not found"));

      const metadata = await generateMetadata({ params: Promise.resolve({ id: "inv_bad" }) });
      expect(metadata.title).toBe("Invoice not found");
    });
  });

  describe("Print styling", () => {
    it("includes CSS rule hiding pay controls and actions in print preview", () => {
      const cssPath = path.resolve(__dirname, "../app/globals.css");
      const cssContent = fs.readFileSync(cssPath, "utf-8");

      const printMedia = cssContent.match(/@media print\s*\{([\s\S]*?\n\})/)?.[1] ?? "";
      expect(printMedia).toContain(".invoice-pay");
      expect(printMedia).toContain(".checkout");
      expect(printMedia).toContain(".invoice-actions");
      expect(printMedia).toMatch(/\.invoice-pay,\s*\.checkout\s*\{\s*display:\s*none\s*!important/);
      expect(printMedia).toMatch(/\.receipt-actions,\s*\.invoice-actions\s*\{\s*display:\s*none\s*!important/);
    });
  });
});
