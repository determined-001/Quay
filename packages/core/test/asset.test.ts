import { describe, expect, it } from "vitest";
import { assetEquals, XLM } from "../src/domain/payment-link";

describe("assetEquals", () => {
  it("distinguishes native XLM from an issued asset with the same code", () => {
    expect(assetEquals(XLM, { code: "XLM", issuer: "GISSUER" })).toBe(false);
    expect(assetEquals({ code: "XLM", issuer: "GISSUER" }, XLM)).toBe(false);
    expect(assetEquals(XLM, XLM)).toBe(true);
  });
});
