import { describe, expect, it, vi } from "vitest";
import { backoffWithFullJitter, isRetryable, retryAfterMs, withHorizonRetry } from "../src/horizon-retry";

function errWithStatus(status: number, headers?: Record<string, string>) {
  return { response: { status, headers } };
}

describe("isRetryable", () => {
  it("treats 5xx as retryable", () => {
    expect(isRetryable(errWithStatus(500))).toBe(true);
    expect(isRetryable(errWithStatus(503))).toBe(true);
  });

  it("treats 429 as retryable", () => {
    expect(isRetryable(errWithStatus(429))).toBe(true);
  });

  it("treats 404 and other 4xx as terminal", () => {
    expect(isRetryable(errWithStatus(404))).toBe(false);
    expect(isRetryable(errWithStatus(400))).toBe(false);
  });

  it("treats 408 Request Timeout as terminal (only 429 and 5xx retry)", () => {
    // 408 is a client error (4xx) and is treated as terminal per RFC/Horizon policy
    expect(isRetryable(errWithStatus(408))).toBe(false);
  });

  it("treats a bare network error (no response) as retryable", () => {
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
  });
});

describe("retryAfterMs", () => {
  it("reads a numeric-seconds Retry-After header", () => {
    expect(retryAfterMs(errWithStatus(429, { "retry-after": "2" }))).toBe(2000);
  });

  it("returns null when there's no Retry-After header", () => {
    expect(retryAfterMs(errWithStatus(429))).toBeNull();
  });

  it("returns null for a non-response error", () => {
    expect(retryAfterMs(new Error("x"))).toBeNull();
  });

  it("reads an HTTP-date Retry-After header with exact difference", () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-10-18T12:00:00Z");
      vi.setSystemTime(now);
      const targetDate = new Date("2026-10-18T12:00:10Z").toUTCString();
      expect(retryAfterMs(errWithStatus(429, { "retry-after": targetDate }))).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns 0 for an HTTP-date Retry-After in the past", () => {
    vi.useFakeTimers();
    try {
      const now = new Date("2026-10-18T12:00:00Z");
      vi.setSystemTime(now);
      const pastDate = new Date("2026-10-18T11:59:50Z").toUTCString();
      expect(retryAfterMs(errWithStatus(429, { "retry-after": pastDate }))).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads from a Headers instance", () => {
    const headers = new Headers({ "retry-after": "5" });
    expect(retryAfterMs({ response: { headers } })).toBe(5000);
  });

  it("reads from a plain object with capital-case Retry-After", () => {
    expect(retryAfterMs({ response: { headers: { "Retry-After": "5" } } })).toBe(5000);
  });

  it("returns null for unparsable string", () => {
    expect(retryAfterMs(errWithStatus(429, { "retry-after": "abc" }))).toBeNull();
  });

  it("returns null for Infinity", () => {
    expect(retryAfterMs(errWithStatus(429, { "retry-after": "Infinity" }))).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(retryAfterMs(errWithStatus(429, { "retry-after": "" }))).toBeNull();
  });
});

describe("backoffWithFullJitter", () => {
  it("stays within [0, cap] and respects the ceiling", () => {
    for (let attempt = 1; attempt <= 6; attempt++) {
      const delay = backoffWithFullJitter(attempt, 100, 1000);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(1000);
    }
  });
});

describe("withHorizonRetry", () => {
  it("caps Retry-After at maxDelayMs so a large server delay sleeps no longer than maxDelayMs", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fn = vi.fn(async () => {
        calls += 1;
        if (calls === 1) throw errWithStatus(429, { "retry-after": "3600" });
        return "ok";
      });
      const onRetry = vi.fn();

      const promise = withHorizonRetry(fn, { maxDelayMs: 50, onRetry });
      await vi.advanceTimersByTimeAsync(50);
      const result = await promise;

      expect(result).toBe("ok");
      expect(fn).toHaveBeenCalledTimes(2);
      expect(onRetry).toHaveBeenCalledTimes(1);
      expect(onRetry).toHaveBeenCalledWith(1, expect.anything(), 50);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves without a caller-visible error on a 429-then-200 sequence", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw errWithStatus(429, { "retry-after": "0" });
      return "ok";
    });

    const result = await withHorizonRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and rethrows the last error", async () => {
    const fn = vi.fn(async () => {
      throw errWithStatus(503);
    });

    await expect(withHorizonRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toMatchObject({
      response: { status: 503 },
    });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("never retries a terminal 404 — the fast path stays fast", async () => {
    const fn = vi.fn(async () => {
      throw errWithStatus(404);
    });

    await expect(withHorizonRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toMatchObject({
      response: { status: 404 },
    });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls onRetry with the attempt number and computed delay", async () => {
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 2) throw errWithStatus(500);
      return "ok";
    });
    const onRetry = vi.fn();

    await withHorizonRetry(fn, { baseDelayMs: 1, maxDelayMs: 1, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toBe(1); // attempt 1 failed, about to retry
  });
});
