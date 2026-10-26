import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StreamingHorizonWatcher } from "../src/streaming-horizon-watcher";
import type {
  HorizonAccount,
  HorizonClient,
  HorizonPaymentRecord,
  PaymentsCallBuilder,
} from "../src/horizon-client";
import { FakeHorizonClient } from "./fake-horizon";

const ACCOUNT = "GDEST0000000000000000000000000000000000000000000000000000";

interface Subscription {
  onmessage: (record: HorizonPaymentRecord) => void;
  onerror: (err: unknown) => void;
  closed: boolean;
}

/** A Horizon client whose polled page and failures the test controls. */
class ControlledClient implements HorizonClient {
  callImpl: () => Promise<{ records: HorizonPaymentRecord[] }> = async () => ({ records: [] });
  calls = 0;
  readonly subscriptions: Subscription[] = [];

  payments(): PaymentsCallBuilder {
    const self = this;
    const builder: PaymentsCallBuilder = {
      forAccount: () => builder,
      order: () => builder,
      limit: () => builder,
      cursor: () => builder,
      join: () => builder,
      call: () => {
        self.calls += 1;
        return self.callImpl();
      },
      stream(opts) {
        const sub: Subscription = { ...opts, closed: false };
        self.subscriptions.push(sub);
        return () => {
          sub.closed = true;
        };
      },
    };
    return builder;
  }

  async loadAccount(): Promise<HorizonAccount> {
    return { balances: [] };
  }

  get live(): number {
    return this.subscriptions.filter((s) => !s.closed).length;
  }
  drop(): void {
    this.subscriptions.at(-1)!.onerror(new Error("connection reset"));
  }
}

const notFound = () => Object.assign(new Error("not found"), { response: { status: 404 } });

function record(token: string, memo = `m${token}`): HorizonPaymentRecord {
  return {
    type: "payment",
    paging_token: token,
    transaction_hash: `tx_${token}`,
    created_at: new Date().toISOString(),
    to: ACCOUNT,
    from: "GFROM",
    amount: "10",
    asset_type: "native",
    transaction: async () => ({ memo_type: "text", memo }),
  } as unknown as HorizonPaymentRecord;
}

function backoffOf(watcher: StreamingHorizonWatcher): number {
  return (watcher as unknown as { streams: Map<string, { backoffMs: number }> }).streams.get(ACCOUNT)!.backoffMs;
}

describe("StreamingHorizonWatcher — fetchSince limit and buffer trimming", () => {
  it("returns at most `limit` payments, oldest first, and the rest on the next call", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake);
    await watcher.fetchSince(ACCOUNT, "");
    for (let i = 1; i <= 5; i += 1) fake.addPayment({ account: ACCOUNT, memo: `r${i}` });

    const first = await watcher.fetchSince(ACCOUNT, "", 2);
    expect(first.map((p) => p.memo)).toEqual(["r1", "r2"]);

    const second = await watcher.fetchSince(ACCOUNT, first[1]!.pagingToken, 2);
    expect(second.map((p) => p.memo)).toEqual(["r3", "r4"]);

    const third = await watcher.fetchSince(ACCOUNT, second[1]!.pagingToken, 2);
    expect(third.map((p) => p.memo)).toEqual(["r5"]);
    watcher.stop();
  });

  it("drops buffered entries the cursor has moved past", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake);
    await watcher.fetchSince(ACCOUNT, "");
    for (let i = 1; i <= 3; i += 1) fake.addPayment({ account: ACCOUNT, memo: `r${i}` });
    const all = await watcher.fetchSince(ACCOUNT, "");

    const buffer = () =>
      (watcher as unknown as { streams: Map<string, { buffer: Map<string, unknown> }> }).streams.get(ACCOUNT)!.buffer;
    expect(buffer().size).toBe(3);

    await watcher.fetchSince(ACCOUNT, all[1]!.pagingToken);
    expect([...buffer().keys()]).toEqual([all[2]!.pagingToken]);
    watcher.stop();
  });
});

describe("StreamingHorizonWatcher — paging token ordering", () => {
  it("compares numeric tokens as numbers, not strings", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake);
    await watcher.fetchSince(ACCOUNT, "");
    fake.pushMessage(ACCOUNT, record("9"));
    fake.pushMessage(ACCOUNT, record("10"));

    const out = await watcher.fetchSince(ACCOUNT, "9");
    expect(out.map((p) => p.pagingToken)).toEqual(["10"]);
    watcher.stop();
  });

  it("falls back to lexicographic order for a non-numeric token", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake);
    await watcher.fetchSince(ACCOUNT, "");
    fake.pushMessage(ACCOUNT, record("abc"));
    fake.pushMessage(ACCOUNT, record("abd"));

    const out = await watcher.fetchSince(ACCOUNT, "abc");
    expect(out.map((p) => p.pagingToken)).toEqual(["abd"]);
    watcher.stop();
  });

  it("treats an empty cursor as before every token", async () => {
    const fake = new FakeHorizonClient();
    const watcher = new StreamingHorizonWatcher(fake);
    await watcher.fetchSince(ACCOUNT, "");
    fake.pushMessage(ACCOUNT, record("5"));

    expect((await watcher.fetchSince(ACCOUNT, "")).map((p) => p.pagingToken)).toEqual(["5"]);
    expect(await watcher.fetchSince(ACCOUNT, "5")).toEqual([]);
    watcher.stop();
  });
});

describe("StreamingHorizonWatcher — latestCursor", () => {
  it("rethrows an error that is not a 404", async () => {
    const client = new ControlledClient();
    client.callImpl = async () => {
      throw new Error("horizon 500");
    };
    await expect(new StreamingHorizonWatcher(client).latestCursor(ACCOUNT)).rejects.toThrow("horizon 500");
  });
});

describe("StreamingHorizonWatcher — reconnect backoff", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const OPTS = { initialBackoffMs: 100, maxBackoffMs: 300 };

  async function open(client: ControlledClient, opts = OPTS) {
    const watcher = new StreamingHorizonWatcher(client, opts);
    await watcher.fetchSince(ACCOUNT, "");
    expect(client.live).toBe(1);
    return watcher;
  }

  it("doubles the delay on each failed reconcile, caps it at maxBackoffMs, and resets after a success", async () => {
    const client = new ControlledClient();
    const watcher = await open(client);

    client.callImpl = async () => {
      throw new Error("horizon 503");
    };
    const callsBefore = client.calls;
    client.drop(); // schedules a reconnect in 100 ms, next delay 200
    expect(backoffOf(watcher)).toBe(200);

    await vi.advanceTimersByTimeAsync(99);
    expect(client.calls).toBe(callsBefore);
    await vi.advanceTimersByTimeAsync(1); // reconcile #1 fails, next delay 200
    expect(client.calls).toBe(callsBefore + 1);
    expect(backoffOf(watcher)).toBe(300); // 200 doubled to 400, capped at 300

    await vi.advanceTimersByTimeAsync(200); // reconcile #2 fails
    expect(client.calls).toBe(callsBefore + 2);
    expect(backoffOf(watcher)).toBe(300);

    await vi.advanceTimersByTimeAsync(299);
    expect(client.calls).toBe(callsBefore + 2);
    client.callImpl = async () => ({ records: [] });
    await vi.advanceTimersByTimeAsync(1); // reconcile #3 succeeds
    expect(client.calls).toBe(callsBefore + 3);
    expect(backoffOf(watcher)).toBe(100); // reset to the initial delay
    expect(client.live).toBe(1); // and the stream is back

    watcher.stop();
  });

  it("swallows a 404 from the reconcile and still reconnects the stream", async () => {
    const client = new ControlledClient();
    const watcher = await open(client);
    client.callImpl = async () => {
      throw notFound();
    };

    client.drop();
    await vi.advanceTimersByTimeAsync(100);

    expect(client.subscriptions).toHaveLength(2);
    expect(client.live).toBe(1);
    watcher.stop();
  });

  it("stop() while a reconnect timer is pending cancels it", async () => {
    const client = new ControlledClient();
    const watcher = await open(client);
    const callsBefore = client.calls;

    client.drop();
    watcher.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(client.calls).toBe(callsBefore);
    expect(client.live).toBe(0);
    expect(client.subscriptions).toHaveLength(1);
  });

  it("ignores a second error while a reconnect is already scheduled", async () => {
    const client = new ControlledClient();
    const watcher = await open(client);

    client.drop();
    client.drop();
    expect(backoffOf(watcher)).toBe(200); // doubled once, not twice

    await vi.advanceTimersByTimeAsync(100);
    expect(client.subscriptions).toHaveLength(2);
    watcher.stop();
  });
});
