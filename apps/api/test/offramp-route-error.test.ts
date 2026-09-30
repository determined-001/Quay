import { afterEach, describe, expect, it, vi } from "vitest";
import { NOOP_LOGGER } from "@checkout/core";
import type { Container } from "../src/services/container";

// The route short-circuits when OFFRAMP=mock (the suite default), so run it as
// testanchor with the anchor's /info failing.
vi.mock("../src/env", () => ({ env: { offramp: "testanchor" } }));

const MARKER = "SECRET-MARKER";

describe("GET /offramp/info: anchor failures (issue 4.36)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  async function call() {
    const { offrampRoutes } = await import("../src/routes/offramp");
    return offrampRoutes({ logger: NOOP_LOGGER } as unknown as Container).request("/info");
  }

  it("does not echo the anchor's response body", async () => {
    globalThis.fetch = (async () =>
      new Response(`<html>${MARKER} stack at /srv/app.js:1</html>`, { status: 500 })) as typeof fetch;
    const res = await call();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(MARKER);
    expect(text).not.toContain("<html>");
    expect(JSON.parse(text)).toEqual({
      error: "anchor_error",
      message: "The anchor returned an error (SEP-6 /info, HTTP 500).",
    });
  });

  it("does not echo a network error's text", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError(`fetch failed ${MARKER} 10.0.0.7`);
    }) as typeof fetch;
    const res = await call();
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain(MARKER);
    expect(JSON.parse(text)).toMatchObject({ error: "anchor_error" });
  });
});
