import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anchorFetch, AnchorTimeoutError } from "../src/http";

describe("anchorFetch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("completes normally when fetch resolves before the timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const res = await anchorFetch("https://anchor.example/test", {}, 5000);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("aborts and throws typed AnchorTimeoutError when fetch hangs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url, init) => {
        return new Promise((resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }
        });
      }),
    );

    const fetchPromise = anchorFetch("https://anchor.example/hanging-endpoint", {}, 2000);

    vi.advanceTimersByTime(2000);

    await expect(fetchPromise).rejects.toThrow(AnchorTimeoutError);
    await expect(fetchPromise).rejects.toMatchObject({
      name: "AnchorTimeoutError",
      url: "https://anchor.example/hanging-endpoint",
      timeoutMs: 2000,
    });
  });

  it("respects caller-provided AbortSignal if caller aborts early", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url, init) => {
        return new Promise((resolve, reject) => {
          if (init?.signal) {
            init.signal.addEventListener("abort", () => {
              reject(new DOMException("User aborted", "AbortError"));
            });
          }
        });
      }),
    );

    const controller = new AbortController();
    const fetchPromise = anchorFetch("https://anchor.example/custom-abort", {
      signal: controller.signal,
      timeoutMs: 10_000,
    });

    controller.abort();

    await expect(fetchPromise).rejects.toThrow("User aborted");
  });
});
