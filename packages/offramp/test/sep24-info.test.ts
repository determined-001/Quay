import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getSep24Info,
  clearSep24InfoCache,
  validateSep24Withdraw,
  AnchorLimitError,
} from "../src/sep24";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid /sep24/info anchor response. */
function makeInfoResponse(overrides: object = {}) {
  return {
    withdraw: {
      USDC: {
        enabled: true,
        min_amount: 1,
        max_amount: 10000,
        fee_fixed: 0.5,
        fee_percent: 1,
        fee_minimum: 1,
        ...overrides,
      },
    },
  };
}

function mockFetch(body: object, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
}

// ---------------------------------------------------------------------------
// getSep24Info
// ---------------------------------------------------------------------------

describe("getSep24Info", () => {
  beforeEach(() => {
    clearSep24InfoCache();
    vi.stubGlobal("fetch", mockFetch(makeInfoResponse()));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearSep24InfoCache();
  });

  it("parses withdraw asset info correctly including fees and limits", async () => {
    const info = await getSep24Info("https://anchor-24-a.test");
    expect(info.withdraw["USDC"]).toBeDefined();
    expect(info.withdraw["USDC"]!.enabled).toBe(true);
    expect(info.withdraw["USDC"]!.minAmount).toBe(1);
    expect(info.withdraw["USDC"]!.maxAmount).toBe(10000);
    expect(info.withdraw["USDC"]!.feeFixed).toBe(0.5);
    expect(info.withdraw["USDC"]!.feePercent).toBe(1);
    expect(info.withdraw["USDC"]!.feeMinimum).toBe(1);
  });

  it("returns cached result on second call (fetch called once within 5 minutes)", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeInfoResponse(),
    });
    vi.stubGlobal("fetch", spy);
    await getSep24Info("https://anchor-24-cached.test");
    await getSep24Info("https://anchor-24-cached.test");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("fetches again after clearSep24InfoCache is called", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeInfoResponse(),
    });
    vi.stubGlobal("fetch", spy);
    await getSep24Info("https://anchor-24-cache-clear.test");
    expect(spy).toHaveBeenCalledTimes(1);

    clearSep24InfoCache("https://anchor-24-cache-clear.test");
    await getSep24Info("https://anchor-24-cache-clear.test");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("throws when the anchor returns a non-2xx status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "Service Unavailable",
      }),
    );
    await expect(getSep24Info("https://anchor-24-fail.test")).rejects.toThrow(
      "SEP-24 /info failed: 503",
    );
  });
});

// ---------------------------------------------------------------------------
// validateSep24Withdraw
// ---------------------------------------------------------------------------

describe("validateSep24Withdraw", () => {
  const baseInfo = {
    withdraw: {
      USDC: {
        enabled: true,
        minAmount: 10,
        maxAmount: 1000,
        feeFixed: 1,
        feePercent: 0.5,
        feeMinimum: 2,
      },
      DISABLED: {
        enabled: false,
        minAmount: 10,
        maxAmount: 1000,
      },
    },
  };

  it("validates amount within bounds successfully", () => {
    const asset = validateSep24Withdraw(baseInfo, "USDC", "100");
    expect(asset.enabled).toBe(true);
    expect(asset.minAmount).toBe(10);
    expect(asset.maxAmount).toBe(1000);
  });

  it("throws AnchorLimitError when asset is not listed", () => {
    expect(() => validateSep24Withdraw(baseInfo, "XLM", "100")).toThrow(
      AnchorLimitError,
    );
  });

  it("throws AnchorLimitError when asset withdrawal is disabled", () => {
    expect(() => validateSep24Withdraw(baseInfo, "DISABLED", "100")).toThrow(
      AnchorLimitError,
    );
  });

  it("throws AnchorLimitError when amount is below minimum", () => {
    try {
      validateSep24Withdraw(baseInfo, "USDC", "5");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnchorLimitError);
      const e = err as AnchorLimitError;
      expect(e.limits.minAmount).toBe(10);
      expect(e.limits.maxAmount).toBe(1000);
      expect(e.message).toContain("below the anchor's minimum");
    }
  });

  it("throws AnchorLimitError when amount is above maximum", () => {
    try {
      validateSep24Withdraw(baseInfo, "USDC", "5000");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AnchorLimitError);
      const e = err as AnchorLimitError;
      expect(e.limits.minAmount).toBe(10);
      expect(e.limits.maxAmount).toBe(1000);
      expect(e.message).toContain("above the anchor's maximum");
    }
  });

  it("throws AnchorLimitError when amount is not a number", () => {
    expect(() =>
      validateSep24Withdraw(baseInfo, "USDC", "not-a-number"),
    ).toThrow(AnchorLimitError);
  });
});
