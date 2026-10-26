// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../app/components/SessionGate", () => ({
  useSellerWallet: () => "GSELLERWALLET",
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => <a href={href} {...props}>{children}</a>,
}));

vi.mock("../app/components/KycPanel", () => ({ default: () => <div data-testid="kyc-panel" /> }));
vi.mock("../app/components/RegistrationForm", () => ({ default: () => <div data-testid="reg-form" /> }));
vi.mock("../app/components/ErasePanel", () => ({ default: () => <div data-testid="erase-panel" /> }));
vi.mock("../app/components/ExportPanel", () => ({ default: () => <div data-testid="export-panel" /> }));
vi.mock("../app/components/DisclosuresPanel", () => ({ default: () => <div data-testid="disclosures-panel" /> }));
vi.mock("../app/components/CashOutModal", () => ({ default: () => null }));
vi.mock("../app/components/TransferStep", () => ({ PendingTransferModal: () => null }));

import Dashboard from "../app/components/Dashboard";

// Made-up key shown once by the mocked create-key response. Joined at runtime so a
// literal `key: "ak_live_..."` does not trip gitleaks' generic-api-key rule on every promotion.
const FAKE_KEY = ["ak_live", "abcdef1234567890abcdef"].join("_");

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

interface CapturedRequest {
  url: string;
  method: string;
  body?: any;
}

describe("Dashboard tab persistence and API keys retention (issue #419)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let requests: CapturedRequest[];

  beforeEach(async () => {
    requests = [];

    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: vi.fn(async () => {}),
      },
      configurable: true,
    });

    globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      let body: any;
      if (init?.body && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      requests.push({ url, method, body });

      if (url.includes("/api-keys")) {
        if (method === "POST") {
          return new Response(
            JSON.stringify({
              id: "key_01J9TESTKEYID",
              name: body?.name ?? "Test Key",
              key: FAKE_KEY,
              prefix: "ak_live_abcd",
              env: "live",
              scopes: ["links:read"],
              createdAt: Date.now(),
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            keys: [],
            availableScopes: ["links:read", "links:write"],
            defaultScopes: ["links:read"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      if (url.includes("/links")) {
        return new Response(JSON.stringify({ links: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/health")) {
        return new Response(JSON.stringify({ ok: true, usdcTrustline: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/seller/anchor-auth")) {
        return new Response(JSON.stringify({ required: false, connected: false, anchor: null, expiresAt: null }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/seller/kyc/consent")) {
        return new Response(JSON.stringify({ consents: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/seller/kyc/disclosures")) {
        return new Response(JSON.stringify({ disclosures: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      if (url.includes("/seller/kyc")) {
        return new Response(
          JSON.stringify({
            status: "NOT_STARTED",
            requiredFields: [],
            providedFields: {},
            message: null,
            lastSyncedAt: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }

      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("does not fetch api-keys before the tab is first opened", async () => {
    await act(async () => root.render(<Dashboard />));

    const keyRequests = requests.filter((r) => r.url.includes("/api-keys"));
    expect(keyRequests).toHaveLength(0);
  });

  it("preserves reveal banner and key across tab switches until Done is pressed", async () => {
    await act(async () => root.render(<Dashboard />));

    // Initially on Payment links tab
    expect(requests.filter((r) => r.url.includes("/api-keys"))).toHaveLength(0);

    // Switch to API keys tab
    const keysTab = [...container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((b) =>
      b.textContent?.includes("API keys"),
    )!;
    expect(keysTab).toBeDefined();

    await act(async () => {
      keysTab.click();
    });

    // Keys endpoint is requested upon opening the tab
    const keyGetRequests = requests.filter(
      (r) => r.url.includes("/api-keys") && r.method === "GET",
    );
    expect(keyGetRequests.length).toBeGreaterThanOrEqual(1);

    // Create a new key
    const input = container.querySelector("#key-name") as HTMLInputElement;
    expect(input).not.toBeNull();

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, "Production Backend Key");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });

    const createBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
      b.textContent?.includes("Create key"),
    )!;
    expect(createBtn).toBeDefined();

    await act(async () => {
      createBtn.click();
    });

    // Banner and plaintext key are visible
    expect(container.textContent).toContain("Copy your key now — it will not be shown again");
    expect(container.textContent).toContain(FAKE_KEY);

    // Switch back to Payment links tab
    const linksTab = [...container.querySelectorAll<HTMLButtonElement>('button[role="tab"]')].find((b) =>
      b.textContent?.includes("Payment links"),
    )!;
    expect(linksTab).toBeDefined();

    await act(async () => {
      linksTab.click();
    });

    // ApiKeys panel is hidden, not unmounted
    const hiddenWrapper = container.querySelector("div[hidden]");
    expect(hiddenWrapper).not.toBeNull();
    expect((hiddenWrapper as HTMLElement).hidden).toBe(true);

    // Switch back to API keys tab
    await act(async () => {
      keysTab.click();
    });

    expect((hiddenWrapper as HTMLElement).hidden).toBe(false);

    // Banner and key survived the tab switch round-trip!
    expect(container.textContent).toContain("Copy your key now — it will not be shown again");
    expect(container.textContent).toContain(FAKE_KEY);

    // Click Done button
    const doneBtn = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "Done",
    )!;
    expect(doneBtn).toBeDefined();

    await act(async () => {
      doneBtn.click();
    });

    // Banner and key are now dismissed
    expect(container.textContent).not.toContain("Copy your key now — it will not be shown again");
    expect(container.textContent).not.toContain(FAKE_KEY);
  });
});
