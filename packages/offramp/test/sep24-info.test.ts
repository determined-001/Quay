import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OffRampRejectedError } from "@checkout/core";
import { AnchorHttpError } from "../src/anchor-error";
import { AnchorOffRamp } from "../src/anchor";
import type { AnchorDiscovery, SellerAnchorAuth } from "../src/anchor-session";
import {
  clearSep24InfoCache,
  estimateSep24Fee,
  getSep24Info,
  validateSep24Withdraw,
  type Sep24AssetInfo,
} from "../src/sep24";
import { Sep6ValidationError } from "../src/sep6";
import { FakeOffRampStateRepository } from "./fake-state";

const BASE = "https://anchor.example/sep24";

function infoBody(overrides: object = {}) {
  return {
    withdraw: {
      USDC: {
        enabled: true,
        min_amount: 5,
        max_amount: 1000,
        fee_fixed: 1,
        fee_percent: 0.5,
        fee_minimum: 2,
        ...overrides,
      },
    },
  };
}

function stubFetch(body: object, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => clearSep24InfoCache());
afterEach(() => vi.unstubAllGlobals());

describe("getSep24Info", () => {
  it("parses limits and fees, and treats a missing or malformed number as unpublished", async () => {
    stubFetch(infoBody({ fee_percent: "0.5", max_amount: -3 }));
    const info = await getSep24Info(BASE);
    expect(info.withdraw.USDC).toEqual({
      enabled: true,
      minAmount: 5,
      maxAmount: undefined,
      feeFixed: 1,
      feePercent: undefined,
      feeMinimum: 2,
    });
  });

  it("only treats enabled: true as enabled", async () => {
    stubFetch(infoBody({ enabled: "yes" }));
    expect((await getSep24Info(BASE)).withdraw.USDC?.enabled).toBe(false);
  });

  it("fetches /info at most once per five minutes per base URL", async () => {
    const fetchFn = stubFetch(infoBody());
    vi.useFakeTimers();
    try {
      await getSep24Info(BASE);
      await getSep24Info(BASE);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
      await getSep24Info(BASE);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      await getSep24Info("https://other.example/sep24");
      expect(fetchFn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the anchor's response body out of the error message", async () => {
    stubFetch({ secret: "internal-host-42" }, 500);
    const err = await getSep24Info(BASE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AnchorHttpError);
    expect((err as Error).message).toBe("SEP-24 /info failed: 500");
    expect((err as Error).message).not.toContain("internal-host-42");
  });
});

describe("validateSep24Withdraw", () => {
  const info = { withdraw: { USDC: { enabled: true, minAmount: 5, maxAmount: 1000 }, XLM: { enabled: false } } };

  it("accepts an amount inside the limits, inclusive", () => {
    expect(validateSep24Withdraw(info, "USDC", "5").minAmount).toBe(5);
    expect(validateSep24Withdraw(info, "USDC", "1000").maxAmount).toBe(1000);
  });

  it("rejects below the minimum and above the maximum, carrying the anchor's limits", () => {
    for (const amount of ["4.99", "1000.01"]) {
      const err = (() => {
        try {
          validateSep24Withdraw(info, "USDC", amount);
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(Sep6ValidationError);
      expect(err).toBeInstanceOf(OffRampRejectedError);
      expect((err as Sep6ValidationError).limits).toEqual({ minAmount: 5, maxAmount: 1000 });
    }
  });

  it("rejects a non-numeric amount, an unlisted asset, and a disabled one", () => {
    expect(() => validateSep24Withdraw(info, "USDC", "abc")).toThrow(Sep6ValidationError);
    expect(() => validateSep24Withdraw(info, "EURC", "10")).toThrow(/does not list/);
    expect(() => validateSep24Withdraw(info, "XLM", "10")).toThrow(/disabled/);
  });
});

describe("estimateSep24Fee", () => {
  const asset = (a: Partial<Sep24AssetInfo>): Sep24AssetInfo => ({ enabled: true, ...a });

  it("fixed fee only", () => expect(estimateSep24Fee(asset({ feeFixed: 1.5 }), "100")).toBe(1.5));
  it("percent fee only", () => expect(estimateSep24Fee(asset({ feePercent: 2 }), "100")).toBe(2));
  it("fixed plus percent", () => expect(estimateSep24Fee(asset({ feeFixed: 1, feePercent: 0.5 }), "100")).toBe(1.5));
  it("minimum fee wins when the computed fee is lower", () => {
    expect(estimateSep24Fee(asset({ feeFixed: 1, feePercent: 0.5, feeMinimum: 5 }), "100")).toBe(5);
  });
  it("computed fee wins when above the minimum", () => {
    expect(estimateSep24Fee(asset({ feePercent: 10, feeMinimum: 5 }), "100")).toBe(10);
  });
  it("is null, not zero, when the anchor publishes no fee fields", () => {
    expect(estimateSep24Fee(asset({}), "100")).toBeNull();
  });
  it("is null for an unusable amount", () => {
    expect(estimateSep24Fee(asset({ feeFixed: 1 }), "abc")).toBeNull();
  });
});

describe("AnchorOffRamp.quote limit enforcement", () => {
  const USDC = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };
  const customer = { sellerId: "s1", account: "GSELLER" };

  function adapter() {
    const token = vi.fn(async () => "jwt");
    const discovery = {
      homeDomain: "anchor.example",
      get: async () => ({ transferServerSep24: BASE, anchorQuoteServer: "https://anchor.example/sep38" }),
    } as unknown as AnchorDiscovery;
    const auth = { token } as unknown as SellerAnchorAuth;
    return { token, offramp: new AnchorOffRamp({ discovery, auth, state: new FakeOffRampStateRepository() }) };
  }

  it("rejects an out-of-range amount before opening a session or calling SEP-38", async () => {
    const fetchFn = stubFetch(infoBody());
    const { offramp, token } = adapter();
    await expect(
      offramp.quote({ sourceAsset: USDC, sourceAmount: "1", targetCurrency: "NGN", customer }),
    ).rejects.toBeInstanceOf(OffRampRejectedError);
    expect(token).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1); // /info only, no SEP-38 quote
  });
});

describe("AnchorOffRamp.quote estimated fee (no SEP-38)", () => {
  const USDC = { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" };
  const customer = { sellerId: "s1", account: "GSELLER" };

  function build(opts: { quoteServer?: string; rate?: string | null } = {}) {
    const token = vi.fn(async () => "jwt");
    const rate = vi.fn(async () => ({
      rate: opts.rate ?? "1500",
      source: "static",
      asOf: Date.now(),
      expiresAt: Date.now() + 60_000,
    }));
    const discovery = {
      homeDomain: "anchor.example",
      get: async () => ({ transferServerSep24: BASE, anchorQuoteServer: opts.quoteServer }),
    } as unknown as AnchorDiscovery;
    const state = new FakeOffRampStateRepository();
    const offramp = new AnchorOffRamp({
      discovery,
      auth: { token } as unknown as SellerAnchorAuth,
      state,
      ...(opts.rate === null ? {} : { rateSource: { rate } }),
    });
    return { offramp, rate, token, state };
  }
  const quote = (o: AnchorOffRamp, amount = "100") =>
    o.quote({ sourceAsset: USDC, sourceAmount: amount, targetCurrency: "NGN", customer });

  it("quotes indicatively with the fee converted at the same rate, net rounded down", async () => {
    stubFetch(infoBody({ fee_fixed: 1, fee_percent: 0.5, fee_minimum: undefined }));
    const { offramp, state } = build();
    const q = await quote(offramp);
    // fee 1 + 0.5 = 1.5 USDC -> 2250 NGN; gross 150000; net 147750
    expect(q.quoteKind).toBe("indicative");
    expect(q.fee).toEqual({ amount: "2250.0000", currency: "NGN", source: "estimated" });
    expect(q.netTargetAmount).toBe("147750.0000");
    expect(q.targetAmount).toBe("150000.0000");
    const stored = await state.getQuote(q.quoteId);
    expect(stored?.quotedAmounts).toMatchObject({
      feeSource: "estimated",
      quoteKind: "indicative",
      netTargetAmount: "147750.0000",
    });
  });

  it("takes fee_minimum when it exceeds the computed fee", async () => {
    stubFetch(infoBody({ fee_fixed: 1, fee_percent: 0.5, fee_minimum: 5 }));
    const q = await quote(build().offramp);
    expect(q.fee.amount).toBe("7500.0000");
    expect(q.netTargetAmount).toBe("142500.0000");
  });

  it("refuses when /info publishes no fee fields (unknown fee is not zero)", async () => {
    stubFetch(infoBody({ fee_fixed: undefined, fee_percent: undefined, fee_minimum: undefined }));
    const { offramp, rate } = build();
    await expect(quote(offramp)).rejects.toThrow(/publishes no fee/);
    expect(rate).not.toHaveBeenCalled();
  });

  it("rejects with an OffRampRejectedError when the fee swallows the amount", async () => {
    stubFetch(infoBody({ min_amount: 1, fee_fixed: 10, fee_percent: 0, fee_minimum: undefined }));
    await expect(quote(build().offramp, "5")).rejects.toBeInstanceOf(OffRampRejectedError);
  });

  it("rejects when the rounded net is zero", async () => {
    stubFetch(infoBody({ min_amount: 1, fee_fixed: 0, fee_percent: 0, fee_minimum: 0 }));
    await expect(quote(build({ rate: "0.00001" }).offramp, "1")).rejects.toBeInstanceOf(OffRampRejectedError);
  });

  it("refuses without a rate source rather than inventing a rate", async () => {
    stubFetch(infoBody());
    await expect(quote(build({ rate: null }).offramp)).rejects.toThrow(/no rate source/);
  });

  it("does not open a session for the rate-source path", async () => {
    stubFetch(infoBody());
    const { offramp, token } = build();
    await quote(offramp);
    expect(token).not.toHaveBeenCalled();
  });

  it("never consults the rate source when SEP-38 exists", async () => {
    stubFetch(infoBody());
    const { offramp, rate } = build({ quoteServer: "https://anchor.example/sep38" });
    await quote(offramp).catch(() => undefined); // the stubbed SEP-38 reply is not a quote; only routing matters
    expect(rate).not.toHaveBeenCalled();
  });

  it("enforces limits before consulting the rate source", async () => {
    stubFetch(infoBody());
    const { offramp, rate } = build();
    await expect(quote(offramp, "1")).rejects.toBeInstanceOf(OffRampRejectedError);
    expect(rate).not.toHaveBeenCalled();
  });
});
