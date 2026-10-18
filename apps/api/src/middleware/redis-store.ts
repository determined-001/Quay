import { createClient, type RedisClientType } from "redis";
import type { RateLimitStore } from "./rate-limit";

export interface RedisStoreClient {
  on?(event: "error", listener: (err: unknown) => void): unknown;
  connect(): Promise<unknown>;
  incr(key: string): Promise<number>;
  pExpire(key: string, milliseconds: number): Promise<unknown>;
  pTTL(key: string): Promise<number>;
}

/**
 * Shared rate-limit store for multi-instance deployments. Uses INCR + PEXPIRE
 * so concurrent instances see the same counter for a given key.
 */
export class RedisStore implements RateLimitStore {
  private client: RedisStoreClient;
  private connecting: Promise<void>;

  constructor(urlOrClient: string | RedisStoreClient, client?: RedisStoreClient) {
    if (typeof urlOrClient === "string") {
      this.client = (client ?? createClient({ url: urlOrClient })) as unknown as RedisStoreClient;
    } else {
      this.client = urlOrClient;
    }
    this.client.on?.("error", (err) => console.error("[rate-limit] redis error", err));
    this.connecting = Promise.resolve(this.client.connect()).then(() => undefined);
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    await this.connecting;
    const redisKey = `ratelimit:${key}`;
    const count = await this.client.incr(redisKey);
    if (count === 1) {
      await this.client.pExpire(redisKey, windowMs);
    }
    const ttl = await this.client.pTTL(redisKey);
    const resetAt = Date.now() + (ttl > 0 ? ttl : windowMs);
    return { count, resetAt };
  }
}
