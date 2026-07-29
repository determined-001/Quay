import { Hono } from "hono";
import { createLinkSchema, cashOutSchema } from "@checkout/core";
import type { Container } from "../services/container";
import { HttpError } from "../services/link-service";
import type { AuthVariables } from "../middleware/auth";

export function linkRoutes(c: Container): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // Create a payment link. Authenticated - the destination is always the
  // caller's own verified wallet, never client-supplied (issue 6.4).
  app.post("/", c.auth.requireAuth, async (ctx) => {
    const parsed = createLinkSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const result = await c.service.createLink(ctx.get("sellerId"), parsed.data);
      return ctx.json(result, 201);
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 401);
      throw err;
    }
  });

  // List the caller's own links. Authenticated (issue 6.4) - previously
  // returned every link in the database.
  app.get("/", c.auth.requireAuth, async (ctx) => {
    return ctx.json({ links: await c.service.listLinks(ctx.get("sellerId")) });
  });

  // Fetch one link for the checkout page. Deliberately public (issue 6.4,
  // point 5) - a buyer paying a link has no seller credential - but returns
  // only the minimal PublicPaymentLink shape, never the full internal
  // record. If a *valid* seller credential for the link's own owner is
  // presented, the full authenticated detail is returned instead - same
  // route, richer response, only for the actual owner. An invalid or
  // cross-tenant credential here is not an error; it just falls through to
  // the public view; a payment link is supposed to be viewable by anyone
  // with the id.
  app.get("/:id", async (ctx) => {
    const id = ctx.req.param("id");
    const sellerId = await c.auth.resolveSellerId(ctx.req.header("authorization"));
    if (sellerId) {
      const owned = await c.service.getLinkForSeller(id, sellerId);
      if (owned) return ctx.json(owned);
    }
    const pub = await c.service.getLink(id);
    if (!pub) return ctx.json({ error: "not_found" }, 404);
    return ctx.json(pub);
  });

  // Seller-initiated cash-out to local currency. Authenticated and scoped
  // (issue 6.4) - a cross-tenant link id 404s, it never confirms existence
  // with a 403.
  app.post("/:id/cash-out", c.auth.requireAuth, async (ctx) => {
    const parsed = cashOutSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const job = await c.service.triggerCashOut(ctx.req.param("id"), ctx.get("sellerId"), parsed.data);
      return ctx.json({ job });
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 401 | 404 | 409 | 502 | 503);
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
