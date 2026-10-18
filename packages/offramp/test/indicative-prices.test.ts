import { Networks } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { targetPerSourceRate } from "@checkout/core";
import { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { MockAnchorOffRamp } from "../src/mock-anchor";
import { getSep38Prices } from "../src/sep38";
import { TESTANCHOR_HOME_DOMAIN, TestAnchorOffRamp } from "../src/testanchor";
import { FakeAnchorSessionRepository, FakeOffRampStateRepository } from "./fake-state";

// ---------------------------------------------------------------------------
//  Issue 3.27 — Indicative SEP-38 prices came back inverted relative to the
//  firm quote next to them. GET /prices is SELL units per BUY unit; the core
//  `IndicativePrice` contract is "1 source = `price` target units". Offline:
//  every anchor response is a stubbed fetch, and the TOML served declares
//  ANCHOR_QUOTE_SERVER — this suite is about the SEP-38 prices path.
// ---------------------------------------------------------------------------

/** USDC sold, NGN bought: 0.00065 USDC per NGN, i.e. ~1538 NGN per USDC. */
const SEP38_PRICE = "0.00065";
const INVERTED = "1538.46153846"; // 1 / 0.00065, to the 8dp quote() uses

const PRICES_BODY = {
  buy_assets: [
    {
      asset: "iso4217:NGN",
      price: SEP38_PRICE,
      buy_delivery_methods: [{ name: "WIRE", description: "Bank wire" }],
    },
  ],
};

/** Base URL of the anchor the current test stands in for. */
let currentBase = "";

let counter = 0;
function stubAnchorFetch(pricesBody: unknown): void {
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
      if (url.includes("/prices")) {
        return { ok: true, status: 200, json: async () => pricesBody } as Response;
      }
      throw new Error(`offline test: unexpected fetch ${url}`);
    }),
  );
}

/** A fresh testanchor adapter whose SEP-1 discovery is served by a stubbed fetch. */
function offrampFor(pricesBody: unknown) {
  const n = ++counter;
  const homeDomain = `indicative-${n}.test`;
  currentBase = `https://anchor-ip-${n}.test`;
  stubAnchorFetch(pricesBody);
  const discovery = new AnchorDiscovery({ homeDomain, fallbackBaseUrl: currentBase });
  const sessions = new FakeAnchorSessionRepository();
  const auth = new SellerAnchorAuth({ discovery, sessions, networkPassphrase: Networks.TESTNET });
  const state = new FakeOffRampStateRepository();
  const offramp = new TestAnchorOffRamp({ discovery, auth, state });
  return { offramp, state };
}

const SOURCE_ASSET = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };

afterEach(() => vi.unstubAllGlobals());

describe("indicativePrices direction (issue 3.27)", () => {
  it("inverts the anchor's SEP-38 price to target-per-source", async () => {
    const { offramp } = offrampFor(PRICES_BODY);

    const prices = await offramp.indicativePrices({ sourceAsset: SOURCE_ASSET, sourceAmount: "10" });

    expect(prices).toHaveLength(1);
    // The bug this fixes: the raw "0.00065" used to be returned as the price
    // for 1 USDC — the dashboard then advertised ~0.00065 NGN per USDC.
    expect(prices[0]!.price).toBe(INVERTED);
    expect(prices[0]!.targetCurrency).toBe("NGN");
    expect(prices[0]!.deliveryMethods).toEqual(["WIRE"]);
    // source × rate = target, the same identity OffRampQuote.rate honours.
    expect(Number(prices[0]!.price) * 10).toBeCloseTo(15384.6153846, 4);
  });

  it("agrees with quote()'s conversion — indicative and firm point the same way", async () => {
    const { offramp } = offrampFor(PRICES_BODY);

    const prices = await offramp.indicativePrices({ sourceAsset: SOURCE_ASSET, sourceAmount: "10" });

    // Same helper, same 8dp precision, so a dashboard showing an indicative
    // rate beside a firm quote can never show two directions.
    expect(prices[0]!.price).toBe(targetPerSourceRate(SEP38_PRICE));
  });

  it("the mock and the testanchor adapter return the same direction", async () => {
    const { offramp } = offrampFor(PRICES_BODY);
    const mock = new MockAnchorOffRamp({ state: new FakeOffRampStateRepository() });

    const [real, mockPrices] = await Promise.all([
      offramp.indicativePrices({ sourceAsset: SOURCE_ASSET, sourceAmount: "10" }),
      mock.indicativePrices({ sourceAsset: SOURCE_ASSET, sourceAmount: "10" }),
    ]);

    const realNgn = real.find((p) => p.targetCurrency === "NGN")!;
    const mockNgn = mockPrices.find((p) => p.targetCurrency === "NGN")!;

    // Both are target-per-source: far more than 1 local unit per USDC. Before
    // the fix the real adapter returned 0.00065 while the mock returned 1650,
    // so mock and real anchors disagreed about which way the rate pointed.
    expect(Number(mockNgn.price)).toBeGreaterThan(1);
    expect(Number(realNgn.price)).toBeGreaterThan(1);
    // ...and each still round-trips against its own source of truth.
    expect(Number(mockNgn.price)).toBeCloseTo(1650, 8);
    expect(Number(realNgn.price) * Number(SEP38_PRICE)).toBeCloseTo(1, 8);
  });
});

describe("getSep38Prices skips malformed entries (issue 3.27)", () => {
  it("skips entries with no asset instead of throwing a TypeError", async () => {
    const { offramp } = offrampFor({
      buy_assets: [{ price: SEP38_PRICE }, { asset: null, price: SEP38_PRICE }, PRICES_BODY.buy_assets[0]],
    });

    // Before the fix this threw `Cannot read properties of undefined (reading
    // 'match')` and failed the whole preview, every other corridor included.
    await expect(
      offramp.indicativePrices({ sourceAsset: SOURCE_ASSET, sourceAmount: "10" }),
    ).resolves.toEqual([
      { targetCurrency: "NGN", price: INVERTED, deliveryMethods: ["WIRE"] },
    ]);
  });

  it("skips non-numeric, non-positive and missing prices", async () => {
    const { offramp } = offrampFor({
      buy_assets: [
        { asset: "iso4217:NGN", price: "not-a-number" },
        { asset: "iso4217:NGN", price: "0" },
        { asset: "iso4217:NGN", price: "-1" },
        { asset: "iso4217:NGN" },
        PRICES_BODY.buy_assets[0],
      ],
    });

    const prices = await offramp.indicativePrices({ sourceAsset: SOURCE_ASSET, sourceAmount: "10" });

    expect(prices).toEqual([{ targetCurrency: "NGN", price: INVERTED, deliveryMethods: ["WIRE"] }]);
  });

  it("still ignores non-fiat assets and returns [] for an empty buy_assets", async () => {
    const { offramp } = offrampFor({
      buy_assets: [{ asset: "stellar:native", price: "0.4" }, { asset: "iso4217:NGN", price: "bad" }],
    });
    await expect(
      offramp.indicativePrices({ sourceAsset: SOURCE_ASSET, sourceAmount: "10" }),
    ).resolves.toEqual([]);

    const empty = await offrampFor({ buy_assets: [] }).offramp.indicativePrices({
      sourceAsset: SOURCE_ASSET,
      sourceAmount: "10",
    });
    expect(empty).toEqual([]);
  });

  it("accepts a numeric price from an anchor that sends one", async () => {
    const { offramp } = offrampFor({ buy_assets: [{ asset: "iso4217:NGN", price: 0.00065 }] });

    await expect(
      offramp.indicativePrices({ sourceAsset: SOURCE_ASSET, sourceAmount: "10" }),
    ).resolves.toEqual([{ targetCurrency: "NGN", price: INVERTED, deliveryMethods: [] }]);
  });

  it("getSep38Prices is the layer doing the skipping — no adapter involved", async () => {
    currentBase = "https://anchor-ip-direct.test";
    stubAnchorFetch({
      buy_assets: [{ price: "1" }, { asset: "iso4217:KES", price: "0" }, PRICES_BODY.buy_assets[0]],
    });

    const entries = await getSep38Prices(`${currentBase}/sep38`, {
      sellAsset: SOURCE_ASSET,
      sellAmount: "10",
    });

    expect(entries).toEqual([{ buyCurrency: "NGN", price: SEP38_PRICE, deliveryMethods: ["WIRE"] }]);
  });
});
