import { describe, expect, it } from "vitest";
import { paidWithLine } from "../app/r/[reference]/page";
import type { PublicReceipt } from "../lib/api";

function makePaidWith(amount: string | null, code: string): { amount: string | null; code: string; issuer: string | null } {
  return { amount, code, issuer: null };
}

describe("paidWithLine", () => {
  it("returns empty array when paidWith is null", () => {
    expect(paidWithLine(null)).toEqual([]);
  });

  it("returns empty array when paidWith is empty", () => {
    expect(paidWithLine([])).toEqual([]);
  });

  it("renders a single paid-with entry", () => {
    expect(paidWithLine([makePaidWith("24.1234567", "XLM")])).toEqual(["24.1234567 XLM"]);
  });

  it("renders multiple paid-with entries as separate entries", () => {
    expect(
      paidWithLine([
        makePaidWith("10.00", "USDC"),
        makePaidWith("5.00", "XLM"),
      ]),
    ).toEqual(["10.00 USDC", "5.00 XLM"]);
  });

  it("omits amount when amount is null", () => {
    expect(paidWithLine([makePaidWith(null, "XLM")])).toEqual(["XLM"]);
  });
});
