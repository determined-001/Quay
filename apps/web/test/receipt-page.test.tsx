// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ReceiptPage from "../app/r/[reference]/page";
import { api, type PublicReceipt } from "../lib/api";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("ReceiptPage paidWith display (issue 5.50)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.restoreAllMocks();
  });

  const plainReceipt: PublicReceipt = {
    reference: "pl_ref_plain",
    title: "Test Store",
    amount: "10",
    asset: { code: "USDC", issuer: null },
    status: "paid",
    txHash: "tx_hash_12345678901234567890",
    payer: "GBUYER1234567890",
    paidAmount: "10",
    paidWith: null,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };

  const pathPaidReceipt: PublicReceipt = {
    ...plainReceipt,
    reference: "pl_ref_path",
    paidWith: [
      {
        asset: { code: "XLM", issuer: null },
        amount: "24.1234567",
      },
    ],
  };

  it("renders a plain receipt without a Paid with row when paidWith is null", async () => {
    vi.spyOn(api, "getReceipt").mockResolvedValue(plainReceipt);

    const Page = await ReceiptPage({ params: Promise.resolve({ reference: "pl_ref_plain" }) });
    await act(async () => {
      root.render(Page);
    });

    expect(container.textContent).toContain("Amount paid");
    expect(container.textContent).toContain("10 USDC");
    expect(container.textContent).not.toContain("Paid with");
  });

  it("renders 'Paid with 24.1234567 XLM' under amount when paidWith is present", async () => {
    vi.spyOn(api, "getReceipt").mockResolvedValue(pathPaidReceipt);

    const Page = await ReceiptPage({ params: Promise.resolve({ reference: "pl_ref_path" }) });
    await act(async () => {
      root.render(Page);
    });

    expect(container.textContent).toContain("Amount paid");
    expect(container.textContent).toContain("10 USDC");
    expect(container.textContent).toContain("Paid with");
    expect(container.textContent).toContain("24.1234567 XLM");

    // Verify row order: Paid with is directly under Amount paid
    const rows = Array.from(container.querySelectorAll(".receipt-row"));
    const amountRowIdx = rows.findIndex((r) => r.textContent?.includes("Amount paid"));
    const paidWithRowIdx = rows.findIndex((r) => r.textContent?.includes("Paid with"));
    expect(amountRowIdx).toBeGreaterThan(-1);
    expect(paidWithRowIdx).toBe(amountRowIdx + 1);
    expect(rows[paidWithRowIdx]?.textContent).toContain("Paid with");
    expect(rows[paidWithRowIdx]?.textContent).toContain("24.1234567 XLM");
  });

  it("renders multiple lines when paidWith has several payments", async () => {
    const multiPaidReceipt: PublicReceipt = {
      ...plainReceipt,
      paidWith: [
        { asset: { code: "XLM", issuer: null }, amount: "20.0000000" },
        { asset: { code: "XLM", issuer: null }, amount: "4.1234567" },
      ],
    };
    vi.spyOn(api, "getReceipt").mockResolvedValue(multiPaidReceipt);

    const Page = await ReceiptPage({ params: Promise.resolve({ reference: "pl_ref_path" }) });
    await act(async () => {
      root.render(Page);
    });

    const paidWithRows = Array.from(container.querySelectorAll(".receipt-row")).filter((r) =>
      r.textContent?.includes("Paid with"),
    );
    expect(paidWithRows.length).toBe(2);
    expect(paidWithRows[0]?.textContent).toContain("20.0000000 XLM");
    expect(paidWithRows[1]?.textContent).toContain("4.1234567 XLM");
  });
});
