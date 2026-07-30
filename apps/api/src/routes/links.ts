import { Hono } from "hono";
import { createLinkSchema, cashOutSchema } from "@checkout/core";
import type { Container } from "../services/container";
import { HttpError } from "../services/link-service";
import { getLogger, type AppEnv } from "../request-context";

export function linkRoutes(c: Container): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Create a payment link.
  app.post("/", async (ctx) => {
    const log = getLogger(ctx);
    const parsed = createLinkSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) {
      log.warn({ event: "link.create.invalid", issues: parsed.error.issues }, "create link invalid body");
      return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    const t0 = Date.now();
    try {
      const result = await c.service.createLink(parsed.data, { logger: log });
      log.info({ event: "link.create.ok", linkId: result.link.id, durationMs: Date.now() - t0 }, "create link ok");
      return ctx.json(result, 201);
    } catch (err) {
      log.error({ event: "link.create.error", error: err instanceof Error ? err.message : String(err) }, "create link failed");
      throw err;
    }
  });

  // (linkId is included in the link.create.ok payload above so a grep on
  // `linkId` finds both the route-level `link.create.*` and the service-level
  // `link.created` events symmetrically, the same way POST /:id/cash-out
  // includes linkId in every route-level line.)

  // List the seller's links.
  app.get("/", async (ctx) => {
    return ctx.json({ links: await c.service.listLinks({ logger: getLogger(ctx) }) });
  });

  // Fetch one link plus its payment request (for the checkout page).
  app.get("/:id", async (ctx) => {
    const result = await c.service.getLink(ctx.req.param("id"), { logger: getLogger(ctx) });
    if (!result) return ctx.json({ error: "not_found" }, 404);
    return ctx.json(result);
  });

  // Seller-initiated cash-out to local currency.
  app.post("/:id/cash-out", async (ctx) => {
    // Caller's logger carries just (requestId, method, path). LinkService
    // attachs {linkId, reference} itself — avoids a redundant pino re-parent.
    const log = getLogger(ctx);
    const linkId = ctx.req.param("id");
    const parsed = cashOutSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) {
      log.warn({ event: "cashout.invalid", linkId, issues: parsed.error.issues }, "invalid cash-out body");
      return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    log.info({ event: "cashout.request.received", linkId }, "cash-out request received");
    try {
      const job = await c.service.triggerCashOut(linkId, parsed.data, { logger: log });
      log.info({ event: "cashout.request.ok", linkId, jobId: job.jobId, targetCurrency: job.targetCurrency }, "cash-out requested");
      return ctx.json({ job });
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 403 | 404 | 409 | 502);
      throw err;
    }
  });

  return app;
}

async function safeJson(ctx: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await ctx.req.json();
  } catch {
    return {};
  }
}
