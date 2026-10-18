import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { rateLimit, MemoryStore, clientIp, _resetStoreErrorLogThrottle, type RateLimitStore } from "./rate-limit";
import { metrics } from "../metrics";

function appWithLimit(max: number, trustProxyHops: number) {
  const app = new Hono();
  app.use("*", rateLimit({ windowMs: 60_000, max, store: new MemoryStore(), trustProxyHops }));
  app.get("/", (ctx) => ctx.json({ ok: true }));
  return app;
}

describe("clientIp", () => {
  it("trusts only the nth entry from the right, not the leftmost", async () => {
    const app = new Hono();
    app.get("/", (ctx) => ctx.json({ ip: clientIp(ctx, 1) }));
    // Chain: [attacker-supplied, real-proxy-appended]. With trustProxyHops=1,
    // the rightmost entry (index length-1) is the one our own proxy set.
    const res = await app.request("/", {
      headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" },
    });
    const body = await res.json() as { ip: string };
    expect(body.ip).toBe("5.6.7.8");
  });

  it("ignores x-forwarded-for entirely when trustProxyHops is 0", async () => {
    const app = new Hono();
    app.get("/", (ctx) => ctx.json({ ip: clientIp(ctx, 0) }));
    const res = await app.request("/", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    const body = await res.json() as { ip: string };
    expect(body.ip).not.toBe("1.2.3.4");
  });
});

describe("rateLimit with spoofed x-forwarded-for", () => {
  it("cannot bypass the limit by sending a fresh forged chain per request", async () => {
    const app = appWithLimit(2, 1);

    // Same trusted (rightmost) hop each time — only the untrusted, attacker
    // controlled leftmost entry changes. Because trustProxyHops=1 only looks
    // at the rightmost entry, all three requests must share one counter.
    const req = (spoofed: string) =>
      app.request("/", { headers: { "x-forwarded-for": `${spoofed}, 9.9.9.9` } });

    const r1 = await req("1.1.1.1");
    const r2 = await req("2.2.2.2");
    const r3 = await req("3.3.3.3");

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(429);
  });

  it("gives a fresh budget to a genuinely different trusted hop", async () => {
    const app = appWithLimit(1, 1);

    const r1 = await app.request("/", { headers: { "x-forwarded-for": "1.1.1.1, 9.9.9.9" } });
    const r2 = await app.request("/", { headers: { "x-forwarded-for": "2.2.2.2, 8.8.8.8" } });

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
  });
});

describe("rateLimit store failure and degradation", () => {
  beforeEach(() => {
    _resetStoreErrorLogThrottle();
    metrics.rateLimitStoreErrorsTotal.reset();
  });

  it("degrades to MemoryStore when store throws, omitting headers and counting metric", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejectingStore: RateLimitStore = {
      increment: vi.fn().mockRejectedValue(new Error("Redis connection refused")),
    };

    const app = new Hono();
    app.use(
      "*",
      rateLimit({
        windowMs: 60_000,
        max: 2,
        store: rejectingStore,
        name: "strict_test",
      }),
    );
    app.get("/", (ctx) => ctx.json({ ok: true }));

    // First request degrades to MemoryStore
    const res1 = await app.request("/");
    expect(res1.status).toBe(200);
    expect(res1.headers.get("x-ratelimit-limit")).toBeNull();
    expect(res1.headers.get("x-ratelimit-remaining")).toBeNull();
    expect(res1.headers.get("x-ratelimit-reset")).toBeNull();

    // Second request is also counted in the fallback MemoryStore
    const res2 = await app.request("/");
    expect(res2.status).toBe(200);

    // Third request exceeds max=2 in fallback MemoryStore and is throttled
    const res3 = await app.request("/");
    expect(res3.status).toBe(429);

    // Metric counter is incremented per store error
    expect(metrics.rateLimitStoreErrorsTotal.render()).toContain('rate_limit_store_errors_total{limiter="strict_test"} 3');

    // Warning is logged on first error
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[rate-limit] store error on limiter "strict_test", degrading to MemoryStore: Redis connection refused'),
    );

    warnSpy.mockRestore();
  });

  it("times out hanging store and degrades using fake timers", async () => {
    vi.useFakeTimers();
    try {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const hangingStore: RateLimitStore = {
        increment: () => new Promise(() => {}), // never resolves
      };

      const app = new Hono();
      app.use(
        "*",
        rateLimit({
          windowMs: 60_000,
          max: 5,
          store: hangingStore,
          storeTimeoutMs: 500,
          name: "global_test",
        }),
      );
      app.get("/", (ctx) => ctx.json({ ok: true }));

      const requestPromise = app.request("/");
      await vi.advanceTimersByTimeAsync(500);

      const res = await requestPromise;
      expect(res.status).toBe(200);
      expect(res.headers.get("x-ratelimit-limit")).toBeNull();
      expect(metrics.rateLimitStoreErrorsTotal.render()).toContain('rate_limit_store_errors_total{limiter="global_test"} 1');

      warnSpy.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exempts /health and /ready routes even when store hangs or fails", async () => {
    const hangingStore: RateLimitStore = {
      increment: () => new Promise(() => {}), // never resolves
    };

    const app = new Hono();
    app.use(
      "*",
      rateLimit({
        windowMs: 60_000,
        max: 5,
        store: hangingStore,
        name: "probe_test",
      }),
    );
    app.get("/health", (ctx) => ctx.json({ ok: true }));
    app.get("/ready", (ctx) => ctx.json({ ready: true }));

    const resHealth = await app.request("/health");
    expect(resHealth.status).toBe(200);
    const healthBody = await resHealth.json();
    expect(healthBody).toEqual({ ok: true });

    const resReady = await app.request("/ready");
    expect(resReady.status).toBe(200);
    const readyBody = await resReady.json();
    expect(readyBody).toEqual({ ready: true });

    // Store error metric should NOT have been touched for probe routes
    expect(metrics.rateLimitStoreErrorsTotal.render()).not.toContain("probe_test");
  });

  it("throttles store error warnings to at most once per minute", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejectingStore: RateLimitStore = {
      increment: vi.fn().mockRejectedValue(new Error("Redis offline")),
    };

    const app = new Hono();
    app.use(
      "*",
      rateLimit({
        windowMs: 60_000,
        max: 10,
        store: rejectingStore,
        name: "throttle_test",
      }),
    );
    app.get("/", (ctx) => ctx.json({ ok: true }));

    await app.request("/");
    await app.request("/");
    await app.request("/");

    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("healthy store functions normally with rate-limit headers", async () => {
    const app = new Hono();
    app.use(
      "*",
      rateLimit({
        windowMs: 60_000,
        max: 5,
        store: new MemoryStore(),
        name: "healthy_test",
      }),
    );
    app.get("/", (ctx) => ctx.json({ ok: true }));

    const res = await app.request("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("5");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("4");
    expect(res.headers.get("x-ratelimit-reset")).not.toBeNull();
    expect(metrics.rateLimitStoreErrorsTotal.render()).not.toContain("healthy_test");
  });
});
