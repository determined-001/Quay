// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiKeyCreated, ApiKeyInfo } from "../lib/api";

const apiMock = vi.hoisted(() => ({ listApiKeys: vi.fn(), createApiKey: vi.fn(), revokeApiKey: vi.fn() }));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return { ...actual, api: apiMock };
});

import ApiKeys from "../app/components/ApiKeys";
import { CheckoutError } from "../lib/api";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const SCOPES = ["links:read", "links:write", "offramp:initiate", "api-keys:manage"];
const DEFAULTS = ["links:read", "links:write"];

const key = (over: Partial<ApiKeyInfo>): ApiKeyInfo => ({
  id: "key_1",
  name: "Production server",
  prefix: "ak_live_abcd",
  scopes: DEFAULTS,
  lastUsedAt: null,
  createdAt: Date.now() - 86_400_000,
  revokedAt: null,
  ...over,
});

describe("ApiKeys", () => {
  let container: HTMLDivElement;
  let root: Root;
  let stored: ApiKeyInfo[];
  let confirmAnswer: boolean;
  const writeText = vi.fn(async () => {});

  const flush = () => act(async () => {});
  const byLabel = (label: string) => container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  const button = (text: string) =>
    [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text)!;
  const typeName = async (value: string) => {
    const input = container.querySelector<HTMLInputElement>("#key-name")!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    stored = [key({}), key({ id: "key_old", name: "Old key", prefix: "ak_live_zzzz", revokedAt: Date.now() - 1000 })];
    confirmAnswer = true;
    vi.stubGlobal("confirm", vi.fn(() => confirmAnswer));
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });

    apiMock.listApiKeys.mockImplementation(async () => ({
      keys: stored,
      availableScopes: SCOPES,
      defaultScopes: DEFAULTS,
    }));
    apiMock.createApiKey.mockImplementation(async (input: { name: string; scopes?: string }): Promise<ApiKeyCreated> => ({
      id: "key_new",
      name: input.name,
      key: "ak_live_PLAINTEXT_SECRET_VALUE",
      scopes: (input.scopes ?? "").split(","),
      env: "live",
    }));
    apiMock.revokeApiKey.mockImplementation(async (id: string) => {
      stored = stored.map((k) => (k.id === id ? { ...k, revokedAt: Date.now() } : k));
      return { id, revokedAt: Date.now() };
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<ApiKeys />));
    await flush();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("preselects the default scopes and leaves the rest off", () => {
    expect(byLabel("links:read").checked).toBe(true);
    expect(byLabel("links:write").checked).toBe(true);
    expect(byLabel("offramp:initiate").checked).toBe(false);
    expect(byLabel("api-keys:manage").checked).toBe(false);
  });

  it("blocks creating a key with no name", async () => {
    await act(async () => button("Create key").click());
    expect(container.textContent).toContain("Enter a name for the key.");
    expect(apiMock.createApiKey).not.toHaveBeenCalled();
  });

  it("blocks creating a key with no scopes", async () => {
    await typeName("CI");
    for (const scope of DEFAULTS) await act(async () => byLabel(scope).click());
    await act(async () => button("Create key").click());
    expect(container.textContent).toContain("Select at least one scope.");
    expect(apiMock.createApiKey).not.toHaveBeenCalled();
  });

  it("creates a key, sending the trimmed name and chosen scopes, and shows the plaintext once with a working copy button", async () => {
    await typeName("  CI pipeline  ");
    await act(async () => byLabel("offramp:initiate").click());
    await act(async () => button("Create key").click());
    await flush();

    expect(apiMock.createApiKey).toHaveBeenCalledWith({
      name: "CI pipeline",
      env: "live",
      scopes: "links:read,links:write,offramp:initiate",
    });
    const banner = container.querySelector(".reveal-banner")!;
    expect(banner.textContent).toContain("it will not be shown again");
    expect(banner.textContent).toContain("ak_live_PLAINTEXT_SECRET_VALUE");

    await act(async () => button("Copy").click());
    expect(writeText).toHaveBeenCalledWith("ak_live_PLAINTEXT_SECRET_VALUE");
    expect(button("Copied!")).toBeDefined();

    // Dismissing removes the plaintext from the page for good.
    await act(async () => button("Done").click());
    expect(container.querySelector(".reveal-banner")).toBeNull();
    expect(container.textContent).not.toContain("PLAINTEXT_SECRET_VALUE");
  });

  it("resets the form to the default scopes after creating", async () => {
    await typeName("CI");
    await act(async () => byLabel("api-keys:manage").click());
    await act(async () => button("Create key").click());
    await flush();
    expect(byLabel("api-keys:manage").checked).toBe(false);
    expect(container.querySelector<HTMLInputElement>("#key-name")!.value).toBe("");
  });

  it("shows a seller-facing error when creation fails", async () => {
    apiMock.createApiKey.mockRejectedValueOnce(new CheckoutError("server_error", 500, "boom"));
    await typeName("CI");
    await act(async () => button("Create key").click());
    await flush();
    expect(container.querySelector(".err")?.textContent).toContain("went wrong on the server");
    expect(container.querySelector(".reveal-banner")).toBeNull();
  });

  it("splits active and revoked keys", () => {
    const active = container.querySelector('table[aria-label="API keys"]')!;
    expect(active.textContent).toContain("Production server");
    expect(active.textContent).not.toContain("Old key");

    const revoked = container.querySelector("details")!;
    expect(revoked.querySelector("summary")?.textContent).toContain("1 revoked key");
    expect(revoked.textContent).toContain("Old key");
  });

  it("makes no API call when the revoke confirmation is cancelled", async () => {
    confirmAnswer = false;
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Revoke key Production server"]')!.click());
    expect(confirm).toHaveBeenCalled();
    expect(apiMock.revokeApiKey).not.toHaveBeenCalled();
    expect(container.querySelector('button[aria-label="Revoke key Production server"]')).not.toBeNull();
  });

  it("revokes the confirmed key and moves it to the revoked list", async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Revoke key Production server"]')!.click());
    await flush();

    expect(apiMock.revokeApiKey).toHaveBeenCalledTimes(1);
    expect(apiMock.revokeApiKey).toHaveBeenCalledWith("key_1");
    expect(container.textContent).toContain("No active keys");
    expect(container.querySelector("details summary")?.textContent).toContain("2 revoked keys");
  });

  it("offers a retry when the key list fails to load", async () => {
    apiMock.listApiKeys.mockRejectedValueOnce(new Error("offline"));
    await act(async () => root.render(<ApiKeys key="again" />));
    await flush();
    expect(container.textContent).toContain("Failed to load API keys");

    await act(async () => button("Retry").click());
    await flush();
    expect(container.textContent).toContain("Production server");
  });
});
