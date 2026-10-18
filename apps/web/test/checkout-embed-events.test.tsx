// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkWithRequest, PaymentLink } from "../lib/api";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Mock WalletPayButton and qrcode.react
vi.mock("../app/components/WalletPayButton", () => ({ default: () => null }));
vi.mock("qrcode.react", () => ({ QRCodeSVG: () => <svg data-testid="qr" /> }));

import CheckoutClient from "../app/components/CheckoutClient";
import { api } from "../lib/api";

function makeInitial(
  status: PaymentLink["status"] = "active",
  expiresAt: number | null = Date.now() + 600_000,
): LinkWithRequest {
  const link: PaymentLink = {
    id: "lnk_embed_test",
    reference: "ref_embed_123",
    sellerId: "sel_1",
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    muxedId: null,
    title: "Widget Test",
    amount: "10.00",
    asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    status,
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
    expiresAt,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const request = {
    id: "req_embed_1",
    sellerId: "sel_1",
    amount: "10.00",
    asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    title: "Widget Test",
    description: null,
    callbackUrl: null,
    expiresAt: null,
    createdAt: Date.now(),
    uri: "web+stellar:pay?destination=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN&amount=10.00",
    memo: null,
  };

  return { link, request };
}

describe("CheckoutClient embed postMessage events (issue 7.22)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let parentPostMessageSpy: ReturnType<typeof vi.fn>;
  const getLinkSpy = vi.spyOn(api, "getLink");

  beforeEach(() => {
    vi.useFakeTimers();
    getLinkSpy.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    parentPostMessageSpy = vi.fn();
    Object.defineProperty(window, "parent", {
      value: { postMessage: parentPostMessageSpy },
      writable: true,
      configurable: true,
    });

    Object.defineProperty(document, "referrer", {
      value: "https://merchant.example.com/checkout",
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.useRealTimers();

    // Restore window.parent
    Object.defineProperty(window, "parent", {
      value: window,
      writable: true,
      configurable: true,
    });
  });

  it("posts quay:paid with linkId and link to parent exactly once when settled upon mount", async () => {
    const initial = makeInitial("paid");
    initial.link.paidAmount = "10.00";
    initial.link.txHash = "tx_settled_123";

    await act(async () => {
      root!.render(<CheckoutClient initial={initial} embed={true} />);
    });

    expect(parentPostMessageSpy).toHaveBeenCalledTimes(1);
    expect(parentPostMessageSpy).toHaveBeenCalledWith(
      {
        type: "quay:paid",
        linkId: "lnk_embed_test",
        link: expect.objectContaining({ id: "lnk_embed_test", status: "paid" }),
      },
      "https://merchant.example.com",
    );

    // Re-rendering or advancing timers must not duplicate quay:paid
    await act(async () => {
      root!.render(<CheckoutClient initial={initial} embed={true} />);
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(parentPostMessageSpy).toHaveBeenCalledTimes(1);
  });

  it("posts quay:paid when transitioning from active to settled via poll", async () => {
    const initial = makeInitial("active");
    const activeLink: PaymentLink = { ...initial.link, status: "active" };
    const settledLink: PaymentLink = { ...initial.link, status: "paid", paidAmount: "10.00" };

    // 1st call at t=0: active
    // 2nd call at t=4000: settled
    getLinkSpy
      .mockResolvedValueOnce({ link: activeLink, request: initial.request })
      .mockResolvedValueOnce({ link: settledLink, request: initial.request });

    await act(async () => {
      root!.render(<CheckoutClient initial={initial} embed={true} />);
    });

    // On mount with active link, quay:paid is not emitted
    expect(parentPostMessageSpy).not.toHaveBeenCalled();

    // Advance timer to trigger 2nd poll
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(parentPostMessageSpy).toHaveBeenCalledTimes(1);
    expect(parentPostMessageSpy).toHaveBeenCalledWith(
      {
        type: "quay:paid",
        linkId: "lnk_embed_test",
        link: expect.objectContaining({ id: "lnk_embed_test", status: "paid" }),
      },
      "https://merchant.example.com",
    );
  });

  it("posts quay:error with error: 'expired' when link is expired", async () => {
    const initial = makeInitial("expired");

    await act(async () => {
      root!.render(<CheckoutClient initial={initial} embed={true} />);
    });

    expect(parentPostMessageSpy).toHaveBeenCalledTimes(1);
    expect(parentPostMessageSpy).toHaveBeenCalledWith(
      {
        type: "quay:error",
        linkId: "lnk_embed_test",
        error: "expired",
      },
      "https://merchant.example.com",
    );
  });

  it("posts quay:error with error: 'cancelled' when link is cancelled", async () => {
    const initial = makeInitial("cancelled");

    await act(async () => {
      root!.render(<CheckoutClient initial={initial} embed={true} />);
    });

    expect(parentPostMessageSpy).toHaveBeenCalledTimes(1);
    expect(parentPostMessageSpy).toHaveBeenCalledWith(
      {
        type: "quay:error",
        linkId: "lnk_embed_test",
        error: "cancelled",
      },
      "https://merchant.example.com",
    );
  });

  it("posts quay:error with error: 'connection_lost' when polling fails consecutively", async () => {
    const initial = makeInitial("active");
    getLinkSpy.mockRejectedValue(new Error("503 Service Unavailable"));

    await act(async () => {
      root!.render(<CheckoutClient initial={initial} embed={true} />);
    });

    // 1st fail at t=0
    expect(parentPostMessageSpy).not.toHaveBeenCalled();

    // 2nd fail at t=4000
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(parentPostMessageSpy).not.toHaveBeenCalled();

    // 3rd fail at t=8000 -> connection lost
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(parentPostMessageSpy).toHaveBeenCalledTimes(1);
    expect(parentPostMessageSpy).toHaveBeenCalledWith(
      {
        type: "quay:error",
        linkId: "lnk_embed_test",
        error: "connection_lost",
      },
      "https://merchant.example.com",
    );
  });

  it("posts quay:closed when Close button is clicked in embed mode", async () => {
    const initial = makeInitial("paid");

    await act(async () => {
      root!.render(<CheckoutClient initial={initial} embed={true} />);
    });

    // Find and click the Close button
    const closeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Close",
    );
    expect(closeBtn).toBeDefined();

    await act(async () => {
      closeBtn!.click();
    });

    expect(parentPostMessageSpy).toHaveBeenCalledWith(
      {
        type: "quay:closed",
        linkId: "lnk_embed_test",
      },
      "https://merchant.example.com",
    );
  });

  it("falls back to '*' targetOrigin when document.referrer is absent or invalid", async () => {
    Object.defineProperty(document, "referrer", {
      value: "",
      writable: true,
      configurable: true,
    });

    const initial = makeInitial("paid");

    await act(async () => {
      root!.render(<CheckoutClient initial={initial} embed={true} />);
    });

    expect(parentPostMessageSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: "quay:paid" }),
      "*",
    );
  });

  it("does not post any message when embed is false or window.parent is window", async () => {
    const initial = makeInitial("paid");

    // Case 1: embed is false
    await act(async () => {
      root!.render(<CheckoutClient initial={initial} embed={false} />);
    });
    expect(parentPostMessageSpy).not.toHaveBeenCalled();

    // Case 2: window.parent === window (not in iframe)
    Object.defineProperty(window, "parent", {
      value: window,
      writable: true,
      configurable: true,
    });

    await act(async () => {
      root!.render(<CheckoutClient initial={initial} embed={true} />);
    });
    expect(parentPostMessageSpy).not.toHaveBeenCalled();
  });
});
