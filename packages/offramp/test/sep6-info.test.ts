import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getSep6Info, resolveWithdrawType, Sep6ValidationError } from "../src/sep6";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid /sep6/info anchor response. */
function makeInfoResponse(overrides: object = {}) {
  return {
    withdraw: {
      USDC: {
        enabled: true,
        min_amount: 1,
        max_amount: 10000,
        fee_fixed: 0.5,
        fee_percent: 0,
        types: {
          bank_account: {
            fields: {
              dest: { description: "Bank account number" },
              dest_extra: { description: "Routing number", optional: true },
            },
          },
        },
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
// getSep6Info
// ---------------------------------------------------------------------------

describe("getSep6Info", () => {
  beforeEach(() => {
    // Clear module-level cache between tests by re-importing — easiest approach
    // is to spy on global fetch.
    vi.stubGlobal("fetch", mockFetch(makeInfoResponse()));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    // Reset the internal cache by calling with a unique URL per test group.
  });

  it("parses withdraw asset info correctly", async () => {
    const info = await getSep6Info("https://anchor-a.test");
    expect(info.withdraw["USDC"]).toBeDefined();
    expect(info.withdraw["USDC"]!.enabled).toBe(true);
    expect(info.withdraw["USDC"]!.minAmount).toBe(1);
    expect(info.withdraw["USDC"]!.maxAmount).toBe(10000);
    expect(info.withdraw["USDC"]!.feeFixed).toBe(0.5);
  });

  it("parses types and field descriptors", async () => {
    const info = await getSep6Info("https://anchor-b.test");
    const types = info.withdraw["USDC"]!.types;
    expect(types["bank_account"]).toBeDefined();
    expect(types["bank_account"]!.fields["dest"]!.description).toBe("Bank account number");
    expect(types["bank_account"]!.fields["dest_extra"]!.optional).toBe(true);
  });

  it("returns cached result on second call (fetch called once)", async () => {
    const spy = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => makeInfoResponse(),
    });
    vi.stubGlobal("fetch", spy);
    await getSep6Info("https://anchor-c.test");
    await getSep6Info("https://anchor-c.test");
    expect(spy).toHaveBeenCalledTimes(1);
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
    await expect(getSep6Info("https://anchor-d.test")).rejects.toThrow("SEP-6 /info failed: 503");
  });
});

// ---------------------------------------------------------------------------
// resolveWithdrawType
// ---------------------------------------------------------------------------

describe("resolveWithdrawType", () => {
  afterEach(() => vi.unstubAllGlobals());

  const BASE = "https://anchor-resolve.test";

  function stubInfo(overrides: object = {}) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => makeInfoResponse(overrides),
      }),
    );
  }

  it("resolves the single enabled type automatically", async () => {
    stubInfo();
    const result = await resolveWithdrawType(`${BASE}/single`, "USDC", "100");
    expect(result.type).toBe("bank_account");
    expect(result.feeFixed).toBe(0.5);
    expect(result.feePercent).toBe(0);
  });

  it("uses preferredType when provided and valid", async () => {
    stubInfo({
      types: {
        bank_account: { fields: {} },
        cash: { fields: {} },
      },
    });
    const result = await resolveWithdrawType(`${BASE}/prefer`, "USDC", "100", "cash");
    expect(result.type).toBe("cash");
  });

  it("throws Sep6ValidationError when preferredType is not in /info", async () => {
    stubInfo();
    await expect(
      resolveWithdrawType(`${BASE}/bad-type`, "USDC", "100", "mobile_money"),
    ).rejects.toThrow(Sep6ValidationError);
  });

  it("throws Sep6ValidationError when multiple types present and no preference", async () => {
    stubInfo({
      types: {
        bank_account: { fields: {} },
        cash: { fields: {} },
      },
    });
    await expect(
      resolveWithdrawType(`${BASE}/ambiguous`, "USDC", "100"),
    ).rejects.toThrow(Sep6ValidationError);
  });

  it("throws Sep6ValidationError when amount is below asset min", async () => {
    stubInfo({ min_amount: 10 });
    await expect(
      resolveWithdrawType(`${BASE}/under-min`, "USDC", "5"),
    ).rejects.toThrow(Sep6ValidationError);
  });

  it("throws Sep6ValidationError when amount is above asset max", async () => {
    stubInfo({ max_amount: 500 });
    await expect(
      resolveWithdrawType(`${BASE}/over-max`, "USDC", "1000"),
    ).rejects.toThrow(Sep6ValidationError);
  });

  it("includes anchor limits in the thrown error", async () => {
    stubInfo({ min_amount: 10, max_amount: 500 });
    try {
      await resolveWithdrawType(`${BASE}/limits`, "USDC", "5");
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Sep6ValidationError);
      const e = err as Sep6ValidationError;
      expect(e.limits.minAmount).toBe(10);
      expect(e.limits.maxAmount).toBe(500);
    }
  });

  it("throws Sep6ValidationError when the asset is not in /info", async () => {
    stubInfo();
    await expect(
      resolveWithdrawType(`${BASE}/no-asset`, "XLM", "100"),
    ).rejects.toThrow(Sep6ValidationError);
  });

  it("throws Sep6ValidationError when asset is disabled", async () => {
    stubInfo({ enabled: false });
    await expect(
      resolveWithdrawType(`${BASE}/disabled`, "USDC", "100"),
    ).rejects.toThrow(Sep6ValidationError);
  });

  it("respects per-type min_amount when tighter than the asset level", async () => {
    stubInfo({
      min_amount: 1,
      types: {
        bank_account: {
          fields: {},
          min_amount: 50,
          max_amount: 10000,
        },
      },
    });
    // 10 is above asset min (1) but below type min (50)
    await expect(
      resolveWithdrawType(`${BASE}/type-min`, "USDC", "10"),
    ).rejects.toThrow(Sep6ValidationError);
  });
});
