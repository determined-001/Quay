// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CashOutModal from "../app/components/CashOutModal";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REQUIREMENTS = {
  types: [
    {
      name: "bank_account",
      descriptors: [{ name: "dest", label: "Account number", optional: false }],
    },
  ],
  defaultType: "bank_account",
  savedFields: null,
};

describe("CashOutModal accessibility (issue 5.27)", () => {
  let container: HTMLDivElement;
  let opener: HTMLButtonElement;
  let root: Root | null = null;
  const onClose = vi.fn();
  /** When set, the quote request never settles: the modal sits in "confirming". */
  let hangQuote = false;
  let quoteFails = false;

  beforeEach(() => {
    vi.useFakeTimers();
    onClose.mockClear();
    hangQuote = false;
    quoteFails = false;
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/offramp-requirements")) return jsonResponse(REQUIREMENTS);
      if (url.includes("/cash-out/quote")) {
        if (hangQuote) return new Promise<Response>(() => undefined);
        if (quoteFails) return jsonResponse({ error: "anchor_unavailable", message: "Anchor is down" }, 502);
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    opener = document.createElement("button");
    opener.textContent = "Cash out";
    document.body.appendChild(opener);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    opener.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function openModal() {
    opener.focus();
    root = createRoot(container);
    act(() => {
      root!.render(
        <CashOutModal
          linkId="lnk_1"
          linkAmount="10"
          assetCode="USDC"
          targetCurrency="NGN"
          isMock={false}
          onClose={onClose}
          onSuccess={vi.fn()}
        />,
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  function key(k: string, shiftKey = false) {
    const target = document.activeElement ?? document.body;
    const ev = new KeyboardEvent("keydown", { key: k, shiftKey, bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(ev);
    });
    return ev;
  }

  async function fillAndSubmit() {
    const input = container.querySelector("#payout-dest") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "0123456789");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const submit = container.querySelector('button[type="submit"]') as HTMLButtonElement;
    await act(async () => {
      submit.click();
      await vi.advanceTimersByTimeAsync(0);
    });
  }

  it("moves focus into the dialog on open and labels it by the visible heading", async () => {
    await openModal();
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    const heading = dialog.querySelector("h2") as HTMLElement;
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(heading);
    expect(heading.id).toBeTruthy();
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
    expect(dialog.hasAttribute("aria-label")).toBe(false);
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("wraps Tab from the last focusable to the first and Shift+Tab back", async () => {
    await openModal();
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    const items = Array.from(
      dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), select:not([disabled])"),
    );
    const first = items[0]!;
    const last = items[items.length - 1]!;
    expect(first.getAttribute("aria-label")).toBe("Close");
    expect(last.textContent).toBe("Cancel");

    last.focus();
    const fwd = key("Tab");
    expect(fwd.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const back = key("Tab", true);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("keeps Shift+Tab from the heading inside the dialog", async () => {
    await openModal();
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(document.activeElement).toBe(dialog.querySelector("h2"));
    key("Tab", true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect((document.activeElement as HTMLElement).textContent).toBe("Cancel");
  });

  it("pulls focus back in when it has escaped the dialog", async () => {
    await openModal();
    opener.focus();
    key("Tab");
    const dialog = container.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape", async () => {
    await openModal();
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on Escape while the quote request is in flight", async () => {
    hangQuote = true;
    await openModal();
    await fillAndSubmit();
    expect(container.textContent).toContain("Getting quote…");
    key("Escape");
    expect(onClose).not.toHaveBeenCalled();
    // The in-flight state is announced, not only shown on the button.
    const status = Array.from(container.querySelectorAll('[role="status"]')).find((e) =>
      e.classList.contains("visually-hidden"),
    );
    expect(status?.textContent).toBe("Getting your quote…");
  });

  it("returns focus to the opener when the modal unmounts", async () => {
    await openModal();
    expect(document.activeElement).not.toBe(opener);
    act(() => {
      root!.unmount();
    });
    root = null;
    expect(document.activeElement).toBe(opener);
  });

  it("announces a failed quote with role=alert", async () => {
    quoteFails = true;
    await openModal();
    await fillAndSubmit();
    const alert = Array.from(container.querySelectorAll('.err[role="alert"]')).find((e) =>
      e.textContent?.length,
    );
    expect(alert).toBeTruthy();
  });

  it("announces a load failure with role=alert", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ error: "boom", message: "No requirements" }, 500)) as unknown as typeof fetch;
    await openModal();
    const alert = container.querySelector('.err[role="alert"]');
    expect(alert?.textContent?.length).toBeGreaterThan(0);
  });
});
