import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair, Networks } from "@stellar/stellar-sdk";
import type { AnchorCustomer, FxRate, RateSourcePort } from "@checkout/core";
import { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import { TestAnchorOffRamp } from "../src/testanchor";
import { RateUnavailableError, StaticRateSource } from "../src/rates";
import { clearSep6InfoCache } from "../src/sep6";
import type { Sep1DiscoveryInfo } from "../src/sep1";
import { FakeAnchorSessionRepository, FakeOffRampStateRepository } from "./fake-state";

/**
 * Issue 3.22 — quoting an anchor that has no SEP-38.
 *
 * The fixture TOML below is a real production shape: TRANSFER_SERVER,
 * WEB_AUTH_ENDPOINT, KYC_SERVER, DIRECT_PAYMENT_SERVER, no ANCHOR_QUOTE_SERVER.
 * Before this issue, `quote()` called SEP-38 unconditionally, so it built
 * `https://<domain>/sep38/quote` for an anchor that never published one, took a
 * 404, and tripped the circuit breaker. These tests assert the opposite: no
 * /sep38 request is made, the quote comes from the configured rate source, and
 * the fee is the anchor's own published fee.
 *
 * Everything is offline — fetch is stubbed, the adapter's discovery is pointed
 * at the fixture, and no anchor is contacted.
 */
const USDC_TESTNET_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** A production-shaped TOML: a real transfer server, and no quote server. */
const NO_SEP38_TOML = `
  VERSION = "2.0.0"
  NETWORK_PASSPHRASE = "Test SDF Network ; September 2015"
  WEB_AUTH_ENDPOINT = "https://cowrie.exchange/auth"
  TRANSFER_SERVER = "https://api.cowrie.exchange/sep6"
  KYC_SERVER = "https://api.cowrie.exchange/sep12"
  DIRECT_PAYMENT_SERVER = "https://api.cowrie.exchange/sep31"
  SIGNING_KEY = "GSIGNINGKEY"
  [DOCUMENTATION]
  ORG_NAME = "Cowrie Exchange"
  ORG_URL = "https://cowrie.exchange"
  [[CURRENCIES]]
  code = "USDC"
  issuer = "${USDC_TESTNET_ISSUER}"
  anchor_asset_type = "fiat"
  anchor_asset = "NGN"
`;

/** /sep6/info for the same anchor: withdraw enabled, with a fixed + percent fee. */
const SEP6_INFO = {
  withdraw: {
    USDC: {
      enabled: true,
      min_amount: 1,
      max_amount: 10000,
      types: {
        bank_account: {
          name: "bank_account",
          fields: { dest: { description: "Account number" } },
        },
      },
    },
  },
};

const CUSTOMER: AnchorCustomer = { sellerId: "sel_1", account: Keypair.random().publicKey() };

interface Wiring {
  offramp: TestAnchorOffRamp;
  /** Every URL fetched, so a test can assert nothing /sep38 was touched. */
  fetched: string[];
  state: FakeOffRampStateRepository;
}

function makeWiring(opts: { rateSource?: RateSourcePort; authToken?: string } = {}): Wiring {
  const fetched: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      fetched.push(url);
      if (url.includes("/sep6/info")) {
        return new Response(JSON.stringify(SEP6_INFO), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/sep38")) {
        // Must never be reached on this path. If it is, the test should fail
        // loudly rather than quietly pass on a 404.
        return new Response("SEP-38 must not be called", { status: 500 });
      }
      return new Response("", { status: 404 });
    }),
  );

  const discovery = new AnchorDiscovery({
    homeDomain: "cowrie.exchange",
    fallbackBaseUrl: "https://api.cowrie.exchange",
  });
  // Bypass discovery's network entirely and hand the adapter the parsed fixture.
  // (AnchorDiscovery has no injectable `get`; override the instance method.)
  (discovery as unknown as { get: () => Promise<Sep1DiscoveryInfo> }).get = async () => ({
    ...(await parseFixture()),
    homeDomain: "cowrie.exchange",
  });
  const auth = new SellerAnchorAuth({
    discovery,
    sessions: new FakeAnchorSessionRepository(),
    networkPassphrase: Networks.TESTNET,
  });
  // A seller is already signed in: token() would otherwise do SEP-10.
  (auth as unknown as { token: () => Promise<string> }).token = async () => opts.authToken ?? "jwt";

  const state = new FakeOffRampStateRepository();
  const offramp = new TestAnchorOffRamp({
    discovery,
    auth,
    state,
    preferredWithdrawType: "bank_account",
    ...(opts.rateSource ? { rateSource: opts.rateSource } : {}),
  });
  return { offramp, fetched, state };
}

async function parseFixture() {
  const { parseStellarToml } = await import("../src/sep1");
  return parseStellarToml(NO_SEP38_TOML, "cowrie.exchange");
}

function staticRate(over: Partial<ConstructorParameters<typeof StaticRateSource>[0]> = {}): RateSourcePort {
  return new StaticRateSource({
    rate: "1600",
    expiresAt: Date.now() + 3_600_000,
    anchorDomain: "cowrie.exchange",
    targetCurrency: "NGN",
    sourceAssetCode: "USDC",
    ...over,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Module-level and keyed by base URL — the two fixtures here share a host.
  clearSep6InfoCache();
});

describe("quote() against an anchor with no ANCHOR_QUOTE_SERVER (issue 3.22)", () => {
  it("makes no request to any /sep38 URL", async () => {
    const { offramp, fetched } = makeWiring({ rateSource: staticRate() });

    await offramp.quote({
      linkId: "lnk_1",
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "NGN",
      customer: CUSTOMER,
    });

    expect(fetched.some((u) => u.includes("sep38"))).toBe(false);
  });

  it("fees exactly feeFixed + amount * feePercent/100, converted at the same rate", async () => {
    const { offramp, state } = makeWiring({ rateSource: staticRate() });

    // feeFixed 5 + 10 * 1% = 6 USDC, converted at 1600 = 9600 NGN.
    const info = {
      withdraw: {
        USDC: {
          enabled: true,
          min_amount: 1,
          max_amount: 10000,
          fee_fixed: 5,
          fee_percent: 1,
          types: { bank_account: { name: "bank_account", fields: { dest: { description: "Account" } } } },
        },
      },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/sep6/info")) {
          return new Response(JSON.stringify(info), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("", { status: 404 });
      }),
    );

    const quote = await offramp.quote({
      linkId: "lnk_1",
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "NGN",
      customer: CUSTOMER,
    });

    expect(quote.fee.source).toBe("estimated");
    // The fee is published in the SELL asset: 5 + (10 * 1/100) = 5.1 USDC,
    // converted at 1600 = 8160 NGN. gross = 10 * 1600 = 16000, net = 7840.
    const expectedFee = (5 + 10 * (1 / 100)) * 1600;
    expect(Number(quote.fee.amount)).toBeCloseTo(expectedFee, 4);
    expect(Number(quote.targetAmount)).toBeCloseTo(10 * 1600, 4);
    expect(Number(quote.netTargetAmount)).toBeCloseTo(10 * 1600 - expectedFee, 4);
    expect(quote.rate).toBe("1600");
    expect(state).toBeDefined();
  });

  it("marks the quote indicative, so the seller is told before they commit", async () => {
    const { offramp } = makeWiring({ rateSource: staticRate() });

    const quote = await offramp.quote({
      linkId: "lnk_1",
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "NGN",
      customer: CUSTOMER,
    });

    expect(quote.quoteKind).toBe("indicative");
  });

  it("persists the quote with a locally generated q_ id and the rate's own expiry", async () => {
    const { offramp, state } = makeWiring({ rateSource: staticRate() });

    const quote = await offramp.quote({
      linkId: "lnk_1",
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "NGN",
      customer: CUSTOMER,
    });

    expect(quote.quoteId).toMatch(/^q_/);
    const stored = await state.getQuote(quote.quoteId);
    expect(stored).not.toBeNull();
    expect(stored?.expiresAt).toBe(quote.expiresAt);
    expect(stored?.withdrawType).toBe("bank_account");
  });

  it("refuses to quote when no rate source is configured, rather than inventing a rate", async () => {
    const { offramp, fetched } = makeWiring();

    await expect(
      offramp.quote({
        linkId: "lnk_1",
        sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
        sourceAmount: "10",
        targetCurrency: "NGN",
        customer: CUSTOMER,
      }),
    ).rejects.toThrow(/no rate source is configured/);

    // And it still never reached for a /sep38 URL it was never offered.
    expect(fetched.some((u) => u.includes("sep38"))).toBe(false);
  });

  it("propagates an expired rate as a refusal, not a stale quote", async () => {
    const { offramp } = makeWiring({
      rateSource: staticRate({ expiresAt: Date.now() - 1000 }),
    });

    await expect(
      offramp.quote({
        linkId: "lnk_1",
        sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
        sourceAmount: "10",
        targetCurrency: "NGN",
        customer: CUSTOMER,
      }),
    ).rejects.toThrow(/expired/);
  });

  it("indicativePrices() returns nothing instead of fetching a /sep38 that cannot exist", async () => {
    const { offramp, fetched } = makeWiring({ rateSource: staticRate() });

    const prices = await offramp.indicativePrices({
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
    });

    expect(prices).toEqual([]);
    expect(fetched.some((u) => u.includes("sep38"))).toBe(false);
  });
});

describe("SEP-38 path is unchanged when the anchor declares one", () => {
  it("keeps using the anchor's firm quote and marks it firm", async () => {
    const { parseStellarToml } = await import("../src/sep1");
    const withSep38 = parseStellarToml(
      NO_SEP38_TOML.replace(
        "  TRANSFER_SERVER =",
        '  ANCHOR_QUOTE_SERVER = "https://api.cowrie.exchange/sep38"\n  TRANSFER_SERVER =',
      ),
      "cowrie.exchange",
    );
    expect(withSep38.anchorQuoteServer).toBe("https://api.cowrie.exchange/sep38");

    const fetched: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        fetched.push(url);
        if (url.includes("/sep6/info")) {
          return new Response(JSON.stringify(SEP6_INFO), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.includes("/sep38/quote")) {
          return new Response(
            JSON.stringify({
              id: "anchor_quote_1",
              price: "0.000625", // 1600 NGN per USDC
              buy_amount: "15940",
              expires_at: new Date(Date.now() + 300_000).toISOString(),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("", { status: 404 });
      }),
    );

    const discovery = new AnchorDiscovery({
      homeDomain: "cowrie.exchange",
      fallbackBaseUrl: "https://api.cowrie.exchange",
    });
    (discovery as unknown as { get: () => Promise<Sep1DiscoveryInfo> }).get = async () => ({
      ...withSep38,
      homeDomain: "cowrie.exchange",
    });
    const auth = new SellerAnchorAuth({
      discovery,
      sessions: new FakeAnchorSessionRepository(),
      networkPassphrase: Networks.TESTNET,
    });
    (auth as unknown as { token: () => Promise<string> }).token = async () => "jwt";

    const offramp = new TestAnchorOffRamp({
      discovery,
      auth,
      state: new FakeOffRampStateRepository(),
      preferredWithdrawType: "bank_account",
    });

    const quote = await offramp.quote({
      linkId: "lnk_1",
      sourceAsset: { code: "USDC", issuer: USDC_TESTNET_ISSUER },
      sourceAmount: "10",
      targetCurrency: "NGN",
      customer: CUSTOMER,
    });

    expect(fetched.some((u) => u.includes("/sep38/quote"))).toBe(true);
    expect(quote.quoteId).toBe("anchor_quote_1");
    expect(quote.quoteKind).toBe("firm");
    expect(quote.fee.source).toBe("anchor");
  });
});

describe("StaticRateSource refusals", () => {
  const base = {
    rate: "1600",
    expiresAt: Date.now() + 60_000,
    anchorDomain: "cowrie.exchange",
    targetCurrency: "NGN",
  };

  it("requires an expiry at construction", () => {
    expect(
      () => new StaticRateSource({ ...base, expiresAt: undefined as unknown as number }),
    ).toThrow(/requires expiresAt/);
  });

  it("refuses a rate for a different anchor or currency", async () => {
    const source = new StaticRateSource(base);
    await expect(
      source.rate({ anchorDomain: "other.example", sourceAsset: { code: "USDC" }, targetCurrency: "NGN" }),
    ).rejects.toThrow(/configured for cowrie.exchange/);
    await expect(
      source.rate({ anchorDomain: "cowrie.exchange", sourceAsset: { code: "USDC" }, targetCurrency: "USD" }),
    ).rejects.toThrow(/configured for NGN/);
  });

  it("refuses a non-positive or unparsable rate", () => {
    expect(() => new StaticRateSource({ ...base, rate: "0" })).toThrow(/not a positive number/);
    expect(() => new StaticRateSource({ ...base, rate: "abc" })).toThrow(/not a positive number/);
  });

  it("accepts an ISO-8601 expiry", async () => {
    const source = new StaticRateSource({ ...base, expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const fx: FxRate = await source.rate({
      anchorDomain: "cowrie.exchange",
      sourceAsset: { code: "USDC" },
      targetCurrency: "NGN",
    });
    expect(fx.rate).toBe("1600");
    expect(fx.source).toBe("static");
  });
});

describe("RateUnavailableError", () => {
  it("is a typed error a caller can branch on", () => {
    const err = new RateUnavailableError("static", "no");
    expect(err).toBeInstanceOf(Error);
    expect(err.source).toBe("static");
    expect(err.name).toBe("RateUnavailableError");
  });
});
