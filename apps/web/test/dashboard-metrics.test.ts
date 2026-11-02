import { describe, expect, it } from "vitest";
import type { PaymentLink } from "../lib/api";
import {
  awaitingPayment,
  dailySeries,
  filterCounts,
  formatDollars,
  formatFiat,
  formatLinkAmount,
  humanStatus,
  matchesFilter,
  rangeStart,
  readyToCashOut,
  relativeTime,
  setupSteps,
  totalReceived,
} from "../lib/dashboard-metrics";

// Local noon on 2 Nov 2026, so day arithmetic cannot straddle midnight whatever
// timezone the test runs in.
const NOW = new Date(2026, 10, 2, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;

function link(over: Partial<PaymentLink> & { updatedAt?: number }): PaymentLink {
  return {
    id: "lnk_x",
    title: "Thing",
    amount: "10.00",
    asset: { code: "USDC", issuer: "GISSUER" },
    status: "paid",
    paidAmount: null,
    offrampStatus: null,
    updatedAt: NOW,
    createdAt: NOW,
    ...over,
  } as unknown as PaymentLink;
}

describe("totalReceived", () => {
  it("adds only paid statuses, only USDC, and prefers what was actually paid", () => {
    const links = [
      link({ status: "paid", amount: "10.00" }),
      link({ status: "offramp_settled", amount: "20.00" }),
      link({ status: "offramp_pending", amount: "5.00", paidAmount: "5.50" }), // an overpayment counts
      link({ status: "active", amount: "100.00" }), // not paid yet
      link({ status: "expired", amount: "100.00" }),
      link({ status: "paid", amount: "50", asset: { code: "XLM" } as PaymentLink["asset"] }), // never mixed in
    ];
    expect(totalReceived(links)).toBeCloseTo(35.5, 6);
  });

  it("bounds by the last-changed time when a start is given", () => {
    const links = [
      link({ amount: "10.00", updatedAt: NOW }),
      link({ amount: "7.00", updatedAt: NOW - 3 * DAY }),
      link({ amount: "3.00", updatedAt: NOW - 40 * DAY }),
    ];
    expect(totalReceived(links, rangeStart("7d", NOW))).toBeCloseTo(17, 6);
    expect(totalReceived(links, rangeStart("30d", NOW))).toBeCloseTo(17, 6);
    expect(totalReceived(links, rangeStart("all", NOW))).toBeCloseTo(20, 6);
  });

  it("is zero for no links and never NaN for a malformed amount", () => {
    expect(totalReceived([])).toBe(0);
    expect(totalReceived([link({ amount: "not-a-number" })])).toBe(0);
  });
});

describe("readyToCashOut and awaitingPayment", () => {
  it("counts paid and failed-cash-out links, but not ones already moving or done", () => {
    const links = [
      link({ status: "paid", amount: "10.00" }),
      link({ status: "offramp_failed", amount: "4.00" }),
      link({ status: "offramp_pending", amount: "9.00" }),
      link({ status: "offramp_settled", amount: "9.00" }),
    ];
    expect(readyToCashOut(links)).toEqual({ amount: 14, count: 2 });
  });

  it("counts open links and what is still to come in", () => {
    const links = [
      link({ status: "active", amount: "12.50" }),
      link({ status: "active", amount: "7.50" }),
      link({ status: "paid", amount: "99.00" }),
    ];
    expect(awaitingPayment(links)).toEqual({ count: 2, amount: 20 });
  });
});

describe("dailySeries", () => {
  it("gives one bucket per local day, oldest first and today last", () => {
    const s = dailySeries([], 7, NOW);
    expect(s).toHaveLength(7);
    expect(s[6]!.key).toBe("2026-11-02");
    expect(s[0]!.key).toBe("2026-10-27");
    expect(s.every((b) => b.total === 0)).toBe(true);
  });

  it("drops each paid USDC link into the day it last changed and ignores the rest", () => {
    const links = [
      link({ amount: "10.00", updatedAt: NOW }),
      link({ amount: "5.00", updatedAt: NOW - 2 * HOUR }),
      link({ amount: "8.00", updatedAt: NOW - DAY }),
      link({ status: "active", amount: "999", updatedAt: NOW }),
      link({ amount: "999", updatedAt: NOW - 30 * DAY }), // outside a 7-day window
    ];
    const s = dailySeries(links, 7, NOW);
    expect(s[6]!.total).toBe(15);
    expect(s[5]!.total).toBe(8);
    expect(s.reduce((a, b) => a + b.total, 0)).toBe(23);
  });
});

describe("humanStatus", () => {
  it.each([
    ["active", null, "Waiting for payment", "wait"],
    ["underpaid", null, "Part paid", "wait"],
    ["paid", null, "Paid", "ok"],
    ["offramp_pending", "pending", "Cashing out", "wait"],
    ["offramp_pending", "awaiting_transfer", "Waiting for your transfer", "wait"],
    ["offramp_settled", null, "Cashed out", "ok"],
    ["offramp_failed", null, "Cash-out failed", "bad"],
    ["expired", null, "Expired", "idle"],
    ["cancelled", null, "Cancelled", "idle"],
  ])("%s / %s reads as %s", (status, offrampStatus, label, tone) => {
    expect(humanStatus({ status, offrampStatus } as Pick<PaymentLink, "status" | "offrampStatus">)).toEqual({
      label,
      tone,
    });
  });

  it("falls back to a readable label for a status it does not know", () => {
    expect(humanStatus({ status: "on_hold", offrampStatus: null } as never)).toEqual({ label: "On hold", tone: "idle" });
  });
});

describe("relativeTime", () => {
  it("speaks in the units a person would", () => {
    expect(relativeTime(NOW - 10_000, NOW)).toBe("Just now");
    expect(relativeTime(NOW - 12 * 60_000, NOW)).toBe("12 min ago");
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe("3 h ago");
    expect(relativeTime(NOW - DAY, NOW)).toBe("Yesterday");
    expect(relativeTime(NOW - 4 * DAY, NOW)).toBe("4 days ago");
  });

  it("switches to a date after a week, adding the year only when it differs", () => {
    expect(relativeTime(new Date(2026, 9, 12, 9).getTime(), NOW)).toBe("12 Oct");
    expect(relativeTime(new Date(2025, 9, 12, 9).getTime(), NOW)).toBe("12 Oct 2025");
  });

  it("never reports a future time as negative", () => {
    expect(relativeTime(NOW + HOUR, NOW)).toBe("Just now");
  });
});

describe("formatting", () => {
  it("shows USDC as dollars and other assets as they are", () => {
    expect(formatDollars(1240)).toBe("$1,240.00");
    expect(formatLinkAmount(link({ amount: "25", status: "active" }))).toBe("$25.00");
    expect(formatLinkAmount(link({ amount: "25", paidAmount: "26.5", status: "paid" }))).toBe("$26.50");
    expect(formatLinkAmount(link({ amount: "10", status: "active", asset: { code: "XLM" } as PaymentLink["asset"] }))).toBe(
      "10 XLM",
    );
  });

  it("formats a fiat figure without decimals, and survives a currency code it cannot place", () => {
    expect(formatFiat(1_672_000, "NGN")).toContain("1,672,000");
    expect(formatFiat(1234.6, "???")).toBe("1,235 ???");
  });
});

describe("filters", () => {
  const set = [
    { status: "active" },
    { status: "underpaid" },
    { status: "paid" },
    { status: "offramp_pending" },
    { status: "offramp_settled" },
    { status: "expired" },
    { status: "cancelled" },
  ] as Pick<PaymentLink, "status">[];

  it("sorts every link into the filters a person expects", () => {
    expect(filterCounts(set)).toEqual({ all: 7, waiting: 2, paid: 1, cashout: 2, closed: 2 });
    expect(matchesFilter({ status: "offramp_failed" }, "cashout")).toBe(true);
    expect(matchesFilter({ status: "paid" }, "waiting")).toBe(false);
  });
});

describe("setupSteps", () => {
  it("tracks progress through the first payment", () => {
    const fresh = setupSteps({ links: [], canReceiveUsdc: null });
    expect(fresh.map((s) => [s.id, s.done])).toEqual([
      ["wallet", true],
      ["usdc", false],
      ["link", false],
      ["payment", false],
    ]);

    const done = setupSteps({ links: [{ status: "paid" }], canReceiveUsdc: true });
    expect(done.every((s) => s.done)).toBe(true);
  });

  it("adds the identity step only when a real anchor needs it", () => {
    const base = { links: [{ status: "paid" }] as Pick<PaymentLink, "status">[], canReceiveUsdc: true };
    expect(setupSteps(base).some((s) => s.id === "verify")).toBe(false);
    const withKyc = setupSteps({ ...base, verification: { accepted: false } });
    expect(withKyc.find((s) => s.id === "verify")?.done).toBe(false);
  });
});
