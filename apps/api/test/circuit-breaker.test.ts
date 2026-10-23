import { describe, expect, it, vi } from "vitest";
import {
  AnchorAuthRequiredError,
  OffRampDisabledError,
  OffRampRejectedError,
  type OffRampInitiation,
  type OffRampJob,
  type OffRampPort,
  type OffRampQuote,
  type OfframpRequirementTypes,
} from "@checkout/core";
import {
  AnchorHttpError,
  AnchorRejectedError,
  Sep6ValidationError,
  getSep38Quote,
  startSep6Withdraw,
} from "@checkout/offramp";
import { CircuitBreakerOffRamp } from "../src/services/circuit-breaker";
import { metrics } from "../src/metrics";

const fakeQuote: OffRampQuote = {
  quoteId: "q1",
  sourceAsset: { code: "USDC", issuer: "G" },
  sourceAmount: "1",
  targetCurrency: "USD",
  targetAmount: "1",
  rate: "1",
  expiresAt: Date.now() + 60_000,
  fee: { amount: "0", currency: "USD", source: "estimated" },
  netTargetAmount: "1",
  quoteKind: "indicative",
};

const fakeJob: OffRampJob = {
  jobId: "j1",
  linkId: "lnk_1",
  status: "pending",
  targetCurrency: "USD",
  targetAmount: "1",
  rate: "1",
};

const fakeInitiation: OffRampInitiation = { kind: "fields", jobId: "j1" };

function fakePort(overrides: Partial<OffRampPort> = {}): OffRampPort {
  return {
    mode: "seller_initiated",
    quote: vi.fn(async () => fakeQuote),
    initiate: vi.fn(async () => fakeInitiation),
    status: vi.fn(async () => fakeJob),
    offrampRequirements: vi.fn(async (): Promise<OfframpRequirementTypes> => ({ types: [], defaultType: null })),
    ...overrides,
  };
}

describe("CircuitBreakerOffRamp", () => {
  it("passes calls through and stays closed while the adapter succeeds", async () => {
    const inner = fakePort();
    const breaker = new CircuitBreakerOffRamp(inner);

    await breaker.quote({ linkId: "lnk_1", sourceAsset: { code: "USDC", issuer: "G" }, sourceAmount: "1", targetCurrency: "USD", customer: { sellerId: "sel_1", account: "G" } });
    expect(breaker.getState()).toBe("closed");
    expect(inner.quote).toHaveBeenCalledTimes(1);
  });

  it("opens after the failure threshold and short-circuits further calls without touching the adapter", async () => {
    const status = vi.fn(async () => {
      throw new Error("anchor down");
    });
    const inner = fakePort({ status });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 2, cooldownMs: 60_000 });

    await expect(breaker.status("j1")).rejects.toThrow("anchor down");
    expect(breaker.getState()).toBe("closed"); // 1st failure, not yet at threshold
    await expect(breaker.status("j1")).rejects.toThrow("anchor down");
    expect(breaker.getState()).toBe("open"); // 2nd failure hits threshold

    await expect(breaker.status("j1")).rejects.toThrow(/circuit open/);
    expect(status).toHaveBeenCalledTimes(2); // 3rd call never reached the adapter
  });

  it("closes again after a successful half-open trial past the cooldown", async () => {
    let shouldFail = true;
    const status = vi.fn(async () => {
      if (shouldFail) throw new Error("down");
      return { ...fakeJob, status: "settled" as const };
    });
    const inner = fakePort({ status });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 1, cooldownMs: 10 });

    await expect(breaker.status("j1")).rejects.toThrow();
    expect(breaker.getState()).toBe("open");

    await new Promise((r) => setTimeout(r, 20)); // past cooldown
    shouldFail = false;
    const result = await breaker.status("j1");
    expect(result.status).toBe("settled");
    expect(breaker.getState()).toBe("closed");
  });

  it("getStateNumeric reflects closed=0, open=2", async () => {
    const inner = fakePort({
      quote: vi.fn(async () => {
        throw new Error("x");
      }),
    });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 1 });
    expect(breaker.getStateNumeric()).toBe(0);
    await expect(breaker.quote({ linkId: "lnk_1", sourceAsset: { code: "USDC", issuer: "G" }, sourceAmount: "1", targetCurrency: "USD", customer: { sellerId: "sel_1", account: "G" } })).rejects.toThrow();
    expect(breaker.getStateNumeric()).toBe(2);
  });

  it("does not count a seller without an anchor session as an anchor failure", async () => {
    const inner = fakePort({ quote: vi.fn(async () => Promise.reject(new AnchorAuthRequiredError("anchor.example"))) });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 1 });
    const input = {
      linkId: "lnk_1",
      sourceAsset: { code: "USDC", issuer: "G" },
      sourceAmount: "1",
      targetCurrency: "USD",
      customer: { sellerId: "sel_1", account: "G" },
    };

    await expect(breaker.quote(input)).rejects.toBeInstanceOf(AnchorAuthRequiredError);
    // One signed-out seller must not pause cash-outs for everyone else.
    expect(breaker.getState()).toBe("closed");
  });

  describe("indicativePrices forwarding", () => {
    it("exposes indicativePrices iff the inner adapter provides it", () => {
      const withoutPrices = new CircuitBreakerOffRamp(fakePort());
      expect(withoutPrices.indicativePrices).toBeUndefined();

      const innerWithPrices = fakePort({
        indicativePrices: vi.fn(async () => [
          { targetCurrency: "USD", price: "1.00", deliveryMethods: ["WIRE"] },
        ]),
      });
      const withPrices = new CircuitBreakerOffRamp(innerWithPrices);
      expect(typeof withPrices.indicativePrices).toBe("function");
    });

    it("forwards indicativePrices calls to inner adapter and passes results through", async () => {
      const mockResult = [{ targetCurrency: "USD", price: "0.99", deliveryMethods: ["WIRE"] }];
      const fn = vi.fn(async () => mockResult);
      const inner = fakePort({ indicativePrices: fn });
      const breaker = new CircuitBreakerOffRamp(inner);

      const input = {
        sourceAsset: { code: "USDC", issuer: "G" },
        sourceAmount: "10",
      };
      const res = await breaker.indicativePrices!(input);
      expect(res).toEqual(mockResult);
      expect(fn).toHaveBeenCalledWith(input);
      expect(breaker.getState()).toBe("closed");
    });

    it("trips the breaker on repeated indicativePrices failures", async () => {
      const fn = vi.fn(async () => {
        throw new Error("503 anchor unavailable");
      });
      const inner = fakePort({ indicativePrices: fn });
      const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 2 });

      const input = { sourceAsset: { code: "USDC", issuer: "G" }, sourceAmount: "10" };
      await expect(breaker.indicativePrices!(input)).rejects.toThrow("503 anchor unavailable");
      expect(breaker.getState()).toBe("closed");
      await expect(breaker.indicativePrices!(input)).rejects.toThrow("503 anchor unavailable");
      expect(breaker.getState()).toBe("open");

      await expect(breaker.indicativePrices!(input)).rejects.toThrow(/circuit open/);
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });
});

describe("CircuitBreakerOffRamp — rejected requests", () => {
  const input = {
    linkId: "lnk_1",
    sourceAsset: { code: "USDC", issuer: "G" },
    sourceAmount: "25",
    targetCurrency: "USD",
    customer: { sellerId: "sel_1", account: "G" },
  };

  it("never opens on out-of-range amounts (OffRampRejectedError)", async () => {
    const inner = fakePort({
      quote: vi.fn(async () => Promise.reject(new OffRampRejectedError("above max", { maxAmount: 10 }))),
    });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 3 });

    for (let i = 0; i < 10; i++) {
      await expect(breaker.quote(input)).rejects.toBeInstanceOf(OffRampRejectedError);
    }
    expect(breaker.getState()).toBe("closed");
    expect(inner.quote).toHaveBeenCalledTimes(10);
  });

  it("does not count Sep6ValidationError, which extends the generic rejection", async () => {
    const inner = fakePort({
      quote: vi.fn(async () => Promise.reject(new Sep6ValidationError("above max", { maxAmount: 10 }))),
    });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 1 });
    await expect(breaker.quote(input)).rejects.toBeInstanceOf(Sep6ValidationError);
    expect(breaker.getState()).toBe("closed");
  });

  it("does not count OffRampDisabledError as failure or error, and keeps breaker closed", async () => {
    metrics.anchorCallsTotal.reset();
    const inner = fakePort({
      quote: vi.fn(async () => Promise.reject(new OffRampDisabledError("quote"))),
    });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 1 });

    for (let i = 0; i < 5; i++) {
      await expect(breaker.quote(input)).rejects.toBeInstanceOf(OffRampDisabledError);
    }
    expect(breaker.getState()).toBe("closed");
    expect(inner.quote).toHaveBeenCalledTimes(5);
    expect(metrics.anchorCallsTotal.render()).not.toContain('status="error"');
  });

  it("still opens on genuine anchor failures", async () => {
    const inner = fakePort({ quote: vi.fn(async () => Promise.reject(new Error("502 from anchor"))) });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 3 });
    for (let i = 0; i < 3; i++) await expect(breaker.quote(input)).rejects.toThrow("502");
    expect(breaker.getState()).toBe("open");
  });
});

// Issue 3.29: a 400/403/404/422 the anchor chose to send is an answer, not an
// outage. One seller asking for a pair the anchor does not quote, or being told
// to finish KYC first, must not open the circuit and pause cash-outs for
// everybody. These go through the real SEP clients so the classification under
// test is the one production actually uses.
describe("CircuitBreakerOffRamp — anchor 4xx are answers, not outages", () => {
  const input = {
    linkId: "lnk_1",
    sourceAsset: { code: "USDC", issuer: "G" },
    sourceAmount: "25",
    targetCurrency: "USD",
    customer: { sellerId: "sel_1", account: "G" },
  };
  const initiateInput = {
    linkId: "lnk_1",
    quoteId: "q1",
    payout: { currency: "NGN", fields: {} },
    customer: { sellerId: "sel_1", account: "G" },
  };

  /** Stubs `fetch` with one anchor answer and hands back what the call threw. */
  async function errorFrom(status: number, body: string, call: () => Promise<unknown>): Promise<unknown> {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
    try {
      return await call().then(
        () => {
          throw new Error("expected the call to reject");
        },
        (err: unknown) => err,
      );
    } finally {
      globalThis.fetch = original;
    }
  }

  const withdrawError = (status: number, body: string) =>
    errorFrom(status, body, () =>
      startSep6Withdraw("https://anchor-reject.test", "jwt", {
        assetCode: "USDC",
        amount: "25",
        account: "GSELLER",
        type: "bank_account",
      }),
    );

  const quoteError = (status: number, body: string) =>
    errorFrom(status, body, () =>
      getSep38Quote("https://anchor-reject.test", "jwt", {
        sellAsset: { code: "USDC", issuer: "G" },
        sellAmount: "25",
        buyCurrency: "NGN",
      }),
    );

  function anchorCalls(method: string, status: string): number {
    const prefix = `anchor_calls_total{method="${method}",status="${status}"}`;
    const line = metrics.registry.render().split("\n").find((l) => l.startsWith(prefix));
    return line ? Number(line.split(" ").pop()) : 0;
  }

  it("never opens on a 400 and a 403 from /withdraw and a 400 from the quote", async () => {
    const withdraw400 = await withdrawError(
      400,
      JSON.stringify({ type: "non_interactive_customer_info_needed", fields: ["phone_number"] }),
    );
    const withdraw403 = await withdrawError(403, JSON.stringify({ type: "customer_info_status" }));
    const quote400 = await quoteError(400, JSON.stringify({ error: "unsupported asset pair" }));
    for (const err of [withdraw400, withdraw403, quote400]) {
      expect(err).toBeInstanceOf(AnchorRejectedError);
      expect(err).toBeInstanceOf(OffRampRejectedError);
    }

    const answers = [withdraw400, withdraw403, quote400];
    let step = 0;
    const next = () => answers[step++ % answers.length]!;
    const inner = fakePort({
      initiate: vi.fn(async () => Promise.reject(next())),
      quote: vi.fn(async () => Promise.reject(next())),
    });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 3 });

    const quoteRejectedBefore = anchorCalls("quote", "rejected");
    const quoteErrorBefore = anchorCalls("quote", "error");

    for (let i = 0; i < 10; i++) {
      await expect(breaker.initiate(initiateInput)).rejects.toBeInstanceOf(AnchorRejectedError);
      await expect(breaker.quote(input)).rejects.toBeInstanceOf(AnchorRejectedError);
    }

    // Past the threshold three times over — the circuit never moved.
    expect(breaker.getState()).toBe("closed");
    expect(breaker.getStateNumeric()).toBe(0);
    expect(inner.initiate).toHaveBeenCalledTimes(10);
    expect(inner.quote).toHaveBeenCalledTimes(10);

    // The metric must report these as rejections, not outages.
    expect(anchorCalls("quote", "rejected") - quoteRejectedBefore).toBe(10);
    expect(anchorCalls("quote", "error")).toBe(quoteErrorBefore);
    expect(anchorCalls("initiate", "rejected")).toBeGreaterThan(0);
  });

  it("still opens on a 502 from /withdraw and from the quote", async () => {
    const withdraw502 = await withdrawError(502, "upstream down");
    const quote502 = await quoteError(502, "upstream down");
    expect(withdraw502).toBeInstanceOf(AnchorHttpError);
    expect(quote502).toBeInstanceOf(AnchorHttpError);
    expect(withdraw502).not.toBeInstanceOf(AnchorRejectedError);

    const withdrawBreaker = new CircuitBreakerOffRamp(fakePort({ initiate: vi.fn(async () => Promise.reject(withdraw502)) }), {
      failureThreshold: 3,
    });
    for (let i = 0; i < 3; i++) await expect(withdrawBreaker.initiate(initiateInput)).rejects.toBeInstanceOf(AnchorHttpError);
    expect(withdrawBreaker.getState()).toBe("open");

    const quoteBreaker = new CircuitBreakerOffRamp(fakePort({ quote: vi.fn(async () => Promise.reject(quote502)) }), {
      failureThreshold: 3,
    });
    for (let i = 0; i < 3; i++) await expect(quoteBreaker.quote(input)).rejects.toBeInstanceOf(AnchorHttpError);
    expect(quoteBreaker.getState()).toBe("open");
  });

  it("stays closed on 404 and 422, the other two rejection statuses", async () => {
    const quote404 = await quoteError(404, JSON.stringify({ error: "pair not quoted" }));
    const withdraw422 = await withdrawError(422, JSON.stringify({ type: "error" }));
    expect(quote404).toBeInstanceOf(AnchorRejectedError);
    expect(withdraw422).toBeInstanceOf(AnchorRejectedError);

    const inner = fakePort({
      quote: vi.fn(async () => Promise.reject(quote404)),
      initiate: vi.fn(async () => Promise.reject(withdraw422)),
    });
    const breaker = new CircuitBreakerOffRamp(inner, { failureThreshold: 1 });
    for (let i = 0; i < 5; i++) {
      await expect(breaker.quote(input)).rejects.toBeInstanceOf(AnchorRejectedError);
      await expect(breaker.initiate(initiateInput)).rejects.toBeInstanceOf(AnchorRejectedError);
    }
    expect(breaker.getState()).toBe("closed");
  });

  it("opens on 429, which is rate-limiting and not an answer to the request", async () => {
    const quote429 = await quoteError(429, "slow down");
    expect(quote429).toBeInstanceOf(AnchorHttpError);
    const breaker = new CircuitBreakerOffRamp(fakePort({ quote: vi.fn(async () => Promise.reject(quote429)) }), {
      failureThreshold: 3,
    });
    for (let i = 0; i < 3; i++) await expect(breaker.quote(input)).rejects.toBeInstanceOf(AnchorHttpError);
    expect(breaker.getState()).toBe("open");
  });
});
