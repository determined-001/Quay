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

  // CSV export of links for a date range.
  // NOTE: must be registered BEFORE /:id to avoid being shadowed by the wildcard.
  app.get("/export/csv", async (ctx) => {
    const from = ctx.req.query("from");
    const to = ctx.req.query("to");
    const links = await c.service.listLinks();

    // Filter by date range if provided.
    let filtered = links;
    if (from) {
      const fromMs = new Date(from).getTime();
      if (!isNaN(fromMs)) filtered = filtered.filter((l) => l.createdAt >= fromMs);
    }
    if (to) {
      const toMs = new Date(to).getTime();
      if (!isNaN(toMs)) filtered = filtered.filter((l) => l.createdAt <= toMs);
    }

    const header = "id,reference,title,amount,asset,status,payer,tx_hash,paid_amount,created_at,updated_at\n";
    const rows = filtered.map(
      (l) =>
        [
          l.id,
          l.reference,
          `"${l.title.replace(/"/g, '""')}"`,
          l.amount,
          l.asset.code,
          l.status,
          l.payer ?? "",
          l.txHash ?? "",
          l.paidAmount ?? "",
          new Date(l.createdAt).toISOString(),
          new Date(l.updatedAt).toISOString(),
        ].join(","),
    );
    const csv = header + rows.join("\n");

    return ctx.newResponse(csv, 200, {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="quay-links-export.csv"`,
    });
  });

  // Fetch one link plus its payment request (for the checkout page).
  app.get("/:id", async (ctx) => {
    const result = await c.service.getLink(ctx.req.param("id"));
    if (!result) return ctx.json({ error: "not_found" }, 404);
    return ctx.json(result);
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

  // Link detail with webhook deliveries (for the timeline page).
  app.get("/:id/detail", async (ctx) => {
    const result = await c.service.getLink(ctx.req.param("id"));
    if (!result) return ctx.json({ error: "not_found" }, 404);
    const deliveries = await c.webhooks.listDeliveriesByLinkId(result.link.id);
    return ctx.json({ link: result.link, request: result.request, deliveries });
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
