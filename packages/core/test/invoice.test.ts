import { describe, expect, it } from "vitest";
import {
  formatInvoiceNumber,
  invoiceStatus,
  invoiceTotal,
  type InvoiceLineItem,
  type InvoiceState,
} from "../src/domain/invoice";
import { LINK_STATUSES, type LinkStatus } from "../src/domain/status";
import { MAX_AMOUNT } from "../src/domain/money";
import { createInvoiceSchema, updateInvoiceSchema } from "../src/schemas";

describe("formatInvoiceNumber", () => {
  it("formats positive numbers with at least 4 digits", () => {
    expect(formatInvoiceNumber(1)).toBe("INV-0001");
    expect(formatInvoiceNumber(42)).toBe("INV-0042");
    expect(formatInvoiceNumber(999)).toBe("INV-0999");
    expect(formatInvoiceNumber(1000)).toBe("INV-1000");
    expect(formatInvoiceNumber(9999)).toBe("INV-9999");
  });

  it("grows past 9999", () => {
    expect(formatInvoiceNumber(10000)).toBe("INV-10000");
    expect(formatInvoiceNumber(123456)).toBe("INV-123456");
  });

  it("throws on non-positive or non-integer numbers", () => {
    expect(() => formatInvoiceNumber(0)).toThrow();
    expect(() => formatInvoiceNumber(-5)).toThrow();
    expect(() => formatInvoiceNumber(1.5)).toThrow();
  });
});

describe("invoiceTotal (exact arithmetic, no floats)", () => {
  it("computes exact totals: 3 x 0.1000001 = 0.3000003", () => {
    const items: InvoiceLineItem[] = [{ description: "Widget", quantity: 3, unitPrice: "0.1000001" }];
    expect(invoiceTotal(items)).toBe("0.3000003");
  });

  it("computes exact totals: 100000 x 0.0000001 = 0.01", () => {
    const items: InvoiceLineItem[] = [{ description: "Tiny", quantity: 100_000, unitPrice: "0.0000001" }];
    expect(invoiceTotal(items)).toBe("0.01");
  });

  it("sums multiple line items exactly", () => {
    const items: InvoiceLineItem[] = [
      { description: "Item A", quantity: 2, unitPrice: "10.5000000" }, // 21.0
      { description: "Item B", quantity: 5, unitPrice: "1.1000001" }, // 5.5000005
    ];
    expect(invoiceTotal(items)).toBe("26.5000005");
  });

  it("throws when total exceeds MAX_AMOUNT", () => {
    const items: InvoiceLineItem[] = [
      { description: "Too big", quantity: 2, unitPrice: MAX_AMOUNT },
    ];
    expect(() => invoiceTotal(items)).toThrow(/exceeds/i);
  });

  it("throws when items array is empty", () => {
    expect(() => invoiceTotal([])).toThrow();
  });

  it("throws on 0 unit price or invalid quantity", () => {
    expect(() => invoiceTotal([{ description: "Zero", quantity: 1, unitPrice: "0" }])).toThrow();
    expect(() => invoiceTotal([{ description: "Zero qty", quantity: 0, unitPrice: "10" }])).toThrow();
    expect(() => invoiceTotal([{ description: "Float qty", quantity: 1.5, unitPrice: "10" }])).toThrow();
  });
});

describe("invoiceStatus (matrix of states, link statuses, and due dates)", () => {
  const now = 1700000000000;
  const beforeDue = now + 100_000; // now < dueAt (not overdue)
  const afterDue = now - 100_000; // now > dueAt (past due)

  const allLinkStatuses: (LinkStatus | null)[] = [...LINK_STATUSES, null];

  describe("void stored state always wins", () => {
    for (const linkStatus of allLinkStatuses) {
      it(`returns void for linkStatus=${linkStatus} before due`, () => {
        expect(invoiceStatus({ state: "void", dueAt: beforeDue }, linkStatus, now)).toBe("void");
      });
      it(`returns void for linkStatus=${linkStatus} after due`, () => {
        expect(invoiceStatus({ state: "void", dueAt: afterDue }, linkStatus, now)).toBe("void");
      });
    }
  });

  describe("draft stored state stays draft", () => {
    for (const linkStatus of allLinkStatuses) {
      it(`returns draft for linkStatus=${linkStatus} before due`, () => {
        expect(invoiceStatus({ state: "draft", dueAt: beforeDue }, linkStatus, now)).toBe("draft");
      });
      it(`returns draft for linkStatus=${linkStatus} after due`, () => {
        expect(invoiceStatus({ state: "draft", dueAt: afterDue }, linkStatus, now)).toBe("draft");
      });
    }
  });

  describe("open stored state transitions", () => {
    it("cancelled link causes void (before and after due)", () => {
      expect(invoiceStatus({ state: "open", dueAt: beforeDue }, "cancelled", now)).toBe("void");
      expect(invoiceStatus({ state: "open", dueAt: afterDue }, "cancelled", now)).toBe("void");
    });

    const paidLinkStatuses: LinkStatus[] = [
      "paid",
      "offramp_pending",
      "offramp_settled",
      "offramp_failed",
    ];

    for (const pls of paidLinkStatuses) {
      it(`paid/offramp status (${pls}) yields paid before due`, () => {
        expect(invoiceStatus({ state: "open", dueAt: beforeDue }, pls, now)).toBe("paid");
      });
      it(`paid/offramp status (${pls}) yields paid after due`, () => {
        expect(invoiceStatus({ state: "open", dueAt: afterDue }, pls, now)).toBe("paid");
      });
    }

    const openBeforeDueStatuses: (LinkStatus | null)[] = ["active", "underpaid", "expired", null];

    for (const obs of openBeforeDueStatuses) {
      it(`linkStatus=${obs} before due yields open`, () => {
        expect(invoiceStatus({ state: "open", dueAt: beforeDue }, obs, now)).toBe("open");
      });
      it(`linkStatus=${obs} after due yields overdue`, () => {
        expect(invoiceStatus({ state: "open", dueAt: afterDue }, obs, now)).toBe("overdue");
      });
    }

    it("explicit rule: an underpaid link past due is overdue", () => {
      expect(invoiceStatus({ state: "open", dueAt: afterDue }, "underpaid", now)).toBe("overdue");
    });
  });
});

describe("invoice zod schemas", () => {
  const validFutureDue = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days in future

  const validPayload = {
    clientName: "Acme Corp",
    clientEmail: "billing@acme.com",
    clientAddress: "123 Main St, Suite 100",
    notes: "Net 30 payment terms.",
    assetCode: "USDC",
    lineItems: [
      { description: "Consulting", quantity: 10, unitPrice: "150.00" },
      { description: "Deployment", quantity: 1, unitPrice: "500.00" },
    ],
    dueAt: validFutureDue,
  };

  it("validates a complete valid invoice creation payload", () => {
    const res = createInvoiceSchema.safeParse(validPayload);
    expect(res.success).toBe(true);
  });

  it("defaults assetCode to USDC when omitted", () => {
    const { assetCode, ...rest } = validPayload;
    const res = createInvoiceSchema.safeParse(rest);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.assetCode).toBe("USDC");
    }
  });

  it("rejects 0 line items", () => {
    const res = createInvoiceSchema.safeParse({ ...validPayload, lineItems: [] });
    expect(res.success).toBe(false);
  });

  it("rejects 51 line items (exceeds max 50)", () => {
    const items = Array.from({ length: 51 }, (_, i) => ({
      description: `Item ${i + 1}`,
      quantity: 1,
      unitPrice: "10.00",
    }));
    const res = createInvoiceSchema.safeParse({ ...validPayload, lineItems: items });
    expect(res.success).toBe(false);
  });

  it("accepts exactly 50 line items", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      description: `Item ${i + 1}`,
      quantity: 1,
      unitPrice: "10.00",
    }));
    const res = createInvoiceSchema.safeParse({ ...validPayload, lineItems: items });
    expect(res.success).toBe(true);
  });

  it("rejects a past dueAt", () => {
    const pastDue = Date.now() - 1000;
    const res = createInvoiceSchema.safeParse({ ...validPayload, dueAt: pastDue });
    expect(res.success).toBe(false);
  });

  it("rejects dueAt more than 365 days in future", () => {
    const farFuture = Date.now() + 367 * 24 * 60 * 60 * 1000;
    const res = createInvoiceSchema.safeParse({ ...validPayload, dueAt: farFuture });
    expect(res.success).toBe(false);
  });

  it("rejects an invalid email address", () => {
    const res = createInvoiceSchema.safeParse({ ...validPayload, clientEmail: "not-an-email" });
    expect(res.success).toBe(false);
  });

  it("rejects 0 unit price", () => {
    const res = createInvoiceSchema.safeParse({
      ...validPayload,
      lineItems: [{ description: "Free item", quantity: 1, unitPrice: "0" }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects negative unit price", () => {
    const res = createInvoiceSchema.safeParse({
      ...validPayload,
      lineItems: [{ description: "Refund item", quantity: 1, unitPrice: "-10" }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects unit price with more than 7 decimals", () => {
    const res = createInvoiceSchema.safeParse({
      ...validPayload,
      lineItems: [{ description: "High precision", quantity: 1, unitPrice: "1.12345678" }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects 0 or negative quantity", () => {
    const res = createInvoiceSchema.safeParse({
      ...validPayload,
      lineItems: [{ description: "Bad qty", quantity: 0, unitPrice: "10" }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects quantity over 100,000", () => {
    const res = createInvoiceSchema.safeParse({
      ...validPayload,
      lineItems: [{ description: "Massive qty", quantity: 100_001, unitPrice: "10" }],
    });
    expect(res.success).toBe(false);
  });

  it("rejects clientName longer than 120 chars", () => {
    const res = createInvoiceSchema.safeParse({
      ...validPayload,
      clientName: "A".repeat(121),
    });
    expect(res.success).toBe(false);
  });

  it("updateInvoiceSchema allows partial updates", () => {
    expect(updateInvoiceSchema.safeParse({ notes: "Updated note" }).success).toBe(true);
    expect(updateInvoiceSchema.safeParse({ clientName: "New Client" }).success).toBe(true);
    expect(updateInvoiceSchema.safeParse({ dueAt: validFutureDue }).success).toBe(true);
    expect(updateInvoiceSchema.safeParse({}).success).toBe(true);
  });

  it("updateInvoiceSchema rejects invalid fields when provided", () => {
    expect(updateInvoiceSchema.safeParse({ clientEmail: "invalid-email" }).success).toBe(false);
    expect(updateInvoiceSchema.safeParse({ dueAt: Date.now() - 5000 }).success).toBe(false);
  });
});
