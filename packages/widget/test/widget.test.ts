// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Quay } from "../src/index";

describe("Quay Widget SDK", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  afterEach(() => {
    Quay.close();
  });

  it("exposes expected Quay SDK API methods", () => {
    expect(typeof Quay.open).toBe("function");
    expect(typeof Quay.close).toBe("function");
    expect(typeof Quay.init).toBe("function");
    expect(typeof Quay.on).toBe("function");
  });

  const TEST_HOST = "https://test.example.com";

  it("opens modal and appends overlay element to body", () => {
    Quay.open({ linkId: "lnk_test_123", host: TEST_HOST });

    const modal = document.getElementById("quay-checkout-modal");
    expect(modal).not.toBeNull();
    expect(modal?.getAttribute("role")).toBe("dialog");

    const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
    expect(iframe).not.toBeNull();
    expect(iframe.src).toContain("/pay/lnk_test_123?embed=true");
    expect(iframe.src).toContain(TEST_HOST);
  });

  it("closes modal on Quay.close() call", () => {
    Quay.open({ linkId: "lnk_test_123", host: TEST_HOST });
    expect(document.getElementById("quay-checkout-modal")).not.toBeNull();

    Quay.close();
    expect(document.getElementById("quay-checkout-modal")).toBeNull();
  });

  it("binds click listener to [data-quay-link] button, inferring the host from the widget's own script tag", () => {
    document.body.innerHTML = `
      <script src="${TEST_HOST}/widget.js"></script>
      <button id="pay-btn" data-quay-link="lnk_btn_456" data-quay-label="Pay $10">Pay</button>
    `;

    Quay.init();

    const btn = document.getElementById("pay-btn")!;
    expect(btn.textContent).toBe("Pay $10");

    btn.click();

    const modal = document.getElementById("quay-checkout-modal");
    expect(modal).not.toBeNull();
    const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
    expect(iframe.src).toContain("/pay/lnk_btn_456?embed=true");
    expect(iframe.src).toContain(TEST_HOST);
  });

  it("subscribes to events with Quay.on()", () => {
    const onPaid = vi.fn();
    const unsubscribe = Quay.on("quay:paid", onPaid);

    Quay.open({ linkId: "lnk_test_123", host: TEST_HOST });

    const event = new MessageEvent("message", {
      data: { type: "quay:paid", linkId: "lnk_test_123", link: { id: "lnk_test_123" } },
      origin: window.location.origin,
    });
    window.dispatchEvent(event);

    expect(onPaid).toHaveBeenCalledWith({
      type: "quay:paid",
      linkId: "lnk_test_123",
      link: { id: "lnk_test_123" },
    });

    unsubscribe();
  });

  // ---------------------------------------------------------------------------
  // Host resolution (issue 5.10) - no silent fallback to someone else's deployment.
  // ---------------------------------------------------------------------------

  describe("host resolution", () => {
    it("throws a clear error when no host can be determined - no explicit host and no widget.js script tag", () => {
      expect(() => Quay.open("lnk_test_123")).toThrow(/could not determine which Quay deployment/i);
      // A failed open() must be a true no-op - nothing left in the DOM.
      expect(document.getElementById("quay-checkout-modal")).toBeNull();
    });

    it("does not fall back to https://quay-web.vercel.app or any other hardcoded host", () => {
      try {
        Quay.open("lnk_test_123");
      } catch {
        /* expected */
      }
      expect(document.getElementById("quay-checkout-iframe")).toBeNull();
    });

    it("uses the explicit host option when given, even with no script tag present", () => {
      Quay.open({ linkId: "lnk_test_123", host: TEST_HOST });
      const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
      expect(iframe.src.startsWith(TEST_HOST)).toBe(true);
    });

    it("infers the host from the widget's own script tag when no explicit host is given", () => {
      document.body.innerHTML = `<script src="${TEST_HOST}/widget.js"></script>`;
      Quay.open("lnk_test_123");
      const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
      expect(iframe.src.startsWith(TEST_HOST)).toBe(true);
    });

    it("an explicit host option takes precedence over a detected script tag", () => {
      document.body.innerHTML = `<script src="https://wrong-host.example.com/widget.js"></script>`;
      Quay.open({ linkId: "lnk_test_123", host: TEST_HOST });
      const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
      expect(iframe.src.startsWith(TEST_HOST)).toBe(true);
    });

    it("a failed open() does not disturb a modal that was already open", () => {
      Quay.open({ linkId: "lnk_already_open", host: TEST_HOST });
      expect(document.getElementById("quay-checkout-modal")).not.toBeNull();

      expect(() => Quay.open("lnk_no_host")).toThrow();

      // The original modal, for the original link, is untouched.
      const iframe = document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;
      expect(iframe.src).toContain("lnk_already_open");
    });
  });

  // ---------------------------------------------------------------------------
  // Handler scoping and error isolation (issue 7.23)
  // ---------------------------------------------------------------------------

  describe("handler scoping and error isolation (issue 7.23)", () => {
    it("unsubscribes per-open() handlers on close, while Quay.on() handlers stay global", () => {
      const handlerA = vi.fn();
      const handlerB = vi.fn();
      const globalHandler = vi.fn();

      const unsubGlobal = Quay.on("quay:paid", globalHandler);

      // First open with handlerA, then close
      Quay.open({ linkId: "lnk_prod_1", host: TEST_HOST, onPaid: handlerA });
      Quay.close();

      // Second open with handlerB
      Quay.open({ linkId: "lnk_prod_2", host: TEST_HOST, onPaid: handlerB });

      // Dispatch paid message for prod 2
      const event = new MessageEvent("message", {
        data: { type: "quay:paid", linkId: "lnk_prod_2", link: { id: "lnk_prod_2" } },
        origin: window.location.origin,
      });
      window.dispatchEvent(event);

      // handlerA should NOT have been called; handlerB should have been called once
      expect(handlerA).toHaveBeenCalledTimes(0);
      expect(handlerB).toHaveBeenCalledTimes(1);
      // globalHandler registered via Quay.on() remains active
      expect(globalHandler).toHaveBeenCalledTimes(1);

      unsubGlobal();
    });

    it("unsubscribes onClosed and onError per-open handlers on close", () => {
      const onClosedA = vi.fn();
      const onClosedB = vi.fn();
      const onErrorA = vi.fn();
      const onErrorB = vi.fn();

      Quay.open({ linkId: "lnk_1", host: TEST_HOST, onClosed: onClosedA, onError: onErrorA });
      Quay.close();

      expect(onClosedA).toHaveBeenCalledTimes(1);

      Quay.open({ linkId: "lnk_2", host: TEST_HOST, onClosed: onClosedB, onError: onErrorB });

      // Dispatch error message
      const errorEvent = new MessageEvent("message", {
        data: { type: "quay:error", linkId: "lnk_2", error: "payment_failed" },
        origin: window.location.origin,
      });
      window.dispatchEvent(errorEvent);

      expect(onErrorA).toHaveBeenCalledTimes(0);
      expect(onErrorB).toHaveBeenCalledTimes(1);

      Quay.close();

      // onClosedA was called once for modal 1, never for modal 2
      expect(onClosedA).toHaveBeenCalledTimes(1);
      expect(onClosedB).toHaveBeenCalledTimes(1);
    });

    it("removes the modal from DOM and restores focus even when a closed handler throws", () => {
      const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const button = document.createElement("button");
      button.id = "focus-trigger";
      document.body.appendChild(button);
      button.focus();

      const throwingOnClosed = vi.fn(() => {
        throw new Error("handler explosion!");
      });

      Quay.open({ linkId: "lnk_throw_close", host: TEST_HOST, onClosed: throwingOnClosed });
      expect(document.getElementById("quay-checkout-modal")).not.toBeNull();

      // Quay.close() should not throw
      expect(() => Quay.close()).not.toThrow();

      // Modal must be removed from the DOM
      expect(document.getElementById("quay-checkout-modal")).toBeNull();
      // Focus must be restored
      expect(document.activeElement).toBe(button);

      expect(throwingOnClosed).toHaveBeenCalledTimes(1);
      expect(consoleErrorSpy).toHaveBeenCalled();
    });

    it("closes modal on Escape key even when an onClosed handler throws", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      Quay.open({
        linkId: "lnk_escape_throw",
        host: TEST_HOST,
        onClosed: () => {
          throw new Error("boom on escape!");
        },
      });

      expect(document.getElementById("quay-checkout-modal")).not.toBeNull();

      const escapeEvent = new KeyboardEvent("keydown", { key: "Escape" });
      document.dispatchEvent(escapeEvent);

      expect(document.getElementById("quay-checkout-modal")).toBeNull();
    });

    it("isolates handler errors so sibling handlers still execute", () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      const healthyHandler = vi.fn();
      const faultyHandler = vi.fn(() => {
        throw new Error("listener error");
      });

      const unsub1 = Quay.on("quay:paid", faultyHandler);
      const unsub2 = Quay.on("quay:paid", healthyHandler);

      Quay.open({ linkId: "lnk_sibling_test", host: TEST_HOST });

      const event = new MessageEvent("message", {
        data: { type: "quay:paid", linkId: "lnk_sibling_test" },
        origin: window.location.origin,
      });
      window.dispatchEvent(event);

      expect(faultyHandler).toHaveBeenCalledTimes(1);
      expect(healthyHandler).toHaveBeenCalledTimes(1);

      unsub1();
      unsub2();
    });
  });
});

