import { randomBytes, createHash } from "node:crypto";

/**
 * Naming convention from `MAINTAINER.md`'s own roadmap note (item 3, "API
 * keys (`ak_live_…`, store hash only)"). Not network-prefixed (no
 * `ak_test_`) - this project's testnet-vs-public distinction is a separate
 * axis (`STELLAR_NETWORK`) from which seller a key authenticates as, and
 * conflating them would just be a second, redundant thing to keep in sync.
 */
export const API_KEY_PREFIX = "ak_live_";

/** 32 random bytes (256 bits) of entropy, hex-encoded, after the prefix. */
export function generateApiKey(): { raw: string; hash: string } {
  const raw = `${API_KEY_PREFIX}${randomBytes(32).toString("hex")}`;
  return { raw, hash: hashApiKey(raw) };
}

/** Only this hash is ever persisted - the raw key exists in memory just long enough to hand back to whoever minted it. */
export function hashApiKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
