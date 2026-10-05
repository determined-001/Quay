// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/components/SessionGate", () => ({ useSellerWallet: () => "GSELLER" }));
vi.mock("../lib/payment-preflight", () => ({ checkPaymentPreflight: () => ({ ok: true }) }));
vi.mock("../app/components/TransferOtherDevice", () => ({ TransferOtherDevice: () => null }));
const sendAnchorTransfer = vi.fn(async () => "hash_sent_1");
vi.mock("../lib/wallet", () => ({
  sendAnchorTransfer: (...args: unknown[]) => (sendAnchorTransfer as (...a: unknown[]) => unknown)(...args),
  shortAddress: (a: string) => a,
}));

import { PendingTransferModal } from "../app/components/TransferStep";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TRANSFER = {
  destination: "GANCHOR",
  amount: "10",
  asset: { code: "USDC", issuer: "GISSUER" },
  memo: "42",
  memoType: "id",
};

describe("PendingTransferModal (resume an unsent withdrawal transfer)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let calls: string[];

  function stubFetch(status: number, body: unknown) {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  async function mount() {
    await act(async () => {
      root.render(<PendingTransferModal linkId="lnk_1" onClose={() => {}} />);
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }

  beforeEach(() => {
    calls = [];
    sendAnchorTransfer.mockClear();
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("fetches the instructions on open and offers the send button", async () => {
    stubFetch(200, { transfer: TRANSFER });
    await mount();
    expect(calls.some((u) => u.endsWith("/links/lnk_1/cash-out/transfer"))).toBe(true);
    expect(container.textContent).toContain("Send with my wallet");
  });

  it("does not offer a second send once the hash is remembered for the session", async () => {
    window.sessionStorage.setItem("quay:transfer-sent:lnk_1:GANCHOR:42", "hash_sent_1");
    stubFetch(200, { transfer: TRANSFER });
    await mount();
    expect(container.textContent).toContain("Payment sent, waiting for the anchor to see it");
    expect(container.textContent).not.toContain("Send with my wallet");
    expect(sendAnchorTransfer).not.toHaveBeenCalled();
  });

  it("explains a 404 as instructions not published yet", async () => {
    stubFetch(404, { error: "not_found" });
    await mount();
    expect(container.textContent).toContain("has not published transfer instructions");
  });
});
