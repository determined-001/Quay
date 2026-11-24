// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("../app/components/WalletPayButton", () => ({ default: () => null }));
vi.mock("qrcode.react", () => ({ QRCodeSVG: () => <svg data-testid="qr" /> }));
vi.mock("../lib/wallet", () => ({
  connectWallet: vi.fn(async () => "GSELLERWALLET"),
  detectWallet: vi.fn(async () => true),
  disconnectWallet: vi.fn(async () => {}),
  shortAddress: (addr: string) => addr.slice(0, 4) + "…" + addr.slice(-4),
  signChallenge: vi.fn(async () => "signed-challenge-xdr"),
}));

import ApiWarmUp from "../app/components/ApiWarmUp";
import CheckoutClient from "../app/components/CheckoutClient";
import Dashboard from "../app/components/Dashboard";
import SessionGate from "../app/components/SessionGate";
import WakingNotice, { WAKING_COPY } from "../app/components/WakingNotice";
import PayPage from "../app/pay/[id]/page";
import { api, CheckoutError, type LinkWithRequest, type PaymentLink } from "../lib/api";
import { SLOW_REQUEST_MS } from "../lib/use-slow-request";

/** A promise that never settles: a request to an API that is still asleep. */
const never = <T,>() => new Promise<T>(() => {});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function render(node: React.ReactNode): Promise<void> {
  await act(async () => root.render(node));
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const shown = () => container.textContent?.includes(WAKING_COPY) ?? false;

describe("WakingNotice / useSlowRequest (issue 5.42)", () => {
  it("stays quiet before the threshold and speaks up after it", async () => {
    await render(<WakingNotice pending />);
    await advance(SLOW_REQUEST_MS - 1);
    expect(shown()).toBe(false);
    await advance(1);
    expect(shown()).toBe(true);
  });

  it("clears as soon as the request is no longer pending", async () => {
    await render(<WakingNotice pending />);
    await advance(SLOW_REQUEST_MS);
    expect(shown()).toBe(true);
    await render(<WakingNotice pending={false} />);
    expect(shown()).toBe(false);
  });

  it("never shows for a request that finishes in time", async () => {
    await render(<WakingNotice pending />);
    await advance(SLOW_REQUEST_MS - 100);
    await render(<WakingNotice pending={false} />);
    await advance(SLOW_REQUEST_MS * 2);
    expect(shown()).toBe(false);
  });

  it("promises no duration", () => {
    expect(WAKING_COPY).not.toMatch(/\d|minute|second/i);
  });
});

function checkoutInitial(): LinkWithRequest {
  const asset = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };
  const destination = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const link: PaymentLink = {
    id: "lnk_wake",
    reference: "pl_wake",
    sellerId: "sel_1",
    destination,
    muxedId: null,
    title: "Coffee",
    amount: "5.00",
    asset,
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
    expiresAt: Date.now() + 3_600_000,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const request = {
    id: "req_1",
    sellerId: "sel_1",
    amount: "5.00",
    asset,
    destination,
    title: "Coffee",
    description: null,
    callbackUrl: null,
    expiresAt: null,
    createdAt: Date.now(),
    uri: `web+stellar:pay?destination=${destination}&amount=5.00`,
    memo: null,
  };
  return { link, request } as LinkWithRequest;
}

describe("checkout polling (issue 5.42)", () => {
  it("shows the waking notice when a status request hangs, not while polls answer quickly", async () => {
    const getLink = vi.spyOn(api, "getLink");
    const initial = checkoutInitial();
    getLink.mockResolvedValue(initial);

    await render(<CheckoutClient initial={initial} />);
    // Several quick polls: waiting for payment is not the service waking up.
    await advance(SLOW_REQUEST_MS * 3);
    expect(getLink).toHaveBeenCalled();
    expect(shown()).toBe(false);

    // The next poll never answers.
    getLink.mockImplementation(() => never());
    const before = getLink.mock.calls.length;
    for (let i = 0; i < 30 && getLink.mock.calls.length === before; i++) await advance(1_000);
    expect(getLink.mock.calls.length).toBe(before + 1);
    await advance(SLOW_REQUEST_MS);
    expect(shown()).toBe(true);
  });
});

describe("sign-in (issue 5.42)", () => {
  async function clickConnect() {
    await render(
      <SessionGate>
        <div>Dashboard Protected Area</div>
      </SessionGate>,
    );
    const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Connect wallet"));
    expect(btn).toBeTruthy();
    await act(async () => btn!.click());
  }

  it("shows the waking notice after the threshold and clears it on success", async () => {
    let answer!: (v: { transaction: string; network_passphrase: string }) => void;
    vi.spyOn(api, "getAuthChallenge").mockImplementation(() => new Promise((r) => (answer = r)));
    vi.spyOn(api, "submitAuthChallenge").mockResolvedValue({ token: "jwt", expiresAt: Date.now() + 3_600_000 });

    await clickConnect();
    await advance(SLOW_REQUEST_MS - 1);
    expect(shown()).toBe(false);
    await advance(1);
    expect(shown()).toBe(true);

    await act(async () => answer({ transaction: "xdr", network_passphrase: "Test SDF Network ; September 2015" }));
    await advance(0);
    expect(shown()).toBe(false);
    expect(container.textContent).toContain("Dashboard Protected Area");
  });

  it("clears the waking notice when the request fails", async () => {
    let fail!: (e: unknown) => void;
    vi.spyOn(api, "getAuthChallenge").mockImplementation(() => new Promise((_, rej) => (fail = rej)));

    await clickConnect();
    await advance(SLOW_REQUEST_MS);
    expect(shown()).toBe(true);

    await act(async () => fail(new CheckoutError("server_error", 503, "booting")));
    await advance(0);
    expect(shown()).toBe(false);
  });
});

describe("dashboard first load (issue 5.42)", () => {
  it("shows the waking notice while the first data load is still out", async () => {
    // Every API call hangs, as against a sleeping service.
    const methods = api as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const key of Object.keys(methods)) {
      if (typeof methods[key] === "function") vi.spyOn(methods, key).mockImplementation(() => never());
    }
    await render(<Dashboard />);
    expect(shown()).toBe(false);
    await advance(SLOW_REQUEST_MS);
    expect(shown()).toBe(true);
  });
});

describe("checkout page errors (issue 5.42)", () => {
  async function pageFor(err: CheckoutError): Promise<string> {
    vi.spyOn(api, "getLink").mockRejectedValue(err);
    const el = await PayPage({ params: Promise.resolve({ id: "lnk_1" }), searchParams: Promise.resolve({}) });
    return renderToString(el);
  }

  it("says the payment service can't be reached for a 503, never 'not found'", async () => {
    const html = await pageFor(new CheckoutError("server_error", 503, "Service Unavailable"));
    expect(html).toContain("can&#x27;t reach the payment service");
    expect(html).not.toContain("not found");
    expect(html).toContain('href="/pay/lnk_1"');
  });

  it("says the same when the API can't be reached at all", async () => {
    const html = await pageFor(new CheckoutError("unreachable", 0, "fetch failed"));
    expect(html).toContain("can&#x27;t reach the payment service");
  });

  it("says 'not found' only for a real 404", async () => {
    const html = await pageFor(new CheckoutError("not_found", 404, "no such link"));
    expect(html).toContain("Payment link not found");
  });
});

describe("landing warm-up (issue 5.42)", () => {
  it("sends one GET /health after first paint and swallows a failure", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("network down"));
    await render(<ApiWarmUp />);
    await advance(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/health$/);
    expect(init).toMatchObject({ keepalive: true });
    expect(container.innerHTML).toBe("");
  });
});
