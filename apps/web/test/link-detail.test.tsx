// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/wallet", () => ({
  connectWallet: vi.fn(async () => "GSELLERWALLET"),
  detectWallet: vi.fn(async () => true),
  disconnectWallet: vi.fn(async () => {}),
  shortAddress: (addr: string) => addr.slice(0, 4) + "…" + addr.slice(-4),
  signChallenge: vi.fn(async () => "signed-challenge-xdr"),
}));

import { api, CheckoutError, type LinkDetail, type PaymentLink } from "../lib/api";
import { LinkDetailClient } from "../app/links/[id]/LinkDetailClient";
import { TimelineClient } from "../app/links/[id]/TimelineClient";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const MOCK_LINK: PaymentLink = {
  id: "lnk_test_123",
  sellerId: "sel_1",
  reference: "REF-999",
  amount: "15.00",
  asset: { code: "USDC", issuer: "GISSUER" },
  destination: "GDESTINATION1234567890",
  status: "paid",
  title: "Coffee Order #123",
  muxedId: null,
  payer: "GPAYER1234567890",
  txHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  paidAmount: "15.00",
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
  isDemo: false,
  createdAt: 1700000000000,
  updatedAt: 1700000060000,
  expiresAt: 1700003600000,
};

const MOCK_DETAIL: LinkDetail = {
  link: MOCK_LINK,
  request: {
    uri: "web+stellar:pay?destination=GDESTINATION1234567890",
    destination: "GDESTINATION1234567890",
    amount: "15.00",
    asset: { code: "USDC", issuer: "GISSUER" },
    memo: "REF-999",
  },
  deliveries: [
    {
      id: "del_1",
      webhookId: "wh_1",
      linkId: "lnk_test_123",
      event: "link.paid",
      statusCode: 200,
      ok: true,
      error: null,
      createdAt: 1700000065000,
    },
  ],
  offrampExternalStatus: null,
};

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("TimelineClient SSR safety", () => {
  it("renders to a string on the server without window", () => {
    // In Node.js or SSR environment, renderToString must not throw ReferenceError: window is not defined
    const html = renderToString(
      <TimelineClient linkId="lnk_test_123" reference="REF-999" />,
    );
    expect(html).toContain("/r/REF-999");
    expect(html).toContain("Copy receipt link");
  });
});

describe("LinkDetailClient", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders sign-in prompt on 401 response", async () => {
    vi.spyOn(api, "getDetail").mockRejectedValue(
      new CheckoutError("unauthorized" as never, 401, "unauthorized"),
    );

    await act(async () => {
      root.render(<LinkDetailClient id="lnk_test_123" />);
    });
    await flush();

    expect(container.textContent).toContain("Connect your wallet");
    const connectButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Connect wallet"),
    );
    expect(connectButton).toBeTruthy();
  });

  it("renders 'Link not found' on 404 response", async () => {
    vi.spyOn(api, "getDetail").mockRejectedValue(
      new CheckoutError("not_found", 404, "not found"),
    );

    await act(async () => {
      root.render(<LinkDetailClient id="lnk_test_123" />);
    });
    await flush();

    expect(container.textContent).toContain("Link not found");
    expect(container.textContent).toContain("This link may have been removed, or the ID is wrong.");
    const backLink = container.querySelector("a[href='/']");
    expect(backLink?.textContent).toContain("Back to dashboard");
  });

  it("renders error state with retry button on unexpected error", async () => {
    const getDetailSpy = vi.spyOn(api, "getDetail");
    getDetailSpy.mockRejectedValueOnce(
      new CheckoutError("server_error", 500, "Internal error"),
    );

    await act(async () => {
      root.render(<LinkDetailClient id="lnk_test_123" />);
    });
    await flush();

    expect(container.textContent).toContain("Failed to load link details");
    const retryBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Retry"),
    );
    expect(retryBtn).toBeTruthy();

    // Clicking retry attempts fetch again
    getDetailSpy.mockResolvedValueOnce(MOCK_DETAIL);
    await act(async () => {
      retryBtn?.click();
    });
    await flush();

    expect(container.textContent).toContain("Coffee Order #123");
  });

  it("renders link timeline and details when signed in and link is found", async () => {
    vi.spyOn(api, "getDetail").mockResolvedValue(MOCK_DETAIL);

    await act(async () => {
      root.render(<LinkDetailClient id="lnk_test_123" />);
    });
    await flush();

    // Header info
    expect(container.textContent).toContain("Coffee Order #123");
    expect(container.textContent).toContain("REF-999");
    expect(container.textContent).toContain("15.00 USDC");
    expect(container.textContent).toContain("paid");

    // Timeline events
    expect(container.textContent).toContain("Link created");
    expect(container.textContent).toContain("Payment received");
    expect(container.textContent).toContain("Webhook: link.paid");

    // Details panel
    expect(container.textContent).toContain("lnk_test_123");
    expect(container.textContent).toContain("GDESTINATION1234567890");

    // Receipt section
    expect(container.textContent).toContain("Receipt");
    expect(container.textContent).toContain("Copy receipt link");
  });
});
