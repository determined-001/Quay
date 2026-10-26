// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SessionGate from "../app/components/SessionGate";
import { api } from "../lib/api";
import * as wallet from "../lib/wallet";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../lib/wallet", () => ({
  connectWallet: vi.fn(async () => "GSELLERWALLET"),
  detectWallet: vi.fn(async () => true),
  disconnectWallet: vi.fn(async () => {}),
  shortAddress: (addr: string) => addr.slice(0, 4) + "…" + addr.slice(-4),
  signChallenge: vi.fn(async () => "signed-challenge-xdr"),
}));

describe("SessionGate - sign out flow and cash-out warning", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    window.confirm = vi.fn(() => true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    vi.spyOn(api, "getAuthChallenge").mockResolvedValue({
      transaction: "challenge-xdr",
      network_passphrase: "Test SDF Network ; September 2015",
    });
    vi.spyOn(api, "submitAuthChallenge").mockResolvedValue({
      token: "session-jwt",
      expiresAt: Date.now() + 3600_000,
    });
    vi.spyOn(api, "logout").mockResolvedValue({ ok: true });
    vi.spyOn(api, "getAnchorAuth").mockResolvedValue({
      anchor: "testanchor.stellar.org",
      required: true,
      connected: true,
      expiresAt: Date.now() + 3600_000,
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  async function signIn() {
    await act(async () => {
      root.render(
        <SessionGate>
          <div data-testid="dashboard-content">Dashboard Protected Area</div>
        </SessionGate>,
      );
    });

    const connectBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Connect wallet"),
    );
    expect(connectBtn).toBeTruthy();

    await act(async () => {
      connectBtn?.click();
    });

    expect(container.textContent).toContain("Dashboard Protected Area");
  }

  it("signs out directly when no cash-out (offramp_pending) link exists", async () => {
    vi.spyOn(api, "listLinks").mockResolvedValue({ links: [] });
    const confirmSpy = vi.spyOn(window, "confirm");

    await signIn();

    const signOutBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Sign out"),
    );
    expect(signOutBtn).toBeTruthy();

    await act(async () => {
      signOutBtn?.click();
    });

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(api.logout).toHaveBeenCalled();
    expect(wallet.disconnectWallet).toHaveBeenCalled();
    // Back to logged out state
    expect(container.textContent).toContain("Connect your wallet");
  });

  it("warns before signing out when an offramp_pending link exists and cancels sign out if user declines", async () => {
    vi.spyOn(api, "listLinks").mockResolvedValue({
      links: [
        {
          id: "lnk_1",
          reference: "ref1",
          sellerId: "sel_1",
          destination: "GWALLET",
          muxedId: null,
          title: "Order 1",
          amount: "50",
          asset: { code: "USDC", issuer: "GISSUER" },
          status: "offramp_pending",
          txHash: "tx1",
          payer: "GPACTION",
          paidAmount: "50",
          overpaidAmount: null,
          offrampJobId: "job_1",
          offrampTargetCurrency: "NGN",
          offrampStatus: "pending",
          offrampIndicativeRate: null,
          offrampRate: "1600",
          offrampRateDelta: null,
          offrampFeeAmount: "1",
          offrampFeeCurrency: "USDC",
          offrampFeeSource: "anchor",
          offrampNetTargetAmount: "78400",
          expiresAt: null,
          isDemo: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false); // User clicks Cancel

    await signIn();

    const signOutBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Sign out"),
    );
    expect(signOutBtn).toBeTruthy();

    await act(async () => {
      signOutBtn?.click();
    });

    expect(confirmSpy).toHaveBeenCalledWith(
      "You have a cash-out in progress. Signing out also disconnects you from testanchor.stellar.org; we will not see updates until you reconnect.",
    );
    // User cancelled, so logout and disconnect must NOT have been called
    expect(api.logout).not.toHaveBeenCalled();
    expect(wallet.disconnectWallet).not.toHaveBeenCalled();
    // Still in protected area
    expect(container.textContent).toContain("Dashboard Protected Area");
  });

  it("warns before signing out when an offramp_pending link exists and proceeds if user confirms", async () => {
    vi.spyOn(api, "listLinks").mockResolvedValue({
      links: [
        {
          id: "lnk_2",
          reference: "ref2",
          sellerId: "sel_1",
          destination: "GWALLET",
          muxedId: null,
          title: "Order 2",
          amount: "20",
          asset: { code: "USDC", issuer: "GISSUER" },
          status: "offramp_pending",
          txHash: "tx2",
          payer: "GPACTION",
          paidAmount: "20",
          overpaidAmount: null,
          offrampJobId: "job_2",
          offrampTargetCurrency: "NGN",
          offrampStatus: "pending",
          offrampIndicativeRate: null,
          offrampRate: "1600",
          offrampRateDelta: null,
          offrampFeeAmount: "1",
          offrampFeeCurrency: "USDC",
          offrampFeeSource: "anchor",
          offrampNetTargetAmount: "30400",
          expiresAt: null,
          isDemo: false,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true); // User clicks OK

    await signIn();

    const signOutBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Sign out"),
    );

    await act(async () => {
      signOutBtn?.click();
    });

    expect(confirmSpy).toHaveBeenCalledWith(
      "You have a cash-out in progress. Signing out also disconnects you from testanchor.stellar.org; we will not see updates until you reconnect.",
    );
    expect(api.logout).toHaveBeenCalled();
    expect(wallet.disconnectWallet).toHaveBeenCalled();
    expect(container.textContent).toContain("Connect your wallet");
  });
});

describe("SessionGate - wallet detection failure and retry (issue #420)", () => {
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

  it("enables the button and shows warning with Retry when detectWallet rejects, and recovers on Retry", async () => {
    let unhandled = false;
    const onUnhandledRejection = (e: PromiseRejectionEvent) => {
      unhandled = true;
      e.preventDefault();
    };
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    vi.mocked(wallet.detectWallet)
      .mockRejectedValueOnce(new Error("Network chunk-load failure"))
      .mockResolvedValueOnce(true);

    await act(async () => {
      root.render(
        <SessionGate>
          <div data-testid="dashboard-content">Dashboard Protected Area</div>
        </SessionGate>,
      );
    });

    window.removeEventListener("unhandledrejection", onUnhandledRejection);
    expect(unhandled).toBe(false);

    // Button is enabled and reads "Connect wallet"
    const connectBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes("Connect wallet"),
    );
    expect(connectBtn).toBeTruthy();
    expect(connectBtn?.disabled).toBe(false);

    // Warning message and Retry button are shown
    expect(container.textContent).toContain("No Stellar wallet detected in this browser");
    const retryBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent?.includes("Retry"),
    );
    expect(retryBtn).toBeTruthy();

    // Clicking Retry runs detection again
    await act(async () => {
      retryBtn?.click();
    });

    expect(wallet.detectWallet).toHaveBeenCalledTimes(2);

    // Resolves true: shows "Connect wallet" and NO warning
    expect(connectBtn?.disabled).toBe(false);
    expect(container.textContent).toContain("Connect wallet");
    expect(container.textContent).not.toContain("No Stellar wallet detected in this browser");
  });
});

