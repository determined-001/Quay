import type { Context, MiddlewareHandler, Next } from "hono";

export const INVOICES_DISABLED_BODY = {
  error: "invoices_disabled",
  message: "Invoices are not enabled on this deployment.",
} as const;

export function requireInvoices(env: { invoicesEnabled: boolean }): MiddlewareHandler {
  return async (ctx: Context, next: Next) => {
    if (!env.invoicesEnabled) {
      return ctx.json(INVOICES_DISABLED_BODY, 501);
    }
    return next();
  };
}
