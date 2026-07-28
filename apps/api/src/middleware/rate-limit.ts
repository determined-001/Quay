import type { Context, Next } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";

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

export function rateLimit(opts: {
  windowMs: number;
  max: number;
  store: RateLimitStore;
  trustProxyHops: number;
}) {
  return async (ctx: Context, next: Next) => {
    if (opts.max <= 0) return next(); // disabled

    const key = clientIp(ctx, opts.trustProxyHops);
    const entry = await opts.store.increment(key, opts.windowMs);
    const now = Date.now();

    const remaining = Math.max(0, opts.max - entry.count);
    ctx.header("x-ratelimit-limit", String(opts.max));
    ctx.header("x-ratelimit-remaining", String(remaining));
    ctx.header("x-ratelimit-reset", String(Math.ceil(entry.resetAt / 1000)));

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
