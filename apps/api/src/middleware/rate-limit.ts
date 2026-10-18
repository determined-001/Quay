import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { metrics } from "../metrics";

/**
 * Fixed-window rate limiter, keyed by client IP, backed by a pluggable store.
 *
 * Use a RedisStore (via REDIS_URL) when running more than one instance —
 * an in-memory store only protects a single process's budget.
 */

export interface RateLimitStore {
  /** Increment the counter for `key`, creating a fresh window if expired. */
  increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

export class MemoryStore implements RateLimitStore {
  private hits = new Map<string, { count: number; resetAt: number }>();

  async increment(key: string, windowMs: number): Promise<{ count: number; resetAt: number }> {
    const now = Date.now();
    if (this.hits.size > 10_000) this.sweep(now);

    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return entry;
  }

  private sweep(now: number): void {
    for (const [key, v] of this.hits) if (v.resetAt <= now) this.hits.delete(key);
  }
}

let lastErrorLogTime = 0;
const ERROR_LOG_INTERVAL_MS = 60_000;

function logStoreError(limiter: string, reason: string): void {
  const now = Date.now();
  if (now - lastErrorLogTime >= ERROR_LOG_INTERVAL_MS) {
    lastErrorLogTime = now;
    console.warn(`[rate-limit] store error on limiter "${limiter}", degrading to MemoryStore: ${reason}`);
  }
}

/** Test seam — resets the 1-minute warning throttle timer. */
export function _resetStoreErrorLogThrottle(): void {
  lastErrorLogTime = 0;
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Defaults to a per-process MemoryStore. Pass a RedisStore to share a budget
   *  across instances. */
  store?: RateLimitStore;
  /** Defaults to 0 — `x-forwarded-for` is ignored entirely, which is the safe
   *  choice when no trusted proxy is guaranteed to overwrite it. */
  trustProxyHops?: number;
  /** Override how the limiter key is derived. Defaults to the client IP; API
   *  keys pass `apiKeyRateLimitKey` so each key gets its own bucket (#40 item 4). */
  keyFor?: (ctx: Context, trustProxyHops: number) => Promise<string> | string;
  /** Timeout in ms to wait for the store before degrading to MemoryStore.
   *  Defaults to 500 ms. */
  storeTimeoutMs?: number;
  /** Name of the limiter for telemetry and metrics. Defaults to "default". */
  name?: string;
  /** Fallback store when the primary store fails or times out. Defaults to a dedicated MemoryStore. */
  fallbackStore?: RateLimitStore;
}

/**
 * Fixed-window rate limiter, keyed by client IP or custom key, backed by a pluggable store.
 *
 * Failure mode:
 * When the configured store (e.g. RedisStore) throws an error or fails to respond within
 * `storeTimeoutMs` (default 500ms), the middleware degrades to an in-process `MemoryStore`
 * instead of failing or blocking the request. This preserves availability during Redis
 * network partitions or outages while maintaining per-instance rate boundaries. Degraded
 * requests omit `x-ratelimit-*` headers (since cluster-wide quota is unknown), increment
 * `rate_limit_store_errors_total{limiter}`, and log a warning throttled to at most once per minute.
 * Probes (`/health` and `/ready`) are explicitly exempted so orchestrators never restart
 * instances due to rate limiter latency or failures.
 */
export function rateLimit(opts: RateLimitOptions) {
  const store = opts.store ?? new MemoryStore();
  const fallbackStore = opts.fallbackStore ?? (store instanceof MemoryStore ? store : new MemoryStore());
  const trustProxyHops = opts.trustProxyHops ?? 0;
  const keyFor = opts.keyFor ?? clientIp;
  const storeTimeoutMs = opts.storeTimeoutMs ?? 500;
  const name = opts.name ?? "default";

  return async (ctx: Context, next: Next) => {
    if (opts.max <= 0) return next(); // disabled

    // Health and readiness probes must never be broken, delayed or failed by rate limiting.
    if (ctx.req.path === "/health" || ctx.req.path === "/ready") {
      return next();
    }

    const key = await keyFor(ctx, trustProxyHops);
    let entry: { count: number; resetAt: number };
    let degraded = false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`store timed out after ${storeTimeoutMs}ms`));
      }, storeTimeoutMs);
    });

    try {
      entry = await Promise.race([
        store.increment(key, opts.windowMs),
        timeoutPromise,
      ]);
    } catch (err) {
      degraded = true;
      const reason = err instanceof Error ? err.message : String(err);
      try {
        metrics.rateLimitStoreErrorsTotal.inc({ limiter: name });
      } catch {
        // Ignore metrics failure in tests
      }
      logStoreError(name, reason);
      entry = await fallbackStore.increment(key, opts.windowMs);
    } finally {
      if (timer) clearTimeout(timer);
    }

    const now = Date.now();

    // When degraded, omit x-ratelimit-* headers because the cluster-wide budget could not be computed.
    if (!degraded) {
      const remaining = Math.max(0, opts.max - entry.count);
      ctx.header("x-ratelimit-limit", String(opts.max));
      ctx.header("x-ratelimit-remaining", String(remaining));
      ctx.header("x-ratelimit-reset", String(Math.ceil(entry.resetAt / 1000)));
    }

    if (entry.count > opts.max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      ctx.header("retry-after", String(retryAfter));
      return ctx.json({ error: "rate_limited" }, 429);
    }

    return next();
  };
}

/**
 * Resolve the real client IP.
 *
 * `x-forwarded-for` is a comma-separated chain appended to by each hop, so
 * only the entry `trustProxyHops` positions in from the right end (the side
 * closest to us) was set by infrastructure we trust — everything else,
 * including the leftmost entry, is attacker-controlled. With
 * trustProxyHops=0 the header is ignored entirely and we fall straight to
 * the socket address.
 */
export function clientIp(ctx: Context, trustProxyHops: number): string {
  if (trustProxyHops > 0) {
    const fwd = ctx.req.header("x-forwarded-for");
    if (fwd) {
      const chain = fwd.split(",").map((s) => s.trim()).filter(Boolean);
      const index = chain.length - trustProxyHops;
      if (index >= 0 && index < chain.length) return chain[index]!;
    }
  }

  try {
    const info = getConnInfo(ctx);
    if (info.remote.address) return info.remote.address;
  } catch {
    // getConnInfo throws outside the Node runtime; fall through.
  }

  return ctx.req.header("x-real-ip") ?? "unknown";
}
