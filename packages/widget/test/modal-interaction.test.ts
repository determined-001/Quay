// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Quay } from "../src/index";

const HOST = "https://test.example.com";

const overlay = () => document.getElementById("quay-checkout-modal");
const closeBtn = () => document.querySelector<HTMLButtonElement>(".quay-modal-close")!;
const iframe = () => document.getElementById("quay-checkout-iframe") as HTMLIFrameElement;

function post(data: unknown, origin: string) {
  window.dispatchEvent(new MessageEvent("message", { data, origin }));
}

function keydown(key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

describe("modal interaction", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });
  afterEach(() => Quay.close());

  describe("closing", () => {
    it("closes from the close button", () => {
      Quay.open({ linkId: "lnk_1", host: HOST });
      closeBtn().click();
      expect(overlay()).toBeNull();
    });

    it("closes from a click on the backdrop but not from a click inside the dialog", () => {
      Quay.open({ linkId: "lnk_1", host: HOST });
      iframe().click();
      expect(overlay()).not.toBeNull();

      overlay()!.click();
      expect(overlay()).toBeNull();
    });

    it("closes on Escape", () => {
      Quay.open({ linkId: "lnk_1", host: HOST });
      keydown("Escape");
      expect(overlay()).toBeNull();
    });

    it("ignores other keys", () => {
      Quay.open({ linkId: "lnk_1", host: HOST });
      keydown("a");
      expect(overlay()).not.toBeNull();
    });

    it("stops listening for Escape once closed", () => {
      Quay.open({ linkId: "lnk_1", host: HOST });
      Quay.close();
      Quay.open({ linkId: "lnk_2", host: HOST });
      Quay.close();
      expect(() => keydown("Escape")).not.toThrow();
      expect(overlay()).toBeNull();
    });

    it("restores focus to the element that opened it", () => {
      const trigger = document.createElement("button");
      document.body.appendChild(trigger);
      trigger.focus();
      expect(document.activeElement).toBe(trigger);

      Quay.open({ linkId: "lnk_1", host: HOST });
      expect(document.activeElement).toBe(closeBtn());

      Quay.close();
      expect(document.activeElement).toBe(trigger);
    });

    it("close() with nothing open is a no-op", () => {
      expect(() => Quay.close()).not.toThrow();
    });
  });

  describe("focus trap", () => {
    it("wraps Tab from the last focusable to the first", () => {
      Quay.open({ linkId: "lnk_1", host: HOST });
      iframe().focus();
      const event = keydown("Tab");
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(closeBtn());
    });

    it("wraps Shift+Tab from the first focusable to the last", () => {
      Quay.open({ linkId: "lnk_1", host: HOST });
      closeBtn().focus();
      const event = keydown("Tab", { shiftKey: true });
      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(iframe());
    });

    it("leaves Tab alone while focus is not on an edge", () => {
      Quay.open({ linkId: "lnk_1", host: HOST });
      closeBtn().focus();
      expect(keydown("Tab").defaultPrevented).toBe(false);
      iframe().focus();
      expect(keydown("Tab", { shiftKey: true }).defaultPrevented).toBe(false);
    });
  });

  describe("postMessage origin filter", () => {
    it("ignores a message from a foreign origin", () => {
      const onPaid = vi.fn();
      Quay.open({ linkId: "lnk_1", host: HOST, onPaid });
      post({ type: "quay:paid", linkId: "lnk_1" }, "https://evil.example");
      expect(onPaid).not.toHaveBeenCalled();
    });

    it("accepts the checkout host's origin, even when the configured host has a path", () => {
      const onPaid = vi.fn();
      Quay.open({ linkId: "lnk_1", host: `${HOST}/some/prefix`, onPaid });
      post({ type: "quay:paid", linkId: "lnk_1", link: { id: "lnk_1" } }, HOST);
      expect(onPaid).toHaveBeenCalledWith({ type: "quay:paid", linkId: "lnk_1", link: { id: "lnk_1" } });
    });

    it("accepts the embedding page's own origin", () => {
      const onPaid = vi.fn();
      Quay.open({ linkId: "lnk_1", host: HOST, onPaid });
      post({ type: "quay:paid", linkId: "lnk_1" }, window.location.origin);
      expect(onPaid).toHaveBeenCalledTimes(1);
    });

    it("ignores a foreign-origin quay:closed instead of closing the modal", () => {
      Quay.open({ linkId: "lnk_1", host: HOST });
      post({ type: "quay:closed" }, "https://evil.example");
      expect(overlay()).not.toBeNull();
    });

    it.each([null, undefined, "quay:paid", 42, true])("ignores non-object data %j", (data) => {
      const onPaid = vi.fn();
      Quay.open({ linkId: "lnk_1", host: HOST, onPaid });
      post(data, HOST);
      expect(onPaid).not.toHaveBeenCalled();
      expect(overlay()).not.toBeNull();
    });

    it("ignores an object with an unknown type", () => {
      const onPaid = vi.fn();
      const onError = vi.fn();
      Quay.open({ linkId: "lnk_1", host: HOST, onPaid, onError });
      post({ type: "quay:something-else" }, HOST);
      expect(onPaid).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe("messages from the checkout iframe", () => {
    it("forwards quay:error with its error payload", () => {
      const onError = vi.fn();
      Quay.open({ linkId: "lnk_1", host: HOST, onError });
      post({ type: "quay:error", linkId: "lnk_1", error: "wallet_rejected" }, HOST);
      expect(onError).toHaveBeenCalledWith({ type: "quay:error", linkId: "lnk_1", error: "wallet_rejected" });
    });

    it("falls back to the open link id when the message names none", () => {
      const onError = vi.fn();
      const onPaid = vi.fn();
      Quay.open({ linkId: "lnk_open", host: HOST, onError, onPaid });
      post({ type: "quay:error", error: "x" }, HOST);
      post({ type: "quay:paid" }, HOST);
      expect(onError.mock.calls[0]![0]).toMatchObject({ linkId: "lnk_open" });
      expect(onPaid.mock.calls[0]![0]).toMatchObject({ linkId: "lnk_open" });
    });

    it("closes the modal and emits quay:closed on a quay:closed message from the host", () => {
      const onClosed = vi.fn();
      Quay.open({ linkId: "lnk_1", host: HOST, onClosed });
      post({ type: "quay:closed" }, HOST);
      expect(overlay()).toBeNull();
      expect(onClosed).toHaveBeenCalledWith({ type: "quay:closed", linkId: "lnk_1" });
    });
  });

  describe("bindButtons", () => {
    it("binds a button once however many times init() runs", () => {
      document.body.innerHTML = `
        <script src="${HOST}/widget.js"></script>
        <button id="pay" data-quay-link="lnk_1">Pay</button>`;
      const onPaid = vi.fn();
      Quay.on("quay:paid", onPaid);

      Quay.init();
      Quay.init();
      document.getElementById("pay")!.click();

      expect(document.querySelectorAll("#quay-checkout-modal")).toHaveLength(1);
      expect((document.getElementById("pay") as HTMLElement).dataset.quayBound).toBe("true");
    });

    it("does nothing for a button with an empty link id", () => {
      document.body.innerHTML = `
        <script src="${HOST}/widget.js"></script>
        <button id="pay" data-quay-link="">Pay</button>`;
      Quay.init();
      document.getElementById("pay")!.click();
      expect(overlay()).toBeNull();
    });

    it("leaves the text alone without data-quay-label and sets it with one", () => {
      document.body.innerHTML = `
        <script src="${HOST}/widget.js"></script>
        <button id="plain" data-quay-link="lnk_1">Keep me</button>
        <button id="labelled" data-quay-link="lnk_2" data-quay-label="Pay $5">Old</button>`;
      Quay.init();
      expect(document.getElementById("plain")!.textContent).toBe("Keep me");
      expect(document.getElementById("labelled")!.textContent).toBe("Pay $5");
    });

    it("also binds the legacy data-stellar-checkout attribute", () => {
      document.body.innerHTML = `
        <script src="${HOST}/widget.js"></script>
        <button id="pay" data-stellar-checkout="lnk_legacy">Pay</button>`;
      Quay.init();
      document.getElementById("pay")!.click();
      expect(iframe().src).toContain("/pay/lnk_legacy?embed=true");
    });
  });
});
