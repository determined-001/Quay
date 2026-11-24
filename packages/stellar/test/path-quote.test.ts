import { Asset, Horizon, Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { filterByPriceImpact, priceImpactBps, quoteStrictReceive, sendMaxFor } from "../src/path-quote";
import { FakeHorizonClient } from "./fake-horizon";

const USDC_ISSUER = Keypair.random().publicKey();
const EURC_ISSUER = Keypair.random().publicKey();
const AQUA_ISSUER = Keypair.random().publicKey();
const BUYER = "GBUYER00000000000000000000000000000000000000000000000000";
const USDC = { code: "USDC", issuer: USDC_ISSUER };

function pathRecord(
  overrides: Partial<Horizon.ServerApi.PaymentPathRecord>,
): Horizon.ServerApi.PaymentPathRecord {
  return {
    _links: { self: { href: "" } },
    path: [],
    source_amount: "1",
    source_asset_type: "native",
    source_asset_code: "",
    source_asset_issuer: "",
    destination_amount: "10",
    destination_asset_type: "credit_alphanum4",
    destination_asset_code: "USDC",
    destination_asset_issuer: USDC_ISSUER,
    ...overrides,
  };
}

describe("quoteStrictReceive", () => {
  it("returns a native source quote with the amount normalized", async () => {
    const fake = new FakeHorizonClient();
    fake.setStrictReceivePaths([
      pathRecord({ source_amount: "10.5000000" }),
    ]);

    const quotes = await quoteStrictReceive({
      client: fake,
      source: BUYER,
      destAsset: USDC,
      destAmount: "10",
    });

    expect(quotes).toEqual([
      { sourceAsset: { code: "XLM", issuer: null }, sourceAmount: "10.5", path: [] },
    ]);
    expect(fake.lastStrictReceivePathsCall()?.source).toBe(BUYER);
    expect(fake.lastStrictReceivePathsCall()?.destinationAmount).toBe("10");
  });

  it("returns an issued source quote and maps multi-hop paths", async () => {
    const fake = new FakeHorizonClient();
    fake.setStrictReceivePaths([
      pathRecord({
        source_asset_type: "credit_alphanum4",
        source_asset_code: "EURC",
        source_asset_issuer: EURC_ISSUER,
        source_amount: "9.25",
        path: [
          { asset_type: "credit_alphanum4", asset_code: "AQUA", asset_issuer: AQUA_ISSUER },
          { asset_type: "native", asset_code: "", asset_issuer: "" },
        ],
      }),
    ]);

    const quotes = await quoteStrictReceive({
      client: fake,
      source: BUYER,
      destAsset: USDC,
      destAmount: "10",
    });

    expect(quotes).toEqual([
      {
        sourceAsset: { code: "EURC", issuer: EURC_ISSUER },
        sourceAmount: "9.25",
        path: [
          { code: "AQUA", issuer: AQUA_ISSUER },
          { code: "XLM", issuer: null },
        ],
      },
    ]);
  });

  it("keeps only the cheapest record per source asset and sorts by code", async () => {
    const fake = new FakeHorizonClient();
    fake.setStrictReceivePaths([
      pathRecord({ source_amount: "12" }),
      pathRecord({
        source_asset_type: "credit_alphanum4",
        source_asset_code: "EURC",
        source_asset_issuer: EURC_ISSUER,
        source_amount: "9",
      }),
      pathRecord({ source_amount: "10.5" }),
      pathRecord({
        source_asset_type: "credit_alphanum4",
        source_asset_code: "AQUA",
        source_asset_issuer: AQUA_ISSUER,
        source_amount: "11",
      }),
    ]);

    const quotes = await quoteStrictReceive({
      client: fake,
      source: BUYER,
      destAsset: USDC,
      destAmount: "10",
    });

    expect(quotes.map((q) => [q.sourceAsset.code, q.sourceAmount])).toEqual([
      ["AQUA", "11"],
      ["EURC", "9"],
      ["XLM", "10.5"],
    ]);
  });

  it("sorts same-code assets deterministically by issuer", async () => {
    const fake = new FakeHorizonClient();
    const issuerA = Keypair.random().publicKey();
    const issuerB = Keypair.random().publicKey();
    fake.setStrictReceivePaths([
      pathRecord({
        source_asset_type: "credit_alphanum4",
        source_asset_code: "EURC",
        source_asset_issuer: issuerB,
        source_amount: "8",
      }),
      pathRecord({
        source_asset_type: "credit_alphanum4",
        source_asset_code: "EURC",
        source_asset_issuer: issuerA,
        source_amount: "9",
      }),
    ]);

    const quotes = await quoteStrictReceive({
      client: fake,
      source: BUYER,
      destAsset: USDC,
      destAmount: "10",
    });

    const [first, second] = [issuerA, issuerB].sort();
    expect(quotes.map((q) => q.sourceAsset.issuer)).toEqual([first, second]);
  });

  it("drops records whose source asset equals the destination asset", async () => {
    const fake = new FakeHorizonClient();
    fake.setStrictReceivePaths([
      pathRecord({
        source_asset_type: "credit_alphanum4",
        source_asset_code: "USDC",
        source_asset_issuer: USDC_ISSUER,
        source_amount: "10",
      }),
      pathRecord({ source_amount: "11" }),
    ]);

    const quotes = await quoteStrictReceive({
      client: fake,
      source: BUYER,
      destAsset: USDC,
      destAmount: "10",
    });

    expect(quotes).toHaveLength(1);
    expect(quotes[0]!.sourceAsset).toEqual({ code: "XLM", issuer: null });
  });

  it("returns an empty array when Horizon returns no records", async () => {
    const fake = new FakeHorizonClient();

    const quotes = await quoteStrictReceive({
      client: fake,
      source: BUYER,
      destAsset: USDC,
      destAmount: "10",
    });

    expect(quotes).toEqual([]);
  });

  it("passes an asset-list source through to Horizon as SDK assets", async () => {
    const fake = new FakeHorizonClient();
    fake.setStrictReceivePaths([
      pathRecord({
        source_asset_type: "credit_alphanum4",
        source_asset_code: "EURC",
        source_asset_issuer: EURC_ISSUER,
        source_amount: "9.25",
      }),
    ]);

    const quotes = await quoteStrictReceive({
      client: fake,
      source: [
        { code: "EURC", issuer: EURC_ISSUER },
        { code: "XLM", issuer: null },
      ],
      destAsset: USDC,
      destAmount: "10",
    });

    expect(quotes).toHaveLength(1);
    const call = fake.lastStrictReceivePathsCall();
    expect(Array.isArray(call?.source)).toBe(true);
    const assets = call?.source as Asset[];
    expect(assets.map((a) => a.code)).toEqual(["EURC", "XLM"]);
    expect(assets[0]!.issuer).toBe(EURC_ISSUER);
    expect(call?.destinationAsset.code).toBe("USDC");
    expect(call?.destinationAsset.issuer).toBe(USDC_ISSUER);
  });

  it("retries on a 503 and succeeds", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeHorizonClient();
      fake.failStrictReceivePaths({ response: { status: 503 } }, 2);
      fake.setStrictReceivePaths([pathRecord({ source_amount: "11" })]);

      const promise = quoteStrictReceive({
        client: fake,
        source: BUYER,
        destAsset: USDC,
        destAmount: "10",
      });
      await vi.advanceTimersByTimeAsync(5000);
      const quotes = await promise;

      expect(quotes).toHaveLength(1);
      expect(quotes[0]!.sourceAmount).toBe("11");
      expect(fake.strictReceivePathsCallCount()).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("sendMaxFor", () => {
  it("rounds 12.3456789 at 100 bps up to 12.4691357", () => {
    expect(sendMaxFor("12.3456789", 100)).toBe("12.4691357");
  });

  it("never rounds down at the stroop boundary", () => {
    // 1 stroop + 1 bp of slippage is 1.0001 stroops: it must cost 2 stroops.
    expect(sendMaxFor("0.0000001", 1)).toBe("0.0000002");
  });

  it("returns the same amount at 0 bps", () => {
    expect(sendMaxFor("10.5", 0)).toBe("10.5");
  });

  it("keeps an exactly divisible result exact", () => {
    expect(sendMaxFor("1", 100)).toBe("1.01");
  });

  it("rejects negative slippage", () => {
    expect(() => sendMaxFor("1", -1)).toThrow(/non-negative integer/);
  });

  it("rejects an invalid amount", () => {
    expect(() => sendMaxFor("abc", 100)).toThrow(/Invalid Stellar amount/);
  });
});

describe("priceImpactBps (issue #547)", () => {
  // Full quote: 100 USDC delivered for 1000 XLM (10 XLM per USDC).
  const full = { sourceAmount: "1000", destAmount: "100" };

  it("is 0 when the full amount costs the same per unit as the 1% slice", () => {
    expect(priceImpactBps(full, { sourceAmount: "10", destAmount: "1" })).toBe(0);
  });

  it("measures how much more the full amount costs per unit", () => {
    // Slice: 1 USDC for 9.5 XLM. Full is 10/9.5 - 1 = 5.263...% worse -> 527 bps (ceil).
    expect(priceImpactBps(full, { sourceAmount: "9.5", destAmount: "1" })).toBe(527);
  });

  it("is 0, not negative, when the full amount is cheaper per unit", () => {
    expect(priceImpactBps(full, { sourceAmount: "11", destAmount: "1" })).toBe(0);
  });

  it("rounds up at stroop precision, so a borderline book reads as thinner", () => {
    // Full costs 1 stroop more than an exact 3% impact.
    const borderline = { sourceAmount: "1030.0000001", destAmount: "100" };
    expect(priceImpactBps(borderline, { sourceAmount: "10", destAmount: "1" })).toBe(301);
    expect(priceImpactBps({ sourceAmount: "1030", destAmount: "100" }, { sourceAmount: "10", destAmount: "1" })).toBe(300);
  });

  it("refuses zero amounts instead of dividing by zero", () => {
    expect(() => priceImpactBps(full, { sourceAmount: "0", destAmount: "1" })).toThrow(/positive amounts/);
    expect(() => priceImpactBps({ sourceAmount: "1", destAmount: "0" }, full)).toThrow(/positive amounts/);
  });
});

describe("filterByPriceImpact (issue #547)", () => {
  const xlm = { asset: "XLM", priceImpactBps: 120 };
  const aqua = { asset: "AQUA", priceImpactBps: 300 };
  const thin = { asset: "THIN", priceImpactBps: 301 };

  it("keeps options at or under the limit and drops the rest", () => {
    expect(filterByPriceImpact([xlm, aqua, thin], 300)).toEqual({ options: [xlm, aqua], reason: null });
  });

  it("says no_path when every option is too thin, so the checkout offers only the link asset", () => {
    expect(filterByPriceImpact([thin], 300)).toEqual({ options: [], reason: "no_path" });
  });

  it("says no_path when there were no options at all", () => {
    expect(filterByPriceImpact([], 300)).toEqual({ options: [], reason: "no_path" });
  });
});
