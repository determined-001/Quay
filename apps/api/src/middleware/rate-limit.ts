import type { Context, Next } from "hono";

/**
 * Dependency-free fixed-window rate limiter, keyed by client IP.
 *
 * In-process and per-instance — fine for a single API node. Behind multiple
 * instances or a load balancer you want a shared store (Redis) instead; this
 * caps accidental abuse and runaway clients, not a distributed attack.
 */
export function rateLimit(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, { count: number; resetAt: number }>();

  // Opportunistic sweep so the map can't grow unbounded.
  const sweep = (now: number) => {
    for (const [key, v] of hits) if (v.resetAt <= now) hits.delete(key);
  };

  return async (ctx: Context, next: Next) => {
    if (opts.max <= 0) return next(); // disabled

    const now = Date.now();
    if (hits.size > 10_000) sweep(now);

    const key = clientIp(ctx);
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + opts.windowMs };
      hits.set(key, entry);
    }
    entry.count++;

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

function clientIp(ctx: Context): string {
  const fwd = ctx.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return ctx.req.header("x-real-ip") ?? "unknown";
}
