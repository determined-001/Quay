import { describe, expect, it } from "vitest";
import { cashOutQuoteQuerySchema, cashOutSchema, currencyCodeSchema } from "../src/schemas";

describe("currencyCodeSchema", () => {
  it("normalises lower-case 3-letter codes to upper-case and trims whitespace", () => {
    expect(currencyCodeSchema.parse("ngn")).toBe("NGN");
    expect(currencyCodeSchema.parse("  usd  ")).toBe("USD");
    expect(currencyCodeSchema.parse("EUR")).toBe("EUR");
  });

  it("rejects codes that are not 3 ASCII letters", () => {
    expect(currencyCodeSchema.safeParse("").success).toBe(false);
    expect(currencyCodeSchema.safeParse("NG").success).toBe(false);
    expect(currencyCodeSchema.safeParse("NGNN").success).toBe(false);
    expect(currencyCodeSchema.safeParse("N N").success).toBe(false);
    expect(currencyCodeSchema.safeParse("123").success).toBe(false);
    expect(currencyCodeSchema.safeParse("$$$").success).toBe(false);
  });
});

describe("cashOutSchema", () => {
  it("defaults targetCurrency to NGN and normalises lower-case", () => {
    expect(cashOutSchema.parse({}).targetCurrency).toBe("NGN");
    expect(cashOutSchema.parse({ targetCurrency: "kes" }).targetCurrency).toBe("KES");
  });

  it("rejects malformed targetCurrency", () => {
    expect(cashOutSchema.safeParse({ targetCurrency: "K" }).success).toBe(false);
    expect(cashOutSchema.safeParse({ targetCurrency: "KESS" }).success).toBe(false);
  });
});

describe("cashOutQuoteQuerySchema", () => {
  it("normalises targetCurrency and accepts optional withdrawType", () => {
    const res = cashOutQuoteQuerySchema.parse({ targetCurrency: "ngn", withdrawType: "bank_account" });
    expect(res).toEqual({ targetCurrency: "NGN", withdrawType: "bank_account" });
  });

  it("rejects missing or malformed targetCurrency", () => {
    expect(cashOutQuoteQuerySchema.safeParse({}).success).toBe(false);
    expect(cashOutQuoteQuerySchema.safeParse({ targetCurrency: "123" }).success).toBe(false);
  });
});
