import { Hono } from "hono";
import { createLinkSchema, cashOutSchema } from "@checkout/core";
import type { Container } from "../services/container";
import { HttpError } from "../services/link-service";
import { requireSeller, type AuthedVariables } from "../middleware/auth";

export function linkRoutes(c: Container): Hono<{ Variables: AuthedVariables }> {
  const app = new Hono<{ Variables: AuthedVariables }>();
  app.use("*", requireSeller({ session: c.auth.session, sellers: c.sellers, revocations: c.auth.revocations }));

  // Create a payment link.
  app.post("/", async (ctx) => {
    const parsed = createLinkSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const result = await c.service.createLink(ctx.get("seller").id, parsed.data);
      return ctx.json(result, 201);
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 404);
      throw err;
    }
  });

  // List the seller's links.
  app.get("/", async (ctx) => {
    return ctx.json({ links: await c.service.listLinks(ctx.get("seller").id) });
  });

  // Fetch one link plus its payment request (for the checkout page).
  app.get("/:id", async (ctx) => {
    const result = await c.service.getLink(ctx.req.param("id"));
    if (!result) return ctx.json({ error: "not_found" }, 404);
    if (result.link.sellerId !== ctx.get("seller").id) {
      return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
    }
    return ctx.json(result);
  });

  // Seller-initiated cash-out to local currency.
  app.post("/:id/cash-out", async (ctx) => {
    const parsed = cashOutSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const existing = await c.service.getLink(ctx.req.param("id"));
      if (!existing) return ctx.json({ error: "not_found" }, 404);
      if (existing.link.sellerId !== ctx.get("seller").id) {
        return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
      }
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
