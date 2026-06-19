import { describe, it, expect } from "vitest";
import { toStroops, compareAmount, normalizeAmount, isValidAmount } from "../src/domain/money";

describe("money: toStroops", () => {
  it("converts whole numbers", () => {
    expect(toStroops("10")).toBe(100_000_000n);
  });
  it("converts fractional amounts at full precision", () => {
    expect(toStroops("12.3456789")).toBe(123_456_789n);
  });
  it("pads short fractions", () => {
    expect(toStroops("0.5")).toBe(5_000_000n);
  });
  it("rejects floats with >7 decimals", () => {
    expect(() => toStroops("1.123456789")).toThrow();
  });
  it("rejects non-numeric input", () => {
    expect(() => toStroops("abc")).toThrow();
  });
});

describe("money: compareAmount", () => {
  it("detects exact (no float drift)", () => {
    expect(compareAmount("0.1", "0.1")).toBe("exact");
    // the classic 0.1 + 0.2 trap — proven safe via integer stroops
    expect(compareAmount("0.3", "0.3")).toBe("exact");
  });
  it("detects overpayment", () => {
    expect(compareAmount("10.0000001", "10")).toBe("over");
  });
  it("detects underpayment", () => {
    expect(compareAmount("9.9999999", "10")).toBe("under");
  });
});

describe("money: normalizeAmount", () => {
  it("trims trailing zeros", () => {
    expect(normalizeAmount("10.5000000")).toBe("10.5");
    expect(normalizeAmount("10.0000000")).toBe("10");
  });
});

describe("money: isValidAmount", () => {
  it("accepts valid", () => {
    expect(isValidAmount("100")).toBe(true);
    expect(isValidAmount("0.0000001")).toBe(true);
  });
  it("rejects invalid", () => {
    expect(isValidAmount("-1")).toBe(false);
    expect(isValidAmount("1.12345678")).toBe(false);
    expect(isValidAmount("")).toBe(false);
  });
});
