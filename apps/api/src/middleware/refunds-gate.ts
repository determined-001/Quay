import type { MiddlewareHandler } from "hono";

/**
 * Refunds are behind a flag that ships before the feature (issue 8.29).
 *
 * A half-built refund button on a live dashboard is a real-money risk, so every
 * refund route mounts this first and answers 501 `refunds_disabled` while the
 * flag is off. It is a 501 and not a 502 on purpose: like `offramp_disabled` in
 * `routes/links.ts`, it names a permanent property of the deployment, not a
 * transient upstream failure, so a client must not retry it.
 *
 * No refund route exists yet; 4.59 (prepare), 4.60 (submit) and the list route
 * mount this before doing any work, with `env.refundsEnabled`.
 */
export function refundsGate(enabled: boolean): MiddlewareHandler {
  return async (ctx, next) => {
    if (!enabled) return ctx.json({ error: "refunds_disabled" }, 501);
    await next();
  };
}
