import type { Horizon } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { HorizonWatcher } from "../src/horizon-watcher";

// Minimal fake satisfying just the chain HorizonWatcher actually calls:
// client.payments().forAccount().order().limit()[.cursor()].join().call()
function fakeServer(call: () => Promise<{ records: unknown[] }>): Horizon.Server {
  const builder = {
    forAccount: () => builder,
    order: () => builder,
    limit: () => builder,
    cursor: () => builder,
    join: () => builder,
    call,
  };
  return { payments: () => builder } as unknown as Horizon.Server;
}

function errWithStatus(status: number) {
  return { response: { status } };
}

const FAST_RETRY = { baseDelayMs: 1, maxDelayMs: 1 };

describe("HorizonWatcher — degraded tracking + fallback", () => {
  it("treats a 404 as a normal answer, not a failure — stays not-degraded", async () => {
    const server = fakeServer(async () => {
      throw errWithStatus(404);
    });
    const watcher = new HorizonWatcher({ primaryServer: server, retryOptions: FAST_RETRY });

    const result = await watcher.latestCursor("GACCOUNT");
    expect(result).toBeNull();
    expect(watcher.getStatus()).toEqual({ degraded: false, usingFallback: false, consecutiveFailures: 0 });
  });

  it("resolves a 429-then-200 sequence transparently (retry policy wired through)", async () => {
    let calls = 0;
    const server = fakeServer(async () => {
      calls += 1;
      if (calls === 1) throw errWithStatus(429);
      return { records: [] };
    });
    const watcher = new HorizonWatcher({ primaryServer: server, retryOptions: FAST_RETRY });

    const result = await watcher.fetchSince("GACCOUNT", "");
    expect(result).toEqual([]);
    expect(watcher.getStatus().degraded).toBe(false);
    expect(calls).toBe(2);
  });

  it("marks degraded after `degradedThreshold` consecutive failed calls, and recovers on success", async () => {
    const server = fakeServer(async () => {
      throw errWithStatus(503);
    });
    const watcher = new HorizonWatcher({ primaryServer: server, degradedThreshold: 2, retryOptions: FAST_RETRY });

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(watcher.getStatus()).toMatchObject({ degraded: false, consecutiveFailures: 1 });

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(watcher.getStatus()).toMatchObject({ degraded: true, consecutiveFailures: 2 });
  });

  it("switches to the fallback server after the threshold, and does not flap back to a dead primary", async () => {
    let primaryCalls = 0;
    const primary = fakeServer(async () => {
      primaryCalls += 1;
      throw errWithStatus(503);
    });
    let fallbackCalls = 0;
    const fallback = fakeServer(async () => {
      fallbackCalls += 1;
      return { records: [] };
    });

    const watcher = new HorizonWatcher({
      primaryServer: primary,
      fallbackServer: fallback,
      degradedThreshold: 1,
      retryOptions: FAST_RETRY,
    });

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(watcher.getStatus().usingFallback).toBe(true);

    // Subsequent calls should hit fallback and succeed without flapping back to dead primary
    for (let i = 0; i < 3; i++) {
      const result = await watcher.fetchSince("GACCOUNT", "");
      expect(result).toEqual([]);
    }
    expect(fallbackCalls).toBe(3);
    expect(watcher.getStatus()).toEqual({ degraded: false, usingFallback: true, consecutiveFailures: 0 });
  });

  it("probes primary after cooldown and returns to it when recovered", async () => {
    let currentTime = 1000;
    let primaryHealthy = false;
    let primaryCalls = 0;
    const primary = fakeServer(async () => {
      primaryCalls += 1;
      if (!primaryHealthy) throw errWithStatus(503);
      return { records: [] };
    });
    let fallbackCalls = 0;
    const fallback = fakeServer(async () => {
      fallbackCalls += 1;
      return { records: [] };
    });

    const watcher = new HorizonWatcher({
      primaryServer: primary,
      fallbackServer: fallback,
      degradedThreshold: 1,
      cooldownMs: 10_000,
      now: () => currentTime,
      retryOptions: { ...FAST_RETRY, maxAttempts: 1 },
    });

    // 1. Initial failure moves to fallback
    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(primaryCalls).toBe(1);
    expect(watcher.getStatus().usingFallback).toBe(true);

    // 2. Before cooldown expires, calls go straight to fallback
    currentTime += 5_000;
    await watcher.fetchSince("GACCOUNT", "");
    expect(fallbackCalls).toBe(1);
    expect(primaryCalls).toBe(1); // no extra primary calls
    expect(watcher.getStatus().usingFallback).toBe(true);

    // 3. Cooldown expires, but primary still fails: probe fails, but call succeeds via fallback
    currentTime += 6_000; // now 11_000 >= 10_000 cooldown
    await watcher.fetchSince("GACCOUNT", "");
    expect(primaryCalls).toBe(2); // probed primary
    expect(fallbackCalls).toBe(2); // served by fallback
    expect(watcher.getStatus().usingFallback).toBe(true);

    // 4. Primary recovers; next probe after another cooldown switches back
    currentTime += 11_000;
    primaryHealthy = true;
    const result = await watcher.fetchSince("GACCOUNT", "");
    expect(result).toEqual([]);
    expect(primaryCalls).toBe(3); // probed primary
    expect(fallbackCalls).toBe(2); // not touched fallback this time
    expect(watcher.getStatus()).toEqual({ degraded: false, usingFallback: false, consecutiveFailures: 0 });
  });

  it("logs horizon_degraded and horizon_recovered", async () => {
    const log = vi.fn();
    let calls = 0;
    const server = fakeServer(async () => {
      calls += 1;
      if (calls === 1) throw errWithStatus(503); // first fetchSince call fails, second succeeds
      return { records: [] };
    });
    const watcher = new HorizonWatcher({ primaryServer: server, degradedThreshold: 1, retryOptions: { ...FAST_RETRY, maxAttempts: 1 }, log });

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("horizon_degraded"));

    await watcher.fetchSince("GACCOUNT", "");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("horizon_recovered"));
  });
});
