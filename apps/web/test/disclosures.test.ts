import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import DisclosuresPanel from "../app/components/DisclosuresPanel";
import { api, apiBase, setSessionToken, type KycDisclosure } from "../lib/api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setSessionToken(null);
  vi.restoreAllMocks();
});

describe("DisclosuresPanel", () => {
  it("shows the required empty state", () => {
    const html = renderToStaticMarkup(createElement(DisclosuresPanel, { disclosures: [] }));
    expect(html).toContain("No identity disclosures recorded yet.");
  });

  it("shows one anchor, field labels, send date, status, error and actions without values", () => {
    const disclosures: KycDisclosure[] = [{
      anchorDomain: "testanchor.stellar.org",
      status: "REJECTED",
      fields: [{ name: "first_name", sentAt: Date.UTC(2026, 9, 3), anchorStatus: "REJECTED", error: "Needs review", value: "private-field-value" } as KycDisclosure["fields"][number]],
      consent: { grantedAt: Date.UTC(2026, 9, 2), revokedAt: null },
    }];
    const html = renderToStaticMarkup(createElement(DisclosuresPanel, {
      disclosures, onRevoke: () => {}, onAskDelete: () => {},
    }));
    expect(html).toContain("testanchor.stellar.org");
    expect(html).toContain("Given name");
    expect(html).toContain("3 Oct 2026");
    expect(html).toContain("Needs review");
    expect(html).toContain("Revoke consent");
    expect(html).toContain("Ask anchor to delete");
    expect(html).not.toContain("private-field-value");
  });

  it("requests disclosure metadata with the seller session", async () => {
    const fetchMock = vi.fn(async () => new Response("[]", {
      status: 200, headers: { "content-type": "application/json" },
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    setSessionToken("session-for-test");

    await expect(api.getDisclosures()).resolves.toEqual([]);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${apiBase()}/seller/kyc/disclosures`);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer session-for-test");
    expect(init.credentials).toBe("include");
  });
});
