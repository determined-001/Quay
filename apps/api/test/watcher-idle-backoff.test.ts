import { describe, it, expect } from "vitest";
import { WatcherLoop } from "../src/worker/watcher-loop";
import { FakeWatcherPort } from "./setup";
import { FakeLinkRepository, makeLink } from "./fakes";
import type { NormalizedPayment, WatcherStateRepository } from "@checkout/core";
import { NOOP_LOGGER } from "@checkout/core";

// ---------------------------------------------------------------------------
//  Adaptive polling must slow down, never stop (BUG-4.22).
//
//  The skip used to `return` once `consecutiveIdleTicks` passed the threshold,
//  and that counter is only reset inside `processAccount` — which the return
//  prevented from running. An account therefore went permanently unwatched
//  after ~10 idle ticks; production was observed at 183 and climbing.
//
//  The watcher only looks at destinations with an OPEN link, so every account
//  it abandoned was one where a buyer was staring at "waiting for payment".
//  A payment landed on-chain with the correct memo and was never matched.
// ---------------------------------------------------------------------------

const DEST = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function stateRepo(): WatcherStateRepository & { cursors: Map<string, string> } {
  const cursors = new Map<string, string>();
  const processed = new Set<string>();
  return {
    cursors,
    async getCursor(a) {
      return cursors.get(a) ?? null;
    },
    async setCursor(a, c) {
      cursors.set(a, c);
    },
    async isProcessed(tx) {
      return processed.has(tx);
    },
    async markProcessed(tx) {
      processed.add(tx);
    },
  };
}

/** Counts how many times the watcher actually asked Horizon for this account. */
class CountingWatcher extends FakeWatcherPort {
  fetchCalls = 0;
  override async fetchSince(account: string, cursor: string, limit?: number): Promise<NormalizedPayment[]> {
    this.fetchCalls++;
    return super.fetchSince(account, cursor, limit);
  }
}

function makeLoop(watcher: CountingWatcher, links: FakeLinkRepository, state: WatcherStateRepository) {
  return new WatcherLoop({
    watcher,
    links,
    state,
    service: { async applyMatch() { return false; }, async recordUnmatchedPayment() {} } as never,
    pollMs: 1,
    logger: NOOP_LOGGER,
    pageLimit: 200,
    maxPagesPerTick: 10,
  });
}

describe("watcher adaptive polling", () => {
  it("keeps polling a quiet account instead of abandoning it", async () => {
    const links = new FakeLinkRepository();
    await links.save(makeLink({ id: "lnk_q", reference: "pl_q", status: "active", txHash: null, destination: DEST }));
    const watcher = new CountingWatcher();
    const state = stateRepo();
    state.cursors.set(DEST, "1");
    const loop = makeLoop(watcher, links, state);

    // Far past the old threshold, where the account used to go dark for good.
    for (let i = 0; i < 60; i++) await loop.runOnce();

    // Backed off, so not once per tick — but emphatically not zero either.
    expect(watcher.fetchCalls).toBeGreaterThan(10);
    expect(watcher.fetchCalls).toBeLessThan(60);
  });

  it("still sees a payment that arrives long after the account went quiet", async () => {
    // The production symptom, reduced: link created, nothing happens for a
    // while, then the buyer finally pays.
    const links = new FakeLinkRepository();
    await links.save(makeLink({ id: "lnk_l", reference: "pl_late", status: "active", txHash: null, destination: DEST }));
    const watcher = new CountingWatcher();
    const state = stateRepo();
    state.cursors.set(DEST, "1");
    const loop = makeLoop(watcher, links, state);

    for (let i = 0; i < 40; i++) await loop.runOnce();
    const before = watcher.fetchCalls;

    watcher.setPayments([
      FakeWatcherPort.payment({ txHash: "tx_late", pagingToken: "999", memo: "pl_late", to: DEST, amount: "10" }),
    ]);

    // Within the capped stride the account must be revisited.
    for (let i = 0; i < 10; i++) await loop.runOnce();

    expect(watcher.fetchCalls).toBeGreaterThan(before);
    expect(await state.getCursor(DEST)).toBe("999");
  });

  it("polls every tick while the account is active", async () => {
    const links = new FakeLinkRepository();
    await links.save(makeLink({ id: "lnk_a", reference: "pl_a", status: "active", txHash: null, destination: DEST }));
    const watcher = new CountingWatcher();
    const state = stateRepo();
    state.cursors.set(DEST, "1");
    const loop = makeLoop(watcher, links, state);

    // Busy account: a payment every tick keeps the idle counter at zero, so
    // backoff must never engage.
    for (let i = 0; i < 5; i++) {
      watcher.setPayments([
        FakeWatcherPort.payment({ txHash: `tx_${i}`, pagingToken: String(100 + i), memo: "pl_a", to: DEST, amount: "10" }),
      ]);
      await loop.runOnce();
    }

    expect(watcher.fetchCalls).toBe(5);
  });
});
