// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ExportPanel from "../app/components/ExportPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("ExportPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let requests: Array<{ url: string; init?: RequestInit }>;
  let respond: () => Response;
  let downloads: string[];

  beforeEach(async () => {
    requests = [];
    downloads = [];
    respond = () =>
      new Response(JSON.stringify({ seller: { id: "sel_1" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      requests.push({ url: String(url), init });
      return respond();
    }) as unknown as typeof fetch;
    URL.createObjectURL = vi.fn(() => "blob:quay-export");
    URL.revokeObjectURL = vi.fn();
    // Record the saved filename instead of letting happy-dom try to navigate to the blob.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root.render(<ExportPanel />));
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const clickDownload = async () => {
    const b = [...container.querySelectorAll("button")].find((x) => x.textContent?.includes("Download my data"))!;
    await act(async () => b.click());
  };

  it("fetches the export with credentials and saves it as a dated JSON file", async () => {
    await clickDownload();

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain("/seller/profile/export");
    expect(requests[0]!.init?.method ?? "GET").toBe("GET");
    expect(requests[0]!.init?.credentials).toBe("include");
    expect(downloads).toEqual([`quay-export-${new Date().toISOString().slice(0, 10)}.json`]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:quay-export");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("downloaded");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("says what is in the file and what is left out", () => {
    expect(container.textContent).toContain("KYC records");
    expect(container.textContent).toContain("never contains passwords, tokens, secrets or key hashes");
  });

  it("explains the hourly limit on a 429 and saves nothing", async () => {
    respond = () =>
      new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      });
    await clickDownload();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("5 times an hour");
    expect(downloads).toEqual([]);
  });

  it("shows a plain error on any other failure and re-enables the button", async () => {
    respond = () => new Response("{}", { status: 500 });
    await clickDownload();

    expect(container.querySelector('[role="alert"]')?.textContent).toContain("couldn't prepare");
    const button = [...container.querySelectorAll("button")].find((x) => x.textContent?.includes("Download my data"))!;
    expect(button.disabled).toBe(false);
    expect(downloads).toEqual([]);
  });
});
