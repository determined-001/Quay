import { Hono } from "hono";
import { createLinkSchema, cashOutSchema } from "@checkout/core";
import type { Container } from "../services/container";
import { HttpError } from "../services/link-service";

export function linkRoutes(c: Container): Hono {
  const app = new Hono();

  // Create a payment link.
  app.post("/", async (ctx) => {
    const parsed = createLinkSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    const result = await c.service.createLink(parsed.data);
    return ctx.json(result, 201);
  });

  // List the seller's links.
  app.get("/", async (ctx) => {
    return ctx.json({ links: await c.service.listLinks() });
  });

  // Fetch one link plus its payment request (for the checkout page).
  app.get("/:id", async (ctx) => {
    const result = await c.service.getLink(ctx.req.param("id"));
    if (!result) return ctx.json({ error: "not_found" }, 404);
    return ctx.json(result);
  });

  // Indicative off-ramp prices — SEP-38 GET /prices, no firm quote consumed.
  // Safe to call on every dashboard load (issue 3.5).
  // Optional query param: ?currency=NGN — when provided, the indicative rate for
  // that currency is persisted against the link for spread-delta telemetry.
  app.get("/:id/offramp-preview", async (ctx) => {
    const currency = ctx.req.query("currency") ?? undefined;
    try {
      const result = await c.service.getOfframpPreview(ctx.req.param("id"), currency);
      if (result === null) {
        // Adapter doesn't support indicative prices — return empty prices list
        // so the dashboard degrades gracefully.
        return ctx.json({ indicative: true, prices: [], sourceAmount: null });
      }
      return ctx.json(result);
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 404 | 409 | 502);
      throw err;
    }
  });

  // Seller-initiated cash-out to local currency.
  app.post("/:id/cash-out", async (ctx) => {
    const parsed = cashOutSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const job = await c.service.triggerCashOut(ctx.req.param("id"), parsed.data);
      return ctx.json({ job });
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 404 | 409 | 502);
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
