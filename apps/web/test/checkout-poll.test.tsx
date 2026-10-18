// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkWithRequest, PaymentLink } from "../lib/api";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// Mock WalletPayButton and qrcode.react to avoid canvas and wallet dependencies
vi.mock("../app/components/WalletPayButton", () => ({ default: () => null }));
vi.mock("qrcode.react", () => ({ QRCodeSVG: () => <svg data-testid="qr" /> }));

import CheckoutClient from "../app/components/CheckoutClient";
import { api } from "../lib/api";

function makeTestInitial(
  status: PaymentLink["status"] = "active",
  expiresAt: number | null = Date.now() + 600_000,
): LinkWithRequest {
  const link: PaymentLink = {
    id: "lnk_test_123",
    reference: "pl_ref123",
    sellerId: "sel_1",
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    muxedId: null,
    title: "Test Coffee",
    amount: "5.00",
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
    id: "req_1",
    sellerId: "sel_1",
    amount: "5.00",
    asset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
    destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    title: "Test Coffee",
    description: null,
    callbackUrl: null,
    expiresAt: null,
    createdAt: Date.now(),
    uri: "web+stellar:pay?destination=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN&amount=5.00",
    memo: null,
  };

  return { link, request };
}

describe("CheckoutClient polling (issue 5.28)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const getLinkSpy = vi.spyOn(api, "getLink");

  beforeEach(() => {
    vi.useFakeTimers();
    getLinkSpy.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.useRealTimers();
  });

  it("continues polling after a failed poll (ok, fail, ok polls three times)", async () => {
    const initial = makeTestInitial("active");
    const activeLink: PaymentLink = { ...initial.link, status: "active" };

    // 1st call at t=0: ok
    // 2nd call at t=4s: throws error (e.g. 502)
    // 3rd call at t=8s: ok
    getLinkSpy
      .mockResolvedValueOnce({ link: activeLink, request: initial.request })
      .mockRejectedValueOnce(new Error("502 Bad Gateway"))
      .mockResolvedValueOnce({ link: activeLink, request: initial.request });

    await act(async () => {
      root!.render(<CheckoutClient initial={initial} />);
    });

    // Call 1 fired immediately on mount (t=0)
    expect(getLinkSpy).toHaveBeenCalledTimes(1);

    // Advance timer by 4000ms -> Call 2 fires (and rejects)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(getLinkSpy).toHaveBeenCalledTimes(2);

    // Advance timer by another 4000ms -> Call 3 fires (and succeeds)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(getLinkSpy).toHaveBeenCalledTimes(3);
  });

  it("shows the retry screen after three consecutive failures and stops polling", async () => {
    const initial = makeTestInitial("active");

    getLinkSpy.mockRejectedValue(new Error("500 Internal Server Error"));

    await act(async () => {
      root!.render(<CheckoutClient initial={initial} />);
    });

    // Call 1 at t=0 fails
    expect(getLinkSpy).toHaveBeenCalledTimes(1);
    expect(container.textContent).not.toContain("We've lost contact");

    // Call 2 at t=4s fails
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(getLinkSpy).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain("We've lost contact");

    // Call 3 at t=8s fails
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(getLinkSpy).toHaveBeenCalledTimes(3);

    // After 3rd failure, the retry screen is rendered
    expect(container.textContent).toContain("We've lost contact with the payment service");
    const tryAgainBtn = container.querySelector("button.btn--primary");
    expect(tryAgainBtn).not.toBeNull();
    expect(tryAgainBtn?.textContent).toBe("Try again");

    // Advance timers further (e.g. 10s) -> no additional poll is made while stopped
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(getLinkSpy).toHaveBeenCalledTimes(3);

    // Clicking "Try again" resets failures and resumes polling immediately
    getLinkSpy.mockResolvedValueOnce({
      link: { ...initial.link, status: "active" as const },
      request: initial.request,
    });

    await act(async () => {
      tryAgainBtn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(getLinkSpy).toHaveBeenCalledTimes(4);
  });

  it("stops polling when the link reaches a settled status (paid)", async () => {
    const initial = makeTestInitial("active");
    const paidLink: PaymentLink = { ...initial.link, status: "paid" };

    getLinkSpy
      .mockResolvedValueOnce({ link: { ...initial.link, status: "active" as const }, request: initial.request })
      .mockResolvedValueOnce({ link: paidLink, request: initial.request });

    await act(async () => {
      root!.render(<CheckoutClient initial={initial} />);
    });

    expect(getLinkSpy).toHaveBeenCalledTimes(1);

    // Advance 4s -> call 2 returns paid link
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(getLinkSpy).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Payment received");

    // Advance 8s more -> no further polls occur
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(getLinkSpy).toHaveBeenCalledTimes(2);
  });

  it("does not start polling if the link is already expired", async () => {
    const initial = makeTestInitial("expired");

    await act(async () => {
      root!.render(<CheckoutClient initial={initial} />);
    });

    expect(getLinkSpy).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(getLinkSpy).not.toHaveBeenCalled();
    expect(container.textContent).toContain("This payment link has expired");
  });
});
