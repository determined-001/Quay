// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/components/SessionGate", () => ({ useSellerWallet: () => "GSELLERWALLET" }));

import ErasePanel from "../app/components/ErasePanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("ErasePanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let requests: Array<{ url: string; init?: RequestInit }>;

  beforeEach(async () => {
    requests = [];
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          erased: ["profile"],
          anchors: [{ anchorDomain: "testanchor.stellar.org", result: "not_attempted:no_session" }],
          retained: [{ what: "payment history", why: "public on the Stellar ledger" }],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<ErasePanel />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const click = async (text: string) => {
    const b = [...container.querySelectorAll("button")].find((x) => x.textContent?.includes(text))!;
    await act(async () => b.click());
  };

  it("lists retained data, requires the typed wallet, then shows the per-anchor result", async () => {
    await click("Erase my identity data");
    expect(container.textContent).toContain("Payment history");
    const confirm = [...container.querySelectorAll("button")].find((b) => b.textContent === "Erase permanently")!;
    expect(confirm.disabled).toBe(true);

    const input = container.querySelector("#erase-confirm") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "GWRONG");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(confirm.disabled).toBe(true);
    await act(async () => {
      setter.call(input, "GSELLERWALLET");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(confirm.disabled).toBe(false);

    await click("Erase permanently");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("/seller/profile");
    expect(requests[0]!.init?.method).toBe("DELETE");
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ confirm: "GSELLERWALLET" });
    expect(container.textContent).toContain("testanchor.stellar.org");
    expect(container.textContent).toContain("connect to the anchor first");
  });
});
