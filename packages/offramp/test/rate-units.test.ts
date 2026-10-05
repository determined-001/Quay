import { Keypair, Networks } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { targetPerSourceRate, type AnchorCustomer } from "@checkout/core";
import { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { clearSep6InfoCache } from "../src/sep6";
import { TestAnchorOffRamp } from "../src/testanchor";
import { MockAnchorOffRamp } from "../src/mock-anchor";
import { FakeAnchorSessionRepository, FakeOffRampStateRepository } from "./fake-state";

// ---------------------------------------------------------------------------
//  Issue 5.21 — OffRampQuote.rate has ONE direction: target currency per
//  1 unit of source asset. SEP-38's `price` is the opposite (sell per buy),
//  and passing it through is what made telemetry's spread meaningless for
//  real anchors while the mock happened to line up. Offline: every anchor
//  response is a stubbed fetch, and the TOML served declares
//  ANCHOR_QUOTE_SERVER — this suite is about the SEP-38 path, and since issue
//  3.22 an anchor that declares no quote server is never quoted at all.
// ---------------------------------------------------------------------------

const PRICE = "1.02"; // sell (USDC) per buy (USD): 1 USD costs 1.02 USDC
const SOURCE_AMOUNT = "5";
const BUY_AMOUNT = "4.80"; // anchor's net after its fee

const INFO_BODY = {
  withdraw: {
    USDC: {
      enabled: true,
      min_amount: 1,
      max_amount: 10,
      types: { bank_account: { fields: { dest: { description: "Account" } } } },
    },
  },
};

const SEP38_QUOTE_BODY = {
  id: "quote_ru_1",
  price: PRICE,
  total_price: PRICE,
  sell_amount: SOURCE_AMOUNT,
  buy_amount: BUY_AMOUNT,
  expires_at: new Date(Date.now() + 300_000).toISOString(),
};

function stubAnchorFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/.well-known/stellar.toml")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () =>
            [
              'VERSION = "2.0.0"',
              `NETWORK_PASSPHRASE = "${Networks.TESTNET}"`,
              `WEB_AUTH_ENDPOINT = "${currentBase}/auth"`,
              `TRANSFER_SERVER = "${currentBase}/sep6"`,
              `ANCHOR_QUOTE_SERVER = "${currentBase}/sep38"`,
              'SIGNING_KEY = "GSIGNINGKEY"',
              "",
            ].join("\n"),
        } as Response;
      }
      const body = url.includes("/info")
        ? INFO_BODY
        : url.includes("/quote")
          ? SEP38_QUOTE_BODY
          : null;
      if (body === null) throw new Error(`offline test: unexpected fetch ${url}`);
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => JSON.stringify(body),
      } as Response;
    }),
  );
}

/** Base URL of the anchor the current test stands in for. */
let currentBase = "";

let counter = 0;
function offrampWithSession() {
  const n = ++counter;
  const homeDomain = `rate-units-${n}.test`;
  const fallbackBaseUrl = `https://anchor-ru-${n}.test`;
  currentBase = fallbackBaseUrl;
  const discovery = new AnchorDiscovery({ homeDomain, fallbackBaseUrl });
  const sessions = new FakeAnchorSessionRepository();
  const auth = new SellerAnchorAuth({ discovery, sessions, networkPassphrase: Networks.TESTNET });
  const offramp = new TestAnchorOffRamp({ discovery, auth, state: new FakeOffRampStateRepository() });

  const customer: AnchorCustomer = { sellerId: "sel_ru", account: Keypair.random().publicKey() };
  void sessions.save({
    sellerId: customer.sellerId,
    anchorDomain: homeDomain,
    account: customer.account,
    token: "jwt-offline-test",
    expiresAt: Date.now() + 3_600_000,
    createdAt: Date.now(),
  });
  return { offramp, customer };
}

afterEach(() => {
  vi.unstubAllGlobals();
  clearSep6InfoCache();
});

describe("OffRampQuote.rate direction (issue 5.21)", () => {
  it("testanchor returns target-per-source, and the settlement spread equals the fee share — not a unit artifact", async () => {
    stubAnchorFetch();
    const { offramp, customer } = offrampWithSession();

    const quote = await offramp.quote({
      linkId: "lnk_ru",
      sourceAsset: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
      sourceAmount: SOURCE_AMOUNT,
      targetCurrency: "USD",
      customer,
    });

    // The documented direction: multiplying source by rate gives gross target.
    expect(quote.rate).toBe(targetPerSourceRate(PRICE));
    expect(Number(quote.rate) * Number(SOURCE_AMOUNT)).toBeCloseTo(Number(quote.targetAmount), 3);

    // Telemetry's math, replayed exactly (link-service.ts settle path): a
    // settlement of exactly the quoted net amount must show a spread equal
    // to the anchor's fee share of gross — with the old rate (= 1.02, the
    // raw price) this came out ~-2% of the wrong thing instead.
    const settledTargetAmount = quote.netTargetAmount;
    const effectiveRate = Number(settledTargetAmount) / Number(SOURCE_AMOUNT);
    const spread = (Number(quote.rate) - effectiveRate) / Number(quote.rate);
    const feeShareOfGross = Number(quote.fee.amount) / Number(quote.targetAmount);
    expect(spread).toBeCloseTo(feeShareOfGross, 3);
    expect(spread).toBeGreaterThan(0);
  });

  it("the mock was already in this direction — rate × source = gross target", async () => {
    const mock = new MockAnchorOffRamp({ state: new FakeOffRampStateRepository() });
    const quote = await mock.quote({
      linkId: "lnk_ru_mock",
      sourceAsset: { code: "USDC", issuer: "G".padEnd(56, "A") },
      sourceAmount: "10",
      targetCurrency: "NGN",
      customer: { sellerId: "sel_ru", account: Keypair.random().publicKey() },
    });
    expect(Number(quote.rate) * 10).toBeCloseTo(Number(quote.targetAmount), 2);
  });
});
