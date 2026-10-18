import { createClient, type RedisClientType } from "redis";
import type { UsedChallengeStore } from "@checkout/core";

export interface RedisUsedChallengeStoreClient {
  on?(event: "error", listener: (err: unknown) => void): unknown;
  connect(): Promise<unknown>;
  set(
    key: string,
    value: string,
    options?: { NX?: boolean; PX?: number },
  ): Promise<string | null | unknown>;
}

/**
 * Shared single-use claim for SEP-10 challenges across instances (issue 6.7).
 * `SET NX` is atomic in Redis, so two instances racing the same already-signed
 * challenge cannot both win: only the first `claim()` call gets "OK" back.
 */
export class RedisUsedChallengeStore implements UsedChallengeStore {
  private client: RedisUsedChallengeStoreClient;
  private connecting: Promise<void>;

  constructor(
    urlOrClient: string | RedisUsedChallengeStoreClient,
    client?: RedisUsedChallengeStoreClient,
  ) {
    if (typeof urlOrClient === "string") {
      this.client = (client ?? createClient({ url: urlOrClient })) as unknown as RedisUsedChallengeStoreClient;
    } else {
      this.client = urlOrClient;
    }
    this.client.on?.("error", (err) => console.error("[sep10-challenge] redis error", err));
    this.connecting = Promise.resolve(this.client.connect()).then(() => undefined);
  }

  async claim(hash: string, expiresAt: number): Promise<boolean> {
    await this.connecting;
    // TTL mirrors the challenge's own timebound so a claim never outlives it.
    // Floored at 1ms: expiresAt is already in the past only if the caller races
    // its own timeout, which PX would otherwise reject with a negative value.
    const ttlMs = Math.max(1, expiresAt * 1000 - Date.now());
    const result = await this.client.set(`sep10-used:${hash}`, "1", { NX: true, PX: ttlMs });
    return result === "OK";
  }
}
