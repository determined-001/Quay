import { describe, expect, it } from "vitest";
import { computeIndicativeAmounts, parseDecimal } from "../src/quote-math";

describe("computeIndicativeAmounts", () => {
  it("computes the plain case exactly", () => {
    expect(computeIndicativeAmounts({ amount: "10", rate: "1600", feeFixed: 5, feePercent: 1 })).toEqual({
      ok: true,
      targetAmount: "16000.0000",
      feeAmount: "8160.0000",
      netTargetAmount: "7840.0000",
    });
  });

  it("treats absent fee fields as no fee", () => {
    expect(computeIndicativeAmounts({ amount: "2", rate: "1.5" })).toEqual({
      ok: true,
      targetAmount: "3.0000",
      feeAmount: "0.0000",
      netTargetAmount: "3.0000",
    });
  });

  it("rounds net DOWN and fee UP, and the three figures always reconcile", () => {
    // exact: gross 1.00005, fee 0.0000300015, net 1.0000199985
    const r = computeIndicativeAmounts({ amount: "1", rate: "1.00005", feeFixed: 0.00003 });
    expect(r).toEqual({ ok: true, netTargetAmount: "1.0000", feeAmount: "0.0001", targetAmount: "1.0001" });
    if (!r.ok) throw new Error("unreachable");
    expect(Number(r.netTargetAmount)).toBeLessThanOrEqual(1.0000199985);
    expect(Number(r.feeAmount)).toBeGreaterThanOrEqual(0.0000300015);
    expect((Number(r.netTargetAmount) + Number(r.feeAmount)).toFixed(4)).toBe(r.targetAmount);
  });

  it("does not use binary floats (0.1 + 0.2 style drift)", () => {
    const r = computeIndicativeAmounts({ amount: "0.3", rate: "3", feeFixed: 0.1 });
    // exact: gross 0.9, fee 0.3, net 0.6
    expect(r).toEqual({ ok: true, targetAmount: "0.9000", feeAmount: "0.3000", netTargetAmount: "0.6000" });
  });

  it("rejects a zero net", () => {
    expect(computeIndicativeAmounts({ amount: "10", rate: "1600", feeFixed: 10 })).toEqual({
      ok: false,
      reason: "non_positive_net",
    });
  });

  it("rejects a negative net", () => {
    expect(computeIndicativeAmounts({ amount: "10", rate: "1600", feeFixed: 20 })).toEqual({
      ok: false,
      reason: "non_positive_net",
    });
    expect(computeIndicativeAmounts({ amount: "10", rate: "1600", feePercent: 150 })).toEqual({
      ok: false,
      reason: "non_positive_net",
    });
  });

  it("rejects a tiny rate whose rounded net is zero", () => {
    expect(computeIndicativeAmounts({ amount: "1", rate: "0.00001" })).toEqual({ ok: false, reason: "zero_quote" });
  });

  it("parses exponent forms that String(number) produces", () => {
    expect(parseDecimal(1e-7)).toEqual({ n: 1n, d: 10_000_000n });
    expect(() => parseDecimal("abc")).toThrow();
  });
});
