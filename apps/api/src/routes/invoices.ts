import { Hono, type Context, type MiddlewareHandler, type Next } from "hono";
import { env } from "../env";
import type { Container } from "../services/container";
import { buildAuthMiddleware, type AuthVariables } from "../middleware/auth";
import { InvoiceService } from "../services/invoice-service";

export const INVOICES_DISABLED_BODY = {
  error: "invoices_disabled",
  message: "Invoices are not enabled on this deployment.",
} as const;

export function requireInvoices(parsedEnv: Record<string, unknown>): MiddlewareHandler {
  return async (ctx: Context, next: Next) => {
    const enabled = Boolean(
      (parsedEnv as any).invoicesEnabled ??
      (parsedEnv as any).INVOICES_ENABLED ??
      ((parsedEnv as any).network !== "public")
    );
    if (!enabled) {
      return ctx.json(INVOICES_DISABLED_BODY, 501);
    }
    return next();
  };
}

let sharedInvoiceService: InvoiceService | null = null;

export function getSharedInvoiceService(c: Container): InvoiceService {
  if (!sharedInvoiceService) {
    sharedInvoiceService = new InvoiceService({
      links: c.links,
      webhooks: c.webhooks,
      linkCreator: async (input) => {
        const assetCode = input.assetCode === "XLM" ? "XLM" : "USDC";
        const res = await c.service.createLink(input.sellerId, {
          amount: input.amount,
          title: input.title,
          assetCode,
        });
        return res.link;
      },
    });
  }
  return sharedInvoiceService;
}

export function invoiceRoutes(c: Container, customService?: InvoiceService): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  const service = customService ?? getSharedInvoiceService(c);

  const auth = buildAuthMiddleware({
    session: c.auth.session,
    sellers: c.sellers,
    revocations: c.auth.revocations,
    apiKeyRepo: c.apiKeys,
    allowedOrigins: c.auth.allowedOrigins,
  });

  app.use("*", requireInvoices(env));

  // Public read view — unauthenticated
  app.get("/:id/public", async (ctx) => {
    const id = ctx.req.param("id");
    const inv = await service.getInvoice(id);
    if (!inv) return ctx.json({ error: "not_found" }, 404);
    if (inv.status === "draft") return ctx.json({ error: "not_found" }, 404);

    const seller = await c.sellers.findById(inv.sellerId);
    return ctx.json({
      id: inv.id,
      number: inv.number,
      sellerName: seller?.name ?? "Seller",
      clientName: inv.clientName,
      lineItems: inv.lineItems,
      total: inv.total,
      asset: inv.asset.code,
      issuedAt: inv.issuedAt,
      dueAt: inv.dueAt,
      status: inv.status,
      linkId: inv.linkId,
      notes: inv.notes,
    });
  });

  // Authed seller routes
  app.post("/", auth, async (ctx) => {
    const seller = ctx.get("seller");
    const body = (await ctx.req.json().catch(() => ({}))) as any;
    if (!body.clientName || !Array.isArray(body.lineItems)) {
      return ctx.json({ error: "invalid_body" }, 400);
    }
    const inv = await service.createDraft({
      sellerId: seller.id,
      clientName: body.clientName,
      clientEmail: body.clientEmail,
      clientAddress: body.clientAddress,
      lineItems: body.lineItems,
      asset: body.assetCode ? { code: body.assetCode } : undefined,
      dueAt: body.dueAt ?? Date.now() + 7 * 86400000,
      notes: body.notes,
    });
    return ctx.json({ invoice: inv }, 201);
  });

  app.get("/", auth, async (ctx) => {
    const seller = ctx.get("seller");
    const status = ctx.req.query("status");
    const list = await service.listInvoices(seller.id, status);
    return ctx.json({ invoices: list });
  });

  app.get("/:id", auth, async (ctx) => {
    const seller = ctx.get("seller");
    const id = ctx.req.param("id");
    const inv = await service.getInvoice(id, seller.id);
    if (!inv) return ctx.json({ error: "not_found" }, 404);
    return ctx.json({ invoice: inv });
  });

  app.patch("/:id", auth, async (ctx) => {
    const seller = ctx.get("seller");
    const id = ctx.req.param("id");
    const body = (await ctx.req.json().catch(() => ({}))) as any;
    try {
      const inv = await service.patchDraft(id, seller.id, body);
      return ctx.json({ invoice: inv });
    } catch (err: any) {
      if (err.message === "not_found") return ctx.json({ error: "not_found" }, 404);
      if (err.message === "invoice_not_draft") return ctx.json({ error: "invoice_not_draft" }, 409);
      throw err;
    }
  });

  app.post("/:id/issue", auth, async (ctx) => {
    const seller = ctx.get("seller");
    const id = ctx.req.param("id");
    try {
      const inv = await service.issue(id, seller.id);
      return ctx.json({ invoice: inv });
    } catch (err: any) {
      if (err.message === "not_found") return ctx.json({ error: "not_found" }, 404);
      if (err.message === "invoice_not_draft") return ctx.json({ error: "invoice_not_draft" }, 409);
      throw err;
    }
  });

  app.post("/:id/void", auth, async (ctx) => {
    const seller = ctx.get("seller");
    const id = ctx.req.param("id");
    try {
      const inv = await service.void(id, seller.id);
      return ctx.json({ invoice: inv });
    } catch (err: any) {
      if (err.message === "not_found") return ctx.json({ error: "not_found" }, 404);
      if (err.message === "invoice_already_paid") return ctx.json({ error: "invoice_already_paid" }, 409);
      throw err;
    }
  });

  return app;
}
