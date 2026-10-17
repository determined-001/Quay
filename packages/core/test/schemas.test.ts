import { describe, expect, it } from "vitest";
import {
  assetCodeSchema,
  cashOutSchema,
  createLinkSchema,
  listWebhookDeliveriesQuerySchema,
  registerWebhookSchema,
  submitPaymentSchema,
  transferSentSchema,
} from "../src/schemas";

describe("assetCodeSchema", () => {
  it("accepts allowed asset codes", () => {
    expect(assetCodeSchema.safeParse("USDC").success).toBe(true);
    expect(assetCodeSchema.safeParse("XLM").success).toBe(true);
  });

  it("rejects unlisted asset codes and invalid types", () => {
    expect(assetCodeSchema.safeParse("EUR").success).toBe(false);
    expect(assetCodeSchema.safeParse("").success).toBe(false);
    expect(assetCodeSchema.safeParse(123).success).toBe(false);
    expect(assetCodeSchema.safeParse(null).success).toBe(false);
  });
});

describe("submitPaymentSchema", () => {
  it("accepts signedXdr within bounds", () => {
    const res = submitPaymentSchema.safeParse({ signedXdr: "AAAA" });
    expect(res.success).toBe(true);
  });

  it("accepts signedXdr at upper bound of 64,000 characters", () => {
    const res = submitPaymentSchema.safeParse({
      signedXdr: "A".repeat(64_000),
    });
    expect(res.success).toBe(true);
  });

  it("rejects signedXdr exceeding 64,000 characters", () => {
    const res = submitPaymentSchema.safeParse({
      signedXdr: "A".repeat(64_001),
    });
    expect(res.success).toBe(false);
  });

  it("rejects empty or whitespace-only signedXdr", () => {
    expect(submitPaymentSchema.safeParse({ signedXdr: "" }).success).toBe(
      false,
    );
    expect(submitPaymentSchema.safeParse({ signedXdr: "   " }).success).toBe(
      false,
    );
  });
});

describe("createLinkSchema", () => {
  it("accepts valid payload and applies defaults", () => {
    const res = createLinkSchema.safeParse({
      title: "  Invoice #101  ",
      amount: "25.50",
    });
    expect(res.success).toBe(true);
    if (!res.success) return;
    expect(res.data.title).toBe("Invoice #101");
    expect(res.data.assetCode).toBe("USDC");
    expect(res.data.expiresInMinutes).toBeUndefined();
    expect(res.data.isDemo).toBeUndefined();
  });

  it("validates title bounds and trimming", () => {
    expect(
      createLinkSchema.safeParse({
        title: "T".repeat(120),
        amount: "10",
      }).success,
    ).toBe(true);

    expect(
      createLinkSchema.safeParse({
        title: "T".repeat(121),
        amount: "10",
      }).success,
    ).toBe(false);

    expect(
      createLinkSchema.safeParse({ title: "", amount: "10" }).success,
    ).toBe(false);
    expect(
      createLinkSchema.safeParse({ title: "   ", amount: "10" }).success,
    ).toBe(false);
  });

  it("validates amount boundaries with isValidAmount refinement", () => {
    expect(
      createLinkSchema.safeParse({ title: "Valid", amount: "0.0000001" })
        .success,
    ).toBe(true);
    expect(
      createLinkSchema.safeParse({ title: "Valid", amount: "100.1234567" })
        .success,
    ).toBe(true);
    // Note: "0" passes isValidAmount regex /^\d+(\.\d{1,7})?$/ (tracked in separate issue 1.10)
    expect(
      createLinkSchema.safeParse({ title: "Zero", amount: "0" }).success,
    ).toBe(true);

    expect(
      createLinkSchema.safeParse({ title: "Negative", amount: "-5" }).success,
    ).toBe(false);
    expect(
      createLinkSchema.safeParse({ title: "8 decimals", amount: "1.12345678" })
        .success,
    ).toBe(false);
    expect(
      createLinkSchema.safeParse({ title: "Letters", amount: "abc" }).success,
    ).toBe(false);
    expect(
      createLinkSchema.safeParse({ title: "Empty", amount: "" }).success,
    ).toBe(false);
  });

  it("validates expiresInMinutes boundaries", () => {
    const maxMinutes = 60 * 24 * 30; // 43,200
    expect(
      createLinkSchema.safeParse({
        title: "Max expiry",
        amount: "10",
        expiresInMinutes: maxMinutes,
      }).success,
    ).toBe(true);

    expect(
      createLinkSchema.safeParse({
        title: "Exceeds max",
        amount: "10",
        expiresInMinutes: maxMinutes + 1,
      }).success,
    ).toBe(false);

    expect(
      createLinkSchema.safeParse({
        title: "Zero minutes",
        amount: "10",
        expiresInMinutes: 0,
      }).success,
    ).toBe(false);

    expect(
      createLinkSchema.safeParse({
        title: "Negative minutes",
        amount: "10",
        expiresInMinutes: -1,
      }).success,
    ).toBe(false);

    expect(
      createLinkSchema.safeParse({
        title: "Non-integer minutes",
        amount: "10",
        expiresInMinutes: 10.5,
      }).success,
    ).toBe(false);
  });

  it("accepts isDemo boolean flag", () => {
    const resTrue = createLinkSchema.safeParse({
      title: "Demo",
      amount: "10",
      isDemo: true,
    });
    expect(resTrue.success).toBe(true);
    if (resTrue.success) {
      expect(resTrue.data.isDemo).toBe(true);
    }

    const resFalse = createLinkSchema.safeParse({
      title: "Demo",
      amount: "10",
      isDemo: false,
    });
    expect(resFalse.success).toBe(true);
    if (resFalse.success) {
      expect(resFalse.data.isDemo).toBe(false);
    }

    expect(
      createLinkSchema.safeParse({
        title: "Demo",
        amount: "10",
        isDemo: "yes",
      }).success,
    ).toBe(false);
  });
});

describe("registerWebhookSchema", () => {
  it("accepts valid URL", () => {
    expect(
      registerWebhookSchema.safeParse({ url: "https://example.com/webhook" })
        .success,
    ).toBe(true);
    expect(
      registerWebhookSchema.safeParse({ url: "http://localhost:3000/api" })
        .success,
    ).toBe(true);
  });

  it("rejects invalid URLs", () => {
    expect(registerWebhookSchema.safeParse({ url: "not-a-url" }).success).toBe(
      false,
    );
    expect(registerWebhookSchema.safeParse({ url: "" }).success).toBe(false);
  });
});

describe("listWebhookDeliveriesQuerySchema", () => {
  it("coerces string limit and applies default", () => {
    const resDefault = listWebhookDeliveriesQuerySchema.safeParse({});
    expect(resDefault.success).toBe(true);
    if (resDefault.success) {
      expect(resDefault.data.limit).toBe(20);
      expect(resDefault.data.cursor).toBeUndefined();
    }

    const resCoerced = listWebhookDeliveriesQuerySchema.safeParse({
      limit: "50",
    });
    expect(resCoerced.success).toBe(true);
    if (resCoerced.success) {
      expect(resCoerced.data.limit).toBe(50);
    }
  });

  it("enforces limit bounds (1 to 100)", () => {
    expect(
      listWebhookDeliveriesQuerySchema.safeParse({ limit: 1 }).success,
    ).toBe(true);
    expect(
      listWebhookDeliveriesQuerySchema.safeParse({ limit: 100 }).success,
    ).toBe(true);
    expect(
      listWebhookDeliveriesQuerySchema.safeParse({ limit: 0 }).success,
    ).toBe(false);
    expect(
      listWebhookDeliveriesQuerySchema.safeParse({ limit: -1 }).success,
    ).toBe(false);
    expect(
      listWebhookDeliveriesQuerySchema.safeParse({ limit: 101 }).success,
    ).toBe(false);
    expect(
      listWebhookDeliveriesQuerySchema.safeParse({ limit: 1.5 }).success,
    ).toBe(false);
  });

  it("validates cursor trimming and minimum length", () => {
    const res = listWebhookDeliveriesQuerySchema.safeParse({
      cursor: "  cur_abc123  ",
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.cursor).toBe("cur_abc123");
    }

    expect(
      listWebhookDeliveriesQuerySchema.safeParse({ cursor: "" }).success,
    ).toBe(false);
    expect(
      listWebhookDeliveriesQuerySchema.safeParse({ cursor: "   " }).success,
    ).toBe(false);
  });
});

describe("cashOutSchema", () => {
  it("uppercases targetCurrency and applies defaults", () => {
    const res = cashOutSchema.safeParse({});
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.targetCurrency).toBe("NGN");
      expect(res.data.payoutFields).toEqual({});
      expect(res.data.quoteId).toBeUndefined();
      expect(res.data.withdrawType).toBeUndefined();
    }

    const resCustom = cashOutSchema.safeParse({
      targetCurrency: "usd",
      payoutFields: { bank: "044", account: "1234567890" },
      quoteId: "quote-99",
      withdrawType: "  bank_transfer  ",
    });
    expect(resCustom.success).toBe(true);
    if (resCustom.success) {
      expect(resCustom.data.targetCurrency).toBe("USD");
      expect(resCustom.data.payoutFields).toEqual({
        bank: "044",
        account: "1234567890",
      });
      expect(resCustom.data.quoteId).toBe("quote-99");
      expect(resCustom.data.withdrawType).toBe("bank_transfer");
    }
  });

  it("enforces targetCurrency length of 3", () => {
    expect(cashOutSchema.safeParse({ targetCurrency: "EUR" }).success).toBe(
      true,
    );
    expect(cashOutSchema.safeParse({ targetCurrency: "EU" }).success).toBe(
      false,
    );
    expect(cashOutSchema.safeParse({ targetCurrency: "USDC" }).success).toBe(
      false,
    );
    expect(cashOutSchema.safeParse({ targetCurrency: "" }).success).toBe(false);
  });

  it("rejects empty quoteId or empty withdrawType when provided", () => {
    expect(cashOutSchema.safeParse({ quoteId: "" }).success).toBe(false);
    expect(cashOutSchema.safeParse({ withdrawType: "" }).success).toBe(false);
    expect(cashOutSchema.safeParse({ withdrawType: "   " }).success).toBe(
      false,
    );
  });
});

describe("transferSentSchema", () => {
  const sampleHex =
    "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

  it("accepts 64-character lowercase hex", () => {
    const res = transferSentSchema.safeParse({ hash: sampleHex });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.hash).toBe(sampleHex);
    }
  });

  it("transforms uppercase 64-character hex to lowercase", () => {
    const upperHex = sampleHex.toUpperCase();
    const res = transferSentSchema.safeParse({ hash: `  ${upperHex}  ` });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.hash).toBe(sampleHex);
    }
  });

  it("rejects invalid hash length or non-hex characters", () => {
    expect(transferSentSchema.safeParse({ hash: "a".repeat(63) }).success).toBe(
      false,
    );
    expect(transferSentSchema.safeParse({ hash: "a".repeat(65) }).success).toBe(
      false,
    );
    expect(
      transferSentSchema.safeParse({
        hash: "g".repeat(64),
      }).success,
    ).toBe(false);
    expect(transferSentSchema.safeParse({ hash: "" }).success).toBe(false);
    expect(transferSentSchema.safeParse({ hash: "   " }).success).toBe(false);
  });
});
