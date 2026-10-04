import type { Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Logger } from "@checkout/core";

/**
 * Last-resort handler for anything a route did not catch.
 *
 * Without it Hono answers a plain-text 500 whose body can differ by runtime and
 * clients cannot branch on. This one logs the error server-side (with the
 * request id, when there is one) and returns `500 { error: "internal_error" }`
 * as JSON with no message and no stack: an unhandled error can carry an
 * anchor's response text, a SQL fragment or a file path, none of which belongs
 * in a response (issue 4.36).
 *
 * `HTTPException`s that middleware threw deliberately keep their own response.
 */
export function installErrorHandler(app: Hono<any>, logger: Logger): void {
  app.onError((err, ctx: Context) => {
    if (err instanceof HTTPException) return err.getResponse();
    const requestId = (ctx.get as (key: string) => unknown)("requestId");
    logger.error(
      {
        event: "unhandled.error",
        requestId,
        method: ctx.req.method,
        path: ctx.req.path,
        errorName: err instanceof Error ? err.name : typeof err,
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      },
      "unhandled error",
    );
    return ctx.json({ error: "internal_error" }, 500);
  });
}
