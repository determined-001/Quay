import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

// ---------------------------------------------------------------------------
//  `ctx.req.json()` buffers the entire body before any zod schema sees it, so
//  validation is not a size defense — it runs too late. The rate limiter is not
//  one either: it counts requests, not bytes, and its default of 120/min/IP is
//  ample budget to exhaust a small instance.
//
//  What makes this worth blocking rather than tolerating is co-tenancy. The
//  settlement watcher runs in this same process. An OOM here does not return
//  502 for a minute; it stops payments being marked paid until the instance
//  comes back.
// ---------------------------------------------------------------------------

const MAX = 64 * 1024;

function app() {
  const a = new Hono();
  a.use("*", bodyLimit({ maxSize: MAX, onError: (ctx) => ctx.json({ error: "payload_too_large" }, 413) }));
  a.post("/links", async (ctx) => ctx.json({ received: Object.keys((await ctx.req.json()) as object).length }));
  return a;
}

async function post(body: string) {
  return app().request("/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("request body limit", () => {
  it("accepts a normal payment link payload", async () => {
    const res = await post(JSON.stringify({ title: "T-shirt", amount: "10.50", assetCode: "USDC" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: 3 });
  });

  it("rejects a body over the cap with 413, not 500", async () => {
    const res = await post(JSON.stringify({ title: "x".repeat(MAX + 1) }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as Record<string, unknown>).error).toBe("payload_too_large");
  });

  it("rejects it without parsing — the point is that the heap never sees it", async () => {
    // Deliberately not valid JSON. A 413 here proves the limiter ran before the
    // body was read; a 400 would mean we parsed first and capped afterwards.
    const res = await post("x".repeat(MAX + 1));
    expect(res.status).toBe(413);
  });

  it("still accepts a body just under the cap", async () => {
    const body = JSON.stringify({ title: "x".repeat(MAX - 200) });
    expect(body.length).toBeLessThan(MAX);
    expect((await post(body)).status).toBe(200);
  });
});
