import { Hono, type Context, type MiddlewareHandler, type Next } from "hono";
import { createInvoiceSchema, updateInvoiceSchema, type InvoiceStatus } from "@checkout/core";
import type { Container } from "../services/container";
import { decodeInvoiceCursor, INVOICE_PAGE_MAX, type InvoiceService } from "../services/invoice-service";
import { HttpError } from "../services/link-service";
import { auditActor } from "../services/pii-audit";
import { buildAuthMiddleware, requireScope, type AuthVariables } from "../middleware/auth";
import { idempotency } from "../middleware/idempotency";

export const INVOICES_DISABLED_BODY = {
  error: "invoices_disabled",
  message: "Invoices are not enabled on this deployment.",
} as const;

/**
 * Answers 501 `invoices_disabled` while invoices are off (issue 8.31).
 *
 * TODO(8.31): PR #598 (https://github.com/determined-001/Quay/pull/598) owns
 * the flag and this middleware, with the same name, signature and body. When
 * it lands, drop this copy and `invoicesFlag`, and pass `env` from `index.ts`.
 */
export function requireInvoices(env: { invoicesEnabled: boolean }): MiddlewareHandler {
  return async (ctx: Context, next: Next) => {
    if (!env.invoicesEnabled) return ctx.json(INVOICES_DISABLED_BODY, 501);
    return next();
  };
}

/** Stand-in for `env.invoicesEnabled` until PR #598 lands: on only when `INVOICES_ENABLED` is "true". */
export const invoicesFlag = {
  get invoicesEnabled(): boolean {
    return process.env.INVOICES_ENABLED === "true";
  },
};

const STATUSES: readonly InvoiceStatus[] = ["draft", "open", "paid", "overdue", "void"];

/** The client fields a body carries, by column name, for the audit log. Names only, never values. */
function clientFields(body: { clientName?: unknown; clientEmail?: unknown; clientAddress?: unknown }): string[] {
  const fields: string[] = [];
  if (body.clientName !== undefined) fields.push("client_name");
  if (body.clientEmail !== undefined) fields.push("client_email");
  if (body.clientAddress !== undefined) fields.push("client_address");
  return fields;
}

/**
 * Invoices (issue 4.67 / #560). Every route sits behind `requireInvoices`.
 * Seller routes take a session or an API key with `invoices:read` or
 * `invoices:write`, and 404 for another seller's invoice, the rule `/links`
 * uses. `GET /:id/public` takes no credentials and has its own rate limit.
 */
export function invoiceRoutes(
  c: Container,
  service: InvoiceService,
  limits: { strict: MiddlewareHandler; publicRead: MiddlewareHandler },
  flag: { invoicesEnabled: boolean } = invoicesFlag,
): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();
  app.use("*", requireInvoices(flag));

  // Per route, not app.use("*"): the public read below takes no credentials.
  const auth = buildAuthMiddleware({
    session: c.auth.session,
    sellers: c.sellers,
    revocations: c.auth.revocations,
    apiKeyRepo: c.apiKeys,
    allowedOrigins: c.auth.allowedOrigins,
  });
  const idempotent = idempotency(c.db);
  const read = requireScope("invoices:read");
  const write = requireScope("invoices:write");

  const fail = (ctx: Context, err: unknown) => {
    if (err instanceof HttpError) {
      return ctx.json({ error: err.message, ...(err.extra ?? {}) }, err.status as 400 | 404 | 409 | 422);
    }
    throw err;
  };

  // Create a draft. No link and no number yet.
  app.post("/", limits.strict, auth, write, idempotent, async (ctx) => {
    const parsed = createInvoiceSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const invoice = await service.createDraft(ctx.get("seller").id, parsed.data);
      await c.piiAudit?.record({ ...auditActor(ctx), action: "invoice.client.write", fields: clientFields(parsed.data) });
      return ctx.json({ invoice }, 201);
    } catch (err) {
      return fail(ctx, err);
    }
  });

  app.get("/", auth, read, async (ctx) => {
    const status = ctx.req.query("status");
    if (status !== undefined && !STATUSES.includes(status as InvoiceStatus)) {
      return ctx.json({ error: "invalid_query", message: `status must be one of ${STATUSES.join(", ")}` }, 400);
    }
    const rawCursor = ctx.req.query("cursor");
    const cursor = rawCursor === undefined ? undefined : decodeInvoiceCursor(rawCursor);
    if (cursor === null) return ctx.json({ error: "invalid_query", message: "cursor is not valid" }, 400);
    const rawLimit = ctx.req.query("limit");
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > INVOICE_PAGE_MAX)) {
      return ctx.json({ error: "invalid_query", message: `limit must be 1 to ${INVOICE_PAGE_MAX}` }, 400);
    }
    return ctx.json(
      await service.list(ctx.get("seller").id, { status: status as InvoiceStatus | undefined, cursor, limit }),
    );
  });

  // The whitelist view for whoever holds the id. Never the client's email or
  // address, so there is nothing to decrypt and nothing to audit.
  app.get("/:id/public", limits.publicRead, async (ctx) => {
    try {
      return ctx.json(await service.getPublic(ctx.req.param("id")));
    } catch (err) {
      return fail(ctx, err);
    }
  });

  app.get("/:id", auth, read, async (ctx) => {
    try {
      return ctx.json({ invoice: await service.get(ctx.get("seller").id, ctx.req.param("id")) });
    } catch (err) {
      return fail(ctx, err);
    }
  });

  app.patch("/:id", auth, write, async (ctx) => {
    const parsed = updateInvoiceSchema.safeParse(await safeJson(ctx));
    if (!parsed.success) return ctx.json({ error: "invalid_body", issues: parsed.error.issues }, 400);
    try {
      const invoice = await service.updateDraft(ctx.get("seller").id, ctx.req.param("id"), parsed.data);
      const fields = clientFields(parsed.data);
      if (fields.length > 0) {
        await c.piiAudit?.record({ ...auditActor(ctx), action: "invoice.client.write", fields });
      }
      return ctx.json({ invoice });
    } catch (err) {
      return fail(ctx, err);
    }
  });

  app.delete("/:id", auth, write, async (ctx) => {
    try {
      await service.deleteDraft(ctx.get("seller").id, ctx.req.param("id"));
      return ctx.body(null, 204);
    } catch (err) {
      return fail(ctx, err);
    }
  });

  app.post("/:id/issue", limits.strict, auth, write, async (ctx) => {
    try {
      return ctx.json({ invoice: await service.issue(ctx.get("seller").id, ctx.req.param("id")) });
    } catch (err) {
      return fail(ctx, err);
    }
  });

  app.post("/:id/void", auth, write, async (ctx) => {
    try {
      return ctx.json({ invoice: await service.void(ctx.get("seller").id, ctx.req.param("id")) });
    } catch (err) {
      return fail(ctx, err);
    }
  });

  return app;
}

async function safeJson(ctx: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await ctx.req.json();
  } catch {
    return null;
  }
}
