import { describe, expect, it } from "vitest";
import { StreamingHorizonWatcher } from "../src/streaming-horizon-watcher";
import type { HorizonPaymentRecord } from "../src/horizon-client";
import { FakeHorizonClient } from "./fake-horizon";
import { runWatcherContract } from "./watcher-contract";

const FAST_BACKOFF = { initialBackoffMs: 5, maxBackoffMs: 20 };

runWatcherContract("StreamingHorizonWatcher (stream)", () => {
  const fake = new FakeHorizonClient();
  const watcher = new StreamingHorizonWatcher(fake, FAST_BACKOFF);
  return {
    fake,
    watcher,
    killConnection: (account) => fake.killConnection(account),
  };
});

describe("StreamingHorizonWatcher extras", () => {
  const ACCOUNT = "GDEST0000000000000000000000000000000000000000000000000000";

  it("reconnects after a dropped connection and re-subscribes", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake, FAST_BACKOFF);

    fake.addPayment({ account: ACCOUNT, memo: "ref_1" });
    await watcher.fetchSince(ACCOUNT, "");
    expect(fake.liveSubscriberCount(ACCOUNT)).toBe(1);

    fake.killConnection(ACCOUNT);
    expect(fake.liveSubscriberCount(ACCOUNT)).toBe(0);

    await new Promise((r) => setTimeout(r, 50));
    expect(fake.liveSubscriberCount(ACCOUNT)).toBe(1);

    watcher.stop();
  });

  it("reconciles a payment that lands entirely during the outage", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake, FAST_BACKOFF);

    fake.addPayment({ account: ACCOUNT, memo: "ref_1" });
    const first = await watcher.fetchSince(ACCOUNT, "");
    const cursor = first[0]!.pagingToken;

    fake.killConnection(ACCOUNT);
    // Lands while no SSE subscriber is registered — only the reconnect's
    // reconciliation poll (not the stream) can pick this one up.
    fake.addPayment({ account: ACCOUNT, memo: "ref_2" });

    await new Promise((r) => setTimeout(r, 50));
    const recovered = await watcher.fetchSince(ACCOUNT, cursor);
    expect(recovered.map((p) => p.memo)).toEqual(["ref_2"]);

    watcher.stop();
  });

  it("stop() closes every live subscription", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake, FAST_BACKOFF);
    fake.addPayment({ account: ACCOUNT, memo: "ref_1" });
    await watcher.fetchSince(ACCOUNT, "");
    expect(fake.liveSubscriberCount(ACCOUNT)).toBe(1);

    watcher.stop();
    expect(fake.liveSubscriberCount(ACCOUNT)).toBe(0);

    // A drop after stop() must not resurrect a reconnect loop.
    fake.killConnection(ACCOUNT);
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.liveSubscriberCount(ACCOUNT)).toBe(0);
  });

  it("delivers a payment whose transaction fetch fails once", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake, FAST_BACKOFF);

    await watcher.fetchSince(ACCOUNT, "");

    let failedOnce = false;
    const failingRecord = {
      type: "payment",
      paging_token: "1",
      transaction_hash: "tx_1",
      created_at: new Date().toISOString(),
      to: ACCOUNT,
      from: "GFROM",
      amount: "10",
      asset_type: "native",
      transaction: async () => {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error("Horizon 500 error fetching transaction");
        }
        return { memo_type: "text", memo: "ref_1" };
      },
    } as unknown as HorizonPaymentRecord;

    const secondRecord = {
      type: "payment",
      paging_token: "2",
      transaction_hash: "tx_2",
      created_at: new Date().toISOString(),
      to: ACCOUNT,
      from: "GFROM",
      amount: "20",
      asset_type: "native",
      transaction: async () => ({ memo_type: "text", memo: "ref_2" }),
    } as unknown as HorizonPaymentRecord;

    fake.pushMessage(ACCOUNT, failingRecord);
    fake.pushMessage(ACCOUNT, secondRecord);

    const payments = await watcher.fetchSince(ACCOUNT, "");
    expect(payments.map((p) => p.memo)).toEqual(["ref_1", "ref_2"]);
    expect(payments.map((p) => p.pagingToken)).toEqual(["1", "2"]);

    watcher.stop();
  });

  it("does not leave stream.pending permanently rejected when the last message fails", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake, FAST_BACKOFF);

    await watcher.fetchSince(ACCOUNT, "");

    let failedOnce = false;
    const failingRecord = {
      type: "payment",
      paging_token: "1",
      transaction_hash: "tx_1",
      created_at: new Date().toISOString(),
      to: ACCOUNT,
      from: "GFROM",
      amount: "10",
      asset_type: "native",
      transaction: async () => {
        if (!failedOnce) {
          failedOnce = true;
          throw new Error("transient 503");
        }
        return { memo_type: "text", memo: "ref_last" };
      },
    } as unknown as HorizonPaymentRecord;

    fake.pushMessage(ACCOUNT, failingRecord);

    const payments = await watcher.fetchSince(ACCOUNT, "");
    expect(payments.map((p) => p.memo)).toEqual(["ref_last"]);

    // Subsequent fetchSince call also succeeds cleanly without throwing
    const next = await watcher.fetchSince(ACCOUNT, "1");
    expect(next).toEqual([]);

    watcher.stop();
  });

  it("does not advance cursor past a repeatedly failing record and does not spin", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake, FAST_BACKOFF);

    await watcher.fetchSince(ACCOUNT, "");

    const permanentlyFailingRecord = {
      type: "payment",
      paging_token: "1",
      transaction_hash: "tx_1",
      created_at: new Date().toISOString(),
      to: ACCOUNT,
      from: "GFROM",
      amount: "10",
      asset_type: "native",
      transaction: async () => {
        throw new Error("permanent failure");
      },
    } as unknown as HorizonPaymentRecord;

    const subsequentRecord = {
      type: "payment",
      paging_token: "2",
      transaction_hash: "tx_2",
      created_at: new Date().toISOString(),
      to: ACCOUNT,
      from: "GFROM",
      amount: "20",
      asset_type: "native",
      transaction: async () => ({ memo_type: "text", memo: "ref_2" }),
    } as unknown as HorizonPaymentRecord;

    fake.pushMessage(ACCOUNT, permanentlyFailingRecord);
    fake.pushMessage(ACCOUNT, subsequentRecord);

    const start = Date.now();
    const payments = await watcher.fetchSince(ACCOUNT, "");
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(1000);
    expect(payments.find((p) => p.pagingToken === "2")).toBeUndefined();
    expect(payments).toEqual([]);

    watcher.stop();
  });

  it("can be constructed with a horizon URL string", () => {
    const watcher = new StreamingHorizonWatcher(
      "https://horizon-testnet.stellar.org",
    );
    expect(watcher).toBeInstanceOf(StreamingHorizonWatcher);
    watcher.stop();
  });
});
