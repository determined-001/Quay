import { describe, it, expect } from "vitest";
import {
  assetCodeSchema,
  submitPaymentSchema,
  createLinkSchema,
  registerWebhookSchema,
  listWebhookDeliveriesQuerySchema,
  cashOutSchema,
  transferSentSchema,
} from "../src/schemas";

// ── assetCodeSchema ──────────────────────────────────────────────────────────

describe("assetCodeSchema", () => {
  it("accepts the two MVP assets", () => {
    expect(assetCodeSchema.safeParse("USDC").success).toBe(true);
    expect(assetCodeSchema.safeParse("XLM").success).toBe(true);
  });

  it("rejects anything outside the allowlist, case-sensitively", () => {
    for (const code of ["BTC", "usdc", "xlm", "", "USDC "]) {
      expect(assetCodeSchema.safeParse(code).success).toBe(false);
    }
  });
});

// ── submitPaymentSchema ──────────────────────────────────────────────────────

describe("submitPaymentSchema", () => {
  it("accepts a body at the 64,000-character bound", () => {
    const parsed = submitPaymentSchema.safeParse({ signedXdr: "a".repeat(64_000) });
    expect(parsed.success).toBe(true);
  });

  it("trims before measuring, so padding does not spend the bound", () => {
    const parsed = submitPaymentSchema.safeParse({ signedXdr: "  abc  " });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.signedXdr).toBe("abc");
  });

  it("rejects 64,001 characters and anything empty after trimming", () => {
    expect(submitPaymentSchema.safeParse({ signedXdr: "a".repeat(64_001) }).success).toBe(false);
    expect(submitPaymentSchema.safeParse({ signedXdr: "" }).success).toBe(false);
    expect(submitPaymentSchema.safeParse({ signedXdr: "   " }).success).toBe(false);
    expect(submitPaymentSchema.safeParse({}).success).toBe(false);
  });
});

// ── createLinkSchema ─────────────────────────────────────────────────────────

describe("createLinkSchema", () => {
  it("trims the title and pins its bounds", () => {
    const parsed = createLinkSchema.safeParse({ title: "  Coffee fund  ", amount: "1" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.title).toBe("Coffee fund");

    expect(createLinkSchema.safeParse({ title: "a".repeat(120), amount: "1" }).success).toBe(true);
    expect(createLinkSchema.safeParse({ title: "a".repeat(121), amount: "1" }).success).toBe(false);
    expect(createLinkSchema.safeParse({ title: "   ", amount: "1" }).success).toBe(false);
    expect(createLinkSchema.safeParse({ amount: "1" }).success).toBe(false);
  });

  it("accepts amounts the money regex accepts and rejects the rest", () => {
    for (const amount of ["1", "0", "12.3456789", " 7 "]) {
      expect(createLinkSchema.safeParse({ title: "t", amount }).success).toBe(true);
    }
    for (const amount of ["", "abc", "1.12345678", "1.", ".5", "-1", "1e3", "   "]) {
      expect(createLinkSchema.safeParse({ title: "t", amount }).success).toBe(false);
    }
  });

  it("defaults assetCode to USDC and validates the allowlist", () => {
    const parsed = createLinkSchema.safeParse({ title: "t", amount: "1" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.assetCode).toBe("USDC");

    expect(createLinkSchema.safeParse({ title: "t", amount: "1", assetCode: "XLM" }).success).toBe(true);
    expect(createLinkSchema.safeParse({ title: "t", amount: "1", assetCode: "BTC" }).success).toBe(false);
  });

  it("pins expiresInMinutes to 43,200 minutes (30 days)", () => {
    expect(createLinkSchema.safeParse({ title: "t", amount: "1", expiresInMinutes: 43_200 }).success).toBe(true);
    expect(createLinkSchema.safeParse({ title: "t", amount: "1", expiresInMinutes: 43_201 }).success).toBe(false);
    for (const minutes of [0, -1, 1.5, Number.NaN, "60"]) {
      expect(createLinkSchema.safeParse({ title: "t", amount: "1", expiresInMinutes: minutes }).success).toBe(false);
    }
  });

  it("leaves expiresInMinutes and isDemo undefined when omitted, and types isDemo", () => {
    const parsed = createLinkSchema.safeParse({ title: "t", amount: "1" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.expiresInMinutes).toBeUndefined();
      expect(parsed.data.isDemo).toBeUndefined();
    }

    expect(createLinkSchema.safeParse({ title: "t", amount: "1", isDemo: true }).success).toBe(true);
    expect(createLinkSchema.safeParse({ title: "t", amount: "1", isDemo: "true" }).success).toBe(false);
  });
});

// ── registerWebhookSchema ────────────────────────────────────────────────────

describe("registerWebhookSchema", () => {
  it("accepts absolute http(s) URLs", () => {
    expect(registerWebhookSchema.safeParse({ url: "https://example.com/hooks/pay" }).success).toBe(true);
    expect(registerWebhookSchema.safeParse({ url: "http://localhost:3000/hook" }).success).toBe(true);
  });

  it("rejects anything that is not a URL", () => {
    for (const url of ["example.com", "/hooks/pay", "", "not a url"]) {
      expect(registerWebhookSchema.safeParse({ url }).success).toBe(false);
    }
    expect(registerWebhookSchema.safeParse({}).success).toBe(false);
  });
});

// ── listWebhookDeliveriesQuerySchema ─────────────────────────────────────────

describe("listWebhookDeliveriesQuerySchema", () => {
  it("applies the limit default and leaves cursor undefined", () => {
    const parsed = listWebhookDeliveriesQuerySchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.limit).toBe(20);
      expect(parsed.data.cursor).toBeUndefined();
    }
  });

  it("coerces the query string the URL gives it", () => {
    const parsed = listWebhookDeliveriesQuerySchema.safeParse({ limit: "25" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.limit).toBe(25);
  });

  it("pins the limit to 100 and rejects nonsense", () => {
    expect(listWebhookDeliveriesQuerySchema.safeParse({ limit: "100" }).success).toBe(true);
    expect(listWebhookDeliveriesQuerySchema.safeParse({ limit: 100 }).success).toBe(true);
    for (const limit of ["101", 101, "0", 0, "-1", "20.5", "abc"]) {
      expect(listWebhookDeliveriesQuerySchema.safeParse({ limit }).success).toBe(false);
    }
  });

  it("requires a non-empty cursor when one is given", () => {
    expect(listWebhookDeliveriesQuerySchema.safeParse({ cursor: "abc" }).success).toBe(true);
    expect(listWebhookDeliveriesQuerySchema.safeParse({ cursor: "" }).success).toBe(false);
    expect(listWebhookDeliveriesQuerySchema.safeParse({ cursor: "   " }).success).toBe(false);
  });
});

// ── cashOutSchema ────────────────────────────────────────────────────────────

describe("cashOutSchema", () => {
  it("defaults targetCurrency to NGN and payoutFields to {}", () => {
    const parsed = cashOutSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.targetCurrency).toBe("NGN");
      expect(parsed.data.payoutFields).toEqual({});
    }
  });

  it("upper-cases targetCurrency after trimming", () => {
    for (const [input, want] of [["ngn", "NGN"], [" ngn ", "NGN"]] as const) {
      const parsed = cashOutSchema.safeParse({ targetCurrency: input });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.targetCurrency).toBe(want);
    }
  });

  it("rejects targetCurrency that is not exactly three characters", () => {
    for (const targetCurrency of ["ng", "ngnn", "", "   "]) {
      expect(cashOutSchema.safeParse({ targetCurrency }).success).toBe(false);
    }
  });

  it("takes string payout fields and rejects other value types", () => {
    const parsed = cashOutSchema.safeParse({ payoutFields: { bank: "GTB", account: "0123456" } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.payoutFields).toEqual({ bank: "GTB", account: "0123456" });

    expect(cashOutSchema.safeParse({ payoutFields: { bank: 1 } }).success).toBe(false);
  });

  it("keeps withdrawType optional but non-empty when present", () => {
    expect(cashOutSchema.safeParse({ withdrawType: "cash" }).success).toBe(true);
    const parsed = cashOutSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.withdrawType).toBeUndefined();

    expect(cashOutSchema.safeParse({ withdrawType: "" }).success).toBe(false);
    expect(cashOutSchema.safeParse({ withdrawType: "   " }).success).toBe(false);
  });
});

// ── transferSentSchema ───────────────────────────────────────────────────────

describe("transferSentSchema", () => {
  const hash = "AB".repeat(32);

  it("accepts a 64-character hex hash and lower-cases it", () => {
    const parsed = transferSentSchema.safeParse({ hash });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.hash).toBe(hash.toLowerCase());
  });

  it("trims before validating", () => {
    const parsed = transferSentSchema.safeParse({ hash: `  ${hash}  ` });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.hash).toBe(hash.toLowerCase());
  });

  it("rejects 63 and 65 characters, and non-hex of the right length", () => {
    expect(transferSentSchema.safeParse({ hash: "a".repeat(63) }).success).toBe(false);
    expect(transferSentSchema.safeParse({ hash: "a".repeat(65) }).success).toBe(false);
    expect(transferSentSchema.safeParse({ hash: "g".repeat(64) }).success).toBe(false);
    expect(transferSentSchema.safeParse({ hash: "" }).success).toBe(false);
    expect(transferSentSchema.safeParse({}).success).toBe(false);
  });
});
