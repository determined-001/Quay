// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Webhook, WebhookDelivery } from "../lib/api";

const apiMock = vi.hoisted(() => ({
  listWebhooks: vi.fn(),
  createWebhook: vi.fn(),
  rotateWebhookSecret: vi.fn(),
  deleteWebhook: vi.fn(),
  listWebhookDeliveries: vi.fn(),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: apiMock };
});

import WebhooksPanel from "../app/components/WebhooksPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const hook = (over: Partial<Webhook> = {}): Webhook => ({
  id: "whk_1",
  url: "https://merchant.example/hooks/quay",
  secretLast4: "a1b2",
  previousSecretLast4: null,
  previousSecretExpiresAt: null,
  deletedAt: null,
  createdAt: Date.now() - 86_400_000,
  ...over,
});

const delivery = (id: string, over: Partial<WebhookDelivery> = {}): WebhookDelivery => ({
  id,
  webhookId: "whk_1",
  linkId: "lnk_1",
  event: `event.${id}`,
  statusCode: 200,
  ok: true,
  error: null,
  createdAt: Date.now(),
  ...over,
});

describe("WebhooksPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stored: Webhook[];
  let confirmAnswer: boolean;

  const flush = () => act(async () => {});
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
  const setUrl = async (value: string) => {
    const input = container.querySelector<HTMLInputElement>("#webhook-url")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  async function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<WebhooksPanel />));
    await flush();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stored = [hook()];
    confirmAnswer = true;
    vi.stubGlobal("confirm", vi.fn(() => confirmAnswer));
    Object.defineProperty(navigator, "clipboard", { value: { writeText: vi.fn(async () => {}) }, configurable: true });

    apiMock.listWebhooks.mockImplementation(async () => ({ webhooks: stored }));
    apiMock.createWebhook.mockImplementation(async (url: string) => ({ ...hook({ id: "whk_new", url }), secret: "whsec_NEW_SECRET" }));
    apiMock.rotateWebhookSecret.mockResolvedValue({ ...hook(), secret: "whsec_ROTATED_SECRET" });
    apiMock.deleteWebhook.mockImplementation(async (id: string) => {
      stored = stored.filter((h) => h.id !== id);
    });
    apiMock.listWebhookDeliveries.mockResolvedValue({ deliveries: [], nextCursor: null });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  describe("adding an endpoint", () => {
    it.each(["", "   "])("rejects the blank URL %j with a message and no API call", async (value) => {
      await mount();
      await setUrl(value);
      await act(async () => button("Add endpoint").click());
      expect(container.querySelector(".err")?.textContent).toBe("Add an endpoint URL.");
      expect(apiMock.createWebhook).not.toHaveBeenCalled();
    });

    it("creates with the trimmed URL, clears the field and shows the secret until Done", async () => {
      await mount();
      await setUrl("  https://new.example/hook  ");
      await act(async () => button("Add endpoint").click());
      await flush();

      expect(apiMock.createWebhook).toHaveBeenCalledWith("https://new.example/hook");
      expect(container.querySelector<HTMLInputElement>("#webhook-url")!.value).toBe("");
      expect(container.textContent).toContain("whsec_NEW_SECRET");
      expect(container.textContent).toContain("shown once");

      await act(async () => button("Done").click());
      expect(container.textContent).not.toContain("whsec_NEW_SECRET");
    });

    it("copies the secret from the one-time banner", async () => {
      await mount();
      await setUrl("https://new.example/hook");
      await act(async () => button("Add endpoint").click());
      await flush();

      await act(async () => button("Copy secret").click());
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("whsec_NEW_SECRET");
      expect(button("Copied")).toBeDefined();
    });

    it("shows the failure and no secret when creation fails", async () => {
      apiMock.createWebhook.mockRejectedValueOnce(new Error("URL must be https"));
      await mount();
      await setUrl("http://insecure.example");
      await act(async () => button("Add endpoint").click());
      await flush();
      expect(container.querySelector(".err")?.textContent).toBe("URL must be https");
      expect(container.textContent).not.toContain("signing secret");
    });
  });

  it("shows the new secret after a rotate", async () => {
    await mount();
    await act(async () => button("Rotate secret").click());
    await flush();
    expect(apiMock.rotateWebhookSecret).toHaveBeenCalledWith("whk_1");
    expect(container.textContent).toContain("whsec_ROTATED_SECRET");
  });

  describe("deleting an endpoint", () => {
    it("makes no call when the confirmation is declined", async () => {
      confirmAnswer = false;
      await mount();
      await act(async () => button("Delete").click());
      expect(confirm).toHaveBeenCalled();
      expect(apiMock.deleteWebhook).not.toHaveBeenCalled();
      expect(container.textContent).toContain("merchant.example");
    });

    it("deletes, refreshes the list and collapses an expanded deliveries row", async () => {
      await mount();
      await act(async () => button("Deliveries").click());
      await flush();
      expect(button("Hide deliveries")).toBeDefined();

      await act(async () => button("Delete").click());
      await flush();

      expect(apiMock.deleteWebhook).toHaveBeenCalledWith("whk_1");
      expect(apiMock.listWebhooks).toHaveBeenCalledTimes(2);
      expect(container.textContent).toContain("No webhooks yet");
      expect(container.textContent).not.toContain("Hide deliveries");
    });
  });

  describe("delivery history", () => {
    async function openDeliveries() {
      await mount();
      await act(async () => button("Deliveries").click());
      await flush();
    }

    it("loads 10 at a time and hides Load more when there is no next page", async () => {
      apiMock.listWebhookDeliveries.mockResolvedValue({ deliveries: [delivery("a")], nextCursor: null });
      await openDeliveries();
      expect(apiMock.listWebhookDeliveries).toHaveBeenCalledWith("whk_1", { limit: 10, cursor: null });
      expect(container.textContent).toContain("event.a");
      expect(container.textContent).not.toContain("Load more");
    });

    it("passes nextCursor through unchanged and appends the next page to the first", async () => {
      const opaque = "opaque-cursor-value";
      apiMock.listWebhookDeliveries
        .mockResolvedValueOnce({ deliveries: [delivery("a"), delivery("b")], nextCursor: opaque })
        .mockResolvedValueOnce({ deliveries: [delivery("c")], nextCursor: null });
      await openDeliveries();
      expect(container.textContent).toContain("Load more");

      await act(async () => button("Load more").click());
      await flush();

      expect(apiMock.listWebhookDeliveries).toHaveBeenLastCalledWith("whk_1", { limit: 10, cursor: opaque });
      for (const id of ["a", "b", "c"]) expect(container.textContent).toContain(`event.${id}`);
      expect(container.textContent).not.toContain("Load more");
    });

    it("says so when there are no deliveries", async () => {
      await openDeliveries();
      expect(container.textContent).toContain("No deliveries yet.");
    });

    it("marks a failed delivery with its error", async () => {
      apiMock.listWebhookDeliveries.mockResolvedValue({
        deliveries: [delivery("x", { ok: false, statusCode: null, error: "connect ECONNREFUSED" })],
        nextCursor: null,
      });
      await openDeliveries();
      expect(container.querySelector(".pill--fail")?.textContent).toBe("no response");
      expect(container.textContent).toContain("connect ECONNREFUSED");
    });

    // Known rough edge, pinned so a change to it is deliberate: a failed
    // "Load more" hits the early `if (error) return` before the table renders,
    // so the rows already loaded are replaced by the error text.
    it("currently replaces the loaded rows with the error when Load more fails", async () => {
      apiMock.listWebhookDeliveries
        .mockResolvedValueOnce({ deliveries: [delivery("a")], nextCursor: "next" })
        .mockRejectedValueOnce(new Error("Horizon is down"));
      await openDeliveries();
      await act(async () => button("Load more").click());
      await flush();

      expect(container.querySelector(".err")?.textContent).toBe("Horizon is down");
      expect(container.textContent).not.toContain("event.a");
    });
    it.todo("keeps loaded deliveries visible when load-more fails");
  });

  describe("secret rotation pill", () => {
    const pill = () => [...container.querySelectorAll(".pill")].find((p) => p.textContent?.includes("rotating"));

    it("shows while the previous secret is still valid", async () => {
      stored = [hook({ previousSecretLast4: "9z9z", previousSecretExpiresAt: Date.now() + 3_600_000 })];
      await mount();
      expect(pill()?.textContent).toContain("old key active until");
    });

    it("is gone once the previous secret has expired", async () => {
      stored = [hook({ previousSecretLast4: "9z9z", previousSecretExpiresAt: Date.now() - 1_000 })];
      await mount();
      expect(pill()).toBeUndefined();
    });

    it("is absent when there is no previous secret", async () => {
      stored = [hook({ previousSecretLast4: null, previousSecretExpiresAt: Date.now() + 3_600_000 })];
      await mount();
      expect(pill()).toBeUndefined();
    });
  });
});
