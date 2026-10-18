import { describe, it, expect, vi } from "vitest";
import { RedisStore, type RedisStoreClient } from "../src/middleware/redis-store";
import {
  RedisUsedChallengeStore,
  type RedisUsedChallengeStoreClient,
} from "../src/services/redis-used-challenge-store";

/**
 * In-memory Fake Redis client providing incr, pExpire, pTTL, and set with NX/PX options.
 * Accurately mimics Redis command behavior for unit testing.
 */
class FakeRedisClient implements RedisStoreClient, RedisUsedChallengeStoreClient {
  public data = new Map<string, string>();
  public expires = new Map<string, number>(); // expiration timestamps in ms

  public calls = {
    connect: 0,
    incr: [] as string[],
    pExpire: [] as { key: string; ms: number }[],
    pTTL: [] as string[],
    set: [] as {
      key: string;
      value: string;
      options?: { NX?: boolean; PX?: number };
    }[],
    errorListeners: [] as ((err: unknown) => void)[],
  };

  public pExpireError: Error | null = null;
  public mockPttlValue: number | null = null;

  async connect(): Promise<void> {
    this.calls.connect++;
  }

  on(event: "error", listener: (err: unknown) => void): this {
    if (event === "error") {
      this.calls.errorListeners.push(listener);
    }
    return this;
  }

  async incr(key: string): Promise<number> {
    this.calls.incr.push(key);
    this.purgeIfExpired(key);
    const currentVal = parseInt(this.data.get(key) ?? "0", 10);
    const nextVal = currentVal + 1;
    this.data.set(key, String(nextVal));
    return nextVal;
  }

  async pExpire(key: string, milliseconds: number): Promise<boolean> {
    this.calls.pExpire.push({ key, ms: milliseconds });
    if (this.pExpireError) {
      throw this.pExpireError;
    }
    this.purgeIfExpired(key);
    if (!this.data.has(key)) {
      return false;
    }
    this.expires.set(key, Date.now() + milliseconds);
    return true;
  }

  async pTTL(key: string): Promise<number> {
    this.calls.pTTL.push(key);
    if (this.mockPttlValue !== null) {
      return this.mockPttlValue;
    }
    this.purgeIfExpired(key);
    if (!this.data.has(key)) {
      return -2; // Redis standard: key does not exist
    }
    const expireAt = this.expires.get(key);
    if (!expireAt) {
      return -1; // Redis standard: key exists with no expire
    }
    const remaining = expireAt - Date.now();
    return Math.max(0, remaining);
  }

  async set(
    key: string,
    value: string,
    options?: { NX?: boolean; PX?: number },
  ): Promise<string | null> {
    this.calls.set.push({ key, value, options });
    this.purgeIfExpired(key);

    if (options?.NX && this.data.has(key)) {
      return null;
    }

    this.data.set(key, value);
    if (options?.PX !== undefined) {
      this.expires.set(key, Date.now() + options.PX);
    }
    return "OK";
  }

  private purgeIfExpired(key: string): void {
    const expireAt = this.expires.get(key);
    if (expireAt !== undefined && Date.now() > expireAt) {
      this.data.delete(key);
      this.expires.delete(key);
    }
  }
}

describe("RedisStore (Rate-Limit Counter)", () => {
  it("creates window and sets TTL on the first hit", async () => {
    const fakeClient = new FakeRedisClient();
    const store = new RedisStore("redis://localhost:6379", fakeClient);

    const key = "client-ip-123";
    const windowMs = 60_000;
    const nowBefore = Date.now();

    const result = await store.increment(key, windowMs);
    const nowAfter = Date.now();

    expect(result.count).toBe(1);
    expect(fakeClient.calls.incr).toEqual(["ratelimit:client-ip-123"]);
    expect(fakeClient.calls.pExpire).toEqual([{ key: "ratelimit:client-ip-123", ms: 60_000 }]);
    expect(fakeClient.calls.pTTL).toEqual(["ratelimit:client-ip-123"]);

    // resetAt should be roughly now + 60s
    expect(result.resetAt).toBeGreaterThanOrEqual(nowBefore + windowMs);
    expect(result.resetAt).toBeLessThanOrEqual(nowAfter + windowMs);
  });

  it("increments without resetting the TTL on subsequent hits", async () => {
    const fakeClient = new FakeRedisClient();
    const store = new RedisStore("redis://localhost:6379", fakeClient);

    const key = "client-ip-456";
    const windowMs = 30_000;

    // First hit: count 1, sets TTL
    const first = await store.increment(key, windowMs);
    expect(first.count).toBe(1);
    expect(fakeClient.calls.pExpire).toHaveLength(1);

    // Second hit: count 2, does NOT call pExpire
    const second = await store.increment(key, windowMs);
    expect(second.count).toBe(2);
    expect(fakeClient.calls.pExpire).toHaveLength(1);

    // Third hit: count 3, still does NOT call pExpire
    const third = await store.increment(key, windowMs);
    expect(third.count).toBe(3);
    expect(fakeClient.calls.pExpire).toHaveLength(1);

    expect(fakeClient.calls.incr).toEqual([
      "ratelimit:client-ip-456",
      "ratelimit:client-ip-456",
      "ratelimit:client-ip-456",
    ]);
  });

  it("calculates resetAt from pTTL when ttl is positive", async () => {
    const fakeClient = new FakeRedisClient();
    fakeClient.mockPttlValue = 42_500; // Simulated remaining TTL
    const store = new RedisStore("redis://localhost:6379", fakeClient);

    const before = Date.now();
    const result = await store.increment("test-ttl", 60_000);
    const after = Date.now();

    expect(result.resetAt).toBeGreaterThanOrEqual(before + 42_500);
    expect(result.resetAt).toBeLessThanOrEqual(after + 42_500);
  });

  it("falls back to windowMs when pTTL is not positive (-1 or -2)", async () => {
    const fakeClient = new FakeRedisClient();
    fakeClient.mockPttlValue = -1; // e.g. key has no TTL
    const store = new RedisStore("redis://localhost:6379", fakeClient);

    const windowMs = 15_000;
    const before = Date.now();
    const result = await store.increment("fallback-key", windowMs);
    const after = Date.now();

    expect(result.resetAt).toBeGreaterThanOrEqual(before + windowMs);
    expect(result.resetAt).toBeLessThanOrEqual(after + windowMs);
  });

  it("propagates error when pExpire fails and documents the consequence", async () => {
    const fakeClient = new FakeRedisClient();
    const expireFailure = new Error("Redis connection reset while setting expiration");
    fakeClient.pExpireError = expireFailure;

    const store = new RedisStore("redis://localhost:6379", fakeClient);

    // Documented behavior:
    // If pExpire throws, increment() rejects with the error.
    // The key was incremented in Redis (count === 1) before pExpire failed;
    // because pExpire threw, the key has no TTL set and would not expire automatically
    // unless retried or cleaned up.
    await expect(store.increment("failing-expire-key", 60_000)).rejects.toThrow(
      "Redis connection reset while setting expiration",
    );

    // Confirm that INCR was executed before PEXPIRE failed
    expect(fakeClient.calls.incr).toEqual(["ratelimit:failing-expire-key"]);
    expect(fakeClient.calls.pExpire).toEqual([
      { key: "ratelimit:failing-expire-key", ms: 60_000 },
    ]);
  });

  it("maintains separate counters and windows for different keys", async () => {
    const fakeClient = new FakeRedisClient();
    const store = new RedisStore("redis://localhost:6379", fakeClient);

    const resA1 = await store.increment("client-A", 10_000);
    const resB1 = await store.increment("client-B", 20_000);
    const resA2 = await store.increment("client-A", 10_000);

    expect(resA1.count).toBe(1);
    expect(resB1.count).toBe(1);
    expect(resA2.count).toBe(2);

    expect(fakeClient.calls.pExpire).toEqual([
      { key: "ratelimit:client-A", ms: 10_000 },
      { key: "ratelimit:client-B", ms: 20_000 },
    ]);
  });

  it("awaits connection before executing commands", async () => {
    const fakeClient = new FakeRedisClient();
    let connectionResolved = false;

    fakeClient.connect = async () => {
      fakeClient.calls.connect++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      connectionResolved = true;
    };

    const store = new RedisStore("redis://localhost:6379", fakeClient);
    const res = await store.increment("delayed-connect", 5_000);

    expect(connectionResolved).toBe(true);
    expect(res.count).toBe(1);
  });

  it("registers error listener on the redis client", () => {
    const fakeClient = new FakeRedisClient();
    new RedisStore("redis://localhost:6379", fakeClient);

    expect(fakeClient.calls.errorListeners).toHaveLength(1);
  });
});

describe("RedisUsedChallengeStore (Single-Use SEP-10 Challenge Nonces)", () => {
  it("claims nonce successfully on first attempt and rejects duplicate claims (atomic NX)", async () => {
    const fakeClient = new FakeRedisClient();
    const store = new RedisUsedChallengeStore("redis://localhost:6379", fakeClient);

    const hash = "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890";
    const expiresAt = Math.floor(Date.now() / 1000) + 300; // 5 minutes in future (seconds)

    // First claim must succeed
    const firstClaim = await store.claim(hash, expiresAt);
    expect(firstClaim).toBe(true);

    // Second claim for same hash must be rejected
    const secondClaim = await store.claim(hash, expiresAt);
    expect(secondClaim).toBe(false);

    // Verify Redis SET was called with NX and PX
    expect(fakeClient.calls.set).toHaveLength(2);
    const firstSet = fakeClient.calls.set[0]!;
    const secondSet = fakeClient.calls.set[1]!;

    expect(firstSet.key).toBe(`sep10-used:${hash}`);
    expect(firstSet.value).toBe("1");
    expect(firstSet.options?.NX).toBe(true);
    expect(firstSet.options?.PX).toBeGreaterThan(0);

    expect(secondSet.key).toBe(`sep10-used:${hash}`);
    expect(secondSet.options?.NX).toBe(true);
  });

  it("floors TTL at 1 ms when challenge is already expired or near expiry", async () => {
    const fakeClient = new FakeRedisClient();
    const store = new RedisUsedChallengeStore("redis://localhost:6379", fakeClient);

    const hash = "expired-challenge-nonce";
    // expiresAt is 60 seconds in the past
    const pastExpiresAt = Math.floor(Date.now() / 1000) - 60;

    const claimed = await store.claim(hash, pastExpiresAt);
    expect(claimed).toBe(true);

    // Assert that PX passed to Redis set is exactly 1 (Math.max(1, negativeMs))
    expect(fakeClient.calls.set).toHaveLength(1);
    const setCall = fakeClient.calls.set[0]!;
    expect(setCall.options).toEqual({
      NX: true,
      PX: 1,
    });
  });

  it("passes calculated remaining TTL in milliseconds for future challenge", async () => {
    const fakeClient = new FakeRedisClient();
    const store = new RedisUsedChallengeStore("redis://localhost:6379", fakeClient);

    const hash = "future-challenge-nonce";
    const futureSeconds = 120;
    const expiresAt = Math.floor(Date.now() / 1000) + futureSeconds;

    const claimed = await store.claim(hash, expiresAt);
    expect(claimed).toBe(true);

    const setCall = fakeClient.calls.set[0]!;
    const px = setCall.options?.PX;
    expect(px).toBeDefined();
    // Expected ~120,000 ms, give generous margin for execution time
    expect(px).toBeGreaterThanOrEqual(118_000);
    expect(px).toBeLessThanOrEqual(121_000);
  });

  it("allows different challenge nonces to be claimed independently", async () => {
    const fakeClient = new FakeRedisClient();
    const store = new RedisUsedChallengeStore("redis://localhost:6379", fakeClient);

    const hashA = "hash-AAA";
    const hashB = "hash-BBB";
    const expiresAt = Math.floor(Date.now() / 1000) + 60;

    expect(await store.claim(hashA, expiresAt)).toBe(true);
    expect(await store.claim(hashB, expiresAt)).toBe(true);
    expect(await store.claim(hashA, expiresAt)).toBe(false);
    expect(await store.claim(hashB, expiresAt)).toBe(false);
  });

  it("awaits connection before executing set command", async () => {
    const fakeClient = new FakeRedisClient();
    let connected = false;

    fakeClient.connect = async () => {
      fakeClient.calls.connect++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      connected = true;
    };

    const store = new RedisUsedChallengeStore("redis://localhost:6379", fakeClient);
    const claimed = await store.claim("delayed-claim", Math.floor(Date.now() / 1000) + 60);

    expect(connected).toBe(true);
    expect(claimed).toBe(true);
  });

  it("registers error listener on the redis client", () => {
    const fakeClient = new FakeRedisClient();
    new RedisUsedChallengeStore("redis://localhost:6379", fakeClient);

    expect(fakeClient.calls.errorListeners).toHaveLength(1);
  });
});
