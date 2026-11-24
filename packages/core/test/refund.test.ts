import { describe, it, expect } from "vitest";
import fc from "fast-check";
import {
  REFUND_STATUSES,
  assertRefundTransition,
  canTransitionRefund,
  isRefundTerminal,
  linkRefundSummary,
  refundableAmount,
  validateRefundAmount,
  type Refund,
  type RefundStatus,
} from "../src/domain/refund";
import { fromStroops, toStroops } from "../src/domain/money";
import { LINK_STATUSES } from "../src/domain/status";
import * as core from "../src/index";

describe("refund status transitions", () => {
  // The whole table, written out: a transition is legal only if it is here.
  const LEGAL: ReadonlyArray<readonly [RefundStatus, RefundStatus]> = [
    ["prepared", "submitted"],
    ["prepared", "failed"],
    ["submitted", "confirmed"],
    ["submitted", "failed"],
  ];
  const isLegal = (from: RefundStatus, to: RefundStatus) => LEGAL.some(([f, t]) => f === from && t === to);

  it("has exactly these four statuses, in this order", () => {
    expect([...REFUND_STATUSES]).toEqual(["prepared", "submitted", "confirmed", "failed"]);
  });

  for (const from of REFUND_STATUSES) {
    for (const to of REFUND_STATUSES) {
      const legal = isLegal(from, to);
      it(`${legal ? "allows" : "forbids"} ${from} -> ${to}`, () => {
        expect(canTransitionRefund(from, to)).toBe(legal);
        if (legal) {
          expect(() => assertRefundTransition(from, to)).not.toThrow();
        } else {
          expect(() => assertRefundTransition(from, to)).toThrow(
            `Illegal refund status transition: ${from} -> ${to}`,
          );
        }
      });
    }
  }

  it("counts sixteen pairs, four of them legal", () => {
    const pairs = REFUND_STATUSES.flatMap((from) => REFUND_STATUSES.map((to) => [from, to] as const));
    expect(pairs).toHaveLength(16);
    expect(pairs.filter(([from, to]) => canTransitionRefund(from, to))).toEqual(LEGAL);
  });

  it("has confirmed and failed as its only terminal statuses", () => {
    expect(REFUND_STATUSES.filter(isRefundTerminal)).toEqual(["confirmed", "failed"]);
    for (const terminal of ["confirmed", "failed"] as const) {
      for (const to of REFUND_STATUSES) {
        expect(canTransitionRefund(terminal, to)).toBe(false);
      }
    }
  });

  it("does not let a refund skip being submitted, or go back", () => {
    expect(canTransitionRefund("prepared", "confirmed")).toBe(false);
    expect(canTransitionRefund("submitted", "prepared")).toBe(false);
  });
});

describe("link statuses", () => {
  it("are unchanged: a refund is not a link status", () => {
    expect([...LINK_STATUSES]).toEqual([
      "active",
      "paid",
      "underpaid",
      "expired",
      "cancelled",
      "offramp_pending",
      "offramp_settled",
      "offramp_failed",
    ]);
    expect(LINK_STATUSES.some((status) => status.includes("refund"))).toBe(false);
  });
});

describe("the package's exports", () => {
  it("include the refund model", () => {
    expect(core.REFUND_STATUSES).toBe(REFUND_STATUSES);
    expect(core.canTransitionRefund).toBe(canTransitionRefund);
    expect(core.assertRefundTransition).toBe(assertRefundTransition);
    expect(core.refundableAmount).toBe(refundableAmount);
    expect(core.validateRefundAmount).toBe(validateRefundAmount);
    expect(core.linkRefundSummary).toBe(linkRefundSummary);
  });
});

const refund = (amount: string, status: RefundStatus) => ({ amount, status });

describe("refundableAmount", () => {
  it("is the whole payment when nothing was refunded", () => {
    expect(refundableAmount("25", [])).toBe("25");
    expect(refundableAmount("10.50", [])).toBe("10.5");
  });

  it("subtracts one partial refund", () => {
    expect(refundableAmount("25", [refund("5", "confirmed")])).toBe("20");
  });

  it("subtracts several partial refunds", () => {
    expect(
      refundableAmount("25", [refund("5", "confirmed"), refund("2.5", "confirmed"), refund("0.0000001", "confirmed")]),
    ).toBe("17.4999999");
  });

  it("ignores a failed refund", () => {
    expect(refundableAmount("25", [refund("5", "failed")])).toBe("25");
    expect(refundableAmount("25", [refund("5", "failed"), refund("3", "confirmed")])).toBe("22");
  });

  it("counts a prepared refund, so two open sheets cannot both reserve the whole amount", () => {
    expect(refundableAmount("25", [refund("25", "prepared")])).toBe("0");
    expect(refundableAmount("25", [refund("10", "prepared")])).toBe("15");
  });

  it("counts a submitted refund", () => {
    expect(refundableAmount("25", [refund("10", "submitted")])).toBe("15");
  });

  it('returns "0" after an exact full refund', () => {
    expect(refundableAmount("25", [refund("25", "confirmed")])).toBe("0");
    expect(refundableAmount("25", [refund("10", "confirmed"), refund("15", "confirmed")])).toBe("0");
  });

  it("never goes below zero, even if the records say more went back than came in", () => {
    expect(refundableAmount("25", [refund("20", "confirmed"), refund("20", "submitted")])).toBe("0");
  });

  it("works in stroops, where floats would lose the last digit", () => {
    expect(refundableAmount("0.3", [refund("0.1", "confirmed"), refund("0.2", "confirmed")])).toBe("0");
    expect(refundableAmount("922337203685.4775807", [refund("0.0000001", "confirmed")])).toBe(
      "922337203685.4775806",
    );
  });

  it("throws on an amount that is not a Stellar amount", () => {
    expect(() => refundableAmount("twenty", [])).toThrow();
    expect(() => refundableAmount("25", [refund("1.123456789", "confirmed")])).toThrow();
  });

  const stroops = fc.bigInt({ min: 1n, max: 10n ** 15n });
  const someRefunds = fc.array(
    fc.record({ stroops, status: fc.constantFrom(...REFUND_STATUSES) }),
    { maxLength: 8 },
  );

  it("is the payment less what has not failed, floored at zero (property)", () => {
    fc.assert(
      fc.property(stroops, someRefunds, (payment, rows) => {
        const held = rows.filter((r) => r.status !== "failed").reduce((sum, r) => sum + r.stroops, 0n);
        const expected = payment > held ? payment - held : 0n;
        const got = refundableAmount(
          fromStroops(payment),
          rows.map((r) => refund(fromStroops(r.stroops), r.status)),
        );
        expect(toStroops(got)).toBe(expected);
        expect(toStroops(got) <= payment).toBe(true);
      }),
    );
  });

  it("leaves nothing once exactly what it offered has been refunded (property)", () => {
    fc.assert(
      fc.property(stroops, someRefunds, (payment, rows) => {
        const refunds = rows.map((r) => refund(fromStroops(r.stroops), r.status));
        const left = refundableAmount(fromStroops(payment), refunds);
        if (left === "0") return;
        expect(validateRefundAmount(left, left)).toEqual({ ok: true });
        expect(refundableAmount(fromStroops(payment), [...refunds, refund(left, "prepared")])).toBe("0");
      }),
    );
  });
});

describe("validateRefundAmount", () => {
  const no = (reason: string) => ({ ok: false, reason });

  it("accepts exactly what is refundable", () => {
    expect(validateRefundAmount("12.5", "12.5")).toEqual({ ok: true });
    expect(validateRefundAmount("12.50", "12.5")).toEqual({ ok: true });
    expect(validateRefundAmount("0.0000001", "0.0000001")).toEqual({ ok: true });
  });

  it("accepts less than what is refundable, down to one stroop", () => {
    expect(validateRefundAmount("5", "12.5")).toEqual({ ok: true });
    expect(validateRefundAmount("0.0000001", "12.5")).toEqual({ ok: true });
  });

  it("rejects one stroop over what is refundable", () => {
    expect(validateRefundAmount("12.5000001", "12.5")).toEqual(no("exceeds_refundable"));
    expect(validateRefundAmount("13", "12.5")).toEqual(no("exceeds_refundable"));
  });

  it("rejects zero", () => {
    expect(validateRefundAmount("0", "12.5")).toEqual(no("not_positive"));
    expect(validateRefundAmount("0.0000000", "12.5")).toEqual(no("not_positive"));
    expect(validateRefundAmount("0", "0")).toEqual(no("not_positive"));
  });

  it("rejects a negative amount", () => {
    expect(validateRefundAmount("-1", "12.5")).toEqual(no("not_positive"));
    expect(validateRefundAmount("-0.5", "12.5")).toEqual(no("not_positive"));
  });

  it("rejects more than 7 decimals", () => {
    expect(validateRefundAmount("1.12345678", "12.5")).toEqual(no("too_many_decimals"));
    // Also when the eighth decimal is a zero: it is still not a stroop amount as written.
    expect(validateRefundAmount("1.00000000", "12.5")).toEqual(no("too_many_decimals"));
    expect(validateRefundAmount("1.1234567", "12.5")).toEqual({ ok: true });
  });

  it("rejects what is not a decimal number", () => {
    for (const text of ["", " ", "abc", "1e3", "1,5", ".5", "5.", "+5", "0x10", "1.2.3", "NaN", "Infinity"]) {
      expect(validateRefundAmount(text, "12.5"), JSON.stringify(text)).toEqual(no("invalid_amount"));
    }
  });

  it("rejects anything when nothing is refundable", () => {
    expect(validateRefundAmount("0.0000001", "0")).toEqual(no("exceeds_refundable"));
  });

  it("rejects more than an account can hold as more than is refundable", () => {
    expect(validateRefundAmount("922337203685.4775808", "922337203685.4775807")).toEqual(
      no("exceeds_refundable"),
    );
    expect(validateRefundAmount("99999999999999999999", "25")).toEqual(no("exceeds_refundable"));
    // Whatever the records claim is left: no transaction could carry it.
    expect(validateRefundAmount("922337203685.4775808", "999999999999999")).toEqual(no("exceeds_refundable"));
    expect(validateRefundAmount("922337203685.4775807", "999999999999999")).toEqual({ ok: true });
  });

  it("compares amounts, not strings or floats", () => {
    // As strings "9" sorts after "10".
    expect(validateRefundAmount("9", "10")).toEqual({ ok: true });
    expect(validateRefundAmount("10", "9")).toEqual(no("exceeds_refundable"));
    // As floats 0.1 + 0.2 is more than 0.3.
    expect(validateRefundAmount("0.3", refundableAmount("0.6", [refund("0.1", "confirmed"), refund("0.2", "confirmed")]))).toEqual({
      ok: true,
    });
    expect(validateRefundAmount("10", "9.9999999")).toEqual(no("exceeds_refundable"));
  });

  it("ignores spaces around the amount", () => {
    expect(validateRefundAmount(" 5 ", "12.5")).toEqual({ ok: true });
  });

  it("throws when the refundable amount itself is malformed", () => {
    expect(() => validateRefundAmount("5", "lots")).toThrow();
    expect(() => validateRefundAmount("abc", "lots")).toThrow();
  });
});

describe("linkRefundSummary", () => {
  const TX_A = "a".repeat(64);
  const TX_B = "b".repeat(64);
  const payment = (txHash: string, operationId: string, amount: string) => ({ txHash, operationId, amount });
  const refundOf = (
    txHash: string,
    operationId: string,
    amount: string,
    status: RefundStatus,
  ): Pick<Refund, "paymentTxHash" | "paymentOperationId" | "amount" | "status"> => ({
    paymentTxHash: txHash,
    paymentOperationId: operationId,
    amount,
    status,
  });

  it("is empty for a link nobody has paid", () => {
    expect(linkRefundSummary([], [])).toEqual({ refundedAmount: "0", pendingAmount: "0", fullyRefunded: false });
  });

  it("is empty for a paid link with no refunds", () => {
    expect(linkRefundSummary([payment(TX_A, "1", "25")], [])).toEqual({
      refundedAmount: "0",
      pendingAmount: "0",
      fullyRefunded: false,
    });
  });

  it("reports a part refund, such as the overpaid part of a payment", () => {
    expect(linkRefundSummary([payment(TX_A, "1", "27")], [refundOf(TX_A, "1", "2", "confirmed")])).toEqual({
      refundedAmount: "2",
      pendingAmount: "0",
      fullyRefunded: false,
    });
  });

  it("reports a full refund once it is confirmed", () => {
    expect(linkRefundSummary([payment(TX_A, "1", "25")], [refundOf(TX_A, "1", "25", "confirmed")])).toEqual({
      refundedAmount: "25",
      pendingAmount: "0",
      fullyRefunded: true,
    });
  });

  it("reports a full refund made in parts", () => {
    const summary = linkRefundSummary(
      [payment(TX_A, "1", "25")],
      [refundOf(TX_A, "1", "10", "confirmed"), refundOf(TX_A, "1", "15", "confirmed")],
    );
    expect(summary).toEqual({ refundedAmount: "25", pendingAmount: "0", fullyRefunded: true });
  });

  it("keeps a refund that is prepared or submitted as pending, not refunded", () => {
    for (const status of ["prepared", "submitted"] as const) {
      expect(linkRefundSummary([payment(TX_A, "1", "25")], [refundOf(TX_A, "1", "25", status)])).toEqual({
        refundedAmount: "0",
        pendingAmount: "25",
        fullyRefunded: false,
      });
    }
  });

  it("adds prepared and submitted refunds together as pending", () => {
    const summary = linkRefundSummary(
      [payment(TX_A, "1", "25")],
      [refundOf(TX_A, "1", "5", "confirmed"), refundOf(TX_A, "1", "3", "prepared"), refundOf(TX_A, "1", "4", "submitted")],
    );
    expect(summary).toEqual({ refundedAmount: "5", pendingAmount: "7", fullyRefunded: false });
  });

  it("counts a failed refund nowhere", () => {
    expect(linkRefundSummary([payment(TX_A, "1", "25")], [refundOf(TX_A, "1", "25", "failed")])).toEqual({
      refundedAmount: "0",
      pendingAmount: "0",
      fullyRefunded: false,
    });
  });

  it("needs every payer refunded before the link is fully refunded", () => {
    const payments = [payment(TX_A, "1", "10"), payment(TX_B, "7", "15")];
    const one = linkRefundSummary(payments, [refundOf(TX_A, "1", "10", "confirmed")]);
    expect(one).toEqual({ refundedAmount: "10", pendingAmount: "0", fullyRefunded: false });
    const both = linkRefundSummary(payments, [
      refundOf(TX_A, "1", "10", "confirmed"),
      refundOf(TX_B, "7", "15", "confirmed"),
    ]);
    expect(both).toEqual({ refundedAmount: "25", pendingAmount: "0", fullyRefunded: true });
  });

  it("tells two payments in one transaction apart by their operation", () => {
    const payments = [payment(TX_A, "1", "10"), payment(TX_A, "2", "10")];
    const summary = linkRefundSummary(payments, [refundOf(TX_A, "1", "10", "confirmed")]);
    expect(summary.fullyRefunded).toBe(false);
    expect(
      linkRefundSummary(payments, [refundOf(TX_A, "1", "10", "confirmed"), refundOf(TX_A, "2", "10", "confirmed")])
        .fullyRefunded,
    ).toBe(true);
  });

  it("tells two payments with the same operation id in different transactions apart", () => {
    const payments = [payment(TX_A, "1", "10"), payment(TX_B, "1", "10")];
    const summary = linkRefundSummary(payments, [
      refundOf(TX_A, "1", "10", "confirmed"),
      refundOf(TX_A, "1", "10", "confirmed"),
    ]);
    expect(summary.fullyRefunded).toBe(false);
  });

  it("is not fooled by totals that match while one payer got nothing back", () => {
    // Bad records: 25 went back against a 10 payment. The other payer is still owed.
    const summary = linkRefundSummary(
      [payment(TX_A, "1", "10"), payment(TX_B, "7", "15")],
      [refundOf(TX_A, "1", "25", "confirmed")],
    );
    expect(summary).toEqual({ refundedAmount: "25", pendingAmount: "0", fullyRefunded: false });
  });

  it("adds in stroops", () => {
    const summary = linkRefundSummary(
      [payment(TX_A, "1", "0.3")],
      [
        refundOf(TX_A, "1", "0.1", "confirmed"),
        refundOf(TX_A, "1", "0.1", "confirmed"),
        refundOf(TX_A, "1", "0.1", "confirmed"),
      ],
    );
    expect(summary).toEqual({ refundedAmount: "0.3", pendingAmount: "0", fullyRefunded: true });
  });

  it("is one stroop short of fully refunded when one stroop is missing", () => {
    const summary = linkRefundSummary([payment(TX_A, "1", "25")], [refundOf(TX_A, "1", "24.9999999", "confirmed")]);
    expect(summary).toEqual({ refundedAmount: "24.9999999", pendingAmount: "0", fullyRefunded: false });
  });
});
