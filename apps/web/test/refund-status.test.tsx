// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/wallet", () => ({
  connectWallet: vi.fn(async () => "GSELLERWALLET"),
  detectWallet: vi.fn(async () => true),
  disconnectWallet: vi.fn(async () => {}),
  shortAddress: (addr: string) => addr.slice(0, 4) + "…" + addr.slice(-4),
  signChallenge: vi.fn(async () => "signed-challenge-xdr"),
}));

import { api, type LinkDetail, type LinkRefundSummary, type PaymentLink, type PublicReceipt, type Refund } from "../lib/api";
import { explorerUrl } from "../lib/explorer";
import { RefundBadge } from "../app/components/dashboard/PaymentsView";
import { LinkDetailClient, buildTimeline } from "../app/links/[id]/LinkDetailClient";
import ReceiptPage from "../app/r/[reference]/page";

// Issue 5.45 (#541): refund status on payments, the link timeline and the buyer's receipt.

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const LINK: PaymentLink = {
  id: "lnk_refund_1",
  sellerId: "sel_1",
  reference: "REF-541",
  amount: "10",
  asset: { code: "USDC", issuer: "GISSUER" },
  destination: "GDESTINATION1234567890",
  status: "paid",
  title: "Coffee beans",
  muxedId: null,
  payer: "GPAYER1234567890",
  txHash: "a".repeat(64),
  paidAmount: "10",
  overpaidAmount: null,
  offrampJobId: null,
  offrampTargetCurrency: null,
  offrampStatus: null,
  offrampIndicativeRate: null,
  offrampRate: null,
  offrampRateDelta: null,
  offrampFeeAmount: null,
  offrampFeeCurrency: null,
  offrampFeeSource: null,
  offrampNetTargetAmount: null,
  isDemo: false,
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_060_000,
  expiresAt: null,
};

function refund(over: Partial<Refund>): Refund {
  return {
    id: "rfd_1",
    linkId: LINK.id,
    sellerId: "sel_1",
    paymentTxHash: LINK.txHash!,
    paymentOperationId: "1001",
    destination: "GBUYERREFUNDADDRESS",
    destinationMuxedId: null,
    memo: null,
    memoType: null,
    amount: "4.50",
    asset: { code: "USDC", issuer: "GISSUER" },
    status: "confirmed",
    txHash: "b".repeat(64),
    failureReason: null,
    createdAt: 1_700_000_100_000,
    updatedAt: 1_700_000_200_000,
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
}

describe("RefundBadge", () => {
  it.each([
    [{ refundedAmount: "10", pendingAmount: "0", fullyRefunded: true }, "Refunded"],
    [{ refundedAmount: "4.5", pendingAmount: "0", fullyRefunded: false }, "Part refunded"],
    [{ refundedAmount: "0.0000001", pendingAmount: "3", fullyRefunded: false }, "Part refunded"],
  ])("shows %j as %s", async (summary, label) => {
    await render(<RefundBadge summary={summary} />);
    expect(container.querySelector(".badge")?.textContent).toBe(label);
  });

  it.each([
    [undefined, "no summary"],
    [null, "a null summary"],
    [{ refundedAmount: "0", pendingAmount: "0", fullyRefunded: false }, "nothing refunded"],
    [{ refundedAmount: "0", pendingAmount: "4.5", fullyRefunded: false }, "a refund that is only on its way"],
  ] as [LinkRefundSummary | null | undefined, string][])("shows nothing for %j (%s)", async (summary) => {
    await render(<RefundBadge summary={summary} />);
    expect(container.querySelector(".badge")).toBeNull();
  });
});

describe("buildTimeline refund events", () => {
  it("adds one event per refund for the state it is in, and none for a prepared refund", () => {
    const events = buildTimeline(LINK, [], null, [
      refund({ id: "rfd_prepared", status: "prepared", txHash: null }),
      refund({ id: "rfd_sent", status: "submitted", txHash: "c".repeat(64), amount: "1", updatedAt: 1_700_000_300_000 }),
      refund({ id: "rfd_ok", status: "confirmed", updatedAt: 1_700_000_200_000 }),
      refund({ id: "rfd_bad", status: "failed", txHash: null, amount: "2", updatedAt: 1_700_000_400_000 }),
    ]);

    const refunds = events.filter((e) => e.type.startsWith("refund_"));
    expect(refunds.map((e) => [e.id, e.type, e.label, e.detail, e.meta?.amount])).toEqual([
      ["refund_rfd_ok", "refund_confirmed", "Refund confirmed", "b".repeat(64), "4.50 USDC"],
      ["refund_rfd_sent", "refund_sent", "Refund sent", "c".repeat(64), "1 USDC"],
      ["refund_rfd_bad", "refund_failed", "Refund failed", undefined, "2 USDC"],
    ]);
  });

  it("places refund events after the payment, in time order", () => {
    const events = buildTimeline(LINK, [], null, [refund({})]);
    expect(events.map((e) => e.type)).toEqual(["created", "paid", "refund_confirmed"]);
  });

  it("adds nothing when there are no refunds, or the argument is left out", () => {
    expect(buildTimeline(LINK, [], null, []).some((e) => e.type.startsWith("refund_"))).toBe(false);
    expect(buildTimeline(LINK, []).some((e) => e.type.startsWith("refund_"))).toBe(false);
  });
});

describe("LinkDetailClient with refunds", () => {
  const detail: LinkDetail = {
    link: LINK,
    request: {
      uri: "web+stellar:pay?destination=GDESTINATION1234567890",
      destination: "GDESTINATION1234567890",
      amount: "10",
      asset: { code: "USDC", issuer: "GISSUER" },
      memo: "REF-541",
    },
    deliveries: [],
    offrampExternalStatus: null,
  };

  it("shows the badge next to the status, and the refund in the timeline with an explorer link", async () => {
    vi.spyOn(api, "getDetail").mockResolvedValue({
      ...detail,
      refunds: [refund({})],
      refundSummary: { refundedAmount: "4.50", pendingAmount: "0", fullyRefunded: false },
    });

    await render(<LinkDetailClient id={LINK.id} />);

    const header = container.querySelector(".tl-header-right");
    expect(header?.querySelector(".pill")?.textContent).toBe("paid");
    expect(header?.querySelector(".badge")?.textContent).toBe("Part refunded");

    const event = [...container.querySelectorAll(".tl-event")].find((el) => el.textContent?.includes("Refund confirmed"));
    expect(event?.textContent).toContain("4.50 USDC");
    expect(event?.querySelector("a")?.getAttribute("href")).toBe(explorerUrl("b".repeat(64)));
  });

  it("shows no badge and no refund event when the API leaves the fields out", async () => {
    vi.spyOn(api, "getDetail").mockResolvedValue(detail);

    await render(<LinkDetailClient id={LINK.id} />);

    expect(container.textContent).toContain("Payment received");
    expect(container.querySelector(".tl-header-right .badge")).toBeNull();
    expect(container.textContent).not.toContain("Refund");
  });
});

describe("ReceiptPage refunds", () => {
  const receipt: PublicReceipt = {
    reference: "pl_ref_refund",
    title: "Test Store",
    amount: "10",
    asset: { code: "USDC", issuer: null },
    status: "paid",
    txHash: "a".repeat(64),
    payer: "GBUYER1234567890",
    paidAmount: "10",
    paidWith: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };

  async function page(value: PublicReceipt) {
    vi.spyOn(api, "getReceipt").mockResolvedValue(value);
    await render(await ReceiptPage({ params: Promise.resolve({ reference: value.reference }) }));
    return [...container.querySelectorAll(".receipt-row")];
  }

  it('shows "Refunded 4.50 USDC" with a link to the refund transaction', async () => {
    const rows = await page({ ...receipt, refundedAmount: "4.50", refunds: [{ amount: "4.50", txHash: "b".repeat(64) }] });

    const row = rows.find((r) => r.textContent?.includes("Refunded"));
    expect(row?.querySelector(".receipt-label")?.textContent).toBe("Refunded 4.50 USDC");
    expect(row?.querySelector("a")?.getAttribute("href")).toBe(explorerUrl("b".repeat(64)));
    // One refund needs no total.
    expect(container.textContent).not.toContain("Total refunded");
  });

  it("shows a line for each refund and their total when there is more than one", async () => {
    const rows = await page({
      ...receipt,
      refundedAmount: "6.5",
      refunds: [
        { amount: "4.5", txHash: "b".repeat(64) },
        { amount: "2", txHash: "c".repeat(64) },
      ],
    });

    const labels = rows.map((r) => r.querySelector(".receipt-label")?.textContent);
    expect(labels.filter((l) => l?.startsWith("Refunded"))).toEqual(["Refunded 4.5 USDC", "Refunded 2 USDC"]);
    expect(rows.find((r) => r.textContent?.includes("Total refunded"))?.textContent).toContain("6.5 USDC");
  });

  it.each([
    [receipt, "the fields are absent"],
    [{ ...receipt, refundedAmount: "0", refunds: [] }, "nothing was refunded"],
  ])("says nothing about refunds when %s", async (value) => {
    await page(value as PublicReceipt);
    expect(container.textContent).not.toContain("Refunded");
    expect(container.textContent).not.toContain("Total refunded");
  });
});
