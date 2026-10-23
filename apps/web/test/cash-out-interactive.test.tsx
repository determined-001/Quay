// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CashOutModal from "../app/components/CashOutModal";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const INTERACTIVE_URL = "https://anchor.example.com/flow/abc123";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("CashOutModal interactive step (issue 5.20)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let detailStatus: {
    offrampStatus: string;
    offrampExternalStatus: string | null;
  };
  const onSuccess = vi.fn(() => {
    // Mirror Dashboard.handleCashOutSuccess: success unmounts the modal,
    // which cancels the poll loop via the effect cleanup.
    act(() => {
      root?.unmount();
    });
    root = null;
  });
  const onClose = vi.fn();

  function stubFetch() {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/offramp-requirements")) {
        return jsonResponse({ descriptors: [], savedFields: null });
      }
      if (url.includes("/cash-out/quote")) {
        return jsonResponse({
          quoteId: "q_1",
          sourceAsset: { code: "USDC", issuer: "GISSUER" },
          sourceAmount: "10",
          targetCurrency: "NGN",
          targetAmount: "16500",
          rate: "1650",
          expiresAt: Date.now() + 10 * 60_000,
          fee: { amount: "0", currency: "NGN", source: "anchor" },
          netTargetAmount: "16500",
        });
      }
      if (url.endsWith("/cash-out")) {
        return jsonResponse({
          job: {
            jobId: "job_1",
            status: "pending",
            targetAmount: "16500",
            targetCurrency: "NGN",
          },
          interactiveUrl: INTERACTIVE_URL,
        });
      }
      if (url.endsWith("/detail")) {
        return jsonResponse({
          link: { id: "lnk_1", offrampStatus: detailStatus.offrampStatus },
          request: {},
          deliveries: [],
          offrampExternalStatus: detailStatus.offrampExternalStatus,
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
  }

  function renderModal(customOnSuccess: () => void = onSuccess) {
    if (!root) {
      root = createRoot(container);
    }
    act(() => {
      root!.render(
        <CashOutModal
          linkId="lnk_1"
          linkAmount="10"
          assetCode="USDC"
          targetCurrency="NGN"
          isMock
          onClose={onClose}
          onSuccess={customOnSuccess}
        />,
      );
    });
  }

  async function submitForm() {
    const submit = container.querySelector(
      'button[type="submit"]',
    ) as HTMLButtonElement;
    // Step 1: "Get quote" fetches the firm quote and shows the quote panel.
    await act(async () => {
      submit.click();
      await vi.advanceTimersByTimeAsync(0);
    });
    // Step 2: confirming the quote is what initiates the cash-out.
    const confirm = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Confirm cash-out",
    ) as HTMLButtonElement;
    await act(async () => {
      confirm.click();
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    onSuccess.mockClear();
    onClose.mockClear();
    detailStatus = {
      offrampStatus: "pending",
      offrampExternalStatus: "incomplete",
    };
    stubFetch();
    // Blocked popup: per the HTML spec window.open with noopener returns null,
    // and the bug was that the modal unmounted anyway via onSuccess().
    Object.defineProperty(window, "open", {
      value: vi.fn(() => null),
      configurable: true,
    });
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

  it("stays open with a clickable continue link when the popup is blocked", async () => {
    renderModal();
    // Requirements load → form renders.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await submitForm();

    // First poll runs: still pending, so the modal stays open.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    // Modal is still mounted (not closed via onSuccess) and the seller has a
    // real link to click themselves.
    expect(onSuccess).not.toHaveBeenCalled();
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    const link = container.querySelector(
      `a[href="${INTERACTIVE_URL}"]`,
    ) as HTMLAnchorElement | null;
    expect(link).not.toBeNull();
    expect(link!.target).toBe("_blank");
    expect(link!.rel).toContain("noopener");
    expect(container.textContent).toContain("anchor.example.com");
    // The anchor-reported state is shown in plain words.
    expect(container.textContent).toContain(
      "Waiting for you to finish in the anchor's window.",
    );
  });

  it("opens the anchor URL from the continue button click", async () => {
    renderModal();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await submitForm();

    const buttons = Array.from(container.querySelectorAll("button"));
    const cont = buttons.find((b) =>
      b.textContent?.startsWith("Continue with"),
    );
    expect(cont).toBeDefined();
    act(() => {
      cont!.click();
    });
    expect(window.open).toHaveBeenCalledWith(
      INTERACTIVE_URL,
      "_blank",
      expect.stringContaining("noopener"),
    );
  });

  it("closes on its own when the polled link settles", async () => {
    renderModal();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await submitForm();
    expect(onSuccess).not.toHaveBeenCalled();

    detailStatus = {
      offrampStatus: "settled",
      offrampExternalStatus: "complete",
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("closes on its own when the polled link fails", async () => {
    renderModal();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await submitForm();

    detailStatus = { offrampStatus: "failed", offrampExternalStatus: "error" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("does not reset the poll timer when parent re-renders with a new onSuccess identity", async () => {
    let detailPolls = 0;
    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/detail")) {
        detailPolls++;
      }
      return baseFetch(input as any);
    }) as unknown as typeof fetch;

    renderModal();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await submitForm();

    detailPolls = 0;

    // Simulate parent re-rendering every 3 seconds (less than 5s base interval)
    // with a brand new onSuccess identity for 15 seconds.
    // If the timer were reset on each re-render, 0 polls would fire.
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
      });
      renderModal(() => {});
    }

    // In 15 seconds with 5s interval, 3 polls fire (at 5s, 10s, 15s).
    expect(detailPolls).toBe(3);
  });

  it("honours the 30 s backoff delay while parent re-renders repeatedly", async () => {
    let detailPolls = 0;
    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/detail")) {
        detailPolls++;
      }
      return baseFetch(input as any);
    }) as unknown as typeof fetch;

    renderModal();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await submitForm();

    // Advance past the 2-minute (120s) mark where backoff kicks in (125s elapsed)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(125_000);
    });

    detailPolls = 0;

    // Now parent re-renders every 5 seconds for 30 seconds (6 re-renders)
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      renderModal(() => {});
    }

    // At the 30s mark, the backed-off poll must have fired despite the 5s re-renders
    expect(detailPolls).toBe(1);
  });
});
