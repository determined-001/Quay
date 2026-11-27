// @vitest-environment happy-dom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Refund, PaymentLink } from "@checkout/core";

const flags = vi.hoisted(() => ({ refunds: true }));
const apiMock = vi.hoisted(() => ({
  getOfframpPreview: vi.fn(),
  listRefundPayments: vi.fn(),
  listRefunds: vi.fn(),
  refundPreflight: vi.fn(),
  prepareRefund: vi.fn(),
  submitRefund: vi.fn(),
}));
const walletMock = vi.hoisted(() => ({ signTransaction: vi.fn() }));

vi.mock("../lib/wallet", () => ({
  signTransaction: walletMock.signTransaction,
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: apiMock };
});

vi.mock("../app/components/dashboard/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../app/components/dashboard/config")>();
  return {
    ...actual,
    get REFUNDS_ENABLED() {
      return flags.refunds;
    },
  };
});

import { CheckoutError, type RefundPayment } from "../lib/api";
import RefundSheet from "../app/components/RefundSheet";
import { PaymentRow, type RowActions } from "../app/components/dashboard/PaymentsView";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SELLER = "GSELLERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PAYER = "GBUYERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const PAYMENT: RefundPayment = {
  linkId: "lnk_1",
  txHash: "a".repeat(64),
  operationId: "12345",
  payer: PAYER,
  amount: "10",
  asset: { code: "USDC", issuer: ISSUER },
  ledger: 42,
  createdAt: 1_700_000_000_000,
};

function refund(over: Partial<Refund> = {}): Refund {
  return {
    id: "rfd_1",
    linkId: "lnk_1",
    sellerId: "sel_1",
    paymentTxHash: PAYMENT.txHash,
    paymentOperationId: "12345",
    destination: PAYER,
    destinationMuxedId: null,
    memo: null,
    memoType: null,
    amount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    status: "submitted",
    txHash: "tx_refund",
    failureReason: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...over,
  };
}

function link(over: Partial<PaymentLink> & { refundSummary?: unknown } = {}): PaymentLink {
  return {
    id: "lnk_1",
    sellerId: "sel_1",
    reference: "REF-1",
    title: "Order 1",
    amount: "10",
    paidAmount: "10",
    asset: { code: "USDC", issuer: ISSUER },
    destination: SELLER,
    status: "paid",
    muxedId: null,
    payer: PAYER,
    txHash: PAYMENT.txHash,
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
    createdAt: 1,
    updatedAt: 2,
    expiresAt: null,
    ...over,
  } as PaymentLink;
}

function rowActions(over: Partial<RowActions> = {}): RowActions {
  return {
    copied: null,
    onCopy: vi.fn(),
    onCashOut: vi.fn(),
    onPendingTransfer: vi.fn(),
    onRefund: vi.fn(),
    cashOutBlocked: false,
    anchorAuth: null,
    now: Date.now(),
    ...over,
  };
}

describe("refund action visibility", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    flags.refunds = true;
    apiMock.getOfframpPreview.mockResolvedValue({ prices: [] });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  async function renderRow(paymentLink: PaymentLink, actions = rowActions()) {
    await act(async () => {
      root.render(<PaymentRow link={paymentLink} actions={actions} />);
    });
    return actions;
  }

  it("is hidden when NEXT_PUBLIC_REFUNDS_ENABLED is off", async () => {
    flags.refunds = false;
    await renderRow(link());
    expect(container.textContent).not.toContain("Refund");
  });

  it("is hidden when the payment has nothing refundable", async () => {
    await renderRow(link({ paidAmount: "0" }));
    expect(container.textContent).not.toContain("Refund");

    await renderRow(link({ refundSummary: { refundedAmount: "10", pendingAmount: "0", fullyRefunded: true } }));
    expect(container.textContent).not.toContain("Refund");
  });

  it("opens the refund sheet for a paid payment with money left", async () => {
    const actions = await renderRow(link());
    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Refund");
    expect(button).toBeTruthy();
    await act(async () => button!.click());
    expect(actions.onRefund).toHaveBeenCalledWith("lnk_1");
  });
});

describe("RefundSheet", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const onClose = vi.fn();
  const onSubmitted = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    flags.refunds = true;
    apiMock.getOfframpPreview.mockResolvedValue({ prices: [] });
    apiMock.listRefundPayments.mockResolvedValue({ payments: [PAYMENT] });
    apiMock.listRefunds.mockResolvedValue({
      refunds: [],
      summary: { refundedAmount: "0", pendingAmount: "0", fullyRefunded: false },
    });
    apiMock.refundPreflight.mockResolvedValue({ ok: true, destination: PAYER, memoRequired: false });
    apiMock.prepareRefund.mockResolvedValue({
      refundId: "rfd_1",
      xdr: "UNSIGNED_XDR",
      networkPassphrase: "Test SDF Network ; September 2015",
      expiresAt: 1_700_000_300_000,
    });
    apiMock.submitRefund.mockResolvedValue({ txHash: "tx_refund" });
    walletMock.signTransaction.mockResolvedValue("SIGNED_XDR");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root!.unmount());
    }
    root = null;
    container.remove();
    vi.useRealTimers();
  });

  async function flush() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  async function open(over: Partial<ComponentProps<typeof RefundSheet>> = {}) {
    await act(async () => {
      root!.render(
        <RefundSheet
          linkId="lnk_1"
          linkDestination={SELLER}
          asset={{ code: "USDC", issuer: ISSUER }}
          payments={[PAYMENT]}
          refunds={[]}
          connectedWallet={SELLER}
          onClose={onClose}
          onSubmitted={onSubmitted}
          {...over}
        />,
      );
    });
    await flush();
    await flush();
  }

  function submit(): HTMLButtonElement {
    return container.querySelector('button[type="submit"]') as HTMLButtonElement;
  }

  function checkbox(): HTMLInputElement {
    return container.querySelector('input[type="checkbox"]') as HTMLInputElement;
  }

  async function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  async function click(element: HTMLElement) {
    await act(async () => {
      element.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    await flush();
  }

  it("blocks a partial amount above what is refundable", async () => {
    await open();
    await click(container.querySelector('input[value="part"]') as HTMLElement);

    const amount = container.querySelector("#rf-amount") as HTMLInputElement;
    await type(amount, "11");
    expect(container.textContent).toContain("more than the 10 USDC still refundable");
    expect(submit().disabled).toBe(true);
    expect(apiMock.prepareRefund).not.toHaveBeenCalled();

    await type(amount, "4.5");
    await click(checkbox());
    expect(submit().disabled).toBe(false);
    await click(submit());

    expect(apiMock.prepareRefund).toHaveBeenCalledWith(
      "lnk_1",
      expect.objectContaining({ payment: `${PAYMENT.txHash}:12345`, amount: "4.5" }),
      expect.any(String),
    );
  });

  it("lets a valid partial refund proceed when the full-amount preflight fails", async () => {
    apiMock.refundPreflight.mockImplementation(async (_id: string, _payment: string, amount: string) => {
      if (amount === "10") {
        throw new CheckoutError("refund_destination_cannot_receive", 422, "no room", undefined, {
          message: "The buyer's trustline cannot receive the full amount.",
        });
      }
      return { ok: true, destination: PAYER, memoRequired: false };
    });

    await open();
    expect(container.textContent).toContain("cannot receive the full amount");

    await click(container.querySelector('input[value="part"]') as HTMLElement);
    await type(container.querySelector("#rf-amount") as HTMLInputElement, "4.5");
    await click(checkbox());

    expect(submit().disabled).toBe(false);
    await click(submit());
    expect(apiMock.prepareRefund).toHaveBeenCalledWith(
      "lnk_1",
      expect.objectContaining({ payment: `${PAYMENT.txHash}:12345`, amount: "4.5" }),
      expect.any(String),
    );
  });

  it("requires the destination checkbox and a memo when the buyer's account needs one", async () => {
    apiMock.refundPreflight.mockResolvedValue({ ok: true, destination: PAYER, memoRequired: true });
    await open();

    const memo = container.querySelector("#rf-memo") as HTMLInputElement;
    expect(memo).toBeTruthy();
    expect(container.textContent).toContain("Exchanges use it to find the right deposit");
    expect(submit().disabled).toBe(true);

    await click(checkbox());
    expect(submit().disabled).toBe(true);
    expect(container.textContent).toContain("Add the buyer's deposit memo before sending");

    await type(memo, "deposit 7781");
    expect(submit().disabled).toBe(false);
    await click(submit());

    expect(apiMock.prepareRefund).toHaveBeenCalledWith(
      "lnk_1",
      expect.objectContaining({ memo: "deposit 7781", memoType: "text" }),
      expect.any(String),
    );
  });

  it("blocks a wallet that does not match the link destination", async () => {
    await open({ connectedWallet: "GOTHERWALLETAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });
    await click(checkbox());

    expect(container.textContent).toContain("connected wallet must match the link destination");
    expect(submit().disabled).toBe(true);
    expect(apiMock.prepareRefund).not.toHaveBeenCalled();
  });

  it("reports a wallet rejection without submitting", async () => {
    walletMock.signTransaction.mockRejectedValue(new Error("User declined"));
    await open();
    await click(checkbox());
    await click(submit());

    expect(container.textContent).toContain("wallet request was cancelled");
    expect(apiMock.submitRefund).not.toHaveBeenCalled();
  });

  it("offers to start again when the prepared refund expired", async () => {
    apiMock.submitRefund.mockRejectedValue(new CheckoutError("refund_expired", 409, "expired"));
    await open();
    await click(checkbox());
    await click(submit());

    expect(container.textContent).toContain("expired before it was signed");
    const again = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Start again");
    expect(again).toBeTruthy();
    await click(again!);
    expect(container.querySelector("#rf-amount") ?? submit()).toBeTruthy();
    expect(container.textContent).toContain("Refund this payment");
  });

  it("shows Horizon's rejection reason", async () => {
    apiMock.submitRefund.mockRejectedValue(
      new CheckoutError("payment_rejected", 409, "rejected", undefined, {
        reason: "insufficient_balance",
        detail: "op_underfunded",
      }),
    );
    await open();
    await click(checkbox());
    await click(submit());

    expect(container.textContent).toContain("Horizon rejected the refund (insufficient balance): op_underfunded");
  });

  it("shows the pending message until the ledger confirms", async () => {
    apiMock.listRefunds
      .mockResolvedValueOnce({
        refunds: [refund({ status: "submitted" })],
        summary: { refundedAmount: "0", pendingAmount: "10", fullyRefunded: false },
      })
      .mockResolvedValueOnce({
        refunds: [refund({ status: "confirmed" })],
        summary: { refundedAmount: "10", pendingAmount: "0", fullyRefunded: true },
      });

    await open();
    await click(checkbox());
    await click(submit());

    expect(container.textContent).toContain("Refund sent, waiting for the network");
    expect(onSubmitted).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(container.textContent).toContain("Refund sent, waiting for the network");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_000);
    });
    expect(container.textContent).toContain("Refund confirmed");
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it("is an accessible dialog: labelled heading, focus trap and Escape", async () => {
    await open();
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    const heading = dialog.querySelector("h2") as HTMLElement;
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(heading);

    const items = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      ),
    );
    const first = items[0]!;
    const last = items[items.length - 1]!;
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    await act(async () => {
      last.dispatchEvent(tab);
    });
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    await act(async () => {
      (document.activeElement ?? document.body).dispatchEvent(escape);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
