import { Hono, type MiddlewareHandler } from "hono";
import { createLinkSchema, cashOutSchema } from "@checkout/core";
import type { Container } from "../services/container";
import { HttpError } from "../services/link-service";
import { requireSeller, type AuthedVariables } from "../middleware/auth";
import { idempotency } from "../middleware/idempotency";

export function linkRoutes(c: Container, strictRateLimit: MiddlewareHandler): Hono<{ Variables: AuthedVariables }> {
  const app = new Hono<{ Variables: AuthedVariables }>();
  // Applied per-route, NOT via app.use("*", ...). `GET /links/:id` is the
  // buyer-facing checkout fetch: the buyer paying an invoice is not the seller
  // and holds no session, and `apps/web/app/pay/[id]/page.tsx` renders it in a
  // server component with no cookie at all. Gating it would 401 every checkout.
  const auth = requireSeller({ session: c.auth.session, sellers: c.sellers, revocations: c.auth.revocations });

  // Idempotency is mounted after `auth` so it can scope stored responses to the
  // authenticated seller (issue #26).
  const idempotent = idempotency(c.db);

  // strictRateLimit runs BEFORE auth so unauthenticated floods are throttled
  // too — a limiter that only applies to valid sessions protects nothing.
  // Create a payment link.
  app.post("/", strictRateLimit, auth, idempotent, async (ctx) => {
    const parsed = createLinkSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const result = await c.service.createLink(ctx.get("seller").id, parsed.data);
      return ctx.json(result, 201);
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message, ...err.extra }, err.status as 422);
      throw err;
    }
  });

  // (linkId is included in the link.create.ok payload above so a grep on
  // `linkId` finds both the route-level `link.create.*` and the service-level
  // `link.created` events symmetrically, the same way POST /:id/cash-out
  // includes linkId in every route-level line.)

  // List the seller's links.
  app.get("/", auth, async (ctx) => {
    return ctx.json({ links: await c.service.listLinks(ctx.get("seller").id) });
  });

  // CSV export of links for a date range.
  // NOTE: must be registered BEFORE /:id to avoid being shadowed by the wildcard.
  // Seller reconciliation export — gated, and scoped to the caller's own links.
  app.get("/export/csv", auth, async (ctx) => {
    const from = ctx.req.query("from");
    const to = ctx.req.query("to");
    const links = await c.service.listLinks(ctx.get("seller").id);

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
  // PUBLIC by design — the link id is the bearer capability, and the buyer must
  // be able to read this to pay. Returns only what the checkout page renders.
  app.get("/:id", async (ctx) => {
    const result = await c.service.getLink(ctx.req.param("id"), { logger: getLogger(ctx) });
    if (!result) return ctx.json({ error: "not_found" }, 404);
    return ctx.json(result);
  });

  // Seller-initiated cash-out to local currency.
  app.post("/:id/cash-out", strictRateLimit, auth, idempotent, async (ctx) => {
    const parsed = cashOutSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) {
      log.warn({ event: "cashout.invalid", linkId, issues: parsed.error.issues }, "invalid cash-out body");
      return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    }
    log.info({ event: "cashout.request.received", linkId }, "cash-out request received");
    try {
      const existing = await c.service.getLink(ctx.req.param("id"));
      if (!existing) return ctx.json({ error: "not_found" }, 404);
      if (existing.link.sellerId !== ctx.get("seller").id) {
        return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
      }
      const job = await c.service.triggerCashOut(ctx.req.param("id"), parsed.data);
      return ctx.json({ job });
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 403 | 404 | 409 | 502);
      throw err;
    }
  });

  // Link detail with webhook deliveries (for the seller's timeline page).
  // Gated and ownership-checked: unlike GET /:id this is the seller's
  // reconciliation view and carries webhook delivery history.
  app.get("/:id/detail", auth, async (ctx) => {
    const result = await c.service.getLink(ctx.req.param("id"));
    if (!result) return ctx.json({ error: "not_found" }, 404);
    if (result.link.sellerId !== ctx.get("seller").id) {
      return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
    }
    const deliveries = await c.webhooks.listDeliveriesByLinkId(result.link.id);
    return ctx.json({ link: result.link, request: result.request, deliveries });
  });

  // Seller voids a link they created by mistake. Idempotent: cancelling an
  // already-`cancelled` link is a successful no-op. Any state from which
  // `cancelled` is not reachable is rejected with 409 (the on-chain payment
  // must NOT be reversed client-side; the seller refunds out of band via the
  // off-ramp / from their own wallet). No request body.
  app.post("/:id/cancel", auth, async (ctx) => {
    try {
      // Ownership check mirrors cash-out: a link id alone must not let one
      // seller void another seller's link.
      const existing = await c.service.getLink(ctx.req.param("id"));
      if (!existing) return ctx.json({ error: "not_found" }, 404);
      if (existing.link.sellerId !== ctx.get("seller").id) {
        return ctx.json({ error: "forbidden", message: "this link belongs to a different seller" }, 403);
      }
      const link = await c.service.cancelLink(ctx.req.param("id"));
      return ctx.json({ link });
    } catch (err) {
      if (err instanceof HttpError) return ctx.json({ error: err.message }, err.status as 403 | 404 | 409);
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
