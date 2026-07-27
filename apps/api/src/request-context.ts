import { randomUUID } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import type { Logger } from "@checkout/core";

export interface RequestContextVariables {
  /** Stable id for the whole request, surfaced as `x-request-id`. */
  requestId: string;
  /** Child logger pre-bound with `requestId` — use this for every log line in the handler. */
  logger: Logger;
}

export type AppEnv = { Variables: RequestContextVariables };

/**
 * Honor an inbound `x-request-id` (so a caller can stitch traces across
 * services) and mint one otherwise. Bind a child logger onto the context
 * keyed by both `requestId` AND the request-specific method+path. Echo the
 * id back so clients can include it in their bug reports.
 *
 * MUST be installed *before* the rate-limit middleware so a 429 still carries
 * the id and can be traced. Routes read the logger via `getLogger(ctx)` and
 * pass it explicitly to service calls so deep subsystems inherit requestId.
 */
export function requestContext(rootLogger: Logger): MiddlewareHandler<AppEnv> {
  return async (ctx, next) => {
    const incoming = ctx.req.header("x-request-id");
    const requestId = isSafeRequestId(incoming) ? incoming : randomUUID();
    const child = rootLogger.child({
      requestId,
      method: ctx.req.method,
      path: ctx.req.path,
    });
    ctx.set("requestId", requestId);
    ctx.set("logger", child);
    ctx.header("x-request-id", requestId);
    return next();
  };
}

/**
 * Reject any inbound x-request-id that doesn't look id-ish. Keeping this
 * strict avoids a malicious caller injecting a fake id into our log stream
 * to mislead on-call searches.
 */
function isSafeRequestId(v: string | undefined): v is string {
  if (!v) return false;
  if (v.length < 8 || v.length > 200) return false;
  // printable ASCII, no control chars, no whitespace
  return /^[\x21-\x7e]+$/.test(v);
}

/** Typed convenience accessor — `c.get('logger')` would otherwise be `unknown`. */
export function getLogger(ctx: Context<AppEnv>): Logger {
  return ctx.get("logger");
}

export function getRequestId(ctx: Context<AppEnv>): string {
  return ctx.get("requestId");
}
