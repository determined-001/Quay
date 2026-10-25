import { Networks } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AssetRef } from "@checkout/core";
import { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { MockAnchorOffRamp } from "../src/mock-anchor";
import type { Sep1DiscoveryInfo } from "../src/sep1";
import { TestAnchorOffRamp } from "../src/testanchor";
import { FakeAnchorSessionRepository, FakeOffRampStateRepository } from "./fake-state";

const USDC: AssetRef = {
  code: "USDC",
  issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
};

const DISCOVERY: Sep1DiscoveryInfo = {
  webAuthEndpoint: "https://anchor.example/auth",
  transferServer: "https://anchor.example/sep6",
  transferServerSep24: "https://anchor.example/sep24",
  anchorQuoteServer: "https://anchor.example/sep38",
  kycServer: "https://anchor.example/sep12",
  homeDomain: "anchor.example",
  signingKey: null,
  currencies: [],
  fallback: false,
} as unknown as Sep1DiscoveryInfo;

function makeOffRamp(): TestAnchorOffRamp {
  const discovery = new AnchorDiscovery({ homeDomain: "anchor.example", fallbackBaseUrl: "https://anchor.example" });
  vi.spyOn(discovery, "get").mockResolvedValue(DISCOVERY);
  const sessions = new FakeAnchorSessionRepository();
  const auth = new SellerAnchorAuth({ discovery, sessions, networkPassphrase: Networks.TESTNET });
  return new TestAnchorOffRamp({ discovery, auth, sessions, state: new FakeOffRampStateRepository() });
}

function stubPrices(buyAssets: unknown[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ buy_assets: buyAssets }), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TestAnchorOffRamp.indicativePrices — direction", () => {
  it("returns target-per-source, the inverse of the SEP-38 sell-per-buy price", async () => {
    stubPrices([{ asset: "iso4217:NGN", price: "0.00065", buy_delivery_methods: [{ name: "WIRE" }] }]);

    const prices = await makeOffRamp().indicativePrices({ sourceAsset: USDC, sourceAmount: "10" });

    expect(prices).toEqual([{ targetCurrency: "NGN", price: "1538.46153846", deliveryMethods: ["WIRE"] }]);
  });

  it("skips entries with no asset or a non-numeric or non-positive price instead of throwing", async () => {
    stubPrices([
      { price: "0.00065" },
      { asset: "iso4217:GHS", price: "abc" },
      { asset: "iso4217:KES", price: "0" },
      { asset: "iso4217:ZAR", price: "-1" },
      { asset: "stellar:native", price: "2" },
      { asset: "iso4217:NGN", price: "0.00065" },
    ]);

    const prices = await makeOffRamp().indicativePrices({ sourceAsset: USDC, sourceAmount: "10" });

    expect(prices.map((p) => p.targetCurrency)).toEqual(["NGN"]);
  });

  it("agrees with the mock adapter: both report target currency units per 1 source unit", async () => {
    // The mock reports NGN per 1 USDC (well above 1), not USDC per NGN.
    const [mockNgn] = (await new MockAnchorOffRamp({ state: new FakeOffRampStateRepository() }).indicativePrices({ sourceAsset: USDC, sourceAmount: "10" })).filter(
      (p) => p.targetCurrency === "NGN",
    );
    expect(Number(mockNgn?.price)).toBeGreaterThan(1);

    stubPrices([{ asset: "iso4217:NGN", price: String(1 / Number(mockNgn?.price)) }]);
    const [real] = await makeOffRamp().indicativePrices({ sourceAsset: USDC, sourceAmount: "10" });

    expect(Number(real?.price)).toBeCloseTo(Number(mockNgn?.price), 4);
  });
});
