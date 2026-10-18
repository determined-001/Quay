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

// For the failover tests we count attempts, so retries must not multiply them.
const ONE_ATTEMPT = { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 1 };

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

    // Still failing: the threshold is reached and the watcher is degraded.
    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(watcher.getStatus()).toMatchObject({ degraded: true, consecutiveFailures: 2 });
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

// ---------------------------------------------------------------------------
//  Issue 2.8 — leaving the fallback on any success made the watcher alternate
//  between the two servers (FAIL, ok, FAIL, ok, …) for as long as the primary
//  stayed down. A fallback success says nothing about the primary, so the way
//  back is a probe: one call spent on the primary, once per cooldown.
// ---------------------------------------------------------------------------
describe("HorizonWatcher — no flapping while the primary is down (issue 2.8)", () => {
  function failoverRig(opts: { degradedThreshold?: number; primaryHealthy?: () => boolean } = {}) {
    const clock = { t: 0 };
    let primaryCalls = 0;
    let fallbackCalls = 0;
    const primary = fakeServer(async () => {
      primaryCalls += 1;
      if (opts.primaryHealthy?.() ?? false) return { records: [] };
      throw errWithStatus(503);
    });
    const fallback = fakeServer(async () => {
      fallbackCalls += 1;
      return { records: [] };
    });
    const watcher = new HorizonWatcher({
      primaryServer: primary,
      fallbackServer: fallback,
      degradedThreshold: opts.degradedThreshold ?? 1,
      primaryProbeIntervalMs: 60_000,
      now: () => clock.t,
      retryOptions: ONE_ATTEMPT,
    });
    return {
      clock,
      watcher,
      primaryCalls: () => primaryCalls,
      fallbackCalls: () => fallbackCalls,
    };
  }

  it("fails only the first `degradedThreshold` calls, then serves every tick from the fallback", async () => {
    const rig = failoverRig({ degradedThreshold: 3 });

    for (let i = 0; i < 3; i += 1) {
      await expect(rig.watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    }
    expect(rig.primaryCalls()).toBe(3);
    expect(rig.watcher.getStatus()).toMatchObject({
      degraded: true,
      usingFallback: true,
      consecutiveFailures: 3,
    });

    // 25 more ticks, all inside the cooldown. The primary is still down, but
    // none of these calls fails — which is the whole point of the fix.
    for (let i = 0; i < 25; i += 1) {
      await expect(rig.watcher.fetchSince("GACCOUNT", "")).resolves.toEqual([]);
    }

    expect(rig.fallbackCalls()).toBe(25);
    expect(rig.primaryCalls()).toBe(3);
    expect(rig.watcher.getStatus()).toMatchObject({ usingFallback: true, consecutiveFailures: 3 });
  });

  it("probes the primary after the cooldown, and a failed probe is still answered — by the fallback", async () => {
    const rig = failoverRig();
    await expect(rig.watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(rig.watcher.getStatus().usingFallback).toBe(true);
    expect(rig.fallbackCalls()).toBe(0);

    // The cooldown elapses, so this tick spends its attempt on the primary...
    rig.clock.t = 60_000;
    // ...and the consumer still gets an answer, because the failed probe is
    // retried on the fallback that is covering the primary.
    await expect(rig.watcher.fetchSince("GACCOUNT", "")).resolves.toEqual([]);
    expect(rig.primaryCalls()).toBe(2);
    expect(rig.fallbackCalls()).toBe(1);
    expect(rig.watcher.getStatus().usingFallback).toBe(true);

    // The failed probe must not poison the next call: the following tick goes
    // straight back to the fallback and succeeds without touching the primary.
    await expect(rig.watcher.fetchSince("GACCOUNT", "")).resolves.toEqual([]);
    expect(rig.primaryCalls()).toBe(2);
    expect(rig.fallbackCalls()).toBe(2);
    expect(rig.watcher.getStatus().usingFallback).toBe(true);
  });

  it("keeps probing on the cooldown, not on every tick", async () => {
    const rig = failoverRig();
    await expect(rig.watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();

    // One probe per cooldown, however many ticks fall inside it.
    for (let i = 0; i < 5; i += 1) {
      rig.clock.t += 10_000;
      await expect(rig.watcher.fetchSince("GACCOUNT", "")).resolves.toEqual([]);
    }
    expect(rig.primaryCalls()).toBe(1); // only the original failing call; 50s < 60s
    expect(rig.fallbackCalls()).toBe(5);

    rig.clock.t = 61_000;
    await expect(rig.watcher.fetchSince("GACCOUNT", "")).resolves.toEqual([]);
    expect(rig.primaryCalls()).toBe(2); // the probe
  });

  it("returns to the primary after the cooldown once the primary recovers", async () => {
    let healthy = false;
    const rig = failoverRig({ primaryHealthy: () => healthy });

    await expect(rig.watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(rig.watcher.getStatus().usingFallback).toBe(true);

    // Still inside the cooldown: the fallback answers, the primary is untouched.
    await rig.watcher.fetchSince("GACCOUNT", "");
    expect(rig.fallbackCalls()).toBe(1);
    expect(rig.primaryCalls()).toBe(1);

    // The primary comes back, and the cooldown elapses.
    healthy = true;
    rig.clock.t = 60_000;
    await expect(rig.watcher.fetchSince("GACCOUNT", "")).resolves.toEqual([]);

    expect(rig.watcher.getStatus()).toEqual({ degraded: false, usingFallback: false, consecutiveFailures: 0 });

    // ...and the next tick goes straight to the primary again.
    await rig.watcher.fetchSince("GACCOUNT", "");
    expect(rig.fallbackCalls()).toBe(1);
    expect(rig.watcher.getStatus().usingFallback).toBe(false);
  });

  it("announces the recovery only when the primary answers the probe", async () => {
    let healthy = false;
    const log = vi.fn();
    const primary = fakeServer(async () => {
      if (!healthy) throw errWithStatus(503);
      return { records: [] };
    });
    const fallback = fakeServer(async () => ({ records: [] }));
    const clock = { t: 0 };
    const watcher = new HorizonWatcher({
      primaryServer: primary,
      fallbackServer: fallback,
      degradedThreshold: 1,
      primaryProbeIntervalMs: 60_000,
      now: () => clock.t,
      retryOptions: ONE_ATTEMPT,
      log,
    });

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    // Fallback successes are not recoveries: no "horizon_recovered" yet.
    await watcher.fetchSince("GACCOUNT", "");
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("horizon_recovered"));

    healthy = true;
    clock.t = 60_000;
    await watcher.fetchSince("GACCOUNT", "");

    expect(log).toHaveBeenCalledWith(expect.stringContaining("horizon_recovered"));
    expect(watcher.getStatus().usingFallback).toBe(false);
  });

  it("still counts failures and reports degraded when no fallback is configured", async () => {
    const server = fakeServer(async () => {
      throw errWithStatus(503);
    });
    const watcher = new HorizonWatcher({ primaryServer: server, degradedThreshold: 2, retryOptions: ONE_ATTEMPT });

    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    await expect(watcher.fetchSince("GACCOUNT", "")).rejects.toBeTruthy();
    expect(watcher.getStatus()).toEqual({ degraded: true, usingFallback: false, consecutiveFailures: 2 });
  });
});
