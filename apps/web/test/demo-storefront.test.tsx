// @vitest-environment happy-dom
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/script", () => ({ default: () => null }));

import DemoPage from "../app/demo/page";

/**
 * The demo API is testnet-only (apps/api/src/routes/demo.ts answers 403 on
 * mainnet), so on the live mainnet site this page cannot seed a working
 * checkout. It used to render a permanently disabled "Pay" button with
 * `pnpm demo:seed` printed under it — a developer instruction one click from
 * the hero. Issue 5.43.
 */

const savedFetch = global.fetch;

beforeEach(() => {
  // /demo/link answers 200 with no seeded link, which is what mainnet does
  // (there it is a 403 in practice; either way there is no link to pay).
  global.fetch = vi.fn(async () =>
    ({
      ok: true,
      status: 200,
      json: async () => ({ linkId: null }),
    }) as unknown as Response,
  ) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = savedFetch;
  vi.unstubAllEnvs();
});

async function renderPage(): Promise<string> {
  return renderToString(await DemoPage());
}

describe("demo page on mainnet", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "public"));

  it("shows no pnpm command and no disabled pay button", async () => {
    const html = await renderPage();
    expect(html).not.toContain("pnpm");
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("demo-pay-btn");
  });

  it("says the widget needs a real link and points at the dashboard", async () => {
    const html = await renderPage();
    expect(html).toContain("needs a real payment link");
    expect(html).toContain('href="/dashboard"');
  });

  it("still shows the storefront and the integration snippet", async () => {
    const html = await renderPage();
    expect(html).toContain("Ceramic Artisans Co.");
    expect(html).toContain("Integration Snippet");
    expect(html).toContain("quay-web.vercel.app/widget.js");
  });
});

describe("demo page on testnet", () => {
  beforeEach(() => vi.stubEnv("NEXT_PUBLIC_STELLAR_NETWORK", "testnet"));

  it("still shows the seeding hint when nothing is seeded", async () => {
    const html = await renderPage();
    expect(html).toContain("pnpm demo:seed");
    expect(html).toContain("disabled");
  });
});
