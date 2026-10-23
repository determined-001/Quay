// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CashOutModal from "../app/components/CashOutModal";
import { classifyError } from "../lib/api";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CashOutModal quote expired and mismatch handling (issue #418)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let quoteFetchCount = 0;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    quoteFetchCount = 0;
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("classifies 409 quote_mismatch as quote_mismatch error code", () => {
    expect(classifyError(409, { error: "quote_mismatch" })).toBe("quote_mismatch");
    expect(classifyError(409, { error: "quote_mismatch: amount changed" })).toBe("quote_mismatch");
  });

  function setupFetch(cashOutError: { error: string }) {
    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/offramp-requirements")) {
        return jsonResponse({ descriptors: [], savedFields: null });
      }
      if (url.includes("/cash-out/quote")) {
        quoteFetchCount++;
        return jsonResponse({
          quoteId: `q_${quoteFetchCount}`,
          sourceAsset: { code: "USDC", issuer: "GISSUER" },
          sourceAmount: "10",
          targetCurrency: "NGN",
          targetAmount: "16500.0000",
          rate: "1650",
          expiresAt: Date.now() + 10 * 60_000, // 10 minutes left
          fee: { amount: "165.0000", currency: "NGN", source: "anchor" },
          netTargetAmount: "16335.0000",
          quoteKind: "firm",
        });
      }
      if (url.endsWith("/cash-out") && init?.method === "POST") {
        return jsonResponse(cashOutError, 409);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
  }

  async function openQuoteStep() {
    root = createRoot(container);
    act(() => {
      root!.render(
        <CashOutModal
          linkId="lnk_1"
          linkAmount="10"
          assetCode="USDC"
          targetCurrency="NGN"
          isMock={false}
          onClose={vi.fn()}
          onSuccess={vi.fn()}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      submit.click();
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("shows 'Get a new quote' and hides 'Confirm cash-out' on quote_expired, persisting across timer advances", async () => {
    setupFetch({ error: "quote_expired: quote lapsed before execution" });
    await openQuoteStep();

    expect(quoteFetchCount).toBe(1);

    const confirmBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "Confirm cash-out",
    );
    expect(confirmBtn).toBeTruthy();

    // Confirm cash-out triggers 409 quote_expired
    await act(async () => {
      confirmBtn!.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    // "Get a new quote" must be shown, and "Confirm cash-out" must NOT be shown
    let newQuoteBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "Get a new quote",
    );
    expect(newQuoteBtn).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (b) => b.textContent === "Confirm cash-out",
      ),
    ).toBe(false);
    expect(container.textContent).toContain("Quote expired — please request a new quote.");

    // Advance timer by several seconds: the interval must not overwrite countdown
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    newQuoteBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "Get a new quote",
    );
    expect(newQuoteBtn).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (b) => b.textContent === "Confirm cash-out",
      ),
    ).toBe(false);

    // Clicking "Get a new quote" issues a new quote request
    await act(async () => {
      newQuoteBtn!.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(quoteFetchCount).toBe(2);
  });

  it("shows 'Get a new quote' on quote_mismatch while quote still has time, persisting across timer advances", async () => {
    setupFetch({ error: "quote_mismatch" });
    await openQuoteStep();

    expect(quoteFetchCount).toBe(1);

    const confirmBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "Confirm cash-out",
    );
    expect(confirmBtn).toBeTruthy();

    // Confirm cash-out triggers 409 quote_mismatch
    await act(async () => {
      confirmBtn!.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    // "Get a new quote" must be shown, and "Confirm cash-out" must NOT be shown
    let newQuoteBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "Get a new quote",
    );
    expect(newQuoteBtn).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (b) => b.textContent === "Confirm cash-out",
      ),
    ).toBe(false);
    expect(container.textContent).toContain("This quote no longer matches the link. Get a new quote.");
    expect(container.textContent).toContain("Quote expired — please request a new quote.");

    // Even though the original quote had 10 minutes left, timer advancement must NOT bring back Confirm
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    newQuoteBtn = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
      (b) => b.textContent === "Get a new quote",
    );
    expect(newQuoteBtn).toBeTruthy();
    expect(
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).some(
        (b) => b.textContent === "Confirm cash-out",
      ),
    ).toBe(false);

    // Clicking "Get a new quote" issues a new quote request
    await act(async () => {
      newQuoteBtn!.click();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(quoteFetchCount).toBe(2);
  });
});
