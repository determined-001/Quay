// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CashOutModal from "../app/components/CashOutModal";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const DISCLAIMER = "Indicative rate — the anchor sets the final amount.";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("CashOutModal quote step: indicative disclaimer (issue 3.22)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function stubFetch(quoteKind: "firm" | "indicative") {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/offramp-requirements")) return jsonResponse({ descriptors: [], savedFields: null });
      if (url.includes("/cash-out/quote")) {
        return jsonResponse({
          quoteId: "q_1",
          sourceAsset: { code: "USDC", issuer: "GISSUER" },
          sourceAmount: "10",
          targetCurrency: "NGN",
          targetAmount: "16500.0000",
          rate: "1650",
          expiresAt: Date.now() + 10 * 60_000,
          fee: { amount: "165.0000", currency: "NGN", source: quoteKind === "indicative" ? "estimated" : "anchor" },
          netTargetAmount: "16335.0000",
          quoteKind,
        });
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

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
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

  it("shows the indicative disclaimer on the quote step, before the seller commits", async () => {
    stubFetch("indicative");
    await openQuoteStep();
    // Still on the quote step: the commit button is on screen, nothing started.
    expect(Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Confirm cash-out")).toBe(
      true,
    );
    expect(container.textContent).toContain(DISCLAIMER);
    expect(container.textContent).toContain("Indicative quote");
  });

  it("does not show it for a firm quote", async () => {
    stubFetch("firm");
    await openQuoteStep();
    expect(container.textContent).not.toContain(DISCLAIMER);
    expect(container.textContent).toContain("Firm quote");
  });
});
