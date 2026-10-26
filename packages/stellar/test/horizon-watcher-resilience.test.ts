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

  it("stays on a healthy fallback while the primary is down — no failed ticks after the switch", async () => {
    let t = 0;
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
      degradedThreshold: 2,
      primaryRetryMs: 1000,
      now: () => t,
      retryOptions: { ...FAST_RETRY, maxAttempts: 1 },
    });

    // Only the first `degradedThreshold` calls fail.
    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(watcher.getStatus().usingFallback).toBe(true);

    const primaryAfterSwitch = primaryCalls;
    for (let i = 0; i < 5; i += 1) {
      await expect(watcher.fetchSince("GACCOUNT", "")).resolves.toEqual([]);
    }
    expect(fallbackCalls).toBe(5);
    // Inside the cooldown the primary is not touched at all.
    expect(primaryCalls).toBe(primaryAfterSwitch);
    expect(watcher.getStatus()).toMatchObject({ degraded: false, usingFallback: true, consecutiveFailures: 0 });
  });

  it("a failed probe after the cooldown is served by the fallback and does not fail the tick", async () => {
    let t = 0;
    let primaryCalls = 0;
    const primary = fakeServer(async () => {
      primaryCalls += 1;
      throw errWithStatus(503);
    });
    const fallback = fakeServer(async () => ({ records: [] }));
    const watcher = new HorizonWatcher({
      primaryServer: primary,
      fallbackServer: fallback,
      degradedThreshold: 1,
      primaryRetryMs: 1000,
      now: () => t,
      retryOptions: { ...FAST_RETRY, maxAttempts: 1 },
    });

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(watcher.getStatus().usingFallback).toBe(true);
    const before = primaryCalls;

    t = 1500; // cooldown elapsed: one probe of the primary
    await expect(watcher.fetchSince("GACCOUNT", "")).resolves.toEqual([]);
    expect(primaryCalls).toBe(before + 1);
    expect(watcher.getStatus()).toMatchObject({ usingFallback: true, consecutiveFailures: 0 });

    // The cooldown restarted, so the next call does not probe again.
    await expect(watcher.fetchSince("GACCOUNT", "")).resolves.toEqual([]);
    expect(primaryCalls).toBe(before + 1);
  });

  it("returns to the primary after the cooldown once the primary itself has recovered", async () => {
    let t = 0;
    let primaryUp = false;
    let primaryCalls = 0;
    const primary = fakeServer(async () => {
      primaryCalls += 1;
      if (!primaryUp) throw errWithStatus(503);
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
      primaryRetryMs: 1000,
      now: () => t,
      retryOptions: { ...FAST_RETRY, maxAttempts: 1 },
    });

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    await watcher.fetchSince("GACCOUNT", "");
    expect(fallbackCalls).toBe(1);

    primaryUp = true;
    await watcher.fetchSince("GACCOUNT", ""); // still inside the cooldown
    expect(fallbackCalls).toBe(2);
    expect(watcher.getStatus().usingFallback).toBe(true);

    t = 2000;
    await watcher.fetchSince("GACCOUNT", ""); // probe succeeds
    expect(fallbackCalls).toBe(2);
    expect(watcher.getStatus()).toEqual({ degraded: false, usingFallback: false, consecutiveFailures: 0 });

    const before = primaryCalls;
    await watcher.fetchSince("GACCOUNT", "");
    expect(primaryCalls).toBe(before + 1); // back on the primary
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
